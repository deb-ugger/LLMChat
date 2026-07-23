#include "HttpServer.h"
#include "LlmClient.h"
#include "TranslateClient.h"

#include <httplib.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <sstream>

using json = nlohmann::json;
namespace fs = std::filesystem;

namespace {

constexpr const char* kProjectFileName = "project.llmchat-proj.json";

void setCors(httplib::Response& res)
{
    res.set_header("Access-Control-Allow-Origin", "*");
    res.set_header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}

json errorJson(const std::string& message)
{
    return json{{"ok", false}, {"error", message}};
}

fs::path dataDirectory(const ConfigStore& config)
{
    return fs::path(config.path()).parent_path();
}

fs::path resolveTextProjectsRoot(const ConfigStore& config)
{
    const auto& raw = config.get().textProjectsDir;
    if (raw.empty())
    {
        return dataDirectory(config) / "text-projects";
    }
    fs::path p(raw);
    if (p.is_absolute())
    {
        return p;
    }
    return dataDirectory(config) / p;
}

std::string sanitizeFolderName(std::string name)
{
    for (char& c : name)
    {
        if (c == '/' || c == '\\' || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' ||
            c == '>' || c == '|' || c < 32)
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

} // namespace

HttpServer::HttpServer(ConfigStore& config, ConversationManager& conversations)
    : config_(config)
    , conversations_(conversations)
{
}

int HttpServer::run()
{
    httplib::Server svr;

    svr.Options(R"(.*)", [](const httplib::Request&, httplib::Response& res) {
        setCors(res);
        res.status = 204;
    });

    auto withCors = [](auto handler) {
        return [handler](const httplib::Request& req, httplib::Response& res) {
            setCors(res);
            handler(req, res);
            if (!res.get_header_value("Content-Type").empty()
                && res.get_header_value("Content-Type").find("charset=") == std::string::npos
                && res.get_header_value("Content-Type").find("application/json") != std::string::npos)
            {
                res.set_header("Content-Type", "application/json; charset=utf-8");
            }
        };
    };

    svr.Get("/api/health", withCors([](const httplib::Request&, httplib::Response& res) {
        res.set_content(json{{"ok", true}, {"service", "llmchat-backend"}}.dump(), "application/json; charset=utf-8");
    }));

    svr.Get("/api/settings", withCors([this](const httplib::Request&, httplib::Response& res) {
        const auto& c = config_.get();
        json body{
            {"apiUrl", c.apiUrl},
            {"apiKey", c.apiKey},
            {"model", c.model},
            {"messagePageSize", c.messagePageSize},
            {"port", c.port},
            {"proxyMode", c.proxyMode},
            {"httpProxy", c.httpProxy},
            {"translateProvider", c.translateProvider},
            {"translateSource", c.translateSource},
            {"translateTarget", c.translateTarget},
            {"translateMaxLength", c.translateMaxLength},
            {"translateAutoChunk", c.translateAutoChunk},
            {"ocrLang", c.ocrLang},
            {"ocrAutoTranslate", c.ocrAutoTranslate},
            {"ocrTranslateProvider", c.ocrTranslateProvider},
            {"ocrTranslateSource", c.ocrTranslateSource},
            {"ocrTranslateTarget", c.ocrTranslateTarget},
            {"ocrTranslateMaxLength", c.ocrTranslateMaxLength},
            {"ocrTranslateAutoChunk", c.ocrTranslateAutoChunk},
            {"textTranslateSource", c.textTranslateSource},
            {"textTranslateTarget", c.textTranslateTarget},
            {"textTranslateProvider", c.textTranslateProvider},
            {"textTranslatePrompt", c.textTranslatePrompt},
            {"textGlossary", c.textGlossary},
            {"textPreReplace", c.textPreReplace},
            {"textPostReplace", c.textPostReplace},
            {"textProjectsDir", c.textProjectsDir},
            {"textProjectsDirResolved", resolveTextProjectsRoot(config_).string()},
            {"dataDir", dataDirectory(config_).string()},
            {"translateEngineKeys", c.translateEngineKeys},
        };
        res.set_content(body.dump(), "application/json");
    }));

    svr.Put("/api/settings", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body);
            auto& c = config_.get();
            if (body.contains("apiUrl"))
            {
                c.apiUrl = body["apiUrl"].get<std::string>();
            }
            if (body.contains("apiKey"))
            {
                c.apiKey = body["apiKey"].get<std::string>();
            }
            if (body.contains("model"))
            {
                c.model = body["model"].get<std::string>();
            }
            if (body.contains("messagePageSize"))
            {
                c.messagePageSize = body["messagePageSize"].get<int>();
            }
            if (body.contains("proxyMode"))
            {
                c.proxyMode = body["proxyMode"].get<std::string>();
            }
            if (body.contains("httpProxy"))
            {
                c.httpProxy = body["httpProxy"].get<std::string>();
            }
            if (body.contains("translateProvider"))
            {
                c.translateProvider = body["translateProvider"].get<std::string>();
            }
            if (body.contains("translateSource"))
            {
                c.translateSource = body["translateSource"].get<std::string>();
            }
            if (body.contains("translateTarget"))
            {
                c.translateTarget = body["translateTarget"].get<std::string>();
            }
            if (body.contains("translateMaxLength"))
            {
                c.translateMaxLength = body["translateMaxLength"].get<int>();
            }
            if (body.contains("translateAutoChunk"))
            {
                c.translateAutoChunk = body["translateAutoChunk"].get<bool>();
            }
            if (body.contains("ocrLang"))
            {
                c.ocrLang = body["ocrLang"].get<std::string>();
            }
            if (body.contains("ocrAutoTranslate"))
            {
                c.ocrAutoTranslate = body["ocrAutoTranslate"].get<bool>();
            }
            if (body.contains("ocrTranslateProvider"))
            {
                c.ocrTranslateProvider = body["ocrTranslateProvider"].get<std::string>();
            }
            if (body.contains("ocrTranslateSource"))
            {
                c.ocrTranslateSource = body["ocrTranslateSource"].get<std::string>();
            }
            if (body.contains("ocrTranslateTarget"))
            {
                c.ocrTranslateTarget = body["ocrTranslateTarget"].get<std::string>();
            }
            if (body.contains("ocrTranslateMaxLength"))
            {
                c.ocrTranslateMaxLength = body["ocrTranslateMaxLength"].get<int>();
            }
            if (body.contains("ocrTranslateAutoChunk"))
            {
                c.ocrTranslateAutoChunk = body["ocrTranslateAutoChunk"].get<bool>();
            }
            if (body.contains("textTranslateSource"))
            {
                c.textTranslateSource = body["textTranslateSource"].get<std::string>();
            }
            if (body.contains("textTranslateTarget"))
            {
                c.textTranslateTarget = body["textTranslateTarget"].get<std::string>();
            }
            if (body.contains("textTranslateProvider"))
            {
                c.textTranslateProvider = body["textTranslateProvider"].get<std::string>();
            }
            if (body.contains("textTranslatePrompt"))
            {
                c.textTranslatePrompt = body["textTranslatePrompt"].get<std::string>();
            }
            if (body.contains("textGlossary"))
            {
                c.textGlossary = body["textGlossary"].get<std::string>();
            }
            if (body.contains("textPreReplace"))
            {
                c.textPreReplace = body["textPreReplace"].get<std::string>();
            }
            if (body.contains("textPostReplace"))
            {
                c.textPostReplace = body["textPostReplace"].get<std::string>();
            }
            if (body.contains("textProjectsDir"))
            {
                c.textProjectsDir = body["textProjectsDir"].get<std::string>();
            }
            if (body.contains("translateEngineKeys"))
            {
                c.translateEngineKeys = body["translateEngineKeys"].get<std::string>();
            }
            config_.save();
            res.set_content(json{
                {"ok", true},
                {"textProjectsDirResolved", resolveTextProjectsRoot(config_).string()},
                {"dataDir", dataDirectory(config_).string()},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Get("/api/text-projects", withCors([this](const httplib::Request&, httplib::Response& res) {
        try
        {
            const fs::path root = resolveTextProjectsRoot(config_);
            fs::create_directories(root);
            json items = json::array();
            for (const auto& entry : fs::directory_iterator(root))
            {
                if (!entry.is_directory())
                {
                    continue;
                }
                const fs::path projectFile = entry.path() / kProjectFileName;
                if (!fs::exists(projectFile))
                {
                    continue;
                }
                std::string name = entry.path().filename().string();
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
                    {"folder", entry.path().filename().string()},
                    {"name", name},
                    {"path", projectFile.string()},
                    {"folderPath", entry.path().string()},
                    {"updatedAt", updatedAt},
                });
            }
            res.set_content(json{
                {"ok", true},
                {"root", root.string()},
                {"items", items},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 500;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Get("/api/text-projects/load", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const fs::path root = resolveTextProjectsRoot(config_);
            fs::path projectFile;
            if (req.has_param("folder"))
            {
                const std::string folder = sanitizeFolderName(req.get_param_value("folder"));
                projectFile = root / folder / kProjectFileName;
            }
            else if (req.has_param("path"))
            {
                projectFile = fs::path(req.get_param_value("path"));
            }
            else
            {
                res.status = 400;
                res.set_content(errorJson("缺少 folder 或 path 参数").dump(), "application/json");
                return;
            }

            if (!fs::exists(projectFile))
            {
                res.status = 404;
                res.set_content(errorJson("工程文件不存在").dump(), "application/json");
                return;
            }

            const auto raw = readFileUtf8(projectFile);
            const auto doc = json::parse(raw);
            res.set_content(json{
                {"ok", true},
                {"project", doc},
                {"folder", projectFile.parent_path().filename().string()},
                {"folderPath", projectFile.parent_path().string()},
                {"path", projectFile.string()},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/text-projects/save", withCors([this](const httplib::Request& req, httplib::Response& res) {
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

            const fs::path root = resolveTextProjectsRoot(config_);
            fs::create_directories(root);
            fs::path folderPath = root / folderName;

            // Avoid clobbering another project when creating fresh without folder hint
            if (!body.value("overwrite", true) && fs::exists(folderPath / kProjectFileName))
            {
                int suffix = 2;
                while (fs::exists(root / (folderName + "-" + std::to_string(suffix)) / kProjectFileName))
                {
                    ++suffix;
                }
                folderName = folderName + "-" + std::to_string(suffix);
                folderPath = root / folderName;
            }

            fs::create_directories(folderPath);
            project["folder"] = folderName;
            const fs::path projectFile = folderPath / kProjectFileName;
            writeFileUtf8(projectFile, project.dump(2) + "\n");

            if (body.contains("sourceFileName") && body.contains("sourceContent") &&
                body["sourceFileName"].is_string() && body["sourceContent"].is_string())
            {
                const std::string srcName = body["sourceFileName"].get<std::string>();
                const auto pos = srcName.find_last_of("\\/");
                const std::string base =
                    pos == std::string::npos ? srcName : srcName.substr(pos + 1);
                if (!base.empty() && base.find("..") == std::string::npos)
                {
                    writeFileUtf8(folderPath / base, body["sourceContent"].get<std::string>());
                }
            }

            res.set_content(json{
                {"ok", true},
                {"folder", folderName},
                {"folderPath", folderPath.string()},
                {"path", projectFile.string()},
                {"root", root.string()},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/text-projects/write-file", withCors([this](const httplib::Request& req, httplib::Response& res) {
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
            const fs::path root = resolveTextProjectsRoot(config_);
            const fs::path folderPath = root / folder;
            fs::create_directories(folderPath);
            const fs::path outPath = folderPath / fileName;
            writeFileUtf8(outPath, body["content"].get<std::string>());
            res.set_content(json{
                {"ok", true},
                {"path", outPath.string()},
                {"folderPath", folderPath.string()},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/export-file", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body);
            if (!body.contains("path") || !body.contains("content"))
            {
                res.status = 400;
                res.set_content(errorJson("缺少 path / content").dump(), "application/json");
                return;
            }
            const fs::path outPath(body["path"].get<std::string>());
            if (!outPath.is_absolute())
            {
                res.status = 400;
                res.set_content(errorJson("导出路径必须是绝对路径").dump(), "application/json");
                return;
            }
            if (outPath.has_parent_path())
            {
                fs::create_directories(outPath.parent_path());
            }
            writeFileUtf8(outPath, body["content"].get<std::string>());
            res.set_content(json{
                {"ok", true},
                {"path", outPath.string()},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Get("/api/conversations", withCors([this](const httplib::Request&, httplib::Response& res) {
        json arr = json::array();
        for (const auto& conv : conversations_.conversations())
        {
            if (conv.messages.empty())
            {
                continue;
            }
            arr.push_back(conversations_.toJson(conv, false));
        }
        json body{
            {"items", arr},
            {"currentId", conversations_.currentConversationId()},
        };
        res.set_content(body.dump(), "application/json");
    }));

    svr.Post("/api/conversations", withCors([this](const httplib::Request&, httplib::Response& res) {
        const auto conv = conversations_.createConversation();
        res.set_content(conversations_.toJson(conv, true).dump(), "application/json");
    }));

    svr.Get(R"(/api/conversations/([^/]+))", withCors([this](const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.matches[1];
        const auto conv = conversations_.conversation(id);
        if (conv.id.empty())
        {
            res.status = 404;
            res.set_content(errorJson("Conversation not found").dump(), "application/json");
            return;
        }
        conversations_.switchToConversation(id);
        res.set_content(conversations_.toJson(conv, true).dump(), "application/json");
    }));

    svr.Delete(R"(/api/conversations/([^/]+))", withCors([this](const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.matches[1];
        if (!conversations_.deleteConversation(id))
        {
            res.status = 400;
            res.set_content(errorJson("Cannot delete conversation").dump(), "application/json");
            return;
        }
        const auto current = conversations_.conversation(conversations_.currentConversationId());
        res.set_content(json{
            {"ok", true},
            {"current", conversations_.toJson(current, true)},
        }.dump(), "application/json");
    }));

    svr.Put(R"(/api/conversations/([^/]+))", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const std::string id = req.matches[1];
            const json body = json::parse(req.body);
            const std::string title = body.value("title", "");
            if (title.empty())
            {
                res.status = 400;
                res.set_content(errorJson("title required").dump(), "application/json");
                return;
            }
            if (!conversations_.setTitle(id, title))
            {
                res.status = 404;
                res.set_content(errorJson("Conversation not found").dump(), "application/json");
                return;
            }
            const auto conv = conversations_.conversation(id);
            res.set_content(conversations_.toJson(conv, true).dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post(R"(/api/conversations/([^/]+)/messages)", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const std::string id = req.matches[1];
            const json body = json::parse(req.body);
            const std::string role = body.value("role", "user");
            const std::string content = body.value("content", "");
            if (content.empty())
            {
                res.status = 400;
                res.set_content(errorJson("content required").dump(), "application/json");
                return;
            }
            if (!conversations_.addMessage(id, role, content))
            {
                res.status = 404;
                res.set_content(errorJson("Conversation not found").dump(), "application/json");
                return;
            }
            const auto conv = conversations_.conversation(id);
            res.set_content(conversations_.toJson(conv, true).dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/chat", withCors([this](const httplib::Request& req, httplib::Response& res) {
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
            const auto& cfg = config_.get();

            LlmRequest llmReq;
            llmReq.apiUrl = cfg.apiUrl;
            llmReq.apiKey = cfg.apiKey;
            llmReq.model = cfg.model;
            llmReq.messages = conv.messages;

            const LlmResponse llmRes = LlmClient::chat(llmReq);
            if (!llmRes.ok)
            {
                res.status = 502;
                res.set_content(errorJson(llmRes.error).dump(), "application/json");
                return;
            }

            conversations_.addMessage(conversationId, "assistant", llmRes.content);
            conv = conversations_.conversation(conversationId);

            res.set_content(json{
                {"ok", true},
                {"reply", llmRes.content},
                {"conversation", conversations_.toJson(conv, true)},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/translate", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body);
            const std::string text = body.value("text", "");
            if (text.empty())
            {
                res.status = 400;
                res.set_content(errorJson("text required").dump(), "application/json");
                return;
            }

            const auto& cfg = config_.get();
            const std::string source = body.value("source", cfg.translateSource);
            const std::string target = body.value("target", cfg.translateTarget);
            const std::string provider = body.value("provider", cfg.translateProvider);
            const int maxLength = body.value("maxLength", cfg.translateMaxLength);
            const bool autoChunk = body.value("autoChunk", cfg.translateAutoChunk);

            TranslateResult tr;
            if (provider == "llm")
            {
                const std::string apiUrl = body.value("apiUrl", cfg.apiUrl);
                const std::string apiKey = body.value("apiKey", cfg.apiKey);
                const std::string model = body.value("model", cfg.model);
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
                tr = TranslateClient::translateWithLlm(
                    text, apiUrl, apiKey, model, source, target,
                    cfg.proxyMode, cfg.httpProxy, prompt, glossary);
            }
            else
            {
                tr = TranslateClient::translateFree(
                    text, source, target, provider, maxLength, autoChunk,
                    cfg.proxyMode, cfg.httpProxy, cfg.translateEngineKeys);
            }

            if (!tr.ok)
            {
                res.status = tr.code == "LENGTH_LIMIT" ? 400 : 502;
                res.set_content(json{
                    {"ok", false},
                    {"error", tr.error},
                    {"code", tr.code.empty() ? "ERROR" : tr.code},
                    {"provider", tr.provider},
                }.dump(), "application/json");
                return;
            }

            res.set_content(json{
                {"ok", true},
                {"source", text},
                {"translation", tr.translation},
                {"provider", tr.provider},
                {"promptTokens", tr.promptTokens},
                {"completionTokens", tr.completionTokens},
                {"totalTokens", tr.totalTokens},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    const int port = config_.get().port;
    std::cout << "LLMChat backend listening on http://127.0.0.1:" << port << std::endl;
    if (!svr.listen("127.0.0.1", port))
    {
        std::cerr << "Failed to bind 127.0.0.1:" << port << std::endl;
        return 1;
    }
    return 0;
}
