#include "UsageStore.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <sstream>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace {

std::string trimCopy(std::string s)
{
    while (!s.empty() && (unsigned char)s.front() <= 0x20)
        s.erase(s.begin());
    while (!s.empty() && (unsigned char)s.back() <= 0x20)
        s.pop_back();
    return s;
}

std::string toLower(std::string s)
{
    for (char& c : s)
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s;
}

std::string makeId()
{
    using clock = std::chrono::system_clock;
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                        clock::now().time_since_epoch())
                        .count();
    static std::atomic<int> seq{0};
    const int n = seq.fetch_add(1);
    std::ostringstream oss;
    oss << "u" << ms << "-" << (n & 0xffff);
    return oss.str();
}

int localUtcOffsetMinutes()
{
#ifdef _WIN32
    TIME_ZONE_INFORMATION tzi{};
    const DWORD r = GetTimeZoneInformation(&tzi);
    long bias = tzi.Bias;
    if (r == TIME_ZONE_ID_DAYLIGHT)
        bias += tzi.DaylightBias;
    else if (r == TIME_ZONE_ID_STANDARD)
        bias += tzi.StandardBias;
    // Bias is minutes west of UTC; we want east-positive offset.
    return static_cast<int>(-bias);
#else
    const std::time_t t = std::time(nullptr);
    std::tm local{};
    std::tm utc{};
    localtime_r(&t, &local);
    gmtime_r(&t, &utc);
    return static_cast<int>(std::difftime(std::mktime(&local), timegm(&utc)) / 60);
#endif
}

} // namespace

UsageEvent UsageStore::makeEventSkeleton()
{
    UsageEvent ev;
    ev.id = makeId();

    const auto now = std::chrono::system_clock::now();
    const std::time_t t = std::chrono::system_clock::to_time_t(now);
    std::tm local{};
#ifdef _WIN32
    localtime_s(&local, &t);
#else
    localtime_r(&t, &local);
#endif

    char dateBuf[16];
    char timeBuf[16];
    char tsBuf[40];
    std::strftime(dateBuf, sizeof(dateBuf), "%Y-%m-%d", &local);
    std::strftime(timeBuf, sizeof(timeBuf), "%H:%M:%S", &local);

    const int offsetMin = localUtcOffsetMinutes();
    const char sign = offsetMin >= 0 ? '+' : '-';
    const int absMin = offsetMin >= 0 ? offsetMin : -offsetMin;
    std::snprintf(
        tsBuf,
        sizeof(tsBuf),
        "%sT%s%c%02d:%02d",
        dateBuf,
        timeBuf,
        sign,
        absMin / 60,
        absMin % 60);

    ev.ts = tsBuf;
    ev.date = dateBuf;
    ev.year = local.tm_year + 1900;
    ev.time = timeBuf;
    return ev;
}

std::string UsageStore::engineKindForProvider(const std::string& provider)
{
    const std::string p = toLower(trimCopy(provider));
    if (p.empty() || p == "llm")
        return "";
    if (p == "baidu" || p == "youdao" || p == "sogou" || p == "niutrans")
        return "keyed";
    return "free";
}

std::string UsageStore::hostFromApiUrl(const std::string& apiUrl)
{
    std::string u = trimCopy(apiUrl);
    if (u.empty())
        return "";
    const auto scheme = u.find("://");
    size_t start = scheme == std::string::npos ? 0 : scheme + 3;
    size_t end = u.find_first_of("/?#", start);
    if (end == std::string::npos)
        end = u.size();
    std::string host = u.substr(start, end - start);
    const auto at = host.rfind('@');
    if (at != std::string::npos)
        host = host.substr(at + 1);
    const auto colon = host.find(':');
    if (colon != std::string::npos)
        host = host.substr(0, colon);
    return toLower(host);
}

std::string UsageStore::vendorFromHostOrModel(
    const std::string& apiHost,
    const std::string& model,
    const std::string& hintVendor)
{
    const std::string hv = trimCopy(hintVendor);
    if (!hv.empty())
        return hv;

    const std::string h = toLower(apiHost);
    if (h.find("deepseek") != std::string::npos)
        return "DeepSeek";
    if (h.find("openai") != std::string::npos)
        return "OpenAI";
    if (h.find("googleapis") != std::string::npos || h.find("generativelanguage") != std::string::npos)
        return "Google";
    if (h.find("dashscope") != std::string::npos || h.find("aliyun") != std::string::npos)
        return "通义";

    const std::string m = toLower(model);
    if (m.find("deepseek") != std::string::npos)
        return "DeepSeek";
    if (m.rfind("gpt-", 0) == 0 || m.find("o1") == 0 || m.find("o3") == 0)
        return "OpenAI";
    if (m.find("gemini") != std::string::npos)
        return "Google";
    if (m.find("qwen") != std::string::npos)
        return "通义";

    if (!h.empty())
        return h;
    return "unknown";
}

UsageStore::UsageStore(std::string filePath)
    : path_(std::move(filePath))
{
}

json UsageStore::toJson(const UsageEvent& ev) const
{
    return json{
        {"id", ev.id},
        {"ts", ev.ts},
        {"date", ev.date},
        {"year", ev.year},
        {"time", ev.time},
        {"feature", ev.feature},
        {"ok", ev.ok},
        {"errorCode", ev.errorCode},
        {"channel", ev.channel},
        {"engineId", ev.engineId},
        {"engineKind", ev.engineKind},
        {"vendor", ev.vendor},
        {"model", ev.model},
        {"apiHost", ev.apiHost},
        {"promptTokens", ev.promptTokens},
        {"completionTokens", ev.completionTokens},
        {"totalTokens", ev.totalTokens},
        {"cacheReadTokens", ev.cacheReadTokens},
        {"cacheWriteTokens", ev.cacheWriteTokens},
        {"sourceChars", ev.sourceChars},
        {"endpoint", ev.endpoint},
        {"errorMessage", ev.errorMessage},
    };
}

void UsageStore::append(const UsageEvent& ev)
{
    std::lock_guard<std::mutex> lock(mu_);
    try
    {
        const fs::path p(path_);
        std::error_code ec;
        fs::create_directories(p.parent_path(), ec);
        std::ofstream out(p, std::ios::binary | std::ios::app);
        if (!out)
            return;
        out << toJson(ev).dump() << "\n";
    }
    catch (...)
    {
        // Never break API calls due to usage logging.
    }
}

void UsageStore::clear()
{
    std::lock_guard<std::mutex> lock(mu_);
    try
    {
        std::error_code ec;
        fs::remove(path_, ec);
    }
    catch (...)
    {
    }
}

bool UsageStore::dateInRange(
    const std::string& date,
    const std::string& fromDate,
    const std::string& toDate)
{
    if (!fromDate.empty() && date < fromDate)
        return false;
    if (!toDate.empty() && date > toDate)
        return false;
    return true;
}

std::vector<json> UsageStore::events(
    const std::string& fromDate,
    const std::string& toDate,
    const std::string& feature,
    const std::string& okFilter) const
{
    std::lock_guard<std::mutex> lock(mu_);
    std::vector<json> out;
    std::ifstream in(path_, std::ios::binary);
    if (!in)
        return out;

    std::string line;
    while (std::getline(in, line))
    {
        if (trimCopy(line).empty())
            continue;
        try
        {
            json row = json::parse(line);
            const std::string date = row.value("date", "");
            if (!dateInRange(date, fromDate, toDate))
                continue;
            if (!feature.empty() && row.value("feature", "") != feature)
                continue;
            if (okFilter == "ok" && !row.value("ok", false))
                continue;
            if (okFilter == "fail" && row.value("ok", false))
                continue;
            out.push_back(std::move(row));
        }
        catch (...)
        {
        }
    }
    return out;
}

json UsageStore::summary(
    const std::string& fromDate,
    const std::string& toDate,
    const std::string& feature,
    const std::string& groupBy,
    const std::string& okFilter) const
{
    const auto rows = events(fromDate, toDate, feature, okFilter);
    json buckets = json::object();

    auto keyOf = [&](const json& row) -> std::string {
        const std::string gb = groupBy.empty() ? "feature" : groupBy;
        if (gb == "day")
            return row.value("date", "unknown");
        if (gb == "engine")
        {
            const std::string ch = row.value("channel", "");
            if (ch == "llm")
                return "";
            const std::string id = row.value("engineId", "");
            const std::string kind = row.value("engineKind", "");
            if (id.empty())
                return "";
            return kind.empty() ? id : (id + "|" + kind);
        }
        if (gb == "llm")
        {
            if (row.value("channel", "") != "llm")
                return "";
            const std::string vendor = row.value("vendor", "unknown");
            const std::string model = row.value("model", "unknown");
            return vendor + "|" + model;
        }
        // feature
        return row.value("feature", "unknown");
    };

    for (const auto& row : rows)
    {
        const std::string key = keyOf(row);
        if (key.empty())
            continue;
        if (!buckets.contains(key))
        {
            buckets[key] = {
                {"key", key},
                {"requests", 0},
                {"ok", 0},
                {"fail", 0},
                {"promptTokens", 0},
                {"completionTokens", 0},
                {"totalTokens", 0},
                {"cacheReadTokens", 0},
                {"cacheWriteTokens", 0},
                {"sourceChars", 0},
            };
        }
        auto& b = buckets[key];
        b["requests"] = b.value("requests", 0) + 1;
        if (row.value("ok", false))
            b["ok"] = b.value("ok", 0) + 1;
        else
            b["fail"] = b.value("fail", 0) + 1;
        b["promptTokens"] = b.value("promptTokens", 0) + row.value("promptTokens", 0);
        b["completionTokens"] =
            b.value("completionTokens", 0) + row.value("completionTokens", 0);
        b["totalTokens"] = b.value("totalTokens", 0) + row.value("totalTokens", 0);
        b["cacheReadTokens"] =
            b.value("cacheReadTokens", 0) + row.value("cacheReadTokens", 0);
        b["cacheWriteTokens"] =
            b.value("cacheWriteTokens", 0) + row.value("cacheWriteTokens", 0);
        b["sourceChars"] = b.value("sourceChars", 0) + row.value("sourceChars", 0);
    }

    json items = json::array();
    for (auto it = buckets.begin(); it != buckets.end(); ++it)
    {
        const auto& b = it.value();
        const int requests = b.value("requests", 0);
        const int totalTokens = b.value("totalTokens", 0);
        if (requests <= 0 && totalTokens <= 0)
            continue;
        items.push_back(b);
    }

    return json{
        {"ok", true},
        {"groupBy", groupBy.empty() ? "feature" : groupBy},
        {"items", items},
        {"totalEvents", static_cast<int>(rows.size())},
    };
}
