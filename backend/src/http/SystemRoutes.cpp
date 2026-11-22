#include "SystemRoutes.h"
#include "HttpRouter.h"
#include "TextRoutes.h"
#include "AtomicFile.h"
#include "Config.h"
#include "PricingStore.h"
#include "StoragePaths.h"
#include "UsageStore.h"
#include "Utf8Path.h"

#include <algorithm>
#include <exception>
#include <fstream>
#include <iterator>
#include <mutex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

std::mutex& configUpdateMutex();

namespace http_router
{
using json = nlohmann::json;
namespace fs = std::filesystem;

fs::path dataDirectory(const ConfigStore& config)
{
    return fs::path(config.path()).parent_path();
}

namespace
{
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
}

void registerSystemRoutes(httplib::Server& svr, UsageStore& usage_, PricingStore& pricing_)
{
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

    const auto requestCurrency = [&pricing_](const httplib::Request& req) {
        auto currency = req.get_param_value("currency");
        return currency.empty() ? pricing_.displayCurrency() : currency;
    };
    const auto eventBand = [&pricing_](const json& row) -> std::string {
        if (row.value("channel", "") == "llm") {
            auto band = pricing_.bandFor(row.value("model", ""), row.value("date", ""), row.value("time", ""));
            if (!band.empty()) return band;
        }
        return "flat";
    };
    const auto pricedEvents = [&usage_, &pricing_, eventBand](const httplib::Request& req, const std::string& currency) {
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

    svr.Get("/api/usage/report", withCors([&usage_, &pricing_, requestCurrency, eventBand](const httplib::Request& req, httplib::Response& res) {
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

    svr.Delete("/api/usage", withCors([&usage_](const httplib::Request&, httplib::Response& res) {
        usage_.clear();
        res.set_content(json{{"ok", true}}.dump(), "application/json");
    }));

    svr.Get("/api/pricing", withCors([&pricing_](const httplib::Request&, httplib::Response& res) {
        json table = pricing_.get();
        table["ok"] = true;
        res.set_content(table.dump(), "application/json; charset=utf-8");
    }));

    svr.Put("/api/pricing", withCors([&pricing_](const httplib::Request& req, httplib::Response& res) {
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
}

void registerSettingsRoutes(httplib::Server& svr, ConfigStore& config_)
{
    svr.Get("/api/settings", withCors([&config_](const httplib::Request&, httplib::Response& res) {
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

    svr.Put("/api/settings", withCors([&config_](const httplib::Request& req, httplib::Response& res) {
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
}

void registerOutputLogRoutes(httplib::Server& svr, const ConfigStore& config_)
{
    static std::mutex outputLogMutex;
    svr.Post(R"(/api/(?:unity/)?output-log)", withCors([&config_](const httplib::Request& req, httplib::Response& res) {
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

    svr.Get(R"(/api/(?:unity/)?output-log)", withCors([&config_](const httplib::Request& req, httplib::Response& res) {
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
}

}
