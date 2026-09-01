#include "HttpServer.h"
#include "AtomicFile.h"
#include "LlmClient.h"
#include "TranslateClient.h"
#include "UnityAutoTranslator.h"
#include "PricingStore.h"
#include "UsageStore.h"
#include "Utf8Path.h"

#include <httplib.h>
#include <algorithm>
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
#endif

using json = nlohmann::json;
namespace fs = std::filesystem;

namespace {

constexpr const char* kProjectFileName = "project.lcproj";
constexpr const char* kProjectFileNameLegacy = "project.llmchat-proj.json";

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

bool isAllowedBrowserOrigin(const httplib::Request& req)
{
    const std::string origin = req.get_header_value("Origin");
    if (origin.empty())
    {
        const std::string fetchSite = req.get_header_value("Sec-Fetch-Site");
        return fetchSite.empty() || fetchSite == "same-origin" || fetchSite == "same-site";
    }
    static const std::set<std::string> allowed{
        "http://localhost:1420",
        "http://127.0.0.1:1420",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
    };
    return allowed.contains(origin);
}

void setCors(const httplib::Request& req, httplib::Response& res)
{
    const std::string origin = req.get_header_value("Origin");
    if (!origin.empty())
    {
        res.set_header("Access-Control-Allow-Origin", origin);
        res.set_header("Vary", "Origin");
    }
    res.set_header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}

json errorJson(const std::string& message)
{
    return json{{"ok", false}, {"error", message}};
}

/** Writes markPending on construction and finalize on destruction (same event id). */
class ScopedUsageLog {
public:
    ScopedUsageLog(UsageStore* store, UsageEvent ev, bool track)
        : store_(track ? store : nullptr), ev_(std::move(ev))
    {
        if (store_)
            store_->markPending(ev_);
    }

    ~ScopedUsageLog()
    {
        if (store_)
            store_->finalize(ev_);
    }

    UsageEvent& ev() { return ev_; }

    ScopedUsageLog(const ScopedUsageLog&) = delete;
    ScopedUsageLog& operator=(const ScopedUsageLog&) = delete;

private:
    UsageStore* store_;
    UsageEvent ev_;
};

fs::path dataDirectory(const ConfigStore& config)
{
    return fs::path(config.path()).parent_path();
}

fs::path resolveTextProjectsRoot(const ConfigStore& config)
{
    const std::string raw = config.snapshot().textProjectsDir;
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

void appendFileUtf8(const fs::path& path, const std::string& content)
{
    std::ofstream out(path, std::ios::binary | std::ios::app);
    if (!out)
    {
        throw std::runtime_error("无法写入日志文件");
    }
    out << content;
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
        if (nl != std::string::npos)
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
    , usage_(std::make_unique<UsageStore>(
          (fs::path(config.path()).parent_path() / "usage-events.jsonl").string()))
    , pricing_(std::make_unique<PricingStore>(
          (fs::path(config.path()).parent_path() / "pricing.json").string()))
    , ocrModels_(std::make_unique<OcrModelStore>(
          fs::path(config.path()).parent_path()))
{
}

int HttpServer::run()
{
    httplib::Server svr;

    svr.Options(R"(.*)", [](const httplib::Request& req, httplib::Response& res) {
        if (!isAllowedBrowserOrigin(req))
        {
            res.status = 403;
            res.set_content(errorJson("不允许的请求来源").dump(), "application/json");
            return;
        }
        setCors(req, res);
        res.status = 204;
    });

    auto withCors = [](auto handler) {
        return [handler](const httplib::Request& req, httplib::Response& res) {
            if (!isAllowedBrowserOrigin(req))
            {
                res.status = 403;
                res.set_content(errorJson("不允许的请求来源").dump(), "application/json");
                return;
            }
            setCors(req, res);
            handler(req, res);
            if (!res.get_header_value("Content-Type").empty()
                && res.get_header_value("Content-Type").find("charset=") == std::string::npos
                && res.get_header_value("Content-Type").find("application/json") != std::string::npos)
            {
                res.set_header("Content-Type", "application/json; charset=utf-8");
            }
        };
    };

    svr.Get("/api/usage/events", withCors([this](const httplib::Request& req, httplib::Response& res) {
        const std::string from = req.has_param("from") ? req.get_param_value("from") : "";
        const std::string to = req.has_param("to") ? req.get_param_value("to") : "";
        const std::string feature = req.has_param("feature") ? req.get_param_value("feature") : "";
        const std::string okFilter = req.has_param("ok") ? req.get_param_value("ok") : "";
        const std::string bandFilter =
            req.has_param("band") ? req.get_param_value("band") : "";
        std::string currency =
            req.has_param("currency") ? req.get_param_value("currency") : "";
        if (currency.empty() && pricing_)
            currency = pricing_->displayCurrency();
        if (currency.empty())
            currency = "CNY";
        json items = json::array();
        if (usage_)
        {
            for (auto& row : usage_->events(from, to, feature, okFilter))
            {
                const double cost = pricing_ ? pricing_->costFor(row, currency) : 0.0;
                row["cost"] = cost;
                std::string band = "flat";
                if (pricing_ && row.value("channel", "") == "llm")
                {
                    const std::string model = row.value("model", "");
                    if (!model.empty())
                    {
                        band = pricing_->bandFor(
                            model,
                            row.value("date", ""),
                            row.value("time", ""));
                        if (band.empty())
                            band = "flat";
                    }
                }
                row["pricingBand"] = band;
                if (!bandFilter.empty() && band != bandFilter)
                    continue;
                items.push_back(std::move(row));
            }
        }
        res.set_content(
            json{{"ok", true}, {"currency", currency}, {"items", items}}.dump(),
            "application/json");
    }));

    svr.Get("/api/usage/summary", withCors([this](const httplib::Request& req, httplib::Response& res) {
        const std::string from = req.has_param("from") ? req.get_param_value("from") : "";
        const std::string to = req.has_param("to") ? req.get_param_value("to") : "";
        const std::string feature = req.has_param("feature") ? req.get_param_value("feature") : "";
        const std::string groupBy =
            req.has_param("groupBy") ? req.get_param_value("groupBy") : "feature";
        const std::string okFilter = req.has_param("ok") ? req.get_param_value("ok") : "";
        const std::string bandFilter =
            req.has_param("band") ? req.get_param_value("band") : "";
        std::string currency =
            req.has_param("currency") ? req.get_param_value("currency") : "";
        if (currency.empty() && pricing_)
            currency = pricing_->displayCurrency();
        if (currency.empty())
            currency = "CNY";
        if (!usage_)
        {
            res.set_content(
                json{
                    {"ok", true},
                    {"groupBy", groupBy},
                    {"currency", currency},
                    {"items", json::array()},
                    {"totalEvents", 0}}
                    .dump(),
                "application/json");
            return;
        }
        auto rows = usage_->events(from, to, feature, okFilter);
        std::vector<json> filteredRows;
        filteredRows.reserve(rows.size());
        for (auto& row : rows)
        {
            const double cost = pricing_ ? pricing_->costFor(row, currency) : 0.0;
            row["cost"] = cost;
            std::string band = "flat";
            if (pricing_ && row.value("channel", "") == "llm")
            {
                const std::string model = row.value("model", "");
                if (!model.empty())
                {
                    band = pricing_->bandFor(
                        model,
                        row.value("date", ""),
                        row.value("time", ""));
                    if (band.empty())
                        band = "flat";
                }
            }
            row["pricingBand"] = band;
            if (!bandFilter.empty() && band != bandFilter)
                continue;
            filteredRows.push_back(std::move(row));
        }
        json body = UsageStore::summaryFromEvents(filteredRows, groupBy);
        body["currency"] = currency;
        res.set_content(body.dump(), "application/json");
    }));

    svr.Get("/api/usage/report", withCors([this](const httplib::Request& req, httplib::Response& res) {
        const std::string from = req.has_param("from") ? req.get_param_value("from") : "";
        const std::string to = req.has_param("to") ? req.get_param_value("to") : "";
        if (from.empty() || to.empty())
        {
            res.status = 400;
            res.set_content(errorJson("统计查询必须指定起止日期").dump(), "application/json");
            return;
        }

        const std::string feature =
            req.has_param("feature") ? req.get_param_value("feature") : "";
        const std::string groupBy =
            req.has_param("groupBy") ? req.get_param_value("groupBy") : "feature";
        const std::string okFilter =
            req.has_param("ok") ? req.get_param_value("ok") : "";
        const std::string bandFilter =
            req.has_param("band") ? req.get_param_value("band") : "";
        std::string currency =
            req.has_param("currency") ? req.get_param_value("currency") : "";
        if (currency.empty() && pricing_)
            currency = pricing_->displayCurrency();
        if (currency.empty())
            currency = "CNY";

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

        if (!usage_)
        {
            res.set_content(
                json{
                    {"ok", true},
                    {"groupBy", groupBy},
                    {"currency", currency},
                    {"summary", json::array()},
                    {"chart", json::array()},
                    {"events", json::array()},
                    {"pagination",
                     {{"page", page}, {"pageSize", pageSize}, {"total", 0}, {"pages", 0}}},
                }
                    .dump(),
                "application/json");
            return;
        }

        struct PriceContext {
            std::optional<TokenRates> rates;
            std::string band = "flat";
        };
        std::unordered_map<std::string, PriceContext> priceCache;
        auto decorate = [&](json& row) {
            row["cost"] = 0.0;
            row["pricingBand"] = "flat";
            if (!pricing_ || row.value("channel", "") != "llm")
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
                it->second.rates = pricing_->ratesFor(model, date, currency, minute);
                it->second.band = pricing_->bandFor(model, date, minute);
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

        auto chartRows = usage_->chartBuckets(from, to, feature, okFilter);
        std::vector<json> filteredChart;
        filteredChart.reserve(chartRows.size());
        int filteredTotal = 0;
        for (auto& row : chartRows)
        {
            decorate(row);
            if (!bandFilter.empty() && row.value("pricingBand", "flat") != bandFilter)
                continue;
            filteredTotal += std::max(1, row.value("requests", 1));
            filteredChart.push_back(std::move(row));
        }

        std::vector<json> pageRows;
        int totalRows = 0;
        if (bandFilter.empty())
        {
            pageRows = usage_->eventPage(
                from,
                to,
                feature,
                okFilter,
                page,
                pageSize,
                totalRows);
            for (auto& row : pageRows)
                decorate(row);
        }
        else
        {
            totalRows = filteredTotal;
            const int wantedBegin = (page - 1) * pageSize;
            const int wantedEnd = wantedBegin + pageSize;
            int matched = 0;
            int sourcePage = 1;
            int sourceTotal = 0;
            while (matched < wantedEnd)
            {
                auto chunk = usage_->eventPage(
                    from,
                    to,
                    feature,
                    okFilter,
                    sourcePage++,
                    200,
                    sourceTotal);
                if (chunk.empty())
                    break;
                for (auto& row : chunk)
                {
                    decorate(row);
                    if (row.value("pricingBand", "flat") != bandFilter)
                        continue;
                    if (matched >= wantedBegin && matched < wantedEnd)
                        pageRows.push_back(std::move(row));
                    ++matched;
                    if (matched >= wantedEnd)
                        break;
                }
                if ((sourcePage - 1) * 200 >= sourceTotal)
                    break;
            }
        }

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
        if (usage_)
            usage_->clear();
        res.set_content(json{{"ok", true}}.dump(), "application/json");
    }));

    svr.Get("/api/pricing", withCors([this](const httplib::Request&, httplib::Response& res) {
        if (!pricing_)
        {
            res.set_content(
                json{{"ok", true}, {"displayCurrency", "CNY"}, {"rules", json::array()}}.dump(),
                "application/json");
            return;
        }
        json table = pricing_->get();
        table["ok"] = true;
        res.set_content(table.dump(), "application/json; charset=utf-8");
    }));

    svr.Put("/api/pricing", withCors([this](const httplib::Request& req, httplib::Response& res) {
        if (!pricing_)
        {
            res.status = 500;
            res.set_content(errorJson("pricing unavailable").dump(), "application/json");
            return;
        }
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            const std::string err = pricing_->put(body);
            if (!err.empty())
            {
                res.status = 400;
                res.set_content(errorJson(err).dump(), "application/json");
                return;
            }
            json table = pricing_->get();
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
        res.set_content(ocrModels_->status().dump(), "application/json");
    }));

    svr.Post(R"(/api/ocr/models/(fast|precise|english|manga))", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const std::string mode = req.matches[1].str();
            res.set_content(ocrModels_->ensureMode(mode, config_.snapshot()).dump(), "application/json");
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
            res.set_content(ocrModels_->removeMode(req.matches[1].str()).dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 409;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Get(R"(/api/ocr/model-files/(.+))", withCors([this](const httplib::Request& req, httplib::Response& res) {
        const std::string fileName = req.matches[1].str();
        if (!ocrModels_->isAllowedModelFile(fileName))
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
        res.set_file_content(ocrModels_->modelFile(fileName).string(), contentType);
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
                const fs::path projectFile = findProjectFile(entry.path());
                if (projectFile.empty())
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
                projectFile = findProjectFile(root / folder);
            }
            else if (req.has_param("path"))
            {
                projectFile = fs::path(req.get_param_value("path"));
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
            const fs::path openPath =
                (attrs & FILE_ATTRIBUTE_DIRECTORY) ? target : target.parent_path();
            const std::wstring wide = openPath.wstring();
            const std::wstring params = L"\"" + wide + L"\"";
            HINSTANCE hi = ShellExecuteW(
                nullptr,
                L"open",
                L"explorer.exe",
                params.c_str(),
                nullptr,
                SW_SHOWNORMAL);
            if (reinterpret_cast<intptr_t>(hi) <= 32)
            {
                hi = ShellExecuteW(
                    nullptr,
                    L"open",
                    wide.c_str(),
                    nullptr,
                    nullptr,
                    SW_SHOWNORMAL);
            }
            if (reinterpret_cast<intptr_t>(hi) <= 32)
            {
                res.status = 500;
                res.set_content(errorJson("无法打开文件夹").dump(), "application/json");
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
            const AppConfig cfg = config_.snapshot();

            LlmRequest llmReq;
            llmReq.apiUrl = cfg.apiUrl;
            llmReq.apiKey = cfg.apiKey;
            llmReq.model = cfg.model;
            llmReq.messages = conv.messages;

            UsageEvent usageEv = UsageStore::makeEventSkeleton();
            usageEv.feature = "chat";
            usageEv.channel = "llm";
            usageEv.model = cfg.model;
            usageEv.apiHost = UsageStore::hostFromApiUrl(cfg.apiUrl);
            usageEv.vendor = UsageStore::vendorFromHostOrModel(
                usageEv.apiHost, cfg.model, "");
            usageEv.sourceChars = static_cast<int>(content.size());
            usageEv.endpoint = "chat";

            const bool trackUsage = static_cast<bool>(usage_);
            ScopedUsageLog usageLog(usage_.get(), usageEv, trackUsage);
            const LlmResponse llmRes = LlmClient::chat(llmReq);
            usageLog.ev().ok = llmRes.ok;
            usageLog.ev().errorCode = llmRes.ok ? "" : "LLM_ERROR";
            usageLog.ev().errorMessage = llmRes.ok ? "" : llmRes.error;
            usageLog.ev().promptTokens = llmRes.promptTokens;
            usageLog.ev().completionTokens = llmRes.completionTokens;
            usageLog.ev().totalTokens = llmRes.totalTokens;
            usageLog.ev().cacheReadTokens = llmRes.cacheReadTokens;
            usageLog.ev().cacheWriteTokens = llmRes.cacheWriteTokens;
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

    svr.Get("/api/dictionary", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const AppConfig cfg = config_.snapshot();
            const std::string q = req.has_param("q") ? req.get_param_value("q") : "";
            const std::string source = req.has_param("source")
                ? req.get_param_value("source")
                : cfg.translateSource;
            const std::string target = req.has_param("target")
                ? req.get_param_value("target")
                : cfg.translateTarget;
            const std::string body = TranslateClient::lookupDictionaryJson(
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

    svr.Get("/api/llm/vendor-models", withCors([=](const httplib::Request&, httplib::Response& res) {
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

                ScopedUsageLog usageLog(usage_.get(), usageEv, static_cast<bool>(usage_));
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

            const bool trackUsage = static_cast<bool>(usage_);
            ScopedUsageLog usageLog(usage_.get(), usageEv, trackUsage);

            if (provider == "llm")
            {
                apiUrl = body.value("apiUrl", cfg.apiUrl);
                const std::string apiKey = body.value("apiKey", cfg.apiKey);
                model = body.value("model", cfg.model);
                vendorHint = body.value("vendor", "");
                usageLog.ev().channel = "llm";
                usageLog.ev().model = model;
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
                    cfg.proxyMode, cfg.httpProxy, prompt, glossary, contextJson);
            }
            else
            {
                usageLog.ev().channel = "engine";
                usageLog.ev().engineId = provider;
                usageLog.ev().engineKind = UsageStore::engineKindForProvider(provider);
                tr = TranslateClient::translateFree(
                    text, source, target, provider, maxLength, autoChunk,
                    cfg.proxyMode, cfg.httpProxy, cfg.translateEngineKeys);
                if (tr.provider.empty() == false)
                    usageLog.ev().engineId = tr.provider;
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
                res.status = tr.code == "LENGTH_LIMIT" ? 400
                    : (tr.code == "CONFIG_ERROR" ? 400 : 502);
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
                {"cacheReadTokens", tr.cacheReadTokens},
                {"cacheWriteTokens", tr.cacheWriteTokens},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Get("/api/unity/endpoints", withCors([](const httplib::Request&, httplib::Response& res) {
        json list = json::array();
        for (const auto& e : UnityAutoTranslator::endpoints())
        {
            list.push_back({
                {"id", e.id},
                {"label", e.label},
                {"needsKey", e.needsKey},
            });
        }
        res.set_content(json{{"ok", true}, {"endpoints", list}}.dump(), "application/json");
    }));

    // AutoTranslator CustomTranslate: GET Url?text=… → plain UTF-8 translation
    svr.Get("/api/unity/llm-translate", withCors([this](const httplib::Request& req, httplib::Response& res) {
        static std::atomic<int> inFlight{0};
        constexpr int kMaxInFlight = 4;

        const std::string text = req.has_param("text") ? req.get_param_value("text") : "";
        if (text.empty())
        {
            res.status = 400;
            res.set_content("text required", "text/plain; charset=utf-8");
            return;
        }

        const int cur = inFlight.fetch_add(1);
        if (cur >= kMaxInFlight)
        {
            inFlight.fetch_sub(1);
            res.status = 429;
            res.set_content("too many concurrent translations", "text/plain; charset=utf-8");
            return;
        }

        struct Guard {
            std::atomic<int>& counter;
            ~Guard() { counter.fetch_sub(1); }
        } guard{inFlight};

        try
        {
            const AppConfig cfg = config_.snapshot();
            if (cfg.apiUrl.empty() || cfg.model.empty())
            {
                res.status = 503;
                res.set_content(
                    "LLM not configured: set apiUrl and model in LLMChat settings",
                    "text/plain; charset=utf-8");
                return;
            }

            // Game UI text is usually ja→zh-CN; optional ?from=&to= override.
            const std::string source =
                req.has_param("from") && !req.get_param_value("from").empty()
                    ? req.get_param_value("from")
                    : "ja";
            const std::string target =
                req.has_param("to") && !req.get_param_value("to").empty()
                    ? req.get_param_value("to")
                    : "zh-CN";

            UsageEvent usageEv = UsageStore::makeEventSkeleton();
            usageEv.feature = "unity";
            usageEv.channel = "llm";
            usageEv.model = cfg.model;
            usageEv.apiHost = UsageStore::hostFromApiUrl(cfg.apiUrl);
            usageEv.vendor = UsageStore::vendorFromHostOrModel(
                usageEv.apiHost, cfg.model, "");
            usageEv.sourceChars = static_cast<int>(text.size());
            usageEv.endpoint = "unity_llm";

            ScopedUsageLog usageLog(usage_.get(), usageEv, static_cast<bool>(usage_));
            const TranslateResult tr = TranslateClient::translateWithLlm(
                text,
                cfg.apiUrl,
                cfg.apiKey,
                cfg.model,
                source,
                target,
                cfg.proxyMode,
                cfg.httpProxy,
                "You are a precise game UI / dialogue translator. "
                "Translate faithfully and concisely for on-screen text. "
                "Preserve placeholders like {0}, %s, \\n, and markup tags. "
                "Output only the translation.",
                "",
                "");
            usageLog.ev().ok = tr.ok;
            usageLog.ev().errorCode = tr.ok ? "" : (tr.code.empty() ? "ERROR" : tr.code);
            usageLog.ev().errorMessage = tr.ok ? "" : tr.error;
            usageLog.ev().promptTokens = tr.promptTokens;
            usageLog.ev().completionTokens = tr.completionTokens;
            usageLog.ev().totalTokens = tr.totalTokens;
            usageLog.ev().cacheReadTokens = tr.cacheReadTokens;
            usageLog.ev().cacheWriteTokens = tr.cacheWriteTokens;

            if (!tr.ok)
            {
                res.status = 502;
                res.set_content(
                    tr.error.empty() ? "translation failed" : tr.error,
                    "text/plain; charset=utf-8");
                return;
            }

            res.set_content(tr.translation, "text/plain; charset=utf-8");
        }
        catch (const std::exception& ex)
        {
            res.status = 500;
            res.set_content(ex.what(), "text/plain; charset=utf-8");
        }
    }));

    svr.Get("/api/unity/config", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const std::string path = req.has_param("path") ? req.get_param_value("path") : "";
            const auto result = UnityAutoTranslator::getConfig(path);
            json sections = json::array();
            for (const auto& sec : result.sections)
            {
                json keys = json::array();
                for (const auto& k : sec.keys)
                {
                    keys.push_back({
                        {"key", k.key},
                        {"value", k.value},
                        {"comment", k.comment},
                    });
                }
                sections.push_back({{"name", sec.name}, {"keys", keys}});
            }
            res.set_content(
                json{
                    {"ok", result.ok},
                    {"error", result.error},
                    {"exists", result.exists},
                    {"path", result.path},
                    {"installMethod", result.installMethod},
                    {"sections", sections},
                }
                    .dump(),
                "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/unity/config", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            const std::string path = body.value("path", "");
            std::vector<UnityIniSection> sections;
            if (body.contains("sections") && body["sections"].is_array())
            {
                for (const auto& secJ : body["sections"])
                {
                    UnityIniSection sec;
                    sec.name = secJ.value("name", "");
                    if (secJ.contains("keys") && secJ["keys"].is_array())
                    {
                        for (const auto& kJ : secJ["keys"])
                        {
                            UnityIniKey k;
                            k.key = kJ.value("key", "");
                            k.value = kJ.value("value", "");
                            k.comment = kJ.value("comment", "");
                            if (!k.key.empty())
                                sec.keys.push_back(std::move(k));
                        }
                    }
                    if (!sec.name.empty())
                        sections.push_back(std::move(sec));
                }
            }
            const auto result = UnityAutoTranslator::saveConfig(path, sections);
            res.set_content(
                json{
                    {"ok", result.ok},
                    {"error", result.error},
                    {"exists", result.exists},
                    {"path", result.path},
                    {"installMethod", result.installMethod},
                }
                    .dump(),
                "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/unity/pick-path", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            std::string defaultPath;
            if (body.contains("defaultPath") && body["defaultPath"].is_string())
                defaultPath = body["defaultPath"].get<std::string>();
            const std::string path = UnityAutoTranslator::pickPath(defaultPath);
            res.set_content(json{
                {"ok", !path.empty()},
                {"path", path},
                {"cancelled", path.empty()},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/unity/detect", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            const std::string path = body.value("path", "");
            const auto info = UnityAutoTranslator::detect(path);
            json games = json::array();
            for (const auto& g : info.games)
            {
                games.push_back({
                    {"isUnity", g.isUnity},
                    {"isIl2Cpp", g.isIl2Cpp},
                    {"hasAutoTranslator", g.hasAutoTranslator},
                    {"hasBepInEx", g.hasBepInEx},
                    {"gameDir", g.gameDir},
                    {"gameExe", g.gameExe},
                    {"runtime", g.runtime},
                    {"installMethod", g.installMethod},
                    {"arch", g.arch},
                    {"plugins", g.plugins},
                    {"autoTranslatorVersion", g.autoTranslatorVersion},
                    {"loaderName", g.loaderName},
                    {"loaderVersion", g.loaderVersion},
                });
            }
            res.set_content(json{
                {"ok", info.ok},
                {"error", info.error},
                {"isUnity", info.isUnity},
                {"isIl2Cpp", info.isIl2Cpp},
                {"hasAutoTranslator", info.hasAutoTranslator},
                {"hasBepInEx", info.hasBepInEx},
                {"gameDir", info.gameDir},
                {"gameExe", info.gameExe},
                {"runtime", info.runtime},
                {"installMethod", info.installMethod},
                {"scanRoot", info.scanRoot},
                {"count", info.count},
                {"games", games},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/unity/detect-stream", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            const std::string path = body.value("path", "");
            res.set_chunked_content_provider(
                "application/x-ndjson",
                [path](size_t offset, httplib::DataSink& sink) {
                    if (offset > 0)
                    {
                        sink.done();
                        return true;
                    }
                    UnityAutoTranslator::detectStream(path, [&](const std::string& line) {
                        sink.write(line.data(), line.size());
                    });
                    sink.done();
                    return true;
                });
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/unity/launch", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            const std::string path = body.value("path", "");
            const auto result = UnityAutoTranslator::launch(path);
            res.set_content(json{
                {"ok", result.ok},
                {"error", result.error},
                {"gameDir", result.gameDir},
                {"gameExe", result.gameExe},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/unity/launch-patch", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            const std::string path = body.value("path", "");
            const auto result = UnityAutoTranslator::launchPatchAndRun(path);
            res.set_content(json{
                {"ok", result.ok},
                {"error", result.error},
                {"gameDir", result.gameDir},
                {"gameExe", result.gameExe},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/unity/self-check", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            const std::string path = body.value("path", "");
            const auto result = UnityAutoTranslator::selfCheck(path);
            json checks = json::array();
            for (const auto& c : result.checks)
            {
                checks.push_back({
                    {"id", c.id},
                    {"level", c.level},
                    {"title", c.title},
                    {"detail", c.detail},
                });
            }
            res.set_content(json{
                {"ok", result.ok},
                {"error", result.error},
                {"gameDir", result.gameDir},
                {"verdict", result.verdict},
                {"verdictLabel", result.verdictLabel},
                {"summary", result.summary},
                {"gameArch", result.gameArch},
                {"loaderArch", result.loaderArch},
                {"runtime", result.runtime},
                {"checks", checks},
                {"suggestions", result.suggestions},
                {"hasLog", result.hasLog},
                {"logPath", result.logPath},
                {"logSnippet", result.logSnippet},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/unity/output-log", withCors([this](const httplib::Request& req, httplib::Response& res) {
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
            const fs::path logPath = dataDirectory(config_) / "unity-output.log";
            appendFileUtf8(logPath, text);
            if (!text.empty() && text.back() != '\n')
                appendFileUtf8(logPath, "\n");
            res.set_content(
                json{{"ok", true}, {"logPath", logPath.string()}}.dump(),
                "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Get("/api/unity/output-log", withCors([this](const httplib::Request& req, httplib::Response& res) {
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
            const fs::path logPath = dataDirectory(config_) / "unity-output.log";
            std::error_code ec;
            const bool exists = fs::exists(logPath, ec);
            const std::string text = exists ? readFileTailLines(logPath, lines) : "";
            res.set_content(
                json{
                    {"ok", true},
                    {"logPath", logPath.string()},
                    {"exists", exists},
                    {"text", text},
                }
                    .dump(),
                "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/unity/install", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            UnityInstallRequest ir;
            ir.gamePath = body.value("path", "");
            ir.language = body.value("language", "zh-CN");
            ir.fromLanguage = body.value("fromLanguage", "ja");
            ir.endpoint = body.value("endpoint", "GoogleTranslate");
            ir.fallbackEndpoint = body.value("fallbackEndpoint", "");
            ir.runSetup = body.value("runSetup", true);
            ir.configIni = body.value("configIni", "");
            const auto result = UnityAutoTranslator::install(ir);
            res.set_content(json{
                {"ok", result.ok},
                {"error", result.error},
                {"gameDir", result.gameDir},
                {"package", result.package},
                {"version", result.version},
                {"configPath", result.configPath},
                {"installMethod", result.installMethod},
                {"steps", result.steps},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/unity/fix-font", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            UnityFixFontRequest fr;
            fr.gamePath = body.value("path", "");
            fr.language = body.value("language", "zh-CN");
            const auto result = UnityAutoTranslator::fixFont(fr);
            res.set_content(json{
                {"ok", result.ok},
                {"error", result.error},
                {"gameDir", result.gameDir},
                {"package", result.package},
                {"version", result.version},
                {"configPath", result.configPath},
                {"installMethod", result.installMethod},
                {"steps", result.steps},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/unity/uninstall", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            UnityUninstallRequest ur;
            ur.gamePath = body.value("path", "");
            const auto result = UnityAutoTranslator::uninstall(ur);
            res.set_content(json{
                {"ok", result.ok},
                {"error", result.error},
                {"gameDir", result.gameDir},
                {"installMethod", result.installMethod},
                {"steps", result.steps},
                {"removed", result.removed},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/unity/install-loader", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            UnityLoaderRequest lr;
            lr.gamePath = body.value("path", "");
            const auto result = UnityAutoTranslator::installLoader(lr);
            res.set_content(json{
                {"ok", result.ok},
                {"error", result.error},
                {"gameDir", result.gameDir},
                {"package", result.package},
                {"version", result.version},
                {"installMethod", result.installMethod},
                {"steps", result.steps},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/unity/uninstall-loader", withCors([](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            UnityLoaderRequest lr;
            lr.gamePath = body.value("path", "");
            const auto result = UnityAutoTranslator::uninstallLoader(lr);
            res.set_content(json{
                {"ok", result.ok},
                {"error", result.error},
                {"gameDir", result.gameDir},
                {"installMethod", result.installMethod},
                {"steps", result.steps},
                {"removed", result.removed},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    const int port = config_.snapshot().port;
    std::cout << "LLMChat backend listening on http://127.0.0.1:" << port << std::endl;
    if (!svr.listen("127.0.0.1", port))
    {
        std::cerr << "Failed to bind 127.0.0.1:" << port << std::endl;
        return 1;
    }
    return 0;
}
