#pragma once

#include <nlohmann/json.hpp>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

struct TokenRates {
    double input = 0;
    double output = 0;
    double cacheRead = 0;
    double cacheWrite = 0;
};
class PricingStore {
public:
    explicit PricingStore(std::string filePath);

    /** Load from disk; seed defaults if missing. */
    nlohmann::json get() const;
    /** Validate and overwrite whole table. Returns error message or empty. */
    std::string put(const nlohmann::json& body);

    std::string displayCurrency() const;

    /**
 * Rates for model on date[/time] when the model's vendor bills in `currency`.
 * nullopt if no rule, or vendor currency ≠ requested currency.
 * Sub-rules (weekday + idle/peak + rates) are matched in list order;
 * the first match wins. Weekdays not in peakWeekdays (1=Mon…7=Sun;
 * empty=every day) skip that sub-rule. Empty peakWindows: first weekday
 * match wins. Non-empty: first weekday + idle/peak band match wins.
 */
    std::optional<TokenRates> ratesFor(
        const std::string& model,
        const std::string& date,
        const std::string& currency,
        const std::string& time = "") const;

    /** Cost in filter currency; 0 if vendor bills in another currency. */
    double costFor(const nlohmann::json& event, const std::string& currency) const;

    /**
     * idle | peak when the matching interval has peak windows;
     * flat when no interval or no idle/peak split (callers treat engines as flat).
     */
    std::string bandFor(
        const std::string& model,
        const std::string& date,
        const std::string& time = "") const;

    static nlohmann::json defaultTable();
    static double computeCost(
        int promptTokens,
        int completionTokens,
        int cacheReadTokens,
        int cacheWriteTokens,
        const TokenRates& rates);

private:
    std::string path_;
    mutable std::mutex mu_;
    nlohmann::json table_;
    std::unordered_map<std::string, std::vector<size_t>> ruleIndexesByModel_;

    void loadUnlocked();
    void rebuildRuleIndexUnlocked();
    bool saveUnlocked() const;
    static bool dateInHalfOpen(
        const std::string& date,
        const std::string& from,
        const std::string& to);
    static std::string normalizeCurrency(const std::string& c);
    static TokenRates ratesFromJson(const nlohmann::json& o);
    static nlohmann::json ratesToJson(const TokenRates& r);
    static std::string validateTable(const nlohmann::json& body, nlohmann::json& out);
};
