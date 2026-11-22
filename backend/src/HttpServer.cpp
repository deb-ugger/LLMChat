#include "HttpServer.h"
#include "http/SystemRoutes.h"
#include "http/FileRoutes.h"
#include "http/OcrRoutes.h"
#include "http/HttpRouter.h"
#include "http/UnityRoutes.h"
#include "http/TextRoutes.h"
#include "http/ScopedUsageLog.h"
#include "AtomicFile.h"
#include "LlmClient.h"
#include "SpeechOnline.h"
#include "TranslateClient.h"
#include "RuntimeLlmBatcher.h"
#include "UnityAutoTranslator.h"
#include "UnityInstallJobs.h"
#include "PricingStore.h"
#include "UsageStore.h"
#include "Utf8Path.h"
#include "RequestCancellation.h"
#include "StoragePaths.h"
#include "TextTaskQueue.h"
#include "TextRunStore.h"
#include "JsonEmbedding.h"
#include "http/JsonEmbeddingRoutes.h"
#include "http/ImageRoutes.h"
#include "RpgImageProject.h"
#include "http/LlmRoutes.h"
#include "http/ConversationRoutes.h"

#include <httplib.h>
#include <algorithm>
#include <mutex>
#include <atomic>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <optional>
#include <set>
#include <sstream>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <objbase.h>
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#endif

using json = nlohmann::json;
using http_router::errorJson;
namespace fs = std::filesystem;

namespace {

using http_router::ScopedUsageLog;

using http_router::dataDirectory;

} // namespace

HttpServer::HttpServer(ConfigStore& config, ConversationManager& conversations)
    : config_(config)
    , conversations_(conversations)
    , usage_((dataDirectory(config) / "usage-events.jsonl").string())
    , pricing_((dataDirectory(config) / "pricing.json").string())
    , ocrModels_(storage::get("ocr"))
{
}

int HttpServer::run()
{
    request_cancel::Registry translationTasks;
    TextRunStore textRuns;
    JsonEmbedding jsonEmbedding(storage::base / "resources" / "wolf");
    RpgImageProject gameImages(storage::base / "resources" / "wolf");
    std::atomic<unsigned long long> nextTask{0};
    httplib::Server svr;
    svr.new_task_queue = [] { return new httplib::ThreadPool(16, 64); };

    svr.Options(R"(.*)", http_router::corsPreflight);
    using http_router::withCors;

    http_router::registerSystemRoutes(svr, usage_, pricing_);

    http_router::registerOcrModelRoutes(svr, ocrModels_, config_);

    http_router::registerRuntimeAssetRoute(svr);

    http_router::registerOcrModelFileRoute(svr, ocrModels_);

    http_router::registerSettingsRoutes(svr, config_);

    http_router::registerTextProjectRoutes(svr);

    http_router::registerFileOpenRoutes(svr);

    http_router::registerTextProjectFileRoute(svr);

    http_router::registerExportFileRoute(svr);

    http_router::registerConversationRoutes(svr, conversations_, config_);

    http_router::registerChatAndDictionaryRoutes(svr, config_, conversations_, usage_, TranslateClient::lookupDictionaryJson);

    const auto vendorModelsPath = [this]() -> fs::path {
        return dataDirectory(config_) / "vendor-models.json";
    };

    const auto loadVendorModelsFile = [&]() -> json {
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

    const auto saveVendorModelsFile = [&](const json& root) -> bool {
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

    http_router::registerLlmCatalogRoutes(svr, loadVendorModelsFile);

    svr.Put(
        R"(/api/llm/vendor-models/([^/]+))",
        withCors([=](const httplib::Request& req, httplib::Response& res) {
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
        withCors([=](const httplib::Request& req, httplib::Response& res) {
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

    http_router::registerTranslateCancelRoute(svr, translationTasks);

    http_router::registerOllamaTestRoute(svr, translationTasks, [this](UsageEvent event, const std::function<void(UsageEvent&)>& run) {
        ScopedUsageLog usageLog(usage_, std::move(event));
        run(usageLog.ev());
    });

    svr.Post("/api/speech/process", withCors([this, &translationTasks](const httplib::Request& req, httplib::Response& res) {
        try {
            const auto body = json::parse(req.body);
            const auto id = body.at("taskId").get<std::string>();
            if (id.empty() || id.size() > 96) throw std::runtime_error("invalid taskId");
            const auto request = speech_online::buildRequest(body, config_.snapshot());
            const auto task = translationTasks.begin(id);
            if (!task) { res.status = 429; res.set_content(errorJson("在线任务较多，请稍后重试").dump(), "application/json"); return; }
            request_cancel::Scope cancellation(translationTasks, id, task);
            if (task->stopped()) { res.status = 499; res.set_content(errorJson("任务已取消").dump(), "application/json"); return; }
            auto event = UsageStore::makeEventSkeleton();
            event.feature = body.value("operation", "") == "recognize" ? "speech_recognition" : "speech_proofread";
            event.endpoint = "speech/process"; event.channel = "llm"; event.model = request.model;
            event.apiHost = UsageStore::hostFromApiUrl(request.apiUrl);
            event.vendor = UsageStore::vendorFromHostOrModel(event.apiHost, request.model, "");
            ScopedUsageLog usageLog(usage_, event);
            const auto response = LlmClient::chat(request);
            auto& ev = usageLog.ev();
            ev.ok = response.ok && !task->stopped();
            ev.promptTokens = response.promptTokens; ev.completionTokens = response.completionTokens;
            ev.totalTokens = response.totalTokens; ev.cacheReadTokens = response.cacheReadTokens; ev.cacheWriteTokens = response.cacheWriteTokens;
            if (response.externalCall && response.totalTokens <= 0) {
                ev.promptTokens = ev.completionTokens = ev.totalTokens = kUsageTokensUnknown;
                ev.cacheReadTokens = ev.cacheWriteTokens = kUsageTokensUnknown;
            }
            ev.errorCode = ev.ok ? "" : task->stopped() ? "CANCELLED" : "ERROR";
            ev.errorMessage = ev.ok ? "" : task->stopped() ? "在线任务已取消或超过时限" : response.error;
            if (!ev.ok) { res.status = task->stopped() ? 499 : 502; res.set_content(errorJson(ev.errorMessage).dump(), "application/json"); return; }
            res.set_content(json{{"ok", true}, {"content", response.content}, {"completionTokens", response.completionTokens}, {"generationTokensPerSecond", response.generationTokensPerSecond}}.dump(), "application/json");
        } catch (const std::exception& error) { res.status = 400; res.set_content(errorJson(error.what()).dump(), "application/json"); }
    }));

    http_router::registerGameModelRoute(svr, config_, usage_, translationTasks, LlmClient::chat);

    const auto translateHandler = http_router::registerTranslationRoute(svr, config_, usage_, translationTasks, nextTask);
    // Queue workers retain a reference to translateHandler and join before it is destroyed.
    TextTaskQueue textQueue([&translationTasks](const std::string& id) { translationTasks.cancel(id); });
    http_router::registerTextRequestRoutes(svr, textQueue, translateHandler, translationTasks);
    http_router::registerTextRunRoutes(svr, textRuns);

    http_router::registerGameTextProjectRoutes(svr);
    http_router::registerJsonEmbeddingStartRoute(svr, jsonEmbedding);
    http_router::registerGameImageProjectRoutes(svr, gameImages);
    http_router::registerJsonEmbeddingPatchDetectionRoute(svr, jsonEmbedding);

    http_router::registerGameMosaicRoutes(svr);

    http_router::registerJsonEmbeddingRoutes(svr, jsonEmbedding);

    RuntimeLlmBatcher runtimeLlm;
    http_router::registerUnityRuntimeRoutes(svr, config_, usage_, runtimeLlm);

    UnityInstallJobs unityInstalls;
    http_router::registerUnityConfigRoutes(svr, unityInstalls);

    http_router::registerUnityRoutes(svr, {UnityAutoTranslator::detect, UnityAutoTranslator::detectStream});

    http_router::registerOutputLogRoutes(svr, config_);

    http_router::registerUnityInstallRoutes(svr, unityInstalls, {UnityAutoTranslator::install, UnityAutoTranslator::installLoader});

    const int port = config_.snapshot().port;
    std::cout << "LLMChat backend listening on http://127.0.0.1:" << port << std::endl;
    if (!svr.listen("127.0.0.1", port))
    {
        std::cerr << "Failed to bind 127.0.0.1:" << port << std::endl;
        return 1;
    }
    return 0;
}
