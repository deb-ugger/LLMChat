#include "LlmRoutes.h"
#include "HttpRouter.h"
#include "ScopedUsageLog.h"
#include "SystemRoutes.h"
#include "AtomicFile.h"
#include "Config.h"
#include "LlmClient.h"
#include "OllamaDirectories.h"
#include "RequestCancellation.h"
#include "UsageStore.h"
#include "Utf8Path.h"

#include <algorithm>
#include <chrono>
#include <exception>
#include <filesystem>
#include <fstream>
#include <set>
#include <stdexcept>

namespace http_router
{
using json = nlohmann::json;
namespace fs = std::filesystem;

void registerLlmCatalogRoutes(httplib::Server& svr, const ConfigStore& config_, UsageStore& usage_)
{
    const auto vendorModelsPath = [&config_]() -> fs::path {
        return dataDirectory(config_) / "vendor-models.json";
    };

    const auto loadVendorModelsFile = [vendorModelsPath]() -> json {
        const fs::path path = vendorModelsPath();
        if (!fs::exists(path))
            return json::object();
        std::ifstream in(path, std::ios::binary);
        if (!in)
            return json::object();
        try
        {
            json root;
            in >> root;
            if (!root.is_object())
                return json::object();
            return root;
        }
        catch (...)
        {
            return json::object();
        }
    };

    const auto saveVendorModelsFile = [vendorModelsPath](const json& root) -> bool {
        return atomicfile::writeText(vendorModelsPath(), root.dump(2));
    };

    const auto decodeVendorSegment = [](std::string s) -> std::string {
        // cpp-httplib usually already decodes; still handle leftover %XX
        std::string out;
        out.reserve(s.size());
        for (size_t i = 0; i < s.size(); ++i)
        {
            if (s[i] == '%' && i + 2 < s.size())
            {
                auto hex = [](char c) -> int {
                    if (c >= '0' && c <= '9') return c - '0';
                    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
                    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
                    return -1;
                };
                const int hi = hex(s[i + 1]);
                const int lo = hex(s[i + 2]);
                if (hi >= 0 && lo >= 0)
                {
                    out.push_back(static_cast<char>((hi << 4) | lo));
                    i += 2;
                    continue;
                }
            }
            else if (s[i] == '+')
            {
                out.push_back(' ');
                continue;
            }
            out.push_back(s[i]);
        }
        return out;
    };

    const auto normalizeModelsArray = [](const json& modelsIn) -> json {
        json arr = json::array();
        if (!modelsIn.is_array())
            return arr;
        for (const auto& item : modelsIn)
        {
            if (item.is_string())
            {
                const std::string id = item.get<std::string>();
                if (id.empty())
                    continue;
                arr.push_back({
                    {"model", id},
                    {"label", id},
                    {"source", "manual"},
                });
                continue;
            }
            if (!item.is_object())
                continue;
            std::string id = item.value("model", "");
            if (id.empty())
                id = item.value("id", "");
            if (id.empty())
                continue;
            std::string label = item.value("label", "");
            if (label.empty())
                label = id;
            std::string source = item.value("source", "");
            if (source != "api" && source != "manual")
                source = "manual";
            arr.push_back({
                {"model", id},
                {"label", label},
                {"source", source},
            });
        }
        return arr;
    };

    svr.Get("/api/llm/ollama/directories", withCors([](const httplib::Request& req, httplib::Response& res) {
        const auto directory = req.get_param_value("directory");
        json result = {{"directories", json::array()}};
        if (directory.empty()) {
            for (const auto& path : ollamadirectories::discover()) result["directories"].push_back(utf8path::pathUtf8(path));
        } else {
            const auto path = ollamadirectories::resolve(utf8path::pathFromUtf8(directory));
            result["valid"] = path.has_value();
            if (path) result["directories"].push_back(utf8path::pathUtf8(*path));
            else result["error"] = "目录无效或不可访问：未找到 Ollama 的 manifests 或 blobs 模型目录。";
        }
        res.set_content(result.dump(), "application/json");
    }));

    svr.Get("/api/llm/ollama/models", withCors([](const httplib::Request& req, httplib::Response& res) {
        try {
            const auto directory = req.get_param_value("directory");
            if (!directory.empty()) {
                const auto root = ollamadirectories::resolve(utf8path::pathFromUtf8(directory));
                if (!root) throw std::runtime_error("所选目录无效，请选择包含 Ollama 模型的目录");
                const auto manifests = *root / "manifests";
                json models = json::array();
                if (!fs::is_directory(manifests)) { res.set_content(models.dump(), "application/json"); return; }
                for (const auto& file : fs::recursive_directory_iterator(manifests)) {
                    if (!file.is_regular_file()) continue;
                    std::ifstream input(file.path());
                    const auto manifest = json::parse(input);
                    if (!manifest.contains("layers")) continue;
                    const auto relative = fs::relative(file.path(), manifests);
                    auto parts = relative.begin();
                    if (parts == relative.end()) continue;
                    const auto registry = utf8path::pathUtf8(*parts);
                    ++parts; // Registry host is not part of an Ollama model ID.
                    fs::path model;
                    for (; parts != relative.end(); ++parts) model /= *parts;
                    const auto tag = utf8path::pathUtf8(model.filename());
                    auto name = utf8path::pathUtf8(model.parent_path());
                    std::replace(name.begin(), name.end(), '\\', '/');
                    if (name.starts_with("library/")) name.erase(0, 8);
                    if (registry != "registry.ollama.ai") name = registry + "/" + name;
                    if (!name.empty() && !tag.ends_with("cloud")) models.push_back(name + ":" + tag);
                }
                res.set_content(models.dump(), "application/json");
                return;
            }
            const auto apiUrl = req.get_param_value("apiUrl");
            if (!apiUrl.empty()) {
                LlmListModelsRequest request;
                request.apiUrl = apiUrl;
                request.proxyMode = "direct";
                const auto response = LlmClient::listModels(request);
                if (!response.ok) throw std::runtime_error(response.error);
                json models = json::array();
                for (const auto& name : response.modelIds)
                    if (!name.ends_with(":cloud") && !name.ends_with("-cloud")) models.push_back(name);
                res.set_content(models.dump(), "application/json");
                return;
            }
            httplib::Client ollama("127.0.0.1", 11434);
            ollama.set_connection_timeout(2, 0);
            ollama.set_read_timeout(5, 0);
            const auto response = ollama.Get("/api/tags");
            if (!response || response->status != 200)
                throw std::runtime_error("无法读取本机 Ollama 模型，请确认 Ollama 已启动（端口 11434）");
            const auto payload = json::parse(response->body);
            json models = json::array();
            for (const auto& entry : payload.at("models")) {
                const auto name = entry.value("name", "");
                if (name.empty() || name.ends_with(":cloud") || name.ends_with("-cloud") ||
                    !entry.value("remote_host", "").empty() || !entry.value("remote_model", "").empty()) continue;
                models.push_back(name);
            }
            res.set_content(models.dump(), "application/json");
        } catch (const std::exception& error) {
            res.status = 502;
            res.set_content(errorJson(error.what()).dump(), "application/json");
        }
    }));

    svr.Get("/api/llm/vendor-models", withCors([loadVendorModelsFile](const httplib::Request&, httplib::Response& res) {
        try
        {
            const json root = loadVendorModelsFile();
            res.set_content(
                json{{"ok", true}, {"vendors", root}}.dump(),
                "application/json; charset=utf-8");
        }
        catch (const std::exception& ex)
        {
            res.status = 500;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Put(
        R"(/api/llm/vendor-models/([^/]+))",
        withCors([decodeVendorSegment, normalizeModelsArray, loadVendorModelsFile, saveVendorModelsFile](const httplib::Request& req, httplib::Response& res) {
            try
            {
                const std::string vendor = decodeVendorSegment(req.matches[1].str());
                if (vendor.empty())
                {
                    res.status = 400;
                    res.set_content(errorJson("vendor required").dump(), "application/json");
                    return;
                }
                const json body = json::parse(req.body.empty() ? "{}" : req.body);
                const json models = normalizeModelsArray(
                    body.contains("models") ? body["models"] : json::array());
                json root = loadVendorModelsFile();
                root[vendor] = models;
                if (!saveVendorModelsFile(root))
                {
                    res.status = 500;
                    res.set_content(
                        errorJson("failed to write vendor-models.json").dump(),
                        "application/json");
                    return;
                }
                res.set_content(
                    json{
                        {"ok", true},
                        {"vendor", vendor},
                        {"models", models},
                        {"count", models.size()},
                    }
                        .dump(),
                    "application/json; charset=utf-8");
            }
            catch (const std::exception& ex)
            {
                res.status = 400;
                res.set_content(errorJson(ex.what()).dump(), "application/json");
            }
        }));

    svr.Post(
        R"(/api/llm/vendor-models/([^/]+)/refresh)",
        withCors([&config_, &usage_, decodeVendorSegment, loadVendorModelsFile, saveVendorModelsFile](const httplib::Request& req, httplib::Response& res) {
            try
            {
                const std::string vendor = decodeVendorSegment(req.matches[1].str());
                if (vendor.empty())
                {
                    res.status = 400;
                    res.set_content(errorJson("vendor required").dump(), "application/json");
                    return;
                }
                const json body = json::parse(req.body.empty() ? "{}" : req.body);
                const AppConfig cfg = config_.snapshot();
                LlmListModelsRequest lm;
                lm.apiUrl = body.value("apiUrl", cfg.apiUrl);
                lm.apiKey = body.value("apiKey", cfg.apiKey);
                lm.proxyMode = body.value("proxyMode", cfg.proxyMode);
                lm.httpProxy = body.value("httpProxy", cfg.httpProxy);
                if (lm.apiUrl.empty())
                {
                    res.status = 400;
                    res.set_content(
                        errorJson("请先填写 API URL").dump(),
                        "application/json");
                    return;
                }
                if (lm.apiKey.empty())
                {
                    res.status = 400;
                    res.set_content(
                        errorJson("请先填写 API Key").dump(),
                        "application/json");
                    return;
                }

                UsageEvent usageEv = UsageStore::makeEventSkeleton();
                usageEv.feature = "vendor_models";
                usageEv.channel = "llm";
                usageEv.apiHost = UsageStore::hostFromApiUrl(lm.apiUrl);
                usageEv.vendor = UsageStore::vendorFromHostOrModel(
                    usageEv.apiHost, "", vendor);
                usageEv.endpoint = "list_models";

                ScopedUsageLog usageLog(usage_, usageEv);
                const LlmListModelsResponse listed = LlmClient::listModels(lm);
                usageLog.ev().ok = listed.ok;
                usageLog.ev().errorCode = listed.ok ? "" : "LIST_MODELS_ERROR";
                usageLog.ev().errorMessage = listed.ok ? "" : listed.error;
                if (!listed.ok)
                {
                    res.status = listed.statusCode >= 400 ? listed.statusCode : 502;
                    res.set_content(
                        json{
                            {"ok", false},
                            {"error", listed.error},
                            {"hint", "官方拉取失败时可在设置里手动添加模型"},
                        }
                            .dump(),
                        "application/json; charset=utf-8");
                    return;
                }

                json apiModels = json::array();
                for (const auto& id : listed.modelIds)
                {
                    apiModels.push_back({
                        {"model", id},
                        {"label", id},
                        {"source", "api"},
                    });
                }

                json root = loadVendorModelsFile();
                json merged = json::array();
                std::set<std::string> seen;
                for (const auto& item : apiModels)
                {
                    const std::string id = item.value("model", "");
                    if (id.empty() || seen.count(id))
                        continue;
                    seen.insert(id);
                    merged.push_back(item);
                }
                // Keep previously manual-added models that are not in the API list
                if (root.contains(vendor) && root[vendor].is_array())
                {
                    for (const auto& item : root[vendor])
                    {
                        if (!item.is_object())
                            continue;
                        const std::string id = item.value("model", "");
                        if (id.empty() || seen.count(id))
                            continue;
                        const std::string source = item.value("source", "");
                        if (source != "manual")
                            continue;
                        seen.insert(id);
                        json keep = item;
                        keep["source"] = "manual";
                        if (!keep.contains("label") || keep["label"].get<std::string>().empty())
                            keep["label"] = id;
                        merged.push_back(keep);
                    }
                }
                root[vendor] = merged;
                if (!saveVendorModelsFile(root))
                {
                    res.status = 500;
                    res.set_content(
                        errorJson("failed to write vendor-models.json").dump(),
                        "application/json");
                    return;
                }

                res.set_content(
                    json{
                        {"ok", true},
                        {"vendor", vendor},
                        {"models", merged},
                        {"count", merged.size()},
                        {"modelsUrl", LlmClient::modelsUrlFromChatUrl(lm.apiUrl)},
                    }
                        .dump(),
                    "application/json; charset=utf-8");
            }
            catch (const std::exception& ex)
            {
                res.status = 400;
                res.set_content(errorJson(ex.what()).dump(), "application/json");
            }
        }));
}

void registerOllamaTestRoute(httplib::Server& svr, request_cancel::Registry& translationTasks, WithOllamaUsageLog withUsageLog)
{
    svr.Post("/api/llm/ollama/test", withCors([&translationTasks, withUsageLog](const httplib::Request& req, httplib::Response& res) {
        try {
            const auto body = json::parse(req.body);
            const auto id = body.at("taskId").get<std::string>();
            const auto url = body.at("apiUrl").get<std::string>(), model = body.at("model").get<std::string>();
            if (id.empty() || id.size() > 96 || url.empty() || model.empty()) throw std::runtime_error("Ollama 测试参数无效");
            const auto task = translationTasks.begin(id);
            if (!task) { res.status = 429; res.set_content(errorJson("已有测试正在处理，请稍后重试").dump(), "application/json"); return; }
            task->deadline = request_cancel::Clock::now() + std::chrono::seconds(300);
            request_cancel::Scope cancellation(translationTasks, id, task);
            auto event = UsageStore::makeEventSkeleton();
            event.feature = "settings_test"; event.endpoint = "ollama/test"; event.channel = "llm"; event.model = model;
            event.apiHost = UsageStore::hostFromApiUrl(url); event.vendor = "Ollama";
            withUsageLog(event, [&](UsageEvent& ev) {
                const auto response = LlmClient::testOllama(url, model);
                ev.ok = response.ok && !task->stopped();
                ev.promptTokens = response.promptTokens; ev.completionTokens = response.completionTokens; ev.totalTokens = response.totalTokens;
                ev.errorCode = ev.ok ? "" : task->stopped() ? "CANCELLED" : "ERROR";
                ev.errorMessage = ev.ok ? "" : task->stopped() ? "模型加载或测试超过 5 分钟，或任务已取消" : response.error;
                if (!ev.ok) { res.status = task->stopped() ? 499 : 502; res.set_content(errorJson(ev.errorMessage).dump(), "application/json"); return; }
                res.set_content(json{{"ok",true},{"content",response.content}}.dump(), "application/json");
            });
        } catch (const std::exception& error) { res.status = 400; res.set_content(errorJson(error.what()).dump(), "application/json"); }
    }));
}
}
