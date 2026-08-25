#pragma once

#include <memory>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

/**
 * SQLite-backed usage-event storage.
 *
 * On Windows this loads the system winsqlite3.dll dynamically, keeping the
 * portable package small and avoiding a separately installed database service.
 */
class SqliteUsageDb {
public:
    explicit SqliteUsageDb(const std::string& legacyJsonlPath);
    ~SqliteUsageDb();

    SqliteUsageDb(const SqliteUsageDb&) = delete;
    SqliteUsageDb& operator=(const SqliteUsageDb&) = delete;

    bool available() const;
    const std::string& databasePath() const;

    /** Insert a new event, or replace the pending row with its final row. */
    bool upsert(const nlohmann::json& row);

    /** Query only rows matching the indexed filters. */
    bool query(
        const std::string& fromDate,
        const std::string& toDate,
        const std::string& feature,
        const std::string& okFilter,
        std::vector<nlohmann::json>& rows) const;

    /** Query one detail page in newest-first order without loading all events. */
    bool queryPage(
        const std::string& fromDate,
        const std::string& toDate,
        const std::string& feature,
        const std::string& okFilter,
        int page,
        int pageSize,
        std::vector<nlohmann::json>& rows,
        int& totalRows) const;

    /**
     * Aggregate chart input in SQLite by minute, actor and result. Pricing is
     * deliberately applied later so editing pricing rules updates history.
     */
    bool aggregateByMinute(
        const std::string& fromDate,
        const std::string& toDate,
        const std::string& feature,
        const std::string& okFilter,
        std::vector<nlohmann::json>& rows) const;

    bool clear();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
