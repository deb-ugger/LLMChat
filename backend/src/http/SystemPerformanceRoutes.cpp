#include "SystemPerformanceRoutes.h"
#include "HttpRouter.h"
#include "SystemPerformance.h"

#include <charconv>
#include <chrono>
#include <limits>
#include <memory>
#include <optional>
#include <string_view>

namespace http_router {
namespace {

using Json = nlohmann::json;

void error(httplib::Response& res, int status, const char* code, const char* message) {
    res.status = status;
    res.set_content(Json{{"ok", false}, {"code", code}, {"error", message}}.dump(), "application/json; charset=utf-8");
}

std::optional<int64_t> number(std::string_view text) {
    int64_t value = 0;
    const auto [end, ec] = std::from_chars(text.data(), text.data() + text.size(), value);
    if (ec != std::errc{} || end != text.data() + text.size() || value < 0) return {};
    return value;
}

std::optional<int64_t> timestamp(std::string_view text) {
    if (text.size() != 24 || text[4] != '-' || text[7] != '-' || text[10] != 'T' ||
        text[13] != ':' || text[16] != ':' || text[19] != '.' || text[23] != 'Z') return {};
    const auto y = number(text.substr(0, 4)), m = number(text.substr(5, 2)), d = number(text.substr(8, 2));
    const auto h = number(text.substr(11, 2)), min = number(text.substr(14, 2)), sec = number(text.substr(17, 2));
    const auto ms = number(text.substr(20, 3));
    if (!y || !m || !d || !h || !min || !sec || !ms || *h > 23 || *min > 59 || *sec > 59) return {};
    using namespace std::chrono;
    const auto date = year{static_cast<int>(*y)} / static_cast<unsigned>(*m) / static_cast<unsigned>(*d);
    if (!date.ok()) return {};
    const auto result = sys_days(date) + hours(*h) + minutes(*min) + seconds(*sec) + milliseconds(*ms);
    return duration_cast<milliseconds>(result.time_since_epoch()).count();
}

bool validRunKey(std::string_view taskId, std::string_view source) {
    return !taskId.empty() && taskId.size() <= 128 && (source == "benchmark" || source == "formal");
}

bool knownMetric(std::string_view name) {
    return name.empty() || name == "cpu" || name == "memory" || name == "disk" || name == "network" || name == "gpu";
}

} // namespace

void registerSystemPerformanceRoutes(httplib::Server& svr, const std::filesystem::path& logs, UsageStore& usage) {
    auto performance = std::make_shared<SystemPerformance>(logs, usage);
    svr.Get("/api/system-performance/now", withCors([performance](const httplib::Request&, httplib::Response& res) {
        res.set_content(performance->now().dump(), "application/json; charset=utf-8");
    }));
    svr.Get("/api/system-performance/history", withCors([performance](const httplib::Request& req, httplib::Response& res) {
        const auto from = req.has_param("from") ? number(req.get_param_value("from")) : std::optional<int64_t>{0};
        const auto to = req.has_param("to") ? number(req.get_param_value("to")) : std::optional<int64_t>{std::numeric_limits<int64_t>::max()};
        if (!from || !to || *from > *to) {
            error(res, 400, "INVALID_RANGE", "性能采样时间范围无效");
            return;
        }
        const auto metric = req.get_param_value("metric");
        if (!knownMetric(metric)) {
            error(res, 400, "INVALID_METRIC", "未知的性能指标");
            return;
        }
        res.set_content(performance->history(*from, *to, metric).dump(), "application/json; charset=utf-8");
    }));
    svr.Get("/api/system-performance/runs", withCors([performance](const httplib::Request& req, httplib::Response& res) {
        const auto taskId = req.get_param_value("taskId"), source = req.get_param_value("source");
        if (!validRunKey(taskId, source)) {
            error(res, 400, "INVALID_RUN", "性能归档编号无效");
            return;
        }
        res.set_content(performance->runs(taskId, source).dump(), "application/json; charset=utf-8");
    }));
    svr.Post("/api/system-performance/runs/start", withCors([performance](const httplib::Request& req, httplib::Response& res) {
        try {
            const auto body = Json::parse(req.body);
            const auto taskId = body.at("taskId").get<std::string>(), source = body.at("source").get<std::string>();
            const auto start = timestamp(body.at("beginTime").get<std::string>());
            if (!validRunKey(taskId, source) || !start || *start < 0) {
                error(res, 400, "INVALID_RUN", "性能归档记录无效");
                return;
            }
            if (!performance->begin(taskId, source, *start)) {
                error(res, 429, "ARCHIVE_BUSY", "正在采集的性能记录已满");
                return;
            }
        } catch (const Json::exception&) {
            error(res, 400, "INVALID_RUN", "性能归档记录无效");
            return;
        }
        res.status = 202;
        res.set_content(R"({"queued":true})", "application/json; charset=utf-8");
    }));
    svr.Post("/api/system-performance/runs", withCors([performance](const httplib::Request& req, httplib::Response& res) {
        try {
            const auto body = Json::parse(req.body);
            const auto taskId = body.at("taskId").get<std::string>();
            const auto source = body.at("source").get<std::string>();
            const auto start = timestamp(body.at("beginTime").get<std::string>());
            const auto end = timestamp(body.at("endedAt").get<std::string>());
            if (!validRunKey(taskId, source) || !start || !end || *start < 0 || *start > *end) {
                error(res, 400, "INVALID_RUN", "性能归档记录无效");
                return;
            }
            if (!performance->complete(taskId, source, *start, *end)) {
                error(res, 429, "ARCHIVE_BUSY", "性能归档队列已满");
                return;
            }
        } catch (const Json::exception&) {
            error(res, 400, "INVALID_RUN", "性能归档记录无效");
            return;
        }
        res.status = 202;
        res.set_content(R"({"queued":true})", "application/json; charset=utf-8");
    }));
}

} // namespace http_router
