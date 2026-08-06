#pragma once

#include <nlohmann/json.hpp>
#include <mutex>
#include <optional>
#include <string>

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
     * Rates for model on date when the model's vendor bills in `currency`.
     * nullopt if no rule, or vendor currency ≠ requested currency.
     */
    std::optional<TokenRates> ratesFor(
        const std::string& model,
        const std::string& date,
        const std::string& currency) const;

    /** Cost in filter currency; 0 if vendor bills in another currency. */
    double costFor(const nlohmann::json& event, const std::string& currency) const;

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

    void loadUnlocked();
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
