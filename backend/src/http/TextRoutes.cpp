#include "TextRoutes.h"
#include "HttpRouter.h"
#include "ScopedUsageLog.h"
#include "AtomicFile.h"
#include "Config.h"
#include "ConversationManager.h"
#include "RequestCancellation.h"
#include "StoragePaths.h"
#include "TextRunStore.h"
#include "TextTaskQueue.h"
#include "TranslateClient.h"
#include "UsageStore.h"
#include "Utf8Path.h"

#include <cstdint>
#include <exception>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace http_router
{
using json = nlohmann::json;
namespace fs = std::filesystem;

namespace
{
constexpr const char* kProjectFileName = "project.lcproj";
constexpr const char* kProjectFileNameLegacy = "project.llmchat-proj.json";

void writeProjectData(const fs::path& path, const std::string& data) {
    std::string error;
    if (!atomicfile::writeText(path, data, &error)) throw std::runtime_error(error);
}

std::string decodeEpubArchive(const std::string& encoded)
{
    const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string bytes; bytes.reserve(encoded.size() * 3 / 4);
    unsigned int bits = 0; int count = 0;
    for (char ch : encoded) {
        if (ch == '=') break;
        const auto value = alphabet.find(ch);
        if (value == std::string::npos) throw std::runtime_error("EPUB 原书编码无效");
        bits = (bits << 6) | static_cast<unsigned int>(value); count += 6;
        if (count >= 8) { count -= 8; bytes.push_back(static_cast<char>((bits >> count) & 255)); }
    }
    if (bytes.size() < 4 || bytes.substr(0, 2) != "PK") throw std::runtime_error("EPUB 原书不是有效压缩文件");
    return bytes;
}

/** Prefer modern name; rename leftover legacy files in place. */
fs::path findProjectFile(const fs::path& folder)
{
    const fs::path modern = folder / kProjectFileName;
    const fs::path legacy = folder / kProjectFileNameLegacy;
    if (fs::exists(modern))
    {
        if (fs::exists(legacy))
        {
            std::error_code ec;
            fs::remove(legacy, ec);
        }
        return modern;
    }
    if (fs::exists(legacy))
    {
        std::error_code ec;
        fs::rename(legacy, modern, ec);
        if (!ec && fs::exists(modern))
        {
            return modern;
        }
        // Rename failed (e.g. cross-device); fall back to reading legacy once
        return legacy;
    }
    return {};
}

std::string sanitizeFolderName(std::string name)
{
    for (char& c : name)
    {
        if (c == '/' || c == '\\' || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' ||
            c == '>' || c == '|' || static_cast<unsigned char>(c) < 32)
        {
            c = '_';
        }
    }
    while (!name.empty() && (name.back() == ' ' || name.back() == '.'))
    {
        name.pop_back();
    }
    if (name.empty())
    {
        name = "untitled";
    }
    if (name.size() > 80)
    {
        name.resize(80);
    }
    return name;
}
}

void appendServiceTiming(json& result, const std::optional<LlmServiceTiming>& timing)
{
    if (timing) {
        result["serviceTiming"] = {{"totalMs", timing->totalMs}, {"loadMs", timing->loadMs},
            {"promptMs", timing->promptMs}, {"generationMs", timing->generationMs}};
    }
}

std::string readFileUtf8(const fs::path& path)
{
    std::ifstream in(path, std::ios::binary);
    if (!in)
    {
        throw std::runtime_error("无法读取文件");
    }
    std::ostringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

void writeFileUtf8(const fs::path& path, const std::string& content)
{
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out)
    {
        throw std::runtime_error("无法写入文件");
    }
    out << content;
}

void registerTextProjectRoutes(httplib::Server& svr)
{
    svr.Get("/api/text-projects", withCors([](const httplib::Request&, httplib::Response& res) {
        try
        {
            const fs::path root = storage::get("projects");
            fs::create_directories(root);
            json items = json::array();
            for (const auto& entry : fs::directory_iterator(root))
            {
                if (!entry.is_directory())
                {
                    continue;
                }
                const fs::path projectFile = findProjectFile(entry.path());
                if (projectFile.empty())
                {
                    continue;
                }
                std::string name = utf8path::pathUtf8(entry.path().filename());
                std::string updatedAt;
                try
                {
                    const auto raw = readFileUtf8(projectFile);
                    const auto doc = json::parse(raw);
                    if (doc.contains("name") && doc["name"].is_string())
                    {
                        name = doc["name"].get<std::string>();
                    }
                    if (doc.contains("updatedAt") && doc["updatedAt"].is_string())
                    {
                        updatedAt = doc["updatedAt"].get<std::string>();
                    }
                }
                catch (...)
                {
                }
                items.push_back(json{
                    {"folder", utf8path::pathUtf8(entry.path().filename())},
                    {"name", name},
                    {"path", utf8path::pathUtf8(projectFile)},
                    {"folderPath", utf8path::pathUtf8(entry.path())},
                    {"updatedAt", updatedAt},
                });
            }
            res.set_content(json{
                {"ok", true},
                {"root", utf8path::pathUtf8(root)},
                {"items", items},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 500;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Get("/api/text-projects/load", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const fs::path root = storage::get("projects");
            fs::path projectFile;
            if (req.has_param("folder"))
            {
                const std::string folder = sanitizeFolderName(req.get_param_value("folder"));
                projectFile = findProjectFile(root / utf8path::pathFromUtf8(folder));
            }
            else if (req.has_param("path"))
            {
                projectFile = utf8path::pathFromUtf8(req.get_param_value("path"));
                // Migrate legacy filename if a path still points at it
                if (projectFile.filename() == kProjectFileNameLegacy)
                {
                    const fs::path modern = projectFile.parent_path() / kProjectFileName;
                    if (!fs::exists(modern) && fs::exists(projectFile))
                    {
                        std::error_code ec;
                        fs::rename(projectFile, modern, ec);
                        if (!ec)
                        {
                            projectFile = modern;
                        }
                    }
                    else if (fs::exists(modern))
                    {
                        std::error_code ec;
                        fs::remove(projectFile, ec);
                        projectFile = modern;
                    }
                }
            }
            else
            {
                res.status = 400;
                res.set_content(errorJson("缺少 folder 或 path 参数").dump(), "application/json");
                return;
            }

            if (projectFile.empty() || !fs::exists(projectFile))
            {
                res.status = 404;
                res.set_content(errorJson("工程文件不存在").dump(), "application/json");
                return;
            }

            const auto raw = readFileUtf8(projectFile);
            auto doc = json::parse(raw);
            if (doc.contains("sourceMeta") && doc["sourceMeta"].contains("epub")) {
                auto& epub = doc["sourceMeta"]["epub"];
                if (epub.contains("archive") && epub["archive"].is_string() && !epub["archive"].get_ref<const std::string&>().empty()) {
                    writeProjectData(projectFile.parent_path() / "source.epub", decodeEpubArchive(epub["archive"].get_ref<const std::string&>()));
                    epub.erase("archive"); epub.erase("archivePath"); epub["archiveFile"] = "source.epub";
                    writeProjectData(projectFile, doc.dump(2) + "\n");
                }
                if (epub.value("archiveFile", "") == "source.epub") {
                    const auto path = projectFile.parent_path() / "source.epub";
                    if (!fs::exists(path)) throw std::runtime_error("工程缺少原书附件 source.epub");
                    epub["archivePath"] = utf8path::pathUtf8(path);
                }
            }
            res.set_content(json{
                {"ok", true},
                {"project", doc},
                {"folder", utf8path::pathUtf8(projectFile.parent_path().filename())},
                {"folderPath", utf8path::pathUtf8(projectFile.parent_path())},
                {"path", utf8path::pathUtf8(projectFile)},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/text-projects/save", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body);
            if (!body.contains("project"))
            {
                res.status = 400;
                res.set_content(errorJson("缺少 project").dump(), "application/json");
                return;
            }

            json project = body["project"];
            if (!project.is_object())
            {
                res.status = 400;
                res.set_content(errorJson("project 必须是对象").dump(), "application/json");
                return;
            }

            std::string folderName;
            if (body.contains("folder") && body["folder"].is_string())
            {
                folderName = sanitizeFolderName(body["folder"].get<std::string>());
            }
            else if (project.contains("folder") && project["folder"].is_string())
            {
                folderName = sanitizeFolderName(project["folder"].get<std::string>());
            }
            else if (project.contains("name") && project["name"].is_string())
            {
                folderName = sanitizeFolderName(project["name"].get<std::string>());
            }
            else
            {
                folderName = "untitled";
            }

            const fs::path root = storage::get("projects");
            fs::create_directories(root);
            fs::path folderPath = root / utf8path::pathFromUtf8(folderName);

            // Reject duplicate folder when creating fresh without overwrite
            if (!body.value("overwrite", true) && !findProjectFile(folderPath).empty())
            {
                res.status = 409;
                res.set_content(
                    errorJson("工程名称已存在，不能重复，请更换名称后再试").dump(),
                    "application/json");
                return;
            }

            fs::create_directories(folderPath);
            project["folder"] = folderName;
            std::string epubPath;
            if (project.contains("sourceMeta") && project["sourceMeta"].contains("epub")) {
                auto& epub = project["sourceMeta"]["epub"];
                const auto destination = folderPath / "source.epub";
                if (epub.contains("archive") && epub["archive"].is_string() && !epub["archive"].get_ref<const std::string&>().empty()) {
                    writeProjectData(destination, decodeEpubArchive(epub["archive"].get_ref<const std::string&>()));
                } else if (epub.contains("archivePath")) {
                    const auto source = utf8path::pathFromUtf8(epub["archivePath"].get<std::string>());
                    if (fs::weakly_canonical(source) != fs::weakly_canonical(destination)) fs::copy_file(source, destination, fs::copy_options::overwrite_existing);
                }
                if (!fs::exists(destination)) throw std::runtime_error("工程缺少 EPUB 原书附件");
                epub.erase("archive"); epub.erase("archivePath"); epub["archiveFile"] = "source.epub";
                epubPath = utf8path::pathUtf8(destination);
            }
            const fs::path projectFile = folderPath / kProjectFileName;
            writeProjectData(projectFile, project.dump(2) + "\n");

            if (body.contains("sourceFileName") && body.contains("sourceContent") &&
                body["sourceFileName"].is_string() && body["sourceContent"].is_string())
            {
                const std::string srcName = body["sourceFileName"].get<std::string>();
                const auto pos = srcName.find_last_of("\\/");
                const std::string base =
                    pos == std::string::npos ? srcName : srcName.substr(pos + 1);
                if (!base.empty() && base.find("..") == std::string::npos)
                {
                    writeFileUtf8(folderPath / utf8path::pathFromUtf8(base), body["sourceContent"].get<std::string>());
                }
            }

            res.set_content(json{
                {"ok", true},
                {"folder", folderName},
                {"folderPath", utf8path::pathUtf8(folderPath)},
                {"path", utf8path::pathUtf8(projectFile)},
                {"root", utf8path::pathUtf8(root)},
                {"epubPath", epubPath},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));
}

void registerTextProjectFileRoute(httplib::Server& svr)
{
    svr.Post("/api/text-projects/write-file", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body);
            if (!body.contains("folder") || !body.contains("fileName") || !body.contains("content"))
            {
                res.status = 400;
                res.set_content(errorJson("缺少 folder / fileName / content").dump(), "application/json");
                return;
            }
            const std::string folder = sanitizeFolderName(body["folder"].get<std::string>());
            std::string fileName = body["fileName"].get<std::string>();
            const auto slash = fileName.find_last_of("\\/");
            if (slash != std::string::npos)
            {
                fileName = fileName.substr(slash + 1);
            }
            if (fileName.empty() || fileName.find("..") != std::string::npos)
            {
                res.status = 400;
                res.set_content(errorJson("非法文件名").dump(), "application/json");
                return;
            }
            for (char& c : fileName)
            {
                if (c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|')
                {
                    c = '_';
                }
            }
            const fs::path root = storage::get("projects");
            const fs::path folderPath = root / utf8path::pathFromUtf8(folder);
            fs::create_directories(folderPath);
            const fs::path outPath = folderPath / utf8path::pathFromUtf8(fileName);
            writeFileUtf8(outPath, body["content"].get<std::string>());
            res.set_content(json{
                {"ok", true},
                {"path", utf8path::pathUtf8(outPath)},
                {"folderPath", utf8path::pathUtf8(folderPath)},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));
}

void registerChatAndDictionaryRoutes(httplib::Server& svr, const ConfigStore& config_, ConversationManager& conversations_, UsageStore& usage_, DictionaryLookup lookupDictionaryJson)
{
    svr.Post("/api/chat", withCors([&config_, &conversations_, &usage_](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body);
            const std::string conversationId = body.value("conversationId", "");
            const std::string content = body.value("content", "");
            if (conversationId.empty() || content.empty())
            {
                res.status = 400;
                res.set_content(errorJson("conversationId and content required").dump(), "application/json");
                return;
            }

            if (!conversations_.addMessage(conversationId, "user", content))
            {
                res.status = 404;
                res.set_content(errorJson("Conversation not found").dump(), "application/json");
                return;
            }

            auto conv = conversations_.conversation(conversationId);
            const AppConfig cfg = config_.snapshot();

            LlmRequest llmReq;
            llmReq.apiUrl = cfg.apiUrl;
            llmReq.apiKey = cfg.apiKey;
            llmReq.model = cfg.model;
            llmReq.messages = conv.messages;
            llmReq.nativeOllama = body.value("ollamaNative", false) && cfg.apiUrl == body.value("ollamaApiUrl", "");
            llmReq.ollamaContextLength = body.value("ollamaContextLength", 0);
            llmReq.requireComplete = llmReq.nativeOllama;
            if (llmReq.nativeOllama) llmReq.proxyMode = "direct";

            UsageEvent usageEv = UsageStore::makeEventSkeleton();
            usageEv.feature = "chat";
            usageEv.channel = "llm";
            usageEv.model = cfg.model;
            usageEv.apiHost = UsageStore::hostFromApiUrl(cfg.apiUrl);
            usageEv.vendor = UsageStore::vendorFromHostOrModel(
                usageEv.apiHost, cfg.model, "");
            usageEv.sourceChars = static_cast<int>(content.size());
            usageEv.endpoint = "chat";

            ScopedUsageLog usageLog(usage_, usageEv);
            const LlmResponse llmRes = LlmClient::chat(llmReq);
            usageLog.ev().ok = llmRes.ok;
            if (!llmRes.ok) usageLog.ev().errorCode = llmRes.errorCode.empty() ? "LLM_ERROR" : llmRes.errorCode;
            usageLog.ev().errorMessage = llmRes.ok ? "" : llmRes.error;
            usageLog.ev().promptTokens = llmRes.promptTokens;
            usageLog.ev().completionTokens = llmRes.completionTokens;
            usageLog.ev().totalTokens = llmRes.totalTokens;
            usageLog.ev().cacheReadTokens = llmRes.cacheReadTokens;
            usageLog.ev().cacheWriteTokens = llmRes.cacheWriteTokens;
            if (!llmRes.ok)
            {
                res.status = 502;
                res.set_content(json{{"error", llmRes.error}, {"code", llmRes.errorCode}}.dump(), "application/json");
                return;
            }

            conversations_.addMessage(conversationId, "assistant", llmRes.content);

            res.set_content(json{
                {"ok", true},
                {"reply", llmRes.content},
                {"conversation", conversations_.page(conversationId, cfg.messagePageSize)},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Get("/api/dictionary", withCors([&config_, lookupDictionaryJson](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const AppConfig cfg = config_.snapshot();
            const std::string q = req.get_param_value("q");
            const std::string source = req.has_param("source")
                ? req.get_param_value("source")
                : cfg.translateSource;
            const std::string target = req.has_param("target")
                ? req.get_param_value("target")
                : cfg.translateTarget;
            const std::string body = lookupDictionaryJson(
                q, source, target, cfg.proxyMode, cfg.httpProxy);
            const json parsed = json::parse(body);
            res.status = parsed.value("ok", false) ? 200 : 502;
            res.set_content(body, "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 500;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));
}

void registerTranslateCancelRoute(httplib::Server& svr, request_cancel::Registry& translationTasks)
{
    svr.Post("/api/translate/cancel", withCors([&translationTasks](const httplib::Request& req, httplib::Response& res) {
        const auto body = json::parse(req.body, nullptr, false);
        const auto id = body.is_object() ? body.value("taskId", std::string{}) : std::string{};
        if (id.empty() || id.size() > 96) {
            res.status = 400;
            res.set_content(errorJson("invalid taskId").dump(), "application/json");
            return;
        }
        translationTasks.cancel(id);
        res.set_content(json{{"ok", true}}.dump(), "application/json");
    }));
}

TranslateHandler registerTranslationRoute(httplib::Server& svr, const ConfigStore& config_, UsageStore& usage_, request_cancel::Registry& translationTasks, std::atomic<unsigned long long>& nextTask)
{
    const TranslateHandler translateHandler = withCors([&config_, &usage_, &translationTasks, &nextTask](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body);
            std::string taskId = body.value("taskId", "");
            if (taskId.empty()) taskId = "server-" + std::to_string(++nextTask);
            if (taskId.size() > 96) throw std::runtime_error("invalid taskId");
            auto task = translationTasks.begin(taskId);
            if (!task) {
                res.status = 429;
                res.set_content(json{{"error", "翻译任务较多，请稍后重试"}, {"code", "BUSY"}}.dump(), "application/json");
                return;
            }
            request_cancel::Scope cancellation(translationTasks, taskId, task);
            if (task->stopped()) {
                res.status = 499;
                res.set_content(json{{"error", "翻译已取消"}, {"code", "CANCELLED"}}.dump(), "application/json");
                return;
            }
            const std::string text = body.value("text", "");
            if (text.empty())
            {
                res.status = 400;
                res.set_content(errorJson("text required").dump(), "application/json");
                return;
            }

            const AppConfig cfg = config_.snapshot();
            const std::string source = body.value("source", cfg.translateSource);
            const std::string target = body.value("target", cfg.translateTarget);
            const std::string provider = body.value("provider", cfg.translateProvider);
            const int maxLength = body.value("maxLength", cfg.translateMaxLength);
            const bool autoChunk = body.value("autoChunk", cfg.translateAutoChunk);

            TranslateResult tr;
            std::string apiUrl;
            std::string model;
            std::string vendorHint;

            UsageEvent usageEv = UsageStore::makeEventSkeleton();
            usageEv.feature = body.value("feature", "unknown");
            if (usageEv.feature.empty())
                usageEv.feature = "unknown";
            usageEv.sourceChars = static_cast<int>(text.size());
            usageEv.endpoint = "translate";
            if (provider == "llm")
            {
                usageEv.channel = "llm";
                usageEv.model = body.value("model", cfg.model);
            }

            ScopedUsageLog usageLog(usage_, usageEv);

            if (provider == "llm")
            {
                apiUrl = body.value("apiUrl", cfg.apiUrl);
                const std::string apiKey = body.value("apiKey", cfg.apiKey);
                model = usageLog.ev().model;
                vendorHint = body.value("vendor", "");
                usageLog.ev().apiHost = UsageStore::hostFromApiUrl(apiUrl);
                usageLog.ev().vendor = UsageStore::vendorFromHostOrModel(
                    usageLog.ev().apiHost, model, vendorHint);

                const std::string prompt = body.value("prompt", "");
                std::string glossary;
                if (body.contains("glossary"))
                {
                    if (body["glossary"].is_string())
                    {
                        glossary = body["glossary"].get<std::string>();
                    }
                    else if (body["glossary"].is_array())
                    {
                        glossary = body["glossary"].dump();
                    }
                }
                else if (body.value("feature", "") == "literature")
                {
                    glossary = cfg.translateGlossary;
                }
                std::string contextJson;
                if (body.contains("context"))
                {
                    if (body["context"].is_string())
                    {
                        contextJson = body["context"].get<std::string>();
                    }
                    else if (body["context"].is_array())
                    {
                        contextJson = body["context"].dump();
                    }
                }
                tr = TranslateClient::translateWithLlm(
                    text, apiUrl, apiKey, model, source, target,
                    body.value("localModel", false) ? "direct" : cfg.proxyMode, cfg.httpProxy, prompt, glossary, contextJson,
                    body.value("localModel", false) && body.value("ollamaReasoningOff", false), body.value("maxOutputTokens", 0),
                    body.value("localModel", false) && body.value("ollamaNative", false), body.value("ollamaContextLength", 0),
                    body.value("feature", "") == "unity");
            }
            else
            {
                usageLog.ev().channel = "engine";
                usageLog.ev().engineId = provider;
                usageLog.ev().engineKind = UsageStore::engineKindForProvider(provider);
                tr = TranslateClient::translateFree(
                    text, source, target, provider, maxLength, autoChunk,
                    cfg.proxyMode, cfg.httpProxy, cfg.translateEngineKeys, body.value("autoFallback", true));
                if (tr.provider.empty() == false)
                    usageLog.ev().engineId = tr.provider;
            }

            if (!tr.ok && task->stopped()) {
                tr.code = "CANCELLED";
                tr.error = "翻译已取消或超过整体时限";
                if (provider == "llm" && tr.externalCall && tr.totalTokens <= 0) {
                    // Sent upstream, but cancelled before usage arrived: never count as free.
                    tr.promptTokens = tr.completionTokens = tr.totalTokens = kUsageTokensUnknown;
                    tr.cacheReadTokens = tr.cacheWriteTokens = kUsageTokensUnknown;
                }
            }
            usageLog.ev().ok = tr.ok;
            usageLog.ev().errorCode = tr.ok ? "" : (tr.code.empty() ? "ERROR" : tr.code);
            usageLog.ev().errorMessage = tr.ok ? "" : tr.error;
            if (provider == "llm")
            {
                usageLog.ev().promptTokens = tr.promptTokens;
                usageLog.ev().completionTokens = tr.completionTokens;
                usageLog.ev().totalTokens = tr.totalTokens;
                usageLog.ev().cacheReadTokens = tr.cacheReadTokens;
                usageLog.ev().cacheWriteTokens = tr.cacheWriteTokens;
            }

            if (!tr.ok)
            {
                res.status = tr.code == "CANCELLED" ? 499 : tr.code == "LENGTH_LIMIT" ? 400
                    : (tr.code == "CONFIG_ERROR" ? 400 : 502);
                res.set_content(json{
                    {"ok", false},
                    {"error", tr.error},
                    {"code", tr.code.empty() ? "ERROR" : tr.code},
                    {"provider", tr.provider},
                    {"promptTokens", tr.promptTokens},
                    {"completionTokens", tr.completionTokens},
                {"generationTokensPerSecond", tr.generationTokensPerSecond},
                    {"totalTokens", tr.totalTokens},
                    {"cacheReadTokens", tr.cacheReadTokens},
                    {"cacheWriteTokens", tr.cacheWriteTokens},
                }.dump(), "application/json");
                return;
            }

            json result = {
                {"ok", true},
                {"source", text},
                {"translation", tr.translation},
                {"provider", tr.provider},
                {"promptTokens", tr.promptTokens},
                {"completionTokens", tr.completionTokens},
                {"generationTokensPerSecond", tr.generationTokensPerSecond},
                {"totalTokens", tr.totalTokens},
                {"cacheReadTokens", tr.cacheReadTokens},
                {"cacheWriteTokens", tr.cacheWriteTokens},
            };
            appendServiceTiming(result, tr.serviceTiming);
            res.set_content(result.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    });
    svr.Post("/api/translate", translateHandler);
    return translateHandler;
}

void registerTextRequestRoutes(httplib::Server& svr, TextTaskQueue& textQueue, const TranslateHandler& translateHandler, request_cancel::Registry& translationTasks)
{
    svr.Post("/api/text-requests", withCors([&textQueue, &translateHandler](const httplib::Request& req, httplib::Response& res) {
        try {
            auto body = json::parse(req.body); const auto id = body.at("taskId").get<std::string>();
            if (id.empty() || id.size() > 96 || body.value("feature", "") != "text") throw std::runtime_error("文本任务参数无效");
            if (!textQueue.submit(id, [body = std::move(body), &translateHandler] {
                httplib::Request request; request.body = body.dump(); httplib::Response response; response.status = 200;
                translateHandler(request, response);
                return json{{"status", response.status}, {"body", json::parse(response.body)}};
            })) { res.status = 429; res.set_content(errorJson("文本请求队列已满或编号重复").dump(), "application/json"); return; }
            res.set_content(json{{"ok", true}, {"taskId", id}}.dump(), "application/json");
        } catch (const std::exception& e) { res.status = 400; res.set_content(errorJson(e.what()).dump(), "application/json"); }
    }));
    svr.Get("/api/text-requests", withCors([&textQueue](const httplib::Request& req, httplib::Response& res) {
        try { res.set_content(textQueue.status(req.get_param_value("taskId")).dump(), "application/json"); }
        catch (const std::exception& e) { res.status = 404; res.set_content(errorJson(e.what()).dump(), "application/json"); }
    }));
    svr.Delete("/api/text-requests", withCors([&textQueue, &translationTasks](const httplib::Request& req, httplib::Response& res) {
        const auto id = req.get_param_value("taskId");
        if (!textQueue.remove(id)) translationTasks.cancel(id);
        res.set_content(json{{"ok", true}}.dump(), "application/json");
    }));
}

void registerTextRunRoutes(httplib::Server& svr, TextRunStore& textRuns)
{
    svr.Post("/api/text-projects/run", withCors([&textRuns](const httplib::Request& req, httplib::Response& res) {
        try {
            const auto body = json::parse(req.body); auto project = body.at("project");
            const auto id = body.at("runId").get<std::string>(), folder = sanitizeFolderName(body.at("folder").get<std::string>());
            if (id.empty() || id.size() > 96) throw std::runtime_error("运行编号无效");
            project["folder"] = folder;
            textRuns.begin(id, storage::get("projects") / utf8path::pathFromUtf8(folder) / kProjectFileName, std::move(project));
            res.set_content(json{{"ok", true}}.dump(), "application/json");
        } catch (const std::exception& e) { res.status = 400; res.set_content(errorJson(e.what()).dump(), "application/json"); }
    }));
    svr.Post("/api/text-projects/checkpoint", withCors([&textRuns](const httplib::Request& req, httplib::Response& res) {
        try {
            const auto body = json::parse(req.body);
            textRuns.checkpoint(body.at("runId").get<std::string>(), body.at("updates"), body.at("tokens"), body.at("elapsedMs").get<long long>());
            res.set_content(json{{"ok", true}}.dump(), "application/json");
        } catch (const std::exception& e) { res.status = 400; res.set_content(errorJson(e.what()).dump(), "application/json"); }
    }));
    svr.Delete("/api/text-projects/run", withCors([&textRuns](const httplib::Request& req, httplib::Response& res) {
        textRuns.finish(req.get_param_value("runId")); res.set_content(json{{"ok", true}}.dump(), "application/json");
    }));
}

}
