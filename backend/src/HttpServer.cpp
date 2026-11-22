#include "HttpServer.h"
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
#include "RuntimeAssets.h"
#include "TextTaskQueue.h"
#include "TextRunStore.h"
#include "JsonEmbedding.h"
#include "GameMosaicPatch.h"
#include "GameTextProject.h"
#include "RpgImageProject.h"
#include "http/LlmRoutes.h"

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

std::mutex& configUpdateMutex();

namespace {

#ifdef _WIN32
bool selectFileInExplorer(const fs::path& path)
{
    const std::wstring fullPath = fs::absolute(path).make_preferred().wstring();
    const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(initialized) && initialized != RPC_E_CHANGED_MODE) return false;

    PIDLIST_ABSOLUTE file = nullptr;
    HRESULT result = SHParseDisplayName(fullPath.c_str(), nullptr, &file, 0, nullptr);
    if (SUCCEEDED(result)) result = SHOpenFolderAndSelectItems(file, 0, nullptr, 0);
    CoTaskMemFree(file);
    if (SUCCEEDED(initialized)) CoUninitialize();
    return SUCCEEDED(result);
}
#endif

using http_router::appendServiceTiming;
using http_router::ScopedUsageLog;

fs::path dataDirectory(const ConfigStore& config)
{
    return fs::path(config.path()).parent_path();
}

using http_router::readFileUtf8;
using http_router::writeFileUtf8;

void appendFileUtf8(const fs::path& path, const std::string& content)
{
    std::ofstream out(path, std::ios::binary | std::ios::app);
    if (!out)
    {
        throw std::runtime_error("无法写入日志文件");
    }
    out << content;
    out.close();
    if (!out) throw std::runtime_error("输出日志写入失败");
}

json readOutputIssues(const fs::path& folder) {
    const auto file = folder / "app-output-issues.json";
    if (!fs::exists(file)) return json::object();
    std::ifstream input(file, std::ios::binary);
    return json::parse(input);
}

void updateOutputIssues(const fs::path& folder, const std::string& records) {
    std::istringstream input(records);
    json issues;
    bool changed = false;
    for (std::string line; std::getline(input, line);) {
        if (line.empty()) continue;
        const auto row = json::parse(line);
        const auto key = row.value("issue", "");
        const auto resolved = row.value("resolves", "");
        if (key.empty() && resolved.empty()) continue;
        if (issues.is_null()) issues = readOutputIssues(folder);
        if (!key.empty()) {
            issues[key] = row;
            changed = true;
        }
        const auto previous = issues.find(resolved);
        if (previous != issues.end() && (!row.contains("resolvesId") || row.at("resolvesId") == previous->at("id"))) {
            issues.erase(previous);
            changed = true;
        }
    }
    std::string error;
    if (changed && !atomicfile::writeText(folder / "app-output-issues.json", issues.dump(), &error))
        throw std::runtime_error(error);
}

/** Return last `maxLines` of a text file (UTF-8), best-effort for large logs. */
std::string readFileTailLines(const fs::path& path, int maxLines)
{
    if (maxLines < 1)
        maxLines = 1;
    std::ifstream in(path, std::ios::binary);
    if (!in)
        return {};
    in.seekg(0, std::ios::end);
    const auto endPos = in.tellg();
    if (endPos <= 0)
        return {};

    const std::streamoff cap = 512 * 1024; // read at most last 512KB
    const std::streamoff start =
        endPos > cap ? static_cast<std::streamoff>(endPos) - cap : 0;
    in.seekg(start);
    std::string buf(
        (std::istreambuf_iterator<char>(in)),
        std::istreambuf_iterator<char>());
    if (start > 0)
    {
        const auto nl = buf.find('\n');
        if (nl == std::string::npos)
            return {};
        buf.erase(0, nl + 1);
    }

    std::vector<std::string> lines;
    std::string cur;
    for (char c : buf)
    {
        if (c == '\n')
        {
            if (!cur.empty() && cur.back() == '\r')
                cur.pop_back();
            lines.push_back(std::move(cur));
            cur.clear();
        }
        else
        {
            cur.push_back(c);
        }
    }
    if (!cur.empty())
    {
        if (cur.back() == '\r')
            cur.pop_back();
        lines.push_back(std::move(cur));
    }

    if (static_cast<int>(lines.size()) > maxLines)
        lines.erase(lines.begin(), lines.end() - maxLines);

    std::ostringstream oss;
    for (size_t i = 0; i < lines.size(); ++i)
    {
        if (i)
            oss << '\n';
        oss << lines[i];
    }
    return oss.str();
}

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

    svr.Get("/api/storage", withCors([](const httplib::Request& req, httplib::Response& res) {
        try { res.set_content(storage::status(req.get_param_value("sizes") != "0").dump(), "application/json"); }
        catch (const std::exception& e) {
            res.status = 500;
            res.set_content(errorJson("无法读取存储信息：" + std::string(e.what())).dump(-1, ' ', false, json::error_handler_t::replace), "application/json");
        }
    }));
    svr.Put("/api/storage/paths", withCors([](const httplib::Request& req, httplib::Response& res) {
        try {
            storage::schedulePaths(json::parse(req.body).at("paths"));
            res.set_content(storage::status(req.get_param_value("sizes") != "0").dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 400;
            res.set_content(errorJson(e.what()).dump(-1, ' ', false, json::error_handler_t::replace), "application/json");
        }
    }));
    svr.Put("/api/storage/cleanup", withCors([](const httplib::Request& req, httplib::Response& res) {
        try {
            storage::scheduleCleanup(json::parse(req.body).at("ids"));
            res.set_content(storage::status().dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 400;
            res.set_content(errorJson(e.what()).dump(-1, ' ', false, json::error_handler_t::replace), "application/json");
        }
    }));

    const auto requestCurrency = [this](const httplib::Request& req) {
        auto currency = req.get_param_value("currency");
        return currency.empty() ? pricing_.displayCurrency() : currency;
    };
    const auto eventBand = [this](const json& row) -> std::string {
        if (row.value("channel", "") == "llm") {
            auto band = pricing_.bandFor(row.value("model", ""), row.value("date", ""), row.value("time", ""));
            if (!band.empty()) return band;
        }
        return "flat";
    };
    const auto pricedEvents = [this, eventBand](const httplib::Request& req, const std::string& currency) {
        auto rows = usage_.events(req.get_param_value("from"), req.get_param_value("to"),
                                  req.get_param_value("feature"), req.get_param_value("ok"));
        for (auto& row : rows) {
            row["cost"] = pricing_.costFor(row, currency);
            row["pricingBand"] = eventBand(row);
        }
        const auto band = req.get_param_value("band");
        if (!band.empty())
            std::erase_if(rows, [&](const json& row) { return row.at("pricingBand") != band; });
        return rows;
    };

    svr.Get("/api/usage/events", withCors([requestCurrency, pricedEvents](const httplib::Request& req, httplib::Response& res) {
        const auto currency = requestCurrency(req);
        res.set_content(json{{"ok", true}, {"currency", currency}, {"items", pricedEvents(req, currency)}}.dump(),
                        "application/json");
    }));

    svr.Get("/api/usage/summary", withCors([requestCurrency, pricedEvents](const httplib::Request& req, httplib::Response& res) {
        const auto currency = requestCurrency(req);
        const auto groupBy = req.has_param("groupBy") ? req.get_param_value("groupBy") : "feature";
        json body = UsageStore::summaryFromEvents(pricedEvents(req, currency), groupBy);
        body["currency"] = currency;
        res.set_content(body.dump(), "application/json");
    }));

    svr.Get("/api/usage/report", withCors([this, requestCurrency, eventBand](const httplib::Request& req, httplib::Response& res) {
        const std::string from = req.get_param_value("from");
        const std::string to = req.get_param_value("to");
        if (from.empty() || to.empty())
        {
            res.status = 400;
            res.set_content(errorJson("统计查询必须指定起止日期").dump(), "application/json");
            return;
        }

        const std::string feature =
            req.get_param_value("feature");
        const std::string groupBy =
            req.has_param("groupBy") ? req.get_param_value("groupBy") : "feature";
        const std::string okFilter =
            req.get_param_value("ok");
        const std::string bandFilter =
            req.get_param_value("band");
        const auto currency = requestCurrency(req);

        auto intParam = [&](const char* name, int fallback, int low, int high) {
            if (!req.has_param(name))
                return fallback;
            try
            {
                return std::max(
                    low,
                    std::min(high, std::stoi(req.get_param_value(name))));
            }
            catch (...)
            {
                return fallback;
            }
        };
        const int page = intParam("page", 1, 1, 1000000);
        const int pageSize = intParam("pageSize", 100, 20, 200);
        const bool detailsOnly = req.get_param_value("detailsOnly") == "1";

        struct PriceContext {
            std::optional<TokenRates> rates;
            std::string band = "flat";
        };
        std::unordered_map<std::string, PriceContext> priceCache;
        auto decorate = [&](json& row) {
            row["cost"] = 0.0;
            row["pricingBand"] = "flat";
            if (row.value("channel", "") != "llm")
                return;
            const std::string model = row.value("model", "");
            if (model.empty())
                return;
            const std::string date = row.value("date", "");
            const std::string time = row.value("time", "");
            const std::string minute = time.size() >= 5 ? time.substr(0, 5) : time;
            const std::string cacheKey = model + "\n" + date + "\n" + minute + "\n" + currency;
            auto [it, inserted] = priceCache.try_emplace(cacheKey);
            if (inserted)
            {
                it->second.rates = pricing_.ratesFor(model, date, currency, minute);
                it->second.band = pricing_.bandFor(model, date, minute);
                if (it->second.band.empty())
                    it->second.band = "flat";
            }
            row["pricingBand"] = it->second.band;
            if (!it->second.rates || row.value("promptTokens", 0) < 0
                || row.value("totalTokens", 0) < 0)
                return;
            row["cost"] = PricingStore::computeCost(
                row.value("promptTokens", 0),
                row.value("completionTokens", 0),
                row.value("cacheReadTokens", 0),
                row.value("cacheWriteTokens", 0),
                *it->second.rates);
        };

        auto chartRows = detailsOnly ? std::vector<json>{} : usage_.chartBuckets(from, to, feature, okFilter);
        std::vector<json> filteredChart;
        filteredChart.reserve(chartRows.size());
        for (auto& row : chartRows)
        {
            decorate(row);
            if (!bandFilter.empty() && row.value("pricingBand", "flat") != bandFilter)
                continue;
            filteredChart.push_back(std::move(row));
        }

        std::vector<json> pageRows;
        int totalRows = 0;
        if (bandFilter.empty())
        {
            pageRows = usage_.eventPage(
                from,
                to,
                feature,
                okFilter,
                page,
                pageSize,
                totalRows);
        }
        else
        {
            pageRows = usage_.eventPage(
                from, to, feature, okFilter, page, pageSize, totalRows,
                [&](const json& row) { return eventBand(row) == bandFilter; });
        }
        for (auto& row : pageRows) decorate(row);

        json summaryBody = UsageStore::summaryFromEvents(filteredChart, groupBy);
        const int pages = totalRows <= 0 ? 0 : (totalRows + pageSize - 1) / pageSize;
        res.set_content(
            json{
                {"ok", true},
                {"groupBy", groupBy},
                {"currency", currency},
                {"summary", summaryBody.value("items", json::array())},
                {"chart", filteredChart},
                {"events", pageRows},
                {"pagination",
                 {{"page", page},
                  {"pageSize", pageSize},
                  {"total", totalRows},
                  {"pages", pages}}},
            }
                .dump(),
            "application/json");
    }));

    svr.Delete("/api/usage", withCors([this](const httplib::Request&, httplib::Response& res) {
        usage_.clear();
        res.set_content(json{{"ok", true}}.dump(), "application/json");
    }));

    svr.Get("/api/pricing", withCors([this](const httplib::Request&, httplib::Response& res) {
        json table = pricing_.get();
        table["ok"] = true;
        res.set_content(table.dump(), "application/json; charset=utf-8");
    }));

    svr.Put("/api/pricing", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            const std::string err = pricing_.put(body);
            if (!err.empty())
            {
                res.status = 400;
                res.set_content(errorJson(err).dump(), "application/json");
                return;
            }
            json table = pricing_.get();
            table["ok"] = true;
            res.set_content(table.dump(), "application/json; charset=utf-8");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Get("/api/health", withCors([](const httplib::Request&, httplib::Response& res) {
        res.set_content(json{{"ok", true}, {"service", "llmchat-backend"}}.dump(), "application/json; charset=utf-8");
    }));

    svr.Get("/api/ocr/models", withCors([this](const httplib::Request&, httplib::Response& res) {
        res.set_content(ocrModels_.status().dump(), "application/json");
    }));

    svr.Post(R"(/api/ocr/models/(fast|precise|english|manga))", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const std::string mode = req.matches[1].str();
            res.set_content(ocrModels_.ensureMode(mode, config_.snapshot()).dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 502;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Delete(R"(/api/ocr/models/(precise|english|manga))", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            res.set_content(ocrModels_.removeMode(req.matches[1].str()).dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 409;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Get(R"(/api/runtime-assets/(.+))", withCors([](const httplib::Request& req, httplib::Response& res) {
        const auto file = runtime_assets::resolve(storage::base / "resources" / "web-assets", req.matches[1].str());
        if (file.empty())
        {
            res.status = 404;
            res.set_content(errorJson("软件资源文件不存在，请重新构建并更新软件").dump(), "application/json");
            return;
        }
        res.set_header("Cache-Control", "no-store");
        res.set_file_content(utf8path::pathUtf8(file), runtime_assets::contentType(file));
    }));

    svr.Get(R"(/api/ocr/model-files/(.+))", withCors([this](const httplib::Request& req, httplib::Response& res) {
        const std::string fileName = req.matches[1].str();
        if (!ocrModels_.isAllowedModelFile(fileName))
        {
            res.status = 404;
            res.set_content(errorJson("OCR 模型文件尚未下载").dump(), "application/json");
            return;
        }
        res.set_header("Cache-Control", "private, max-age=31536000, immutable");
        const std::string contentType = fileName.ends_with(".onnx")
            ? "application/octet-stream"
            : fileName.ends_with(".json")
                ? "application/json; charset=utf-8"
                : fileName.ends_with(".txt")
                    ? "text/plain; charset=utf-8"
                    : "application/x-tar";
        res.set_file_content(ocrModels_.modelFile(fileName).string(), contentType);
    }));

    svr.Get("/api/settings", withCors([this](const httplib::Request&, httplib::Response& res) {
        const AppConfig c = config_.snapshot();
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
            {"translateModel", c.translateModel},
            {"translatePromptId", c.translatePromptId},
            {"translatePromptCatalog", c.translatePromptCatalog},
            {"translatePromptKind", c.translatePromptKind},
            {"translatePrompt", c.translatePrompt},
            {"translateMaxLength", c.translateMaxLength},
            {"translateAutoChunk", c.translateAutoChunk},
            {"translateClearLineBreaks", c.translateClearLineBreaks},
            {"translateContextParagraphs", c.translateContextParagraphs},
            {"translateGlossary", c.translateGlossary},
            {"ocrLang", c.ocrLang},
            {"ocrMode", c.ocrMode},
            {"imageOcrMode", c.imageOcrMode},
            {"ocrAutoTranslate", c.ocrAutoTranslate},
            {"ocrTranslateProvider", c.ocrTranslateProvider},
            {"ocrTranslateSource", c.ocrTranslateSource},
            {"ocrTranslateTarget", c.ocrTranslateTarget},
            {"ocrTranslateModel", c.ocrTranslateModel},
            {"ocrTranslateMaxLength", c.ocrTranslateMaxLength},
            {"ocrTranslateAutoChunk", c.ocrTranslateAutoChunk},
            {"textTranslateSource", c.textTranslateSource},
            {"textTranslateTarget", c.textTranslateTarget},
            {"textTranslateProvider", c.textTranslateProvider},
            {"textTranslateModel", c.textTranslateModel},
            {"textTranslatePrompt", c.textTranslatePrompt},
            {"textPromptMtool", c.textPromptMtool},
            {"textPromptSubtitle", c.textPromptSubtitle},
            {"textPromptSubtitleRetime", c.textPromptSubtitleRetime},
            {"textGlossary", c.textGlossary},
            {"textPreReplace", c.textPreReplace},
            {"textPostReplace", c.textPostReplace},
            {"textProjectsDir", c.textProjectsDir},
            {"textProjectsDirResolved", utf8path::pathUtf8(storage::get("projects"))},
            {"dataDir", utf8path::pathUtf8(dataDirectory(config_))},
            {"translateEngineKeys", c.translateEngineKeys},
        };
        res.set_content(body.dump(), "application/json");
    }));

    svr.Put("/api/settings", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body);
            const std::lock_guard update(configUpdateMutex());
            AppConfig candidate = config_.snapshot();
            auto& c = candidate;
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
            if (body.contains("translateModel"))
            {
                c.translateModel = body["translateModel"].get<std::string>();
            }
            if (body.contains("translatePromptId"))
            {
                c.translatePromptId = body["translatePromptId"].get<std::string>();
            }
            if (body.contains("translatePromptCatalog"))
            {
                c.translatePromptCatalog = body["translatePromptCatalog"].get<std::string>();
            }
            if (body.contains("translatePromptKind"))
            {
                c.translatePromptKind = body["translatePromptKind"].get<std::string>();
            }
            if (body.contains("translatePrompt"))
            {
                c.translatePrompt = body["translatePrompt"].get<std::string>();
            }
            if (body.contains("translateMaxLength"))
            {
                c.translateMaxLength = body["translateMaxLength"].get<int>();
            }
            if (body.contains("translateAutoChunk"))
            {
                c.translateAutoChunk = body["translateAutoChunk"].get<bool>();
            }
            if (body.contains("translateClearLineBreaks"))
            {
                c.translateClearLineBreaks = body["translateClearLineBreaks"].get<bool>();
            }
            if (body.contains("translateContextParagraphs"))
            {
                c.translateContextParagraphs =
                    body["translateContextParagraphs"].get<int>();
            }
            if (body.contains("translateGlossary"))
            {
                c.translateGlossary = body["translateGlossary"].get<std::string>();
            }
            if (body.contains("ocrLang"))
            {
                c.ocrLang = body["ocrLang"].get<std::string>();
            }
            if (body.contains("ocrMode"))
            {
                const std::string mode = body["ocrMode"].get<std::string>();
                c.ocrMode = (mode == "precise" || mode == "english") ? mode : "fast";
            }
            if (body.contains("imageOcrMode"))
            {
                const std::string mode = body["imageOcrMode"].get<std::string>();
                c.imageOcrMode = (mode == "precise" || mode == "english" || mode == "manga")
                    ? mode : "fast";
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
            if (body.contains("ocrTranslateModel"))
            {
                c.ocrTranslateModel = body["ocrTranslateModel"].get<std::string>();
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
            if (body.contains("textTranslateModel"))
            {
                c.textTranslateModel = body["textTranslateModel"].get<std::string>();
            }
            if (body.contains("textTranslatePrompt"))
            {
                c.textTranslatePrompt = body["textTranslatePrompt"].get<std::string>();
            }
            if (body.contains("textPromptMtool"))
            {
                c.textPromptMtool = body["textPromptMtool"].get<std::string>();
            }
            if (body.contains("textPromptSubtitle"))
            {
                c.textPromptSubtitle = body["textPromptSubtitle"].get<std::string>();
            }
            if (body.contains("textPromptSubtitleRetime"))
            {
                c.textPromptSubtitleRetime = body["textPromptSubtitleRetime"].get<std::string>();
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
            if (c.messagePageSize < 1 || c.messagePageSize > 1000)
                throw std::runtime_error("messagePageSize 必须在 1 到 1000 之间");
            if (c.translateMaxLength < 0 || c.ocrTranslateMaxLength < 0)
                throw std::runtime_error("翻译长度限制不能为负数");
            if (c.translateContextParagraphs < 0)
                throw std::runtime_error("上下文段落数不能为负数");
            if (c.proxyMode != "direct" && c.proxyMode != "auto" && c.proxyMode != "custom")
                throw std::runtime_error("不支持的代理模式");

            std::string saveError;
            if (!config_.replace(candidate, &saveError))
            {
                res.status = 500;
                res.set_content(errorJson("保存设置失败: " + saveError).dump(), "application/json");
                return;
            }
            res.set_content(json{
                {"ok", true},
                {"textProjectsDirResolved", utf8path::pathUtf8(storage::get("projects"))},
                {"dataDir", utf8path::pathUtf8(dataDirectory(config_))},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    http_router::registerTextProjectRoutes(svr);

    svr.Post("/api/reveal-path", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body);
            if (!body.contains("path") || !body["path"].is_string())
            {
                res.status = 400;
                res.set_content(errorJson("缺少 path").dump(), "application/json");
                return;
            }
            // JSON paths are UTF-8. fs::path(std::string) on Windows uses ACP/GBK and
            // breaks 中文/日文/(括号) folders — falsely returning "路径不存在".
            const fs::path target = utf8path::pathFromUtf8(body["path"].get<std::string>());
#ifdef _WIN32
            const std::wstring wideTarget = target.wstring();
            const DWORD attrs = GetFileAttributesW(wideTarget.c_str());
            if (attrs == INVALID_FILE_ATTRIBUTES)
            {
                res.status = 404;
                res.set_content(errorJson("路径不存在").dump(), "application/json");
                return;
            }
            const bool directory = (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0;
            const bool opened = directory
                ? reinterpret_cast<intptr_t>(ShellExecuteW(nullptr, nullptr, wideTarget.c_str(), nullptr, nullptr, SW_SHOWNORMAL)) > 32
                : selectFileInExplorer(target);
            if (!opened)
            {
                res.status = 500;
                res.set_content(errorJson(directory ? "无法打开文件夹" : "无法在文件夹中定位文件").dump(), "application/json");
                return;
            }
#else
            std::error_code ec;
            if (!fs::exists(target, ec))
            {
                res.status = 404;
                res.set_content(errorJson("路径不存在").dump(), "application/json");
                return;
            }
            const fs::path openPath = fs::is_directory(target, ec) ? target : target.parent_path();
            (void)openPath;
            res.status = 501;
            res.set_content(errorJson("当前平台不支持打开文件夹").dump(), "application/json");
            return;
#endif
            res.set_content(json{{"ok", true}}.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/open-path", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body);
            if (!body.contains("path") || !body["path"].is_string())
            {
                res.status = 400;
                res.set_content(errorJson("缺少 path").dump(), "application/json");
                return;
            }
            const std::string pathUtf8 = body["path"].get<std::string>();
            // http(s) links (e.g. GitHub README) — do not treat as filesystem paths.
            if (pathUtf8.rfind("http://", 0) == 0 || pathUtf8.rfind("https://", 0) == 0)
            {
#ifdef _WIN32
                const std::wstring wideUrl = utf8path::toWide(pathUtf8);
                const HINSTANCE hi = ShellExecuteW(
                    nullptr,
                    L"open",
                    wideUrl.c_str(),
                    nullptr,
                    nullptr,
                    SW_SHOWNORMAL);
                if (reinterpret_cast<intptr_t>(hi) <= 32)
                {
                    res.status = 500;
                    res.set_content(errorJson("无法打开链接").dump(), "application/json");
                    return;
                }
                res.set_content(json{{"ok", true}}.dump(), "application/json");
#else
                res.status = 501;
                res.set_content(errorJson("当前平台不支持打开链接").dump(), "application/json");
#endif
                return;
            }
            // Same UTF-8 rule as /api/reveal-path: never construct fs::path from ACP string.
            const fs::path target = utf8path::pathFromUtf8(pathUtf8);
#ifdef _WIN32
            const std::wstring wideTarget = target.wstring();
            const DWORD attrs = GetFileAttributesW(wideTarget.c_str());
            if (attrs == INVALID_FILE_ATTRIBUTES)
            {
                res.status = 404;
                res.set_content(
                    errorJson("文件不存在（可能尚未安装翻译插件或未保存配置）").dump(),
                    "application/json");
                return;
            }
            const HINSTANCE hi = ShellExecuteW(
                nullptr,
                L"open",
                wideTarget.c_str(),
                nullptr,
                nullptr,
                SW_SHOWNORMAL);
            if (reinterpret_cast<intptr_t>(hi) <= 32)
            {
                res.status = 500;
                res.set_content(errorJson("无法打开文件").dump(), "application/json");
                return;
            }
            res.set_content(json{{"ok", true}}.dump(), "application/json");
#else
            (void)target;
            res.status = 501;
            res.set_content(errorJson("当前平台不支持打开文件").dump(), "application/json");
#endif
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    http_router::registerTextProjectFileRoute(svr);

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
            const fs::path outPath = utf8path::pathFromUtf8(body["path"].get<std::string>());
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
                {"path", utf8path::pathUtf8(outPath)},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Get("/api/conversations", withCors([this](const httplib::Request&, httplib::Response& res) {
        json arr = conversations_.summaries();
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
        if (req.has_param("limit")) {
            try {
                auto page = conversations_.page(id, std::stoi(req.get_param_value("limit")), req.has_param("before") ? std::stoi(req.get_param_value("before")) : -1);
                if (page.is_null()) { res.status = 404; res.set_content(errorJson("Conversation not found").dump(), "application/json"); return; }
                if (!req.has_param("before")) conversations_.switchToConversation(id);
                res.set_content(page.dump(), "application/json");
            } catch (const std::exception& ex) { res.status = 400; res.set_content(errorJson(ex.what()).dump(), "application/json"); }
            return;
        }
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
        const auto current = conversations_.page(conversations_.currentConversationId(), config_.snapshot().messagePageSize);
        res.set_content(json{
            {"ok", true},
            {"current", current},
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
            res.set_content(conversations_.page(id, config_.snapshot().messagePageSize).dump(), "application/json");
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

    svr.Post(R"(/api/(game-images|game-text)/model)", withCors([this, &translationTasks](const httplib::Request& req, httplib::Response& res) {
        try {
            const bool textScreening = req.path == "/api/game-text/model";
            const auto body = json::parse(req.body);
            const auto id = body.at("taskId").get<std::string>();
            if (id.empty() || id.size() > 96) throw std::runtime_error("invalid taskId");
            LlmRequest request;
            request.apiUrl = body.at("apiUrl").get<std::string>(); request.apiKey = body.value("apiKey", "");
            request.model = body.at("model").get<std::string>(); request.requireComplete = true;
            request.nativeOllama = body.value("localModel", false) && body.value("ollamaNative", false);
            request.ollamaContextLength = body.value("ollamaContextLength", 0);
            const int maxOutputTokens = body.value("maxOutputTokens", 0);
            if (maxOutputTokens > 0 && maxOutputTokens <= 1048576) request.options["max_tokens"] = maxOutputTokens;
            const auto cfg = config_.snapshot();
            request.proxyMode = body.value("localModel", false) ? "direct" : cfg.proxyMode; request.httpProxy = cfg.httpProxy;
            const auto prompt = body.at("prompt").get<std::string>(), image = body.value("image", "");
            const bool imageClassification = !image.empty() && body.value("imageClassification", false);
            if (imageClassification) {
                request.options["max_tokens"] = maxOutputTokens > 0 ? std::min(maxOutputTokens, 256) : 256;
                request.options["temperature"] = 0;
                if (request.nativeOllama) {
                    request.options["reasoning_effort"] = "none";
                    request.options["keep_alive"] = "5m";
                    request.options["format"] = json::parse(R"schema({
                        "type":"object","required":["text_probability"],"additionalProperties":false,
                        "properties":{"text_probability":{"type":"number","minimum":0,"maximum":100}}
                    })schema");
                }
            }
            if (!image.empty() && body.value("mosaicReview", false)) {
                request.options["temperature"] = 0;
                if (request.nativeOllama) {
                    request.options["max_tokens"] = maxOutputTokens > 0 ? std::min(maxOutputTokens, 256) : 256;
                    request.options["reasoning_effort"] = "none";
                    request.options["keep_alive"] = "5m";
                    request.options["format"] = json::parse(R"schema({
                        "type":"object","required":["pixelation","boxes","confidence"],"additionalProperties":false,
                        "properties":{
                            "pixelation":{"type":"boolean"},
                            "confidence":{"type":"number","minimum":0,"maximum":1},
                            "boxes":{"type":"array","maxItems":3,"items":{
                                "type":"array","minItems":4,"maxItems":4,
                                "items":{"type":"number","minimum":0,"maximum":1000}
                            }}
                        }
                    })schema");
                }
            }
            if (request.nativeOllama && !imageClassification && !image.empty() && body.value("groupedImageOcr", false)) {
                request.options["temperature"] = 0;
                request.options["format"] = json::parse(R"schema({
                    "type":"object","required":["regions"],"additionalProperties":false,
                    "properties":{"regions":{"type":"array","maxItems":10,"items":{
                        "type":"object","required":["index","text","confidence"],"additionalProperties":false,
                        "properties":{"index":{"type":"integer","minimum":1,"maximum":10},
                            "text":{"type":"string","minLength":1},"confidence":{"type":"number","minimum":0,"maximum":100}}
                    }}}})schema");
            } else if (request.nativeOllama && !imageClassification && !image.empty() && body.value("imageOcr", false)) {
                request.options["format"] = json::parse(R"schema({
                    "type":"object","required":["regions"],"additionalProperties":false,
                    "properties":{"regions":{"type":"array","items":{
                        "type":"object","required":["text","confidence","x0","y0","x1","y1"],"additionalProperties":false,
                        "properties":{"text":{"type":"string","minLength":1},"confidence":{"type":"number","minimum":0,"maximum":100},
                        "x0":{"type":"number","minimum":0,"maximum":1000},"y0":{"type":"number","minimum":0,"maximum":1000},
                        "x1":{"type":"number","minimum":0,"maximum":1000},"y1":{"type":"number","minimum":0,"maximum":1000}}
                    }}}})schema");
            }
            if (request.nativeOllama && image.empty() && body.value("imageLayout", false)) {
                request.options["format"] = json::parse(R"schema({
                    "type":"object","required":["regions"],"additionalProperties":false,
                    "properties":{"regions":{"type":"array","items":{
                        "type":"object","required":["index","breakAfter"],"additionalProperties":false,
                        "properties":{"index":{"type":"integer","minimum":0},
                            "breakAfter":{"type":"array","items":{"type":"integer","minimum":1}}}
                    }}}})schema");
            }
            if (request.apiUrl.empty() || request.model.empty() || prompt.empty() || prompt.size() > 2000000) throw std::runtime_error("处理模型、接口或请求内容无效");
            json content = json::array({json{{"type","text"},{"text",prompt}}});
            if (!image.empty()) {
                if (image.rfind("data:image/png;base64,", 0) != 0 || image.size() > 20000000) throw std::runtime_error("图片输入须为不超过 20 MB 的 PNG 数据");
                content.push_back(json{{"type","image_url"},{"image_url",json{{"url",image}}}});
            }
            request.messages = json::array({json{{"role","user"},{"content",textScreening ? json(prompt) : content}}});
            const auto task = translationTasks.begin(id);
            if (!task) { res.status = 429; res.set_content(errorJson("在线任务较多，请稍后重试").dump(), "application/json"); return; }
            request_cancel::Scope cancellation(translationTasks, id, task);
            if (task->stopped()) { res.status = 499; res.set_content(errorJson("任务已取消").dump(), "application/json"); return; }
            auto event = UsageStore::makeEventSkeleton();
            event.feature = textScreening ? "game_text_screening" : "game_image_model";
            event.endpoint = textScreening ? "game-text/model" : "game-images/model"; event.channel = "llm"; event.model = request.model;
            event.apiHost = UsageStore::hostFromApiUrl(request.apiUrl);
            event.vendor = UsageStore::vendorFromHostOrModel(event.apiHost, request.model, "");
            ScopedUsageLog usageLog(usage_, event);
            const auto response = LlmClient::chat(request);
            auto& ev = usageLog.ev();
            const bool cancelled = task->cancelled.load();
            const bool timedOut = !cancelled && request_cancel::Clock::now() >= task->deadline;
            ev.ok = response.ok && !cancelled && !timedOut;
            ev.promptTokens = response.promptTokens; ev.completionTokens = response.completionTokens;
            ev.totalTokens = response.totalTokens; ev.cacheReadTokens = response.cacheReadTokens; ev.cacheWriteTokens = response.cacheWriteTokens;
            if (response.externalCall && response.totalTokens <= 0) {
                ev.promptTokens = ev.completionTokens = ev.totalTokens = kUsageTokensUnknown;
                ev.cacheReadTokens = ev.cacheWriteTokens = kUsageTokensUnknown;
            }
            ev.errorCode = ev.ok ? "" : cancelled ? "CANCELLED" : timedOut ? "TIMEOUT" : "ERROR";
            ev.errorMessage = ev.ok ? "" : cancelled ? "模型请求已取消" : timedOut ? "模型请求超时，未在时限内返回结果" : response.error;
            if (!ev.ok) {
                res.status = cancelled ? 499 : timedOut ? 504 : 502;
                res.set_content(json{{"error", ev.errorMessage}, {"code", cancelled || timedOut ? ev.errorCode : response.errorCode},
                    {"outputTokenLimit", request.options.value("max_tokens", 0)},
                    {"promptTokens", response.promptTokens}, {"completionTokens", response.completionTokens}}.dump(), "application/json");
                return;
            }
            json result = {{"ok", true}, {"content", response.content}, {"completionTokens", response.completionTokens},
                {"generationTokensPerSecond", response.generationTokensPerSecond}};
            appendServiceTiming(result, response.serviceTiming);
            res.set_content(result.dump(), "application/json");
        } catch (const std::exception& error) { res.status = 400; res.set_content(errorJson(error.what()).dump(), "application/json"); }
    }));

    const auto translateHandler = http_router::registerTranslationRoute(svr, config_, usage_, translationTasks, nextTask);
    // Queue workers retain a reference to translateHandler and join before it is destroyed.
    TextTaskQueue textQueue([&translationTasks](const std::string& id) { translationTasks.cancel(id); });
    http_router::registerTextRequestRoutes(svr, textQueue, translateHandler, translationTasks);
    http_router::registerTextRunRoutes(svr, textRuns);

    for (const std::string operation : {"load", "save", "workflow", "checkpoint"}) svr.Post("/api/game-text/" + operation, withCors([operation](const httplib::Request& req, httplib::Response& res) {
        try { const auto body = json::parse(req.body); res.set_content((operation == "load" ? gametext::load(body) : operation == "workflow" ? gametext::workflow(body) : operation == "checkpoint" ? gametext::checkpoint(body) : gametext::save(body)).dump(), "application/json"); }
        catch (const std::exception& e) { res.status = 400; res.set_content(errorJson(e.what()).dump(), "application/json"); }
    }));
    svr.Post("/api/json-embedding/start", withCors([&](const httplib::Request& req, httplib::Response& res) {
        try { jsonEmbedding.start(json::parse(req.body)); res.set_content(jsonEmbedding.status().dump(), "application/json"); }
        catch (const std::exception& e) { res.status = 400; res.set_content(errorJson(e.what()).dump(), "application/json"); }
    }));
    for(const std::string operation:{"info","load","scan","save","save-many","apply","uninstall","stop-read","current-sources","mosaic-status","mosaic-prepare","mosaic-apply","mosaic-uninstall"})svr.Post("/api/game-images/"+operation,withCors([&,operation](const httplib::Request& req,httplib::Response& res){try{const auto body=json::parse(req.body);const auto game=utf8path::pathFromUtf8(body.at("gamePath").get<std::string>());json value;if(operation=="info")value=gameImages.info(game);else if(operation=="current-sources")value=gameImages.currentSources(game,body.at("sources"));else if(operation=="stop-read")value=gameImages.stopReading(game);else if(operation=="load")value=gameImages.load(game);else if(operation=="scan")value=gameImages.scan(game);else if(operation=="save-many")value=gameImages.saveMany(game,body.at("images"));else if(operation=="save")value=gameImages.saveImage(game,body.at("image"));else if(operation=="uninstall")value=gameImages.uninstall(game);else if(operation=="mosaic-uninstall")value=gameImages.uninstall(game,true,body.at("imageIds"));else if(operation=="mosaic-status")value=gameImages.mosaicStatus(game);else if(operation=="mosaic-prepare")value=gameImages.prepareMosaic(game,body.at("imageIds"),body.at("patchId").get<std::string>());else value=gameImages.apply(game,body.value("backupMode","auto")!="manual",body.value("backupScopes",json::array({"images"})),body.value("imageIds",json(nullptr)),operation=="mosaic-apply",body.value("patchId",""));res.set_content(value.dump(),"application/json");}catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}}));
    svr.Post("/api/game-images/load-stream",withCors([&](const httplib::Request& req,httplib::Response& res){
        try{const auto game=utf8path::pathFromUtf8(json::parse(req.body).at("gamePath").get<std::string>());res.set_chunked_content_provider("application/x-ndjson",[&,game](size_t,httplib::DataSink& sink){auto send=[&](const json& event){const auto line=event.dump()+"\n";if(!sink.write(line.data(),line.size()))throw std::runtime_error("图片工程读取已取消");};try{send({{"type","progress"},{"completed",0},{"total",0},{"detail","正在读取已有图片工程"}});auto project=gameImages.load(game,[&](size_t completed,size_t total,const std::string& detail){send({{"type","progress"},{"completed",completed},{"total",total},{"detail",detail}});});send({{"type","result"},{"project",project}});}catch(const std::exception& e){const auto line=json({{"type","error"},{"error",e.what()}}).dump()+"\n";sink.write(line.data(),line.size());}sink.done();return true;});}catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}
    }));
    svr.Post("/api/game-images/scan-stream",withCors([&](const httplib::Request& req,httplib::Response& res){
        try{const auto game=utf8path::pathFromUtf8(json::parse(req.body).at("gamePath").get<std::string>());res.set_chunked_content_provider("application/x-ndjson",[&,game](size_t,httplib::DataSink& sink){auto send=[&](const json& event){auto line=event.dump()+"\n";if(!sink.write(line.data(),line.size()))throw std::runtime_error("图片扫描已取消");};try{send({{"type","progress"},{"completed",0},{"total",0},{"detail","正在准备图片扫描"}});auto project=gameImages.scan(game,[&](size_t completed,size_t total,const std::string& detail){send({{"type","progress"},{"completed",completed},{"total",total},{"detail",detail}});});send({{"type","result"},{"project",project}});}catch(const std::exception& e){auto line=json({{"type","error"},{"error",e.what()}}).dump()+"\n";sink.write(line.data(),line.size());}sink.done();return true;});}catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}
    }));
    svr.Get("/api/game-images/preview",withCors([&](const httplib::Request& req,httplib::Response& res){try{res.set_content(gameImages.preview(utf8path::pathFromUtf8(req.get_param_value("gamePath")),req.get_param_value("id"),req.get_param_value("translated")=="1"),"image/png");}catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}}));
    svr.Get("/api/game-images/mosaic",withCors([&](const httplib::Request& req,httplib::Response& res){
        try{res.set_content(gameImages.previewMosaic(utf8path::pathFromUtf8(req.get_param_value("gamePath")),req.get_param_value("id")),"image/png");}
        catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}
    }));
    svr.Post("/api/game-images/mosaic",withCors([&](const httplib::Request& req,httplib::Response& res){
        try{res.set_content(gameImages.saveMosaic(utf8path::pathFromUtf8(req.get_param_value("gamePath")),req.get_param_value("id"),req.get_param_value("sourceHash"),req.body).dump(),"application/json");}
        catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}
    }));
    svr.Post("/api/game-images/render",withCors([&](const httplib::Request& req,httplib::Response& res){try{res.set_content(gameImages.render(utf8path::pathFromUtf8(req.get_param_value("gamePath")),req.get_param_value("id"),req.body).dump(),"application/json");}catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}}));
    svr.Post("/api/json-embedding/detect-patch", withCors([&](const httplib::Request& req, httplib::Response& res){try{res.set_content(jsonEmbedding.detectPatch(utf8path::pathFromUtf8(json::parse(req.body).at("gamePath").get<std::string>())).dump(),"application/json");}catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}}));

    for (const std::string operation : {"status","preview","install","rule","uninstall"}) {
        svr.Post("/api/game-mosaic/" + operation, withCors([operation](const httplib::Request& req, httplib::Response& res) {
            try {
                const auto body = json::parse(req.body);
                const auto game = fs::canonical(utf8path::pathFromUtf8(body.at("gamePath").get<std::string>()));
                const auto detected = JsonEmbedding::detect(game);
                if (detected.size() != 1 || !fs::equivalent(game,utf8path::pathFromUtf8(detected[0].at("path").get<std::string>())))
                    throw std::runtime_error("无法识别当前游戏目录");
                const auto engine = detected[0].at("engine").get<std::string>();
                const bool isUnreal = engine == unreal::engine;
                if (!isUnreal && engine != "Unity") throw std::runtime_error("请打开 UE 或 Unity 游戏工程");
                json result;
                if (operation == "status") result = mosaic::status(game,isUnreal);
                else if (operation == "uninstall") result = mosaic::uninstall(game,isUnreal);
                else if (operation == "rule") result = mosaic::installRule(game,isUnreal,body);
                else {
                    const auto source = utf8path::pathFromUtf8(body.at("source").get<std::string>());
                    const auto target = body.value("target","game");
                    if (operation == "preview") {
                        const auto bundle = mosaic::package(game,isUnreal,source,target);
                        result = {{"files",bundle.list},{"ignored",bundle.ignored}};
                    } else result = mosaic::install(game,isUnreal,source,target,body.at("files"));
                }
                res.set_content(result.dump(),"application/json");
            } catch (const std::exception& e) {
                res.status=400;
                res.set_content(errorJson(e.what()).dump(-1,' ',false,json::error_handler_t::replace),"application/json");
            }
        }));
    }
    svr.Post("/api/json-embedding/launch", withCors([](const httplib::Request& req, httplib::Response& res) {
        try {
            const auto game = utf8path::pathFromUtf8(json::parse(req.body).at("gamePath").get<std::string>());
            if (game.empty() || !fs::is_directory(game)) throw std::runtime_error("游戏目录不存在");
            const auto games = JsonEmbedding::detect(game);
            if (games.size() != 1 || !games[0].value("supported", false) ||
                !fs::equivalent(game, utf8path::pathFromUtf8(games[0].at("path").get<std::string>())))
                throw std::runtime_error("无法识别当前游戏目录");
            const auto root = fs::absolute(game);
            auto exe = games[0].at("engine").get<std::string>() == unreal::engine ? unreal::executable(root) : root / "Game.exe";
            if (!fs::is_regular_file(exe)) exe = root / (root.filename().wstring() + L".exe");
            if (!fs::is_regular_file(exe) || gamefiles::reparsePoint(exe)) throw std::runtime_error("未找到有效的游戏主程序");
#ifdef _WIN32
            const auto directory = exe.parent_path();
            const auto result = reinterpret_cast<intptr_t>(ShellExecuteW(nullptr, L"open", exe.c_str(), nullptr, directory.c_str(), SW_SHOWNORMAL));
            if (result <= 32) throw std::runtime_error("Windows 无法启动游戏（错误 " + std::to_string(result) + "）");
            res.set_content(json{{"ok", true}, {"gameExe", utf8path::pathUtf8(exe.filename())}}.dump(), "application/json");
#else
            throw std::runtime_error("当前平台不支持启动 Windows 游戏");
#endif
        } catch (const std::exception& e) { res.status = 400; res.set_content(errorJson(e.what()).dump(), "application/json"); }
    }));

    svr.Get("/api/json-embedding/patch", withCors([&](const httplib::Request& req, httplib::Response& res) {
        try {res.set_content(JsonEmbedding::patchInfo(utf8path::pathFromUtf8(req.get_param_value("gamePath"))).dump(),"application/json");}
        catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}
    }));
    svr.Get("/api/json-embedding/status", withCors([&](const httplib::Request&, httplib::Response& res) { res.set_content(jsonEmbedding.status().dump(), "application/json"); }));
    svr.Post("/api/json-embedding/detect", withCors([&](const httplib::Request& req, httplib::Response& res) {
        try { res.set_content(JsonEmbedding::detect(utf8path::pathFromUtf8(json::parse(req.body).at("path").get<std::string>())).dump(), "application/json"); }
        catch (const std::exception& e) { res.status = 400; res.set_content(errorJson(e.what()).dump(-1, ' ', false, json::error_handler_t::replace), "application/json"); }
    }));
    svr.Get("/api/json-embedding/backups", withCors([&](const httplib::Request& req, httplib::Response& res) {
        try { res.set_content(JsonEmbedding::backups(utf8path::pathFromUtf8(req.get_param_value("gamePath"))).dump(), "application/json"); }
        catch (const std::exception& e) { res.status = 400; res.set_content(errorJson(e.what()).dump(-1, ' ', false, json::error_handler_t::replace), "application/json"); }
    }));
    svr.Post("/api/json-embedding/stop", withCors([&](const httplib::Request&, httplib::Response& res) { jsonEmbedding.cancel(); res.set_content(json{{"ok", true}}.dump(), "application/json"); }));

    RuntimeLlmBatcher runtimeLlm;
    http_router::registerUnityRuntimeRoutes(svr, config_, usage_, runtimeLlm);

    UnityInstallJobs unityInstalls;
    http_router::registerUnityConfigRoutes(svr, unityInstalls);

    http_router::registerUnityRoutes(svr, {UnityAutoTranslator::detect, UnityAutoTranslator::detectStream});

    static std::mutex outputLogMutex;
    svr.Post(R"(/api/(?:unity/)?output-log)", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            const std::string text = body.value("text", "");
            if (text.empty())
            {
                res.status = 400;
                res.set_content(errorJson("text 不能为空").dump(), "application/json");
                return;
            }
            const bool global = req.path == "/api/output-log";
            const fs::path logPath = dataDirectory(config_) / (global ? "app-output.jsonl" : "unity-output.log");
            std::lock_guard lock(outputLogMutex);
            if (global) updateOutputIssues(logPath.parent_path(), text);
            if (global && fs::exists(logPath) && fs::file_size(logPath) >= 4 * 1024 * 1024) {
                const auto archive = fs::path(logPath).concat(".bak");
                fs::remove(archive);
                fs::rename(logPath, archive);
            }
            appendFileUtf8(logPath, text.back() == '\n' ? text : text + "\n");
            res.set_content(
                json{{"ok", true}, {"logPath", utf8path::pathUtf8(logPath)}}.dump(),
                "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Get(R"(/api/(?:unity/)?output-log)", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            int lines = 200;
            if (req.has_param("lines"))
            {
                try
                {
                    lines = std::stoi(req.get_param_value("lines"));
                }
                catch (...)
                {
                    lines = 200;
                }
            }
            if (lines < 1)
                lines = 1;
            if (lines > 2000)
                lines = 2000;
            const bool global = req.path == "/api/output-log";
            const bool full = global && req.get_param_value("full") == "1";
            const fs::path logPath = dataDirectory(config_) / (global ? "app-output.jsonl" : "unity-output.log");
            std::lock_guard lock(outputLogMutex);
            std::error_code ec;
            const bool exists = fs::exists(logPath, ec);
            const auto archive = fs::path(logPath).concat(".bak");
            std::string text = exists ? (full ? readFileUtf8(logPath) : readFileTailLines(logPath, lines)) : "";
            if (full && fs::is_regular_file(archive)) {
                auto older = readFileUtf8(archive);
                if (!older.empty()) {
                    if (!text.empty() && older.back() != '\n') older += '\n';
                    text = std::move(older) + text;
                }
            } else if (global && !full) {
                const int count = static_cast<int>(std::count(text.begin(), text.end(), '\n')) + (!text.empty() && text.back() != '\n');
                if (count < lines) {
                    const auto older = readFileTailLines(archive, lines - count);
                    if (!older.empty()) text = older + "\n" + text;
                }
            }
            json result = {{"ok", true}, {"logPath", utf8path::pathUtf8(logPath)}, {"exists", exists}, {"text", text}};
            if (global && !full) {
                result["issues"] = json::array();
                for (const auto& row : readOutputIssues(logPath.parent_path())) result["issues"].push_back(row);
            }
            res.set_content(result.dump(-1, ' ', false, json::error_handler_t::replace), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

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
