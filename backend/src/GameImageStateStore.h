#pragma once
#include "GameFileOps.h"
#include "SqliteSupport.h"
#include <functional>
#include <map>

// Image state rows share one database; original per-image JSON files remain a backup.
class GameImageStateStore {
    using Json = nlohmann::json;
    using Path = std::filesystem::path;
    using Rows = std::map<std::string, Json>;
public:
    using Progress = std::function<void(size_t, const std::string&)>;

    explicit GameImageStateStore(const Path& folder) : legacy_(folder / "state") {
        if (!api_.ready()) throw std::runtime_error("Windows SQLite 不可用，无法打开图片状态数据库");
        std::filesystem::create_directories(folder);
        const auto file = utf8path::pathUtf8(folder / "state.sqlite3");
        if (api_.openV2(file.c_str(), &db_, sqlite_support::kSqliteOpenReadWrite | sqlite_support::kSqliteOpenCreate |
                sqlite_support::kSqliteOpenFullMutex, nullptr) != sqlite_support::kSqliteOk) {
            const std::string error = db_ ? api_.errorMessage(db_) : "无法打开数据库";
            if (db_) api_.close(db_);
            throw std::runtime_error("打开图片状态失败：" + file + "：" + error);
        }
        try {
            api_.busyTimeout(db_, 5000);
            exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS image_state(id TEXT PRIMARY KEY,payload TEXT NOT NULL)");
            sqlite_support::Statement version(api_, db_, "PRAGMA user_version");
            if (!version.valid() || api_.step(version.get()) != sqlite_support::kSqliteRow) fail("读取图片状态版本失败");
            ready_ = api_.columnInt64(version.get(), 0) == 1;
        } catch (...) {
            api_.close(db_);
            throw;
        }
    }

    ~GameImageStateStore() { api_.close(db_); }
    GameImageStateStore(const GameImageStateStore&) = delete;
    GameImageStateStore& operator=(const GameImageStateStore&) = delete;

    Rows load(const std::function<void()>& check = {}, const Progress& progress = {}) {
        Rows rows;
        if (!ready_) {
            migrate(&rows, check, progress);
            return rows;
        }
        sqlite_support::Statement statement(api_, db_, "SELECT id,payload FROM image_state");
        if (!statement.valid()) fail("读取图片状态失败");
        size_t count = 0;
        int status;
        while ((status = api_.step(statement.get())) == sqlite_support::kSqliteRow) {
            if (check) check();
            rows[sqlite_support::columnText(api_, statement.get(), 0)] =
                Json::parse(sqlite_support::columnText(api_, statement.get(), 1));
            if (progress && ++count % 512 == 0) progress(count, "正在恢复图片状态 · " + std::to_string(count) + " 条");
        }
        if (status != sqlite_support::kSqliteDone) fail("读取图片状态失败");
        return rows;
    }

    void save(const Json& rows) {
        if (!ready_) migrate(nullptr, {}, {});
        writeTransaction([&](auto& insert) {
            for (const auto& row : rows) put(insert, row);
        });
    }

private:
    sqlite_support::SqliteApi& api_ = sqlite_support::sqliteApi();
    sqlite_support::sqlite3* db_ = nullptr;
    Path legacy_;
    bool ready_ = false;

    [[noreturn]] void fail(const std::string& action) const {
        throw std::runtime_error(action + "：" + api_.errorMessage(db_));
    }
    void exec(const char* sql) {
        if (!sqlite_support::execute(api_, db_, sql)) fail("图片状态数据库操作失败");
    }

    template<class Write>
    void writeTransaction(Write write) {
        exec("BEGIN IMMEDIATE");
        try {
            sqlite_support::Statement insert(api_, db_, "INSERT OR REPLACE INTO image_state(id,payload) VALUES(?,?)");
            if (!insert.valid()) fail("准备保存图片状态失败");
            write(insert);
            exec("COMMIT");
        } catch (...) {
            sqlite_support::execute(api_, db_, "ROLLBACK");
            throw;
        }
    }

    void put(sqlite_support::Statement& insert, const Json& value) {
        const auto statement = insert.get();
        if (!sqlite_support::bindText(api_, statement, 1, value.at("id").get_ref<const std::string&>()) ||
            !sqlite_support::bindText(api_, statement, 2, value.dump()) ||
            api_.step(statement) != sqlite_support::kSqliteDone || api_.reset(statement) != sqlite_support::kSqliteOk)
            fail("保存图片状态失败");
    }

    void migrate(Rows* restored, const std::function<void()>& check, const Progress& progress) {
        writeTransaction([&](auto& insert) {
            if (progress) progress(0, "正在归并旧图片状态");
            if (std::filesystem::is_directory(legacy_)) {
                size_t count = 0;
                for (const auto& file : std::filesystem::directory_iterator(legacy_)) {
                    if (!file.is_regular_file() || file.path().extension() != ".json") continue;
                    if (check) check();
                    auto value = Json::parse(gamefiles::read(file.path()));
                    if (!value.contains("selectionManual") && !value.contains("screening")) value["selectionManual"] = true;
                    put(insert, value);
                    if (restored) {
                        const auto id = value.at("id").get<std::string>();
                        (*restored)[id] = std::move(value);
                    }
                    if (progress && ++count % 128 == 0) progress(count, "正在归并旧图片状态 · " + std::to_string(count) + " 条");
                }
            }
            if (check) check();
            exec("PRAGMA user_version=1");
        });
        ready_ = true;
    }
};
