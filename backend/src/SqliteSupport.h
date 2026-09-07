#pragma once

#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

// One shared dynamic binding to Windows SQLite; no bundled SQLite binary.
namespace sqlite_support {

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
#ifdef _WIN32
    HMODULE module = nullptr;
#else
    void* module = nullptr;
#endif

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
#ifdef _WIN32
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
#endif
    }

    ~SqliteApi()
    {
#ifdef _WIN32
        if (module)
            FreeLibrary(module);
#endif
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
#ifdef _WIN32
        return reinterpret_cast<T>(GetProcAddress(module, name));
#else
        (void)name;
        return nullptr;
#endif
    }
};

inline SqliteApi& sqliteApi()
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

    Statement(const Statement&) = delete;
    Statement& operator=(const Statement&) = delete;

    bool valid() const { return statement_ != nullptr; }
    sqlite3_stmt* get() const { return statement_; }

private:
    SqliteApi& api_;
    sqlite3_stmt* statement_ = nullptr;
};

inline bool execute(SqliteApi& api, sqlite3* db, const char* sql)
{
    return api.exec(db, sql, nullptr, nullptr, nullptr) == kSqliteOk;
}

inline bool bindText(SqliteApi& api, sqlite3_stmt* statement, int index, const std::string& value)
{
    const auto transient = reinterpret_cast<SqliteDestructor>(-1);
    return api.bindText(statement, index, value.c_str(), static_cast<int>(value.size()), transient)
        == kSqliteOk;
}

inline bool bindInt(SqliteApi& api, sqlite3_stmt* statement, int index, long long value)
{
    return api.bindInt64(statement, index, value) == kSqliteOk;
}

inline std::string columnText(SqliteApi& api, sqlite3_stmt* statement, int index)
{
    const auto* value = api.columnText(statement, index);
    return value ? reinterpret_cast<const char*>(value) : "";
}

} // namespace sqlite_support
