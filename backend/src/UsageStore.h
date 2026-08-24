#pragma once

#include <nlohmann/json.hpp>
#include <mutex>
#include <string>
#include <vector>

struct UsageEvent {
    std::string id;
    std::string ts;
    std::string date;
    int year = 0;
    std::string time;
    std::string feature;
    bool ok = false;
    /** Empty for normal requests; "supplement" for manual token backfill. */
    std::string requestType;
    std::string errorCode;
    std::string channel; // llm | engine
    std::string engineId;
    std::string engineKind; // free | keyed | ""
    std::string vendor;
    std::string model;
    std::string apiHost;
    int promptTokens = 0;
    int completionTokens = 0;
    int totalTokens = 0;
    int cacheReadTokens = 0;
    int cacheWriteTokens = 0;
    int sourceChars = 0;
    std::string endpoint;
    /** Optional remark (success or failure), e.g. manual backfill. */
    std::string note;
    /** Human-readable failure reason when ok=false. */
    std::string errorMessage;
};

/** Sentinel in JSON when usage was interrupted before the API returned token counts. */
constexpr int kUsageTokensUnknown = -1;

class UsageStore {
public:
    explicit UsageStore(std::string filePath);

    void append(const UsageEvent& ev);
    /** Persist in-flight marker immediately (same id finalized later). */
    void markPending(UsageEvent& ev);
    /** Append completion row; readers keep latest row per id. */
    void finalize(const UsageEvent& ev);
    void clear();

    std::vector<nlohmann::json> events(
        const std::string& fromDate,
        const std::string& toDate,
        const std::string& feature,
        const std::string& okFilter) const;

    nlohmann::json summary(
        const std::string& fromDate,
        const std::string& toDate,
        const std::string& feature,
        const std::string& groupBy,
        const std::string& okFilter) const;

    /** Aggregate pre-filtered event rows (may include cost). */
    static nlohmann::json summaryFromEvents(
        const std::vector<nlohmann::json>& rows,
        const std::string& groupBy);

    static UsageEvent makeEventSkeleton();
    static std::string engineKindForProvider(const std::string& provider);
    static std::string hostFromApiUrl(const std::string& apiUrl);
    static std::string vendorFromHostOrModel(
        const std::string& apiHost,
        const std::string& model,
        const std::string& hintVendor);

private:
    std::string path_;
    mutable std::mutex mu_;

    nlohmann::json toJson(const UsageEvent& ev) const;
    static bool dateInRange(
        const std::string& date,
        const std::string& fromDate,
        const std::string& toDate);
};
