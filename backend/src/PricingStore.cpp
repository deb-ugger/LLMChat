#include "PricingStore.h"
#include "AtomicFile.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <map>
#include <set>
#include <sstream>
#include <vector>

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
std::string toUpper(std::string s)
{
    for (char& c : s)
        c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return s;
}

std::string makeRuleId()
{
    using clock = std::chrono::system_clock;
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                        clock::now().time_since_epoch())
                        .count();
    static std::atomic<int> seq{0};
    const int n = seq.fetch_add(1);
    std::ostringstream oss;
    oss << "p" << ms << "-" << (n & 0xffff);
    return oss.str();
}

json rateObj(double input, double output, double cacheRead, double cacheWrite)
{
    return json{
        {"input", input},
        {"output", output},
        {"cacheRead", cacheRead},
        {"cacheWrite", cacheWrite},
    };
}

json rule(
    const std::string& vendor,
    const std::string& model,
    const std::string& from,
    const json& rates,
    const std::string& to = "",
    const json& idleRates = json(),
    const json& peakWindows = json::array())
{
    json o = json{
        {"id", makeRuleId()},
        {"vendor", vendor},
        {"model", model},
        {"from", from},
        {"to", to},
        {"rates", rates},
        {"peakWindows", peakWindows.is_array() ? peakWindows : json::array()},
        {"locked", true},
    };
    if (idleRates.is_object() && !idleRates.empty())
        o["idleRates"] = idleRates;
    return o;
}

json halfRateObj(const json& r)
{
    return rateObj(
        r.value("input", 0.0) / 2.0,
        r.value("output", 0.0) / 2.0,
        r.value("cacheRead", 0.0) / 2.0,
        r.value("cacheWrite", 0.0) / 2.0);
}

json deepSeekPeakWindows()
{
    // Legacy single-window peak used by built-in baseline defaults.
    // Latest official dual windows are applied via frontend date-interval append.
    return json::array({json{{"from", "08:30"}, {"to", "00:30"}}});
}

/** Minutes from midnight; -1 if invalid. Accepts HH:MM or HH:MM:SS. */
int parseTimeMinutes(const std::string& raw)
{
    const std::string s = trimCopy(raw);
    int h = 0, m = 0, sec = 0;
    if (s.size() >= 5 && std::sscanf(s.c_str(), "%d:%d:%d", &h, &m, &sec) >= 2)
    {
        if (h < 0 || h > 23 || m < 0 || m > 59)
            return -1;
        return h * 60 + m;
    }
    return -1;
}

bool isInHalfOpenTimeRange(
    const std::string& time,
    const std::string& from,
    const std::string& to)
{
    const int t = parseTimeMinutes(time);
    const int a = parseTimeMinutes(from);
    const int b = parseTimeMinutes(to);
    if (t < 0 || a < 0 || b < 0)
        return false;
    if (a == b)
        return false;
    if (a < b)
        return t >= a && t < b;
    return t >= a || t < b;
}

/** Empty peakWindows → not peak (list priority decides the sub-rule). */
bool isPeakLocalTime(const std::string& time, const json& peakWindows)
{
    if (!peakWindows.is_array() || peakWindows.empty())
        return false;
    for (const auto& w : peakWindows)
    {
        if (!w.is_object())
            continue;
        if (isInHalfOpenTimeRange(
                time,
                trimCopy(w.value("from", "")),
                trimCopy(w.value("to", ""))))
            return true;
    }
    return false;
}

/** 1=Mon … 7=Sun. Empty or all seven → every day. */
json normalizePeakWeekdays(const json& raw)
{
    std::set<int> days;
    if (raw.is_array())
    {
        for (const auto& item : raw)
        {
            int n = 0;
            if (item.is_number_integer())
                n = item.get<int>();
            else if (item.is_number())
                n = static_cast<int>(item.get<double>());
            else if (item.is_string())
            {
                try
                {
                    n = std::stoi(trimCopy(item.get<std::string>()));
                }
                catch (...)
                {
                    continue;
                }
            }
            else
                continue;
            if (n >= 1 && n <= 7)
                days.insert(n);
        }
    }
    json out = json::array();
    if (days.size() == 7)
        return out;
    for (int d : days)
        out.push_back(d);
    return out;
}

/** Local ISO weekday from YYYY-MM-DD; 0 if invalid. */
int isoWeekdayFromDate(const std::string& iso)
{
    const std::string s = trimCopy(iso);
    int y = 0, mo = 0, d = 0;
    if (s.size() != 10 || std::sscanf(s.c_str(), "%d-%d-%d", &y, &mo, &d) != 3)
        return 0;
    std::tm tm{};
    tm.tm_year = y - 1900;
    tm.tm_mon = mo - 1;
    tm.tm_mday = d;
    tm.tm_isdst = -1;
    const std::time_t t = std::mktime(&tm);
    if (t == -1)
        return 0;
#ifdef _WIN32
    localtime_s(&tm, &t);
#else
    localtime_r(&t, &tm);
#endif
    return tm.tm_wday == 0 ? 7 : tm.tm_wday;
}

bool weekdayAllowsPeak(const json& peakWeekdays, const std::string& date)
{
    if (!peakWeekdays.is_array() || peakWeekdays.empty())
        return true;
    const int wd = isoWeekdayFromDate(date);
    if (wd <= 0)
        return true;
    for (const auto& item : peakWeekdays)
    {
        if (item.is_number_integer() && item.get<int>() == wd)
            return true;
    }
    return false;
}

bool ratesRoughlyEqual(const json& a, const json& b)
{
    if (!a.is_object() || !b.is_object())
        return false;
    return a.value("input", 0.0) == b.value("input", 0.0)
        && a.value("output", 0.0) == b.value("output", 0.0)
        && a.value("cacheRead", 0.0) == b.value("cacheRead", 0.0)
        && a.value("cacheWrite", 0.0) == b.value("cacheWrite", 0.0);
}

std::string defaultVendorCurrency(const std::string& vendor)
{
    const std::string v = trimCopy(vendor);
    if (v == "DeepSeek" || v == "通义千问")
        return "CNY";
    return "USD";
}

} // namespace

json PricingStore::defaultTable()
{
    return json{
        {"displayCurrency", "CNY"},
        {"vendorCurrencies",
         {{"DeepSeek", "CNY"},
          {"OpenAI", "USD"},
          {"Google", "USD"},
          {"通义千问", "CNY"}}},
        {"lockedModels", json::array()},
        {"rules", json::array()},
    };
}

PricingStore::PricingStore(std::string filePath)
    : path_(std::move(filePath))
{
    std::lock_guard<std::mutex> lock(mu_);
    loadUnlocked();
    rebuildRuleIndexUnlocked();
}

void PricingStore::rebuildRuleIndexUnlocked()
{
    ruleIndexesByModel_.clear();
    if (!table_.contains("rules") || !table_["rules"].is_array())
        return;
    const auto& rules = table_["rules"];
    for (size_t i = 0; i < rules.size(); ++i)
    {
        const auto& rule = rules[i];
        if (!rule.is_object())
            continue;
        const std::string model = trimCopy(rule.value("model", ""));
        if (!model.empty())
            ruleIndexesByModel_[model].push_back(i);
    }
}

void PricingStore::loadUnlocked()
{
    try
    {
        const fs::path p(path_);
        if (!fs::exists(p))
        {
            table_ = defaultTable();
            saveUnlocked();
            return;
        }
        std::ifstream in(p, std::ios::binary);
        if (!in)
        {
            table_ = defaultTable();
            saveUnlocked();
            return;
        }
        json root;
        in >> root;
        json normalized;
        const std::string err = validateTable(root, normalized);
        if (!err.empty())
        {
            table_ = defaultTable();
            saveUnlocked();
            return;
        }
        table_ = std::move(normalized);
    }
    catch (...)
    {
        table_ = defaultTable();
        try
        {
            saveUnlocked();
        }
        catch (...)
        {
        }
    }
}

bool PricingStore::saveUnlocked() const
{
    return atomicfile::writeText(fs::path(path_), table_.dump(2));
}

json PricingStore::get() const
{
    std::lock_guard<std::mutex> lock(mu_);
    return table_;
}

std::string PricingStore::displayCurrency() const
{
    std::lock_guard<std::mutex> lock(mu_);
    return normalizeCurrency(table_.value("displayCurrency", "CNY"));
}

std::string PricingStore::put(const json& body)
{
    json normalized;
    const std::string err = validateTable(body, normalized);
    if (!err.empty())
        return err;
    std::lock_guard<std::mutex> lock(mu_);
    table_ = std::move(normalized);
    rebuildRuleIndexUnlocked();
    if (!saveUnlocked())
        return "failed to write pricing.json";
    return "";
}

std::string PricingStore::normalizeCurrency(const std::string& c)
{
    const std::string u = toUpper(trimCopy(c));
    if (u == "USD")
        return "USD";
    return "CNY";
}

TokenRates PricingStore::ratesFromJson(const json& o)
{
    TokenRates r;
    if (!o.is_object())
        return r;
    r.input = o.value("input", 0.0);
    r.output = o.value("output", 0.0);
    r.cacheRead = o.value("cacheRead", 0.0);
    r.cacheWrite = o.value("cacheWrite", 0.0);
    return r;
}

json PricingStore::ratesToJson(const TokenRates& r)
{
    return rateObj(r.input, r.output, r.cacheRead, r.cacheWrite);
}

bool PricingStore::dateInHalfOpen(
    const std::string& date,
    const std::string& from,
    const std::string& to)
{
    if (date.empty())
        return false;
    if (!from.empty() && date < from)
        return false;
    // Inclusive [from, to]; empty to = open-ended
    if (!to.empty() && date > to)
        return false;
    return true;
}

std::string PricingStore::validateTable(const json& body, json& out)
{
    if (!body.is_object())
        return "body must be an object";

    const std::string currency = normalizeCurrency(body.value("displayCurrency", "CNY"));
    if (!body.contains("rules") || !body["rules"].is_array())
        return "rules must be an array";

    json vendorCurrencies = json::object();
    if (body.contains("vendorCurrencies") && body["vendorCurrencies"].is_object())
    {
        for (auto it = body["vendorCurrencies"].begin(); it != body["vendorCurrencies"].end();
             ++it)
        {
            const std::string vendor = trimCopy(it.key());
            if (vendor.empty())
                continue;
            if (!it.value().is_string())
                return "vendorCurrencies values must be CNY or USD";
            vendorCurrencies[vendor] = normalizeCurrency(it.value().get<std::string>());
        }
    }

    auto checkRates = [](const json& r, const char* name) -> std::string {
        if (!r.is_object())
            return std::string(name) + " rates required";
        for (const char* k : {"input", "output", "cacheRead", "cacheWrite"})
        {
            if (!r.contains(k) || !r[k].is_number())
                return std::string(name) + "." + k + " must be a number";
            if (r[k].get<double>() < 0)
                return std::string(name) + "." + k + " must be >= 0";
        }
        return "";
    };

    json rules = json::array();
    std::set<std::string> legacyLockedModels;
    bool hasLegacyLockedModels = false;
    if (body.contains("lockedModels") && body["lockedModels"].is_array())
    {
        hasLegacyLockedModels = true;
        for (const auto& item : body["lockedModels"])
        {
            if (!item.is_string())
                return "lockedModels entries must be strings";
            const std::string m = trimCopy(item.get<std::string>());
            if (!m.empty())
                legacyLockedModels.insert(m);
        }
    }

    for (const auto& item : body["rules"])
    {
        if (!item.is_object())
            return "each rule must be an object";
        const std::string model = trimCopy(item.value("model", ""));
        if (model.empty())
            return "rule.model required";
        const std::string vendor = trimCopy(item.value("vendor", ""));
        const std::string from = trimCopy(item.value("from", ""));
        if (!from.empty() && from.size() != 10)
            return "rule.from must be YYYY-MM-DD or empty (open start)";
        std::string to = trimCopy(item.value("to", ""));
        if (!to.empty() && to.size() != 10)
            return "rule.to must be YYYY-MM-DD or empty (open end)";
        if (!from.empty() && !to.empty() && to < from)
            return "rule.to must be on or after rule.from";

        std::string vendorCur = defaultVendorCurrency(vendor);
        if (vendorCurrencies.contains(vendor))
            vendorCur = normalizeCurrency(vendorCurrencies[vendor].get<std::string>());
        else if (!vendor.empty())
            vendorCurrencies[vendor] = vendorCur;

        json ratesIn;
        if (item.contains("rates") && item["rates"].is_object())
        {
            ratesIn = item["rates"];
        }
        else
        {
            // Migrate legacy dual cny/usd → single rates by vendor currency
            const char* key = vendorCur == "USD" ? "usd" : "cny";
            ratesIn = item.contains(key) ? item[key] : json::object();
        }
        if (auto e = checkRates(ratesIn, "rates"); !e.empty())
            return e;

        json idleRatesOut = json();
        if (item.contains("idleRates") && item["idleRates"].is_object())
        {
            if (auto e = checkRates(item["idleRates"], "idleRates"); !e.empty())
                return e;
            idleRatesOut = ratesToJson(ratesFromJson(item["idleRates"]));
        }
        else
        {
            // Always persist idleRates (default = peak rates) so UI can show both.
            idleRatesOut = ratesToJson(ratesFromJson(ratesIn));
        }

        json peakWindowsOut = json::array();
        if (item.contains("peakWindows") && item["peakWindows"].is_array())
        {
            for (const auto& w : item["peakWindows"])
            {
                if (!w.is_object())
                    return "peakWindows entries must be objects";
                const std::string pf = trimCopy(w.value("from", ""));
                const std::string pt = trimCopy(w.value("to", ""));
                if (parseTimeMinutes(pf) < 0 || parseTimeMinutes(pt) < 0)
                    return "peakWindows.from/to must be HH:MM";
                peakWindowsOut.push_back(json{{"from", pf}, {"to", pt}});
            }
        }
        else
        {
            // Migrate legacy global dayParts only when idle rates differ from peak.
            std::string idleFrom = "00:30";
            std::string idleTo = "08:30";
            if (body.contains("dayParts") && body["dayParts"].is_object())
            {
                idleFrom = trimCopy(body["dayParts"].value("idleFrom", idleFrom));
                idleTo = trimCopy(body["dayParts"].value("idleTo", idleTo));
            }
            const json peakRates = ratesToJson(ratesFromJson(ratesIn));
            if (!ratesRoughlyEqual(peakRates, idleRatesOut)
                && parseTimeMinutes(idleFrom) >= 0
                && parseTimeMinutes(idleTo) >= 0
                && idleFrom != idleTo)
            {
                // idle [idleFrom, idleTo) → peak complement [idleTo, idleFrom)
                peakWindowsOut.push_back(json{{"from", idleTo}, {"to", idleFrom}});
            }
        }

        std::string id = trimCopy(item.value("id", ""));
        if (id.empty())
            id = makeRuleId();

        bool locked = true;
        if (item.contains("locked") && item["locked"].is_boolean())
            locked = item["locked"].get<bool>();
        else if (hasLegacyLockedModels)
            locked = legacyLockedModels.count(model) > 0;
        // else: missing both → default lock

        json peakWeekdaysOut = json::array();
        if (item.contains("peakWeekdays"))
            peakWeekdaysOut = normalizePeakWeekdays(item["peakWeekdays"]);

        json subRulesOut = json::array();
        if (item.contains("subRules") && item["subRules"].is_array())
        {
            for (const auto& s : item["subRules"])
            {
                if (!s.is_object())
                    return "subRules entries must be objects";
                json srates = s.contains("rates") && s["rates"].is_object()
                    ? s["rates"]
                    : json::object();
                if (auto e = checkRates(srates, "subRules.rates"); !e.empty())
                    return e;
                std::string sid = trimCopy(s.value("id", ""));
                if (sid.empty())
                    sid = makeRuleId();
                const std::string bandRaw = trimCopy(s.value("band", "peak"));
                subRulesOut.push_back(json{
                    {"id", sid},
                    {"band", bandRaw == "idle" ? "idle" : "peak"},
                    {"peakWeekdays",
                     s.contains("peakWeekdays")
                         ? normalizePeakWeekdays(s["peakWeekdays"])
                         : json::array()},
                    {"rates", ratesToJson(ratesFromJson(srates))},
                });
            }
        }
        if (subRulesOut.empty())
        {
            json idleCopy = idleRatesOut.is_object() ? idleRatesOut : ratesToJson(ratesFromJson(ratesIn));
            json peakCopy = ratesToJson(ratesFromJson(ratesIn));
            subRulesOut.push_back(json{
                {"id", makeRuleId()},
                {"band", "idle"},
                {"peakWeekdays", peakWeekdaysOut},
                {"rates", idleCopy},
            });
            subRulesOut.push_back(json{
                {"id", makeRuleId()},
                {"band", "peak"},
                {"peakWeekdays", peakWeekdaysOut},
                {"rates", peakCopy},
            });
        }

        json row = json{
            {"id", id},
            {"vendor", vendor},
            {"model", model},
            {"from", from},
            {"to", to},
            {"rates", ratesToJson(ratesFromJson(ratesIn))},
            {"idleRates", idleRatesOut},
            {"peakWindows", peakWindowsOut},
            {"peakWeekdays", peakWeekdaysOut},
            {"subRules", subRulesOut},
            {"locked", locked},
        };
        rules.push_back(std::move(row));
    }

    // Same model: no overlapping inclusive ranges [from, to]
    {
        auto startKey = [](const json& r) -> std::string {
            const std::string f = r.value("from", "");
            return f.empty() ? std::string("0000-01-01") : f;
        };
        auto endKey = [](const json& r) -> std::string {
            const std::string t = r.value("to", "");
            return t.empty() ? std::string("9999-12-31") : t;
        };
        auto overlaps = [&](const json& a, const json& b) -> bool {
            return startKey(a) <= endKey(b) && startKey(b) <= endKey(a);
        };

        for (size_t i = 0; i < rules.size(); ++i)
        {
            for (size_t j = i + 1; j < rules.size(); ++j)
            {
                if (rules[i].value("model", "") != rules[j].value("model", ""))
                    continue;
                if (overlaps(rules[i], rules[j]))
                {
                    return "overlapping date ranges for model "
                        + rules[i].value("model", std::string());
                }
            }
        }

        // Continuity: sorted by from, next.from == prev.to + 1 day
        auto addOneDay = [](const std::string& iso) -> std::string {
            if (iso.size() != 10)
                return "";
            int y = 0, mo = 0, d = 0;
            if (std::sscanf(iso.c_str(), "%d-%d-%d", &y, &mo, &d) != 3)
                return "";
            std::tm tm{};
            tm.tm_year = y - 1900;
            tm.tm_mon = mo - 1;
            tm.tm_mday = d + 1;
            tm.tm_isdst = -1;
            const std::time_t t = std::mktime(&tm);
            if (t == -1)
                return "";
            std::tm out{};
#ifdef _WIN32
            localtime_s(&out, &t);
#else
            localtime_r(&t, &out);
#endif
            char buf[16];
            std::snprintf(buf, sizeof(buf), "%04d-%02d-%02d", out.tm_year + 1900, out.tm_mon + 1, out.tm_mday);
            return buf;
        };

        std::map<std::string, std::vector<json>> byModel;
        for (const auto& r : rules)
            byModel[r.value("model", "")].push_back(r);

        for (auto& [model, list] : byModel)
        {
            std::sort(list.begin(), list.end(), [&](const json& a, const json& b) {
                return startKey(a) < startKey(b);
            });
            for (size_t i = 0; i < list.size(); ++i)
            {
                const std::string from = list[i].value("from", "");
                const std::string to = list[i].value("to", "");
                if (i > 0 && from.empty())
                    return "only first range may have open start for model " + model;
                if (i + 1 < list.size() && to.empty())
                    return "open end only allowed on last range for model " + model;
                if (i > 0)
                {
                    const std::string prevTo = list[i - 1].value("to", "");
                    if (prevTo.empty())
                        return "cannot continue after open-ended range for model " + model;
                    const std::string expect = addOneDay(prevTo);
                    if (expect.empty() || from != expect)
                        return "non-contiguous date ranges for model " + model;
                }
            }
        }
    }

    json lockedModels = json::array();
    if (body.contains("lockedModels") && body["lockedModels"].is_array())
    {
        for (const auto& item : body["lockedModels"])
        {
            if (!item.is_string())
                return "lockedModels entries must be strings";
            const std::string m = trimCopy(item.get<std::string>());
            if (!m.empty())
                lockedModels.push_back(m);
        }
    }
    else
    {
        // Legacy tables without lockedModels: level-1 lock every model
        std::map<std::string, bool> seen;
        for (const auto& r : rules)
        {
            const std::string m = r.value("model", "");
            if (m.empty() || seen[m])
                continue;
            seen[m] = true;
            lockedModels.push_back(m);
        }
    }

    // dayParts is legacy; keep if provided for old clients, otherwise omit.
    json outObj = json{
        {"displayCurrency", currency},
        {"vendorCurrencies", vendorCurrencies},
        {"lockedModels", lockedModels},
        {"rules", rules},
    };
    if (body.contains("dayParts") && body["dayParts"].is_object())
    {
        const std::string idleFrom =
            trimCopy(body["dayParts"].value("idleFrom", "00:30"));
        const std::string idleTo =
            trimCopy(body["dayParts"].value("idleTo", "08:30"));
        if (parseTimeMinutes(idleFrom) < 0)
            return "dayParts.idleFrom must be HH:MM";
        if (parseTimeMinutes(idleTo) < 0)
            return "dayParts.idleTo must be HH:MM";
        outObj["dayParts"] = json{{"idleFrom", idleFrom}, {"idleTo", idleTo}};
    }
    out = std::move(outObj);
    return "";
}

std::optional<TokenRates> PricingStore::ratesFor(
    const std::string& model,
    const std::string& date,
    const std::string& currency,
    const std::string& time) const
{
    const std::string m = trimCopy(model);
    if (m.empty())
        return std::nullopt;

    std::lock_guard<std::mutex> lock(mu_);
    const std::string cur = normalizeCurrency(currency);
    const json& rules = table_.contains("rules") ? table_["rules"] : json::array();
    const json& vendorCurrencies =
        table_.contains("vendorCurrencies") && table_["vendorCurrencies"].is_object()
            ? table_["vendorCurrencies"]
            : json::object();

    const json* best = nullptr;
    std::string bestFrom;
    const auto candidates = ruleIndexesByModel_.find(m);
    if (candidates == ruleIndexesByModel_.end())
        return std::nullopt;
    for (const size_t index : candidates->second)
    {
        if (index >= rules.size())
            continue;
        const auto& r = rules[index];
        if (!r.is_object())
            continue;
        const std::string from = trimCopy(r.value("from", ""));
        const std::string to = trimCopy(r.value("to", ""));
        if (!dateInHalfOpen(date, from, to))
            continue;
        // Prefer latest from among overlaps (empty from = oldest)
        if (!best || from > bestFrom
            || (from == bestFrom && trimCopy((*best).value("to", "")).empty()
                && !to.empty()))
        {
            best = &r;
            bestFrom = from;
        }
    }
    if (!best)
        return std::nullopt;

    const std::string vendor = trimCopy(best->value("vendor", ""));
    std::string vendorCur = defaultVendorCurrency(vendor);
    if (vendorCurrencies.contains(vendor) && vendorCurrencies[vendor].is_string())
        vendorCur = normalizeCurrency(vendorCurrencies[vendor].get<std::string>());

    // Stats filter currency must match vendor billing currency (no FX).
    if (vendorCur != cur)
        return std::nullopt;

    // Prefer per-rule peakWindows; fall back to legacy table dayParts.
    json peakWindows = json::array();
    if (best->contains("peakWindows") && (*best)["peakWindows"].is_array())
    {
        peakWindows = (*best)["peakWindows"];
    }
    else if (table_.contains("dayParts") && table_["dayParts"].is_object())
    {
        const std::string idleFrom =
            trimCopy(table_["dayParts"].value("idleFrom", "00:30"));
        const std::string idleTo =
            trimCopy(table_["dayParts"].value("idleTo", "08:30"));
        if (parseTimeMinutes(idleFrom) >= 0 && parseTimeMinutes(idleTo) >= 0
            && idleFrom != idleTo)
            peakWindows = json::array({json{{"from", idleTo}, {"to", idleFrom}}});
    }

    json peakWeekdays = json::array();
    if (best->contains("peakWeekdays"))
        peakWeekdays = normalizePeakWeekdays((*best)["peakWeekdays"]);

    const bool hasWindows = peakWindows.is_array() && !peakWindows.empty();
    const bool clockPeak =
        hasWindows && (time.empty() || isPeakLocalTime(time, peakWindows));
    if (best->contains("subRules") && (*best)["subRules"].is_array()
        && !(*best)["subRules"].empty())
    {
        const json* picked = nullptr;
        const json* firstWeekday = nullptr;
        for (const auto& s : (*best)["subRules"])
        {
            if (!s.is_object())
                continue;
            json days = s.contains("peakWeekdays")
                ? normalizePeakWeekdays(s["peakWeekdays"])
                : json::array();
            if (!days.empty() && !weekdayAllowsPeak(days, date))
                continue;
            if (!firstWeekday)
                firstWeekday = &s;
            if (!hasWindows)
            {
                picked = &s;
                break;
            }
            const std::string band = trimCopy(s.value("band", "peak"));
            if (band == (clockPeak ? "peak" : "idle"))
            {
                picked = &s;
                break;
            }
        }
        if (!picked)
            picked = firstWeekday;
        if (picked && picked->contains("rates") && (*picked)["rates"].is_object())
            return ratesFromJson((*picked)["rates"]);
    }

    const bool useIdle = best->contains("idleRates") && (*best)["idleRates"].is_object()
        && (!weekdayAllowsPeak(peakWeekdays, date) || !clockPeak);

    if (useIdle)
        return ratesFromJson((*best)["idleRates"]);

    if (best->contains("rates") && (*best)["rates"].is_object())
        return ratesFromJson((*best)["rates"]);

    // Legacy dual fields
    const char* key = vendorCur == "USD" ? "usd" : "cny";
    return ratesFromJson(best->value(key, json::object()));
}

std::string PricingStore::bandFor(
    const std::string& model,
    const std::string& date,
    const std::string& time) const
{
    const std::string m = trimCopy(model);
    if (m.empty())
        return "";

    std::lock_guard<std::mutex> lock(mu_);
    const json& rules = table_.contains("rules") ? table_["rules"] : json::array();

    const json* best = nullptr;
    std::string bestFrom;
    const auto candidates = ruleIndexesByModel_.find(m);
    if (candidates == ruleIndexesByModel_.end())
        return "flat";
    for (const size_t index : candidates->second)
    {
        if (index >= rules.size())
            continue;
        const auto& r = rules[index];
        if (!r.is_object())
            continue;
        const std::string from = trimCopy(r.value("from", ""));
        const std::string to = trimCopy(r.value("to", ""));
        if (!dateInHalfOpen(date, from, to))
            continue;
        if (!best || from > bestFrom
            || (from == bestFrom && trimCopy((*best).value("to", "")).empty()
                && !to.empty()))
        {
            best = &r;
            bestFrom = from;
        }
    }
    if (!best)
        return "flat";

    json peakWindows = json::array();
    if (best->contains("peakWindows") && (*best)["peakWindows"].is_array())
        peakWindows = (*best)["peakWindows"];
    else if (table_.contains("dayParts") && table_["dayParts"].is_object())
    {
        const std::string idleFrom =
            trimCopy(table_["dayParts"].value("idleFrom", "00:30"));
        const std::string idleTo =
            trimCopy(table_["dayParts"].value("idleTo", "08:30"));
        if (parseTimeMinutes(idleFrom) >= 0 && parseTimeMinutes(idleTo) >= 0
            && idleFrom != idleTo)
            peakWindows = json::array({json{{"from", idleTo}, {"to", idleFrom}}});
    }

    json peakWeekdays = json::array();
    if (best->contains("peakWeekdays"))
        peakWeekdays = normalizePeakWeekdays((*best)["peakWeekdays"]);

    const bool hasWindows = peakWindows.is_array() && !peakWindows.empty();
    if (!hasWindows)
        return "flat";
    const bool clockPeak = time.empty() || isPeakLocalTime(time, peakWindows);
    if (best->contains("subRules") && (*best)["subRules"].is_array()
        && !(*best)["subRules"].empty())
    {
        const json* picked = nullptr;
        const json* firstWeekday = nullptr;
        for (const auto& s : (*best)["subRules"])
        {
            if (!s.is_object())
                continue;
            json days = s.contains("peakWeekdays")
                ? normalizePeakWeekdays(s["peakWeekdays"])
                : json::array();
            if (!days.empty() && !weekdayAllowsPeak(days, date))
                continue;
            if (!firstWeekday)
                firstWeekday = &s;
            if (!hasWindows)
            {
                picked = &s;
                break;
            }
            const std::string band = trimCopy(s.value("band", "peak"));
            if (band == (clockPeak ? "peak" : "idle"))
            {
                picked = &s;
                break;
            }
        }
        if (!picked)
            picked = firstWeekday;
        if (picked)
        {
            const std::string band = trimCopy(picked->value("band", ""));
            if (band == "idle" || band == "peak")
                return band;
        }
    }

    const bool useIdle = best->contains("idleRates") && (*best)["idleRates"].is_object()
        && (!weekdayAllowsPeak(peakWeekdays, date) || !clockPeak);
    return useIdle ? "idle" : "peak";
}

double PricingStore::computeCost(
    int promptTokens,
    int completionTokens,
    int cacheReadTokens,
    int cacheWriteTokens,
    const TokenRates& rates)
{
    const int inputTokens = std::max(0, promptTokens - cacheReadTokens);
    const double perM = 1e6;
    return (static_cast<double>(inputTokens) / perM) * rates.input
        + (static_cast<double>(completionTokens) / perM) * rates.output
        + (static_cast<double>(cacheReadTokens) / perM) * rates.cacheRead
        + (static_cast<double>(cacheWriteTokens) / perM) * rates.cacheWrite;
}

double PricingStore::costFor(const json& event, const std::string& currency) const
{
    if (event.value("channel", "") != "llm")
        return 0.0;
    if (event.value("promptTokens", 0) < 0 || event.value("totalTokens", 0) < 0)
        return 0.0;
    const std::string model = event.value("model", "");
    const std::string date = event.value("date", "");
    const std::string time = event.value("time", "");
    const auto rates = ratesFor(model, date, currency, time);
    if (!rates)
        return 0.0;
    return computeCost(
        event.value("promptTokens", 0),
        event.value("completionTokens", 0),
        event.value("cacheReadTokens", 0),
        event.value("cacheWriteTokens", 0),
        *rates);
}
