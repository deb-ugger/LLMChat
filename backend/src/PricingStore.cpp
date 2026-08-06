#include "PricingStore.h"

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
    const std::string& to = "")
{
    return json{
        {"id", makeRuleId()},
        {"vendor", vendor},
        {"model", model},
        {"from", from},
        {"to", to},
        {"rates", rates},
    };
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
    // Open start (empty from) + open end until user splits ranges.
    // Rates are in each vendor's billing currency (see vendorCurrencies).
    const std::string from = "";
    json rules = json::array();

    // DeepSeek — CNY — https://api-docs.deepseek.com/zh-cn/quick_start/pricing
    // input = 缓存未命中; cacheRead = 缓存命中; cacheWrite 无单独项，按未命中计
    rules.push_back(rule(
        "DeepSeek", "deepseek-v4-flash", from, rateObj(1.0, 2.0, 0.02, 1.0)));
    rules.push_back(rule(
        "DeepSeek", "deepseek-v4-pro", from, rateObj(3.0, 6.0, 0.025, 3.0)));
    rules.push_back(rule(
        "DeepSeek", "deepseek-chat", from, rateObj(1.0, 2.0, 0.02, 1.0)));
    rules.push_back(rule(
        "DeepSeek", "deepseek-reasoner", from, rateObj(1.0, 2.0, 0.02, 1.0)));

    // OpenAI — USD
    rules.push_back(rule(
        "OpenAI", "gpt-4o", from, rateObj(2.5, 10.0, 1.25, 2.5)));
    rules.push_back(rule(
        "OpenAI", "gpt-4o-mini", from, rateObj(0.15, 0.6, 0.075, 0.15)));
    rules.push_back(rule(
        "OpenAI", "gpt-4-turbo", from, rateObj(10.0, 30.0, 5.0, 10.0)));
    rules.push_back(rule(
        "OpenAI", "gpt-3.5-turbo", from, rateObj(0.5, 1.5, 0.25, 0.5)));

    // Google — USD
    rules.push_back(rule(
        "Google", "gemini-2.0-flash", from, rateObj(0.1, 0.4, 0.025, 0.1)));

    // 通义千问 — CNY
    rules.push_back(rule(
        "通义千问", "qwen-plus", from, rateObj(0.8, 2.0, 0.16, 0.8)));
    rules.push_back(rule(
        "通义千问", "qwen-turbo", from, rateObj(0.3, 0.6, 0.06, 0.3)));

    return json{
        {"displayCurrency", "CNY"},
        {"vendorCurrencies",
         {{"DeepSeek", "CNY"},
          {"OpenAI", "USD"},
          {"Google", "USD"},
          {"通义千问", "CNY"}}},
        {"rules", rules},
    };
}

PricingStore::PricingStore(std::string filePath)
    : path_(std::move(filePath))
{
    std::lock_guard<std::mutex> lock(mu_);
    loadUnlocked();
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
    try
    {
        const fs::path p(path_);
        std::error_code ec;
        fs::create_directories(p.parent_path(), ec);
        std::ofstream out(p, std::ios::binary | std::ios::trunc);
        if (!out)
            return false;
        out << table_.dump(2);
        return static_cast<bool>(out);
    }
    catch (...)
    {
        return false;
    }
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

        std::string id = trimCopy(item.value("id", ""));
        if (id.empty())
            id = makeRuleId();

        rules.push_back(json{
            {"id", id},
            {"vendor", vendor},
            {"model", model},
            {"from", from},
            {"to", to},
            {"rates", ratesToJson(ratesFromJson(ratesIn))},
        });
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

    out = json{
        {"displayCurrency", currency},
        {"vendorCurrencies", vendorCurrencies},
        {"rules", rules},
    };
    return "";
}

std::optional<TokenRates> PricingStore::ratesFor(
    const std::string& model,
    const std::string& date,
    const std::string& currency) const
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
    for (const auto& r : rules)
    {
        if (!r.is_object())
            continue;
        if (trimCopy(r.value("model", "")) != m)
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

    if (best->contains("rates") && (*best)["rates"].is_object())
        return ratesFromJson((*best)["rates"]);

    // Legacy dual fields
    const char* key = vendorCur == "USD" ? "usd" : "cny";
    return ratesFromJson(best->value(key, json::object()));
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
    const std::string model = event.value("model", "");
    const std::string date = event.value("date", "");
    const auto rates = ratesFor(model, date, currency);
    if (!rates)
        return 0.0;
    return computeCost(
        event.value("promptTokens", 0),
        event.value("completionTokens", 0),
        event.value("cacheReadTokens", 0),
        event.value("cacheWriteTokens", 0),
        *rates);
}
