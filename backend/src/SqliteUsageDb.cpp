#include "SqliteUsageDb.h"
#include "SqliteSupport.h"
#include "Utf8Path.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <utility>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace {

#ifdef _WIN32

using namespace sqlite_support;

void appendFilters(
    std::string& sql,
    std::vector<std::string>& parameters,
    const std::string& fromDate,
    const std::string& toDate,
    const std::string& feature,
    const std::string& okFilter)
{
    if (!fromDate.empty())
    {
        sql += " AND date>=?";
        parameters.push_back(fromDate);
    }
    if (!toDate.empty())
    {
        sql += " AND date<=?";
        parameters.push_back(toDate);
    }
    if (!feature.empty())
    {
        sql += " AND feature=?";
        parameters.push_back(feature);
    }
    if (okFilter == "ok" || okFilter == "fail" || okFilter == "supplement")
    {
        sql += " AND request_type=?";
        parameters.push_back(okFilter);
    }
}

bool bindParameters(
    SqliteApi& api,
    sqlite3_stmt* statement,
    const std::vector<std::string>& parameters)
{
    for (size_t i = 0; i < parameters.size(); ++i)
    {
        if (!bindText(api, statement, static_cast<int>(i + 1), parameters[i]))
            return false;
    }
    return true;
}

std::string requestTypeOf(const json& row)
{
    if (row.value("requestType", "") == "supplement")
        return "supplement";
    return row.value("ok", false) ? "ok" : "fail";
}

constexpr std::array kTextFields{
    "id", "date", "ts", "time", "feature", "channel", "engineId", "engineKind", "vendor", "model"};
constexpr std::array kNumberFields{
    "promptTokens", "completionTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "sourceChars"};
constexpr std::array kOptionalTextFields{"errorCode", "apiHost", "endpoint", "note", "errorMessage"};
const std::string kSelectUsageRow =
    "SELECT payload,event_id,date,ts,time,feature,channel,engine_id,engine_kind,vendor,model,"
    "prompt_tokens,completion_tokens,total_tokens,cache_read_tokens,cache_write_tokens,source_chars,"
    "ok,request_type FROM usage_events";

int usageYear(const std::string& date)
{
    if (date.size() < 4)
        return 0;
    int year = 0;
    const auto end = date.data() + 4;
    const auto result = std::from_chars(date.data(), end, year);
    return result.ptr == end ? year : 0;
}

// Field order fixes the bits in the persisted missing-field mask. The JSON
// tail only carries values that cannot be recovered from the columns/defaults.
std::string packPayload(const json& row, const std::string& requestType)
{
    json extra = row;
    std::uint32_t missing = 0;
    std::uint32_t bit = 1;
    auto omitStored = [&](const char* key, const json& value) {
        const auto it = extra.find(key);
        if (it == extra.end())
            missing |= bit;
        else if (*it == value)
            extra.erase(it);
        bit <<= 1;
    };
    for (const char* key : kTextFields)
    {
        auto value = row.value(key, "");
        // columnText reads through the first NUL, so keep the original in the tail.
        if (const auto nul = value.find('\0'); nul != std::string::npos)
            value.resize(nul);
        omitStored(key, value);
    }
    for (const char* key : kNumberFields)
        omitStored(key, row.value(key, 0));
    omitStored("ok", row.value("ok", false));
    omitStored("requestType", requestType == "supplement" ? "supplement" : "");
    omitStored("year", usageYear(row.value("date", "")));
    for (const char* key : kOptionalTextFields)
        omitStored(key, "");

    if (missing == 0 && extra.empty())
        return {};
    return json::array({missing, std::move(extra)}).dump();
}

json readUsageRow(SqliteApi& api, sqlite3_stmt* statement)
{
    const auto payload = columnText(api, statement, 0);
    if (payload.starts_with('{'))
        return json::parse(payload);

    std::uint32_t missing = 0;
    json row = json::object();
    if (!payload.empty())
    {
        auto packed = json::parse(payload);
        missing = packed.at(0).get<std::uint32_t>();
        row = std::move(packed.at(1));
    }
    std::uint32_t bit = 1;
    auto restore = [&](const char* key, const json& value) {
        if ((missing & bit) == 0 && !row.contains(key))
            row[key] = value;
        bit <<= 1;
    };
    int column = 1;
    for (const char* key : kTextFields)
        restore(key, columnText(api, statement, column++));
    for (const char* key : kNumberFields)
        restore(key, api.columnInt64(statement, column++));
    restore("ok", api.columnInt64(statement, column++) != 0);
    restore("requestType", columnText(api, statement, column) == "supplement" ? "supplement" : "");
    restore("year", usageYear(columnText(api, statement, 2)));
    for (const char* key : kOptionalTextFields)
        restore(key, "");
    return row;
}

#endif

} // namespace

struct SqliteUsageDb::Impl {
    std::string legacyPath;
    std::string dbPath;
#ifdef _WIN32
    SqliteApi* api = nullptr;
    sqlite3* db = nullptr;

    bool execute(const char* sql) const
    {
        return db && sqlite_support::execute(*api, db, sql);
    }

    static std::string writeSql(const char* conflictColumn)
    {
        return std::string(
            "INSERT INTO usage_events("
            "event_id,date,ts,time,feature,request_type,ok,channel,engine_id,"
            "engine_kind,vendor,model,prompt_tokens,completion_tokens,total_tokens,"
            "cache_read_tokens,cache_write_tokens,source_chars,payload,seq) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(") + conflictColumn + ") DO UPDATE SET "
            "event_id=excluded.event_id,date=excluded.date,ts=excluded.ts,time=excluded.time,"
            "feature=excluded.feature,request_type=excluded.request_type,ok=excluded.ok,"
            "channel=excluded.channel,engine_id=excluded.engine_id,"
            "engine_kind=excluded.engine_kind,vendor=excluded.vendor,model=excluded.model,"
            "prompt_tokens=excluded.prompt_tokens,"
            "completion_tokens=excluded.completion_tokens,total_tokens=excluded.total_tokens,"
            "cache_read_tokens=excluded.cache_read_tokens,"
            "cache_write_tokens=excluded.cache_write_tokens,"
            "source_chars=excluded.source_chars,payload=excluded.payload";
    }

    bool writeRow(sqlite3_stmt* statement, const json& row, long long seq = 0)
    {
        const std::string id = row.value("id", "");
        if (id.empty())
        {
            if (api->bindNull(statement, 1) != kSqliteOk)
                return false;
        }
        else if (!bindText(*api, statement, 1, id))
            return false;

        const auto requestType = requestTypeOf(row);
        int parameter = 2;
        if (!bindText(*api, statement, parameter++, row.value("date", ""))
            || !bindText(*api, statement, parameter++, row.value("ts", ""))
            || !bindText(*api, statement, parameter++, row.value("time", ""))
            || !bindText(*api, statement, parameter++, row.value("feature", ""))
            || !bindText(*api, statement, parameter++, requestType)
            || !bindInt(*api, statement, parameter++, row.value("ok", false) ? 1 : 0)
            || !bindText(*api, statement, parameter++, row.value("channel", ""))
            || !bindText(*api, statement, parameter++, row.value("engineId", ""))
            || !bindText(*api, statement, parameter++, row.value("engineKind", ""))
            || !bindText(*api, statement, parameter++, row.value("vendor", ""))
            || !bindText(*api, statement, parameter++, row.value("model", "")))
            return false;
        for (const char* key : kNumberFields)
        {
            if (!bindInt(*api, statement, parameter++, row.value(key, 0)))
                return false;
        }
        return bindText(*api, statement, parameter++, packPayload(row, requestType))
            && (seq ? bindInt(*api, statement, parameter, seq) : api->bindNull(statement, parameter) == kSqliteOk)
            && api->step(statement) == kSqliteDone
            && api->reset(statement) == kSqliteOk;
    }

    bool writeRow(const json& row)
    {
        static const auto sql = writeSql("event_id");
        Statement statement(*api, db, sql);
        return statement.valid() && writeRow(statement.get(), row);
    }

    bool columnExists(const std::string& name) const
    {
        Statement statement(*api, db, "PRAGMA table_info(usage_events)");
        if (!statement.valid())
            return false;
        while (api->step(statement.get()) == kSqliteRow)
        {
            if (columnText(*api, statement.get(), 1) == name)
                return true;
        }
        return false;
    }

    bool ensureColumn(const std::string& name, const std::string& declaration)
    {
        if (columnExists(name))
            return true;
        const std::string sql =
            "ALTER TABLE usage_events ADD COLUMN " + name + " " + declaration;
        return ::execute(*api, db, sql.c_str());
    }

    bool hasMetadata(const std::string& key) const
    {
        Statement statement(*api, db, "SELECT 1 FROM usage_metadata WHERE key=?");
        return statement.valid() && bindText(*api, statement.get(), 1, key)
            && api->step(statement.get()) == kSqliteRow;
    }

    bool rewriteLegacyRows()
    {
        const bool structured = hasMetadata("structured_columns_v2");
        Statement write(*api, db, structured
            ? "UPDATE usage_events SET payload=? WHERE seq=?"
            : writeSql("seq"));
        if (!write.valid())
            return false;
        long long after = 0;
        std::vector<std::pair<long long, std::string>> batch;
        batch.reserve(512);
        while (true)
        {
            batch.clear();
            {
                Statement read(*api, db,
                    "SELECT seq,payload FROM usage_events WHERE seq>? AND substr(payload,1,1)='{' "
                    "ORDER BY seq LIMIT 512");
                if (!read.valid() || !bindInt(*api, read.get(), 1, after))
                    return false;
                int result;
                while ((result = api->step(read.get())) == kSqliteRow)
                    batch.emplace_back(api->columnInt64(read.get(), 0), columnText(*api, read.get(), 1));
                if (result != kSqliteDone)
                    return false;
            }
            if (batch.empty())
                return true;
            for (const auto& [seq, payload] : batch)
            {
                const auto row = json::parse(payload, nullptr, false);
                if (row.is_discarded())
                    continue;
                if (structured)
                {
                    if (!bindText(*api, write.get(), 1, packPayload(row, requestTypeOf(row)))
                        || !bindInt(*api, write.get(), 2, seq)
                        || api->step(write.get()) != kSqliteDone
                        || api->reset(write.get()) != kSqliteOk)
                        return false;
                }
                else if (!writeRow(write.get(), row, seq))
                    return false;
            }
            after = batch.back().first;
        }
    }

    bool compactStoredRows()
    {
        if (hasMetadata("compact_payload_v3"))
            return true;
        if (!execute("BEGIN IMMEDIATE"))
            return false;
        try
        {
            if (rewriteLegacyRows()
                && execute("DROP INDEX IF EXISTS usage_events_date_feature_idx;"
                    "DROP INDEX IF EXISTS usage_events_date_result_idx;"
                    "DROP INDEX IF EXISTS usage_events_date_model_time_idx;")
                && execute("INSERT OR REPLACE INTO usage_metadata(key,value) VALUES"
                    "('structured_columns_v2','complete'),('compact_payload_v3','complete')")
                && execute("COMMIT"))
                return true;
        }
        catch (const json::exception& error)
        {
            std::cerr << "Usage database migration: " << error.what() << '\n';
        }
        execute("ROLLBACK");
        return false;
    }

    bool reclaimDiskSpace() const
    {
        constexpr int incrementalVacuum = 2;
        int mode;
        {
            Statement statement(*api, db, "PRAGMA auto_vacuum");
            if (!statement.valid() || api->step(statement.get()) != kSqliteRow)
                return false;
            mode = static_cast<int>(api->columnInt64(statement.get(), 0));
        }
        if (mode != incrementalVacuum
            && (!execute("PRAGMA auto_vacuum=INCREMENTAL") || !execute("VACUUM")))
            return false;
        return execute("PRAGMA incremental_vacuum") && execute("PRAGMA wal_checkpoint(TRUNCATE)");
    }

    bool migrateJsonl()
    {
        if (hasMetadata("jsonl_migrated_v1"))
            return true;
        if (!fs::exists(legacyPath))
            return execute(
                "INSERT OR REPLACE INTO usage_metadata(key,value) "
                "VALUES('jsonl_migrated_v1','absent')");

        std::ifstream in(legacyPath, std::ios::binary);
        if (!in || !execute("BEGIN IMMEDIATE"))
            return false;

        bool ok = true;
        std::string line;
        while (std::getline(in, line))
        {
            if (line.find_first_not_of(" \t\r\n") == std::string::npos)
                continue;
            try
            {
                if (!writeRow(json::parse(line)))
                {
                    ok = false;
                    break;
                }
            }
            catch (...)
            {
                // Preserve the old reader's behavior: malformed lines are ignored.
            }
        }

        if (ok)
            ok = execute(
                "INSERT OR REPLACE INTO usage_metadata(key,value) "
                "VALUES('jsonl_migrated_v1','complete')");
        if (ok && execute("COMMIT"))
            return true;
        execute("ROLLBACK");
        return false;
    }
#endif
};

SqliteUsageDb::SqliteUsageDb(const std::string& legacyJsonlPath)
    : impl_(std::make_unique<Impl>())
{
    impl_->legacyPath = legacyJsonlPath;
    impl_->dbPath = (fs::path(legacyJsonlPath).parent_path() / "usage.db").string();

#ifdef _WIN32
    impl_->api = &sqliteApi();
    if (!impl_->api->ready())
        return;

    std::error_code ec;
    fs::create_directories(fs::path(impl_->dbPath).parent_path(), ec);
    const int flags = kSqliteOpenReadWrite | kSqliteOpenCreate | kSqliteOpenFullMutex;
    if (impl_->api->openV2(utf8path::pathUtf8(fs::path(impl_->dbPath)).c_str(), &impl_->db, flags, nullptr) != kSqliteOk)
    {
        if (impl_->db)
            impl_->api->close(impl_->db);
        impl_->db = nullptr;
        return;
    }

    impl_->api->busyTimeout(impl_->db, 5000);
    const bool ready = impl_->execute("PRAGMA auto_vacuum=INCREMENTAL")
        && impl_->execute("PRAGMA journal_mode=WAL")
        && impl_->execute("PRAGMA synchronous=NORMAL")
        && impl_->execute(
            "CREATE TABLE IF NOT EXISTS usage_metadata("
            "key TEXT PRIMARY KEY,value TEXT NOT NULL)")
        && impl_->execute(
            "CREATE TABLE IF NOT EXISTS usage_events("
            "seq INTEGER PRIMARY KEY AUTOINCREMENT,"
            "event_id TEXT UNIQUE,"
            "date TEXT NOT NULL DEFAULT '',"
            "ts TEXT NOT NULL DEFAULT '',"
            "time TEXT NOT NULL DEFAULT '',"
            "feature TEXT NOT NULL DEFAULT '',"
            "request_type TEXT NOT NULL DEFAULT '',"
            "ok INTEGER NOT NULL DEFAULT 0,"
            "channel TEXT NOT NULL DEFAULT '',"
            "engine_id TEXT NOT NULL DEFAULT '',"
            "engine_kind TEXT NOT NULL DEFAULT '',"
            "vendor TEXT NOT NULL DEFAULT '',"
            "model TEXT NOT NULL DEFAULT '',"
            "prompt_tokens INTEGER NOT NULL DEFAULT 0,"
            "completion_tokens INTEGER NOT NULL DEFAULT 0,"
            "total_tokens INTEGER NOT NULL DEFAULT 0,"
            "cache_read_tokens INTEGER NOT NULL DEFAULT 0,"
            "cache_write_tokens INTEGER NOT NULL DEFAULT 0,"
            "source_chars INTEGER NOT NULL DEFAULT 0,"
            "payload TEXT NOT NULL)")
        && impl_->ensureColumn("ts", "TEXT NOT NULL DEFAULT ''")
        && impl_->ensureColumn("time", "TEXT NOT NULL DEFAULT ''")
        && impl_->ensureColumn("ok", "INTEGER NOT NULL DEFAULT 0")
        && impl_->ensureColumn("channel", "TEXT NOT NULL DEFAULT ''")
        && impl_->ensureColumn("engine_id", "TEXT NOT NULL DEFAULT ''")
        && impl_->ensureColumn("engine_kind", "TEXT NOT NULL DEFAULT ''")
        && impl_->ensureColumn("vendor", "TEXT NOT NULL DEFAULT ''")
        && impl_->ensureColumn("model", "TEXT NOT NULL DEFAULT ''")
        && impl_->ensureColumn("prompt_tokens", "INTEGER NOT NULL DEFAULT 0")
        && impl_->ensureColumn("completion_tokens", "INTEGER NOT NULL DEFAULT 0")
        && impl_->ensureColumn("total_tokens", "INTEGER NOT NULL DEFAULT 0")
        && impl_->ensureColumn("cache_read_tokens", "INTEGER NOT NULL DEFAULT 0")
        && impl_->ensureColumn("cache_write_tokens", "INTEGER NOT NULL DEFAULT 0")
        && impl_->ensureColumn("source_chars", "INTEGER NOT NULL DEFAULT 0")
        && impl_->migrateJsonl()
        && impl_->execute(
            "CREATE INDEX IF NOT EXISTS usage_events_date_idx "
            "ON usage_events(date)")
        && impl_->execute(
            "CREATE INDEX IF NOT EXISTS usage_events_newest_idx "
            "ON usage_events(ts DESC,seq DESC)");
    if (!ready)
    {
        impl_->api->close(impl_->db);
        impl_->db = nullptr;
    }
    else if (!impl_->compactStoredRows())
        std::cerr << "Usage database could not migrate compact rows: " << impl_->dbPath << '\n';
    else if (!impl_->reclaimDiskSpace())
        std::cerr << "Usage database could not reclaim disk space: " << impl_->dbPath << '\n';
#endif
}

SqliteUsageDb::~SqliteUsageDb()
{
#ifdef _WIN32
    if (impl_ && impl_->db)
        impl_->api->close(impl_->db);
#endif
}

bool SqliteUsageDb::available() const
{
#ifdef _WIN32
    return impl_ && impl_->db;
#else
    return false;
#endif
}

const std::string& SqliteUsageDb::databasePath() const
{
    return impl_->dbPath;
}

bool SqliteUsageDb::upsert(const json& row)
{
#ifdef _WIN32
    return available() && impl_->writeRow(row);
#else
    (void)row;
    return false;
#endif
}

bool SqliteUsageDb::query(
    const std::string& fromDate,
    const std::string& toDate,
    const std::string& feature,
    const std::string& okFilter,
    std::vector<json>& rows) const
{
    rows.clear();
#ifdef _WIN32
    if (!available())
        return false;

    std::string sql = kSelectUsageRow + " WHERE 1=1";
    std::vector<std::string> parameters;
    appendFilters(sql, parameters, fromDate, toDate, feature, okFilter);
    sql += " ORDER BY seq";

    Statement statement(*impl_->api, impl_->db, sql);
    if (!statement.valid()
        || !bindParameters(*impl_->api, statement.get(), parameters))
        return false;

    while (true)
    {
        const int result = impl_->api->step(statement.get());
        if (result == kSqliteDone)
            return true;
        if (result != kSqliteRow)
            return false;
        try
        {
            rows.push_back(readUsageRow(*impl_->api, statement.get()));
        }
        catch (...)
        {
        }
    }
#else
    (void)fromDate;
    (void)toDate;
    (void)feature;
    (void)okFilter;
    return false;
#endif
}

bool SqliteUsageDb::queryPage(
    const std::string& fromDate,
    const std::string& toDate,
    const std::string& feature,
    const std::string& okFilter,
    int page,
    int pageSize,
    std::vector<json>& rows,
    int& totalRows,
    const std::function<bool(const json&)>& matches) const
{
    rows.clear();
    totalRows = 0;
#ifdef _WIN32
    if (!available())
        return false;

    page = std::max(1, page);
    pageSize = std::max(1, std::min(200, pageSize));
    std::vector<std::string> parameters;
    std::string where = " WHERE 1=1";
    appendFilters(where, parameters, fromDate, toDate, feature, okFilter);

    // One ordered statement is also the cursor: each source row is read once.
    // Pricing remains a caller predicate so changed rules apply to history.
    if (matches)
    {
        Statement statement(
            *impl_->api, impl_->db,
            kSelectUsageRow + where + " ORDER BY ts DESC,seq DESC");
        if (!statement.valid()
            || !bindParameters(*impl_->api, statement.get(), parameters))
            return false;
        const auto begin = static_cast<long long>(page - 1) * pageSize;
        rows.reserve(pageSize);
        while (true)
        {
            const int result = impl_->api->step(statement.get());
            if (result == kSqliteDone)
                return true;
            if (result != kSqliteRow)
                return false;
            json row;
            try
            {
                row = readUsageRow(*impl_->api, statement.get());
            }
            catch (const json::parse_error&)
            {
                continue;
            }
            if (!matches(row))
                continue;
            if (totalRows >= begin && rows.size() < static_cast<size_t>(pageSize))
                rows.push_back(std::move(row));
            ++totalRows;
        }
    }

    Statement countStatement(
        *impl_->api,
        impl_->db,
        "SELECT COUNT(*) FROM usage_events" + where);
    if (!countStatement.valid()
        || !bindParameters(*impl_->api, countStatement.get(), parameters)
        || impl_->api->step(countStatement.get()) != kSqliteRow)
        return false;
    totalRows = static_cast<int>(impl_->api->columnInt64(countStatement.get(), 0));

    const std::string sql =
        kSelectUsageRow + where
        + " ORDER BY ts DESC,seq DESC LIMIT ? OFFSET ?";
    Statement statement(*impl_->api, impl_->db, sql);
    if (!statement.valid()
        || !bindParameters(*impl_->api, statement.get(), parameters))
        return false;
    int parameter = static_cast<int>(parameters.size() + 1);
    if (!bindInt(*impl_->api, statement.get(), parameter++, pageSize)
        || !bindInt(
            *impl_->api,
            statement.get(),
            parameter,
            static_cast<long long>(page - 1) * pageSize))
        return false;

    while (true)
    {
        const int result = impl_->api->step(statement.get());
        if (result == kSqliteDone)
            return true;
        if (result != kSqliteRow)
            return false;
        try
        {
            rows.push_back(readUsageRow(*impl_->api, statement.get()));
        }
        catch (...)
        {
        }
    }
#else
    (void)fromDate;
    (void)toDate;
    (void)feature;
    (void)okFilter;
    (void)page;
    (void)pageSize;
    (void)matches;
    return false;
#endif
}

bool SqliteUsageDb::aggregateByMinute(
    const std::string& fromDate,
    const std::string& toDate,
    const std::string& feature,
    const std::string& okFilter,
    std::vector<json>& rows) const
{
    rows.clear();
#ifdef _WIN32
    if (!available() || !impl_->hasMetadata("structured_columns_v2"))
        return false;

    std::vector<std::string> parameters;
    std::string sql =
        "SELECT date,CASE WHEN length(time)>=5 THEN substr(time,1,5)||':00' ELSE time END,"
        "feature,request_type,channel,engine_id,engine_kind,vendor,model,"
        "CASE WHEN prompt_tokens<0 OR total_tokens<0 THEN 1 ELSE 0 END,"
        "COUNT(*),"
        "SUM(CASE WHEN prompt_tokens<0 THEN 0 ELSE prompt_tokens END),"
        "SUM(CASE WHEN completion_tokens<0 THEN 0 ELSE completion_tokens END),"
        "SUM(CASE WHEN total_tokens<0 THEN 0 ELSE total_tokens END),"
        "SUM(CASE WHEN cache_read_tokens<0 THEN 0 ELSE cache_read_tokens END),"
        "SUM(CASE WHEN cache_write_tokens<0 THEN 0 ELSE cache_write_tokens END),"
        "SUM(source_chars) FROM usage_events WHERE 1=1";
    appendFilters(sql, parameters, fromDate, toDate, feature, okFilter);
    sql +=
        " GROUP BY date,substr(time,1,5),feature,request_type,channel,engine_id,"
        "engine_kind,vendor,model,"
        "CASE WHEN prompt_tokens<0 OR total_tokens<0 THEN 1 ELSE 0 END"
        " ORDER BY date,time";

    Statement statement(*impl_->api, impl_->db, sql);
    if (!statement.valid()
        || !bindParameters(*impl_->api, statement.get(), parameters))
        return false;

    while (true)
    {
        const int result = impl_->api->step(statement.get());
        if (result == kSqliteDone)
            return true;
        if (result != kSqliteRow)
            return false;

        const std::string date = columnText(*impl_->api, statement.get(), 0);
        const std::string time = columnText(*impl_->api, statement.get(), 1);
        const std::string requestType = columnText(*impl_->api, statement.get(), 3);
        const bool unknownTokens = impl_->api->columnInt64(statement.get(), 9) != 0;
        const int requests = static_cast<int>(impl_->api->columnInt64(statement.get(), 10));
        int year = 0;
        if (date.size() >= 4)
        {
            try
            {
                year = std::stoi(date.substr(0, 4));
            }
            catch (...)
            {
            }
        }
        const int unknown = unknownTokens ? -1 : 0;
        rows.push_back(json{
            {"id", "aggregate-" + std::to_string(rows.size())},
            {"ts", date + "T" + time},
            {"date", date},
            {"year", year},
            {"time", time},
            {"feature", columnText(*impl_->api, statement.get(), 2)},
            {"ok", requestType == "ok"},
            {"requestType", requestType == "supplement" ? "supplement" : ""},
            {"channel", columnText(*impl_->api, statement.get(), 4)},
            {"engineId", columnText(*impl_->api, statement.get(), 5)},
            {"engineKind", columnText(*impl_->api, statement.get(), 6)},
            {"vendor", columnText(*impl_->api, statement.get(), 7)},
            {"model", columnText(*impl_->api, statement.get(), 8)},
            {"promptTokens", unknownTokens
                 ? unknown
                 : static_cast<int>(impl_->api->columnInt64(statement.get(), 11))},
            {"completionTokens", unknownTokens
                 ? unknown
                 : static_cast<int>(impl_->api->columnInt64(statement.get(), 12))},
            {"totalTokens", unknownTokens
                 ? unknown
                 : static_cast<int>(impl_->api->columnInt64(statement.get(), 13))},
            {"cacheReadTokens", unknownTokens
                 ? unknown
                 : static_cast<int>(impl_->api->columnInt64(statement.get(), 14))},
            {"cacheWriteTokens", unknownTokens
                 ? unknown
                 : static_cast<int>(impl_->api->columnInt64(statement.get(), 15))},
            {"sourceChars", static_cast<int>(impl_->api->columnInt64(statement.get(), 16))},
            {"requests", requests},
            {"okCount", requestType == "ok" ? requests : 0},
            {"failCount", requestType == "fail" ? requests : 0},
            {"supplementCount", requestType == "supplement" ? requests : 0},
        });
    }
#else
    (void)fromDate;
    (void)toDate;
    (void)feature;
    (void)okFilter;
    return false;
#endif
}

bool SqliteUsageDb::clear()
{
#ifdef _WIN32
    return available() && impl_->execute("DELETE FROM usage_events") && impl_->reclaimDiskSpace();
#else
    return false;
#endif
}
