#include "SqliteUsageDb.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <set>
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

struct sqlite3;
struct sqlite3_stmt;
using SqliteDestructor = void (*)(void*);

constexpr int kSqliteOk = 0;
constexpr int kSqliteRow = 100;
constexpr int kSqliteDone = 101;
constexpr int kSqliteOpenReadWrite = 0x00000002;
constexpr int kSqliteOpenCreate = 0x00000004;
constexpr int kSqliteOpenFullMutex = 0x00010000;

struct SqliteApi {
    HMODULE module = nullptr;

    int (*openV2)(const char*, sqlite3**, int, const char*) = nullptr;
    int (*close)(sqlite3*) = nullptr;
    const char* (*errorMessage)(sqlite3*) = nullptr;
    int (*exec)(sqlite3*, const char*, int (*)(void*, int, char**, char**), void*, char**) = nullptr;
    int (*prepareV2)(sqlite3*, const char*, int, sqlite3_stmt**, const char**) = nullptr;
    int (*step)(sqlite3_stmt*) = nullptr;
    int (*finalize)(sqlite3_stmt*) = nullptr;
    int (*bindText)(sqlite3_stmt*, int, const char*, int, SqliteDestructor) = nullptr;
    int (*bindNull)(sqlite3_stmt*, int) = nullptr;
    int (*bindInt64)(sqlite3_stmt*, int, long long) = nullptr;
    const unsigned char* (*columnText)(sqlite3_stmt*, int) = nullptr;
    long long (*columnInt64)(sqlite3_stmt*, int) = nullptr;
    int (*busyTimeout)(sqlite3*, int) = nullptr;

    SqliteApi()
    {
        module = LoadLibraryW(L"winsqlite3.dll");
        if (!module)
            return;

        openV2 = load<decltype(openV2)>("sqlite3_open_v2");
        close = load<decltype(close)>("sqlite3_close");
        errorMessage = load<decltype(errorMessage)>("sqlite3_errmsg");
        exec = load<decltype(exec)>("sqlite3_exec");
        prepareV2 = load<decltype(prepareV2)>("sqlite3_prepare_v2");
        step = load<decltype(step)>("sqlite3_step");
        finalize = load<decltype(finalize)>("sqlite3_finalize");
        bindText = load<decltype(bindText)>("sqlite3_bind_text");
        bindNull = load<decltype(bindNull)>("sqlite3_bind_null");
        bindInt64 = load<decltype(bindInt64)>("sqlite3_bind_int64");
        columnText = load<decltype(columnText)>("sqlite3_column_text");
        columnInt64 = load<decltype(columnInt64)>("sqlite3_column_int64");
        busyTimeout = load<decltype(busyTimeout)>("sqlite3_busy_timeout");

        if (!ready())
        {
            FreeLibrary(module);
            module = nullptr;
        }
    }

    ~SqliteApi()
    {
        if (module)
            FreeLibrary(module);
    }

    bool ready() const
    {
        return module && openV2 && close && errorMessage && exec && prepareV2 && step
            && finalize && bindText && bindNull && bindInt64 && columnText
            && columnInt64 && busyTimeout;
    }

private:
    template <typename T>
    T load(const char* name)
    {
        return reinterpret_cast<T>(GetProcAddress(module, name));
    }
};

SqliteApi& sqliteApi()
{
    static SqliteApi api;
    return api;
}

class Statement {
public:
    Statement(SqliteApi& api, sqlite3* db, const std::string& sql)
        : api_(api)
    {
        if (api_.prepareV2(db, sql.c_str(), -1, &statement_, nullptr) != kSqliteOk)
            statement_ = nullptr;
    }

    ~Statement()
    {
        if (statement_)
            api_.finalize(statement_);
    }

    bool valid() const { return statement_ != nullptr; }
    sqlite3_stmt* get() const { return statement_; }

private:
    SqliteApi& api_;
    sqlite3_stmt* statement_ = nullptr;
};

bool execute(SqliteApi& api, sqlite3* db, const char* sql)
{
    return api.exec(db, sql, nullptr, nullptr, nullptr) == kSqliteOk;
}

bool bindText(SqliteApi& api, sqlite3_stmt* statement, int index, const std::string& value)
{
    const auto transient = reinterpret_cast<SqliteDestructor>(-1);
    return api.bindText(statement, index, value.c_str(), static_cast<int>(value.size()), transient)
        == kSqliteOk;
}

bool bindInt(SqliteApi& api, sqlite3_stmt* statement, int index, long long value)
{
    return api.bindInt64(statement, index, value) == kSqliteOk;
}

std::string columnText(SqliteApi& api, sqlite3_stmt* statement, int index)
{
    const auto* value = api.columnText(statement, index);
    return value ? reinterpret_cast<const char*>(value) : "";
}

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
        return db && ::execute(*api, db, sql);
    }

    bool writeRow(const json& row)
    {
        static const char* sql =
            "INSERT INTO usage_events("
            "event_id,date,ts,time,feature,request_type,ok,channel,engine_id,"
            "engine_kind,vendor,model,prompt_tokens,completion_tokens,total_tokens,"
            "cache_read_tokens,cache_write_tokens,source_chars,payload) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(event_id) DO UPDATE SET "
            "date=excluded.date,ts=excluded.ts,time=excluded.time,"
            "feature=excluded.feature,request_type=excluded.request_type,ok=excluded.ok,"
            "channel=excluded.channel,engine_id=excluded.engine_id,"
            "engine_kind=excluded.engine_kind,vendor=excluded.vendor,model=excluded.model,"
            "prompt_tokens=excluded.prompt_tokens,"
            "completion_tokens=excluded.completion_tokens,total_tokens=excluded.total_tokens,"
            "cache_read_tokens=excluded.cache_read_tokens,"
            "cache_write_tokens=excluded.cache_write_tokens,"
            "source_chars=excluded.source_chars,payload=excluded.payload";
        Statement statement(*api, db, sql);
        if (!statement.valid())
            return false;

        const std::string id = row.value("id", "");
        if (id.empty())
        {
            if (api->bindNull(statement.get(), 1) != kSqliteOk)
                return false;
        }
        else if (!bindText(*api, statement.get(), 1, id))
            return false;

        const std::string payload = row.dump();
        int parameter = 2;
        if (!bindText(*api, statement.get(), parameter++, row.value("date", ""))
            || !bindText(*api, statement.get(), parameter++, row.value("ts", ""))
            || !bindText(*api, statement.get(), parameter++, row.value("time", ""))
            || !bindText(*api, statement.get(), parameter++, row.value("feature", ""))
            || !bindText(*api, statement.get(), parameter++, requestTypeOf(row))
            || !bindInt(*api, statement.get(), parameter++, row.value("ok", false) ? 1 : 0)
            || !bindText(*api, statement.get(), parameter++, row.value("channel", ""))
            || !bindText(*api, statement.get(), parameter++, row.value("engineId", ""))
            || !bindText(*api, statement.get(), parameter++, row.value("engineKind", ""))
            || !bindText(*api, statement.get(), parameter++, row.value("vendor", ""))
            || !bindText(*api, statement.get(), parameter++, row.value("model", ""))
            || !bindInt(*api, statement.get(), parameter++, row.value("promptTokens", 0))
            || !bindInt(*api, statement.get(), parameter++, row.value("completionTokens", 0))
            || !bindInt(*api, statement.get(), parameter++, row.value("totalTokens", 0))
            || !bindInt(*api, statement.get(), parameter++, row.value("cacheReadTokens", 0))
            || !bindInt(*api, statement.get(), parameter++, row.value("cacheWriteTokens", 0))
            || !bindInt(*api, statement.get(), parameter++, row.value("sourceChars", 0))
            || !bindText(*api, statement.get(), parameter++, payload))
            return false;
        return api->step(statement.get()) == kSqliteDone;
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

    bool structured() const
    {
        Statement statement(
            *api,
            db,
            "SELECT value FROM usage_metadata WHERE key='structured_columns_v2'");
        return statement.valid() && api->step(statement.get()) == kSqliteRow;
    }

    bool backfillStructuredColumns()
    {
        if (structured())
            return true;

        Statement statement(*api, db, "SELECT payload FROM usage_events ORDER BY seq");
        if (!statement.valid())
            return false;
        std::vector<json> rows;
        while (true)
        {
            const int result = api->step(statement.get());
            if (result == kSqliteDone)
                break;
            if (result != kSqliteRow)
                return false;
            try
            {
                rows.push_back(json::parse(columnText(*api, statement.get(), 0)));
            }
            catch (...)
            {
            }
        }

        if (!execute("BEGIN IMMEDIATE"))
            return false;
        bool ok = true;
        for (const auto& row : rows)
        {
            if (!writeRow(row))
            {
                ok = false;
                break;
            }
        }
        if (ok)
            ok = execute(
                "INSERT OR REPLACE INTO usage_metadata(key,value) "
                "VALUES('structured_columns_v2','complete')");
        if (ok)
            ok = execute("COMMIT");
        else
            execute("ROLLBACK");
        return ok;
    }

    bool migrated() const
    {
        Statement statement(
            *api,
            db,
            "SELECT value FROM usage_metadata WHERE key='jsonl_migrated_v1'");
        return statement.valid() && api->step(statement.get()) == kSqliteRow;
    }

    bool migrateJsonl()
    {
        if (migrated())
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
        if (ok)
            ok = execute("COMMIT");
        else
            execute("ROLLBACK");
        return ok;
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
    if (impl_->api->openV2(impl_->dbPath.c_str(), &impl_->db, flags, nullptr) != kSqliteOk)
    {
        if (impl_->db)
            impl_->api->close(impl_->db);
        impl_->db = nullptr;
        return;
    }

    impl_->api->busyTimeout(impl_->db, 5000);
    const bool ready = impl_->execute("PRAGMA journal_mode=WAL")
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
        && impl_->backfillStructuredColumns()
        && impl_->execute(
            "CREATE INDEX IF NOT EXISTS usage_events_date_idx "
            "ON usage_events(date)")
        && impl_->execute(
            "CREATE INDEX IF NOT EXISTS usage_events_date_feature_idx "
            "ON usage_events(date,feature)")
        && impl_->execute(
            "CREATE INDEX IF NOT EXISTS usage_events_date_result_idx "
            "ON usage_events(date,request_type)")
        && impl_->execute(
            "CREATE INDEX IF NOT EXISTS usage_events_date_model_time_idx "
            "ON usage_events(date,model,time)");
    if (!ready)
    {
        impl_->api->close(impl_->db);
        impl_->db = nullptr;
    }
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

    std::string sql = "SELECT payload FROM usage_events WHERE 1=1";
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
        const std::string text = columnText(*impl_->api, statement.get(), 0);
        if (text.empty())
            continue;
        try
        {
            rows.push_back(json::parse(text));
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
    int& totalRows) const
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
        "SELECT payload FROM usage_events" + where
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
            rows.push_back(json::parse(columnText(*impl_->api, statement.get(), 0)));
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
    if (!available())
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
    return available() && impl_->execute("DELETE FROM usage_events");
#else
    return false;
#endif
}
