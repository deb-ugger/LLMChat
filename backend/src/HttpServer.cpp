#include "HttpServer.h"
#include "http/SystemRoutes.h"
#include "http/SystemPerformanceRoutes.h"
#include "http/FileRoutes.h"
#include "http/OcrRoutes.h"
#include "http/HttpRouter.h"
#include "http/UnityRoutes.h"
#include "http/TextRoutes.h"
#include "http/ScopedUsageLog.h"
#include "LlmClient.h"
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
#include <iostream>
#include <nlohmann/json.hpp>
#include <optional>
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
    http_router::registerSystemPerformanceRoutes(svr, dataDirectory(config_) / "logs", usage_);

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

    http_router::registerLlmCatalogRoutes(svr, config_, usage_);

    http_router::registerTranslateCancelRoute(svr, translationTasks);

    http_router::registerOllamaTestRoute(svr, translationTasks, [this](UsageEvent event, const std::function<void(UsageEvent&)>& run) {
        ScopedUsageLog usageLog(usage_, std::move(event));
        run(usageLog.ev());
    });

    http_router::registerSpeechRoutes(svr, config_, usage_, translationTasks);

    http_router::registerGameModelRoute(svr, config_, usage_, translationTasks, LlmClient::chat);

    const auto translateHandler = http_router::registerTranslationRoute(svr, config_, usage_, translationTasks, nextTask);
    // Queue workers retain a reference to translateHandler and join before it is destroyed.
    TextTaskQueue textQueue([&translationTasks](const std::string& id) { translationTasks.cancel(id); });
    http_router::registerTextRequestRoutes(svr, textQueue, translateHandler, translationTasks);
    http_router::registerTextRunRoutes(svr, textRuns);

    http_router::registerGameTextProjectRoutes(svr);
    http_router::registerJsonEmbeddingStartRoute(svr, jsonEmbedding);
    http_router::registerGameImageProjectRoutes(svr, gameImages);
    http_router::registerExportRoutes(svr, gameImages);
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
