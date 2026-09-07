#include "ConversationManager.h"
#include "SqliteUsageDb.h"
#include "SqliteSupport.h"
#include "UsageStore.h"
#include "Utf8Path.h"

#include <cstdio>
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <random>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace fs = std::filesystem;
using json = nlohmann::json;
using namespace sqlite_support;

void expect(bool value, const std::string& message)
{
    if (!value)
        throw std::runtime_error(message);
}

template <typename Fn>
void expectThrow(Fn&& fn, const std::string& message)
{
    bool threw = false;
    try { fn(); }
    catch (const std::exception&) { threw = true; }
    expect(threw, message);
}

struct TemporaryDirectory {
    fs::path path;
    TemporaryDirectory()
    {
        const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
        path = fs::temp_directory_path()
            / ("llmchat-storage-test-" + std::to_string(stamp)
                + "-" + std::to_string(std::random_device{}()));
        expect(fs::create_directory(path), "create isolated test directory");
    }
    ~TemporaryDirectory()
    {
        // Only the exact fresh directory created above is ever removed.
        std::error_code ec;
        fs::remove_all(path, ec);
    }
};

void writeFile(const fs::path& path, const std::string& text)
{
    fs::create_directories(path.parent_path());
    std::ofstream file(path, std::ios::binary);
    file << text;
    file.close();
    expect(static_cast<bool>(file), "write test fixture");
}

std::string readFile(const fs::path& path)
{
    std::ifstream file(path, std::ios::binary);
    expect(static_cast<bool>(file), "read test fixture");
    std::ostringstream text;
    text << file.rdbuf();
    return text.str();
}

struct Database {
    SqliteApi& api = sqliteApi();
    sqlite3* db = nullptr;
    explicit Database(const fs::path& path)
    {
        expect(api.ready(), "system SQLite available");
        expect(api.openV2(utf8path::pathUtf8(path).c_str(), &db,
            kSqliteOpenReadWrite | kSqliteOpenFullMutex, nullptr) == kSqliteOk,
            "open test database");
    }
    ~Database() { if (db) api.close(db); }
    void run(const char* sql)
    {
        expect(execute(api, db, sql), "execute test SQL");
    }
    long long scalar(const char* sql)
    {
        Statement statement(api, db, sql);
        expect(statement.valid() && api.step(statement.get()) == kSqliteRow,
            "read test scalar");
        return api.columnInt64(statement.get(), 0);
    }
};

void testUsage(const fs::path& root)
{
    const auto path = root / "usage" / "usage-events.jsonl";
    SqliteUsageDb db(path.string());
    expect(db.available(), "usage SQLite initialized");
    std::vector<json> inserted;
    for (int i = 0; i < 1605; ++i)
    {
        // Three rows share a timestamp: newest-first must also order by seq.
        char time[16];
        std::snprintf(time, sizeof(time), "%02d:%02d:%02d",
            (i / 3 / 3600) % 24, (i / 3 / 60) % 60, (i / 3) % 60);
        const std::string date = i % 9 == 0 ? "2026-08-22" : "2026-08-23";
        json row{
            {"id", std::to_string(i)}, {"date", date},
            {"ts", date + "T" + time + "+08:00"}, {"time", time},
            {"feature", i % 3 == 0 ? "chat" : "image"},
            {"model", i % 7 == 0 ? "peak-model" : "idle-model"},
            {"channel", "llm"}, {"ok", i % 4 != 0},
            {"promptTokens", i % 13 == 0 ? -1 : 100},
            {"totalTokens", i % 13 == 0 ? -1 : 130},
        };
        expect(db.upsert(row), "insert usage fixture");
        inserted.push_back(std::move(row));
    }

    auto ordered = inserted;
    std::reverse(ordered.begin(), ordered.end());
    std::stable_sort(ordered.begin(), ordered.end(), [](const json& a, const json& b) {
        return a.at("ts").get<std::string>() > b.at("ts").get<std::string>();
    });
    std::vector<json> candidates;
    for (const auto& row : ordered)
        if (row["date"] == "2026-08-23" && row["feature"] == "image" && row["ok"] == true)
            candidates.push_back(row);
    std::vector<json> expected;
    for (const auto& row : candidates)
        if (row["model"] == "peak-model")
            expected.push_back(row);

    for (const int page : {1, 2, 5, 100})
    {
        int calls = 0;
        int total = -1;
        std::vector<json> actual;
        expect(db.queryPage("2026-08-23", "2026-08-23", "image", "ok",
            page, 20, actual, total, [&](const json& row) {
                ++calls;
                return row["model"] == "peak-model";
            }), "filtered page succeeds");
        expect(calls == static_cast<int>(candidates.size()),
            "predicate is evaluated exactly once per candidate, including a late page");
        expect(total == static_cast<int>(expected.size()), "filtered count exact");
        const size_t begin = std::min(expected.size(), static_cast<size_t>((page - 1) * 20));
        const size_t end = std::min(expected.size(), begin + 20);
        expect(actual == std::vector<json>(expected.begin() + begin, expected.begin() + end),
            "filtered page preserves row payload and (ts,seq) order");
    }

    int total = -1;
    std::vector<json> rows;
    expect(db.queryPage("", "", "", "", 1, 20, rows, total), "unfiltered page");
    expect(total == 1605 && rows == std::vector<json>(ordered.begin(), ordered.begin() + 20),
        "unfiltered pagination unchanged");
    expect(db.queryPage("", "", "", "", 1, 20, rows, total,
        [](const json&) { return false; }), "empty filter query");
    expect(total == 0 && rows.empty(), "zero matches");
    expectThrow([&] {
        db.queryPage("", "", "", "", 1, 20, rows, total,
            [](const json&) -> bool { throw std::runtime_error("predicate failed"); });
    }, "predicate errors must not silently produce incomplete statistics");

    UsageStore store(path.string());
    rows = store.eventPage("2026-08-23", "2026-08-23", "image", "ok", 2, 20, total,
        [](const json& row) { return row["model"] == "peak-model"; });
    expect(total == static_cast<int>(expected.size())
        && rows == std::vector<json>(expected.begin() + 20, expected.begin() + 40),
        "UsageStore forwards predicate and count");
    std::cout << "PASS usage pagination: one stream, exact count, ties, late/empty pages\n";
}

json legacyConversations()
{
    return json::array({
        {{"id", "newest"}, {"title", "Newer"}, {"createTime", "2026-09-06T10:00:00Z"},
         {"messages", json::array({{{"role", "user"}, {"content", "hello"},
             {"extra", "preserve arbitrary legacy message fields"}}})}},
        {{"id", "empty"}, {"title", "新对话"}, {"createTime", "2026-09-05T10:00:00Z"},
         {"messages", json::array()}},
        {{"id", "older"}, {"title", "Older"}, {"createTime", "2026-09-04T10:00:00Z"},
         {"messages", json::array({{{"role", "user"}, {"content", "old question"}},
             {{"role", "assistant"}, {"content", "old answer"}}})}},
    });
}

void testConversations(const fs::path& root)
{
    const auto path = root / "conversations" / "conversations.json";
    const auto legacy = legacyConversations();
    const auto original = legacy.dump(2);
    writeFile(path, original);
    std::string newId;
    {
        ConversationManager manager(path.string());
        auto summaries = manager.summaries();
        expect(summaries.size() == 2 && summaries[0]["id"] == "newest"
            && summaries[1]["id"] == "older", "legacy list order and hidden empty conversation");
        expect(!summaries[0].contains("messages") && summaries[1]["messageCount"] == 2,
            "summary has count without bodies");
        expect(manager.conversation("newest").messages == legacy[0]["messages"],
            "legacy body including extra fields preserved");
        expect(manager.addMessage("newest", "assistant", "new answer"), "append one message");
        expect(manager.conversation("older").messages == legacy[2]["messages"],
            "loading another body works");
        expect(manager.conversation("newest").messages.size() == 2,
            "switching cached conversation reloads updated body");
        expect(manager.setTitle("older", "renamed"), "rename");
        auto created = manager.createConversation();
        newId = created.id;
        expect(manager.conversation("empty").id.empty(), "create prunes only empty conversations");
        expect(manager.addMessage(newId, "user", "这是一段超过二十字节的中文标题"),
            "append UTF-8 message");
        const auto summaryText = manager.summaries().dump();
        expect(!summaryText.empty(), "title truncation stays valid UTF-8");

        // Force the metadata update to fail AFTER inserting the message. Both
        // must roll back together, and the cache must not expose the failed row.
        Database control(path.parent_path() / "conversations.sqlite3");
        control.run("CREATE TRIGGER reject_count BEFORE UPDATE OF message_count ON conversations "
            "BEGIN SELECT RAISE(ABORT,'test rollback'); END");
        expectThrow([&] { manager.addMessage(newId, "assistant", "must roll back"); },
            "injected metadata failure surfaces");
        control.run("DROP TRIGGER reject_count");
        expect(manager.conversation(newId).messages.size() == 1, "cache unchanged after rollback");
        expect(control.scalar("SELECT COUNT(*) FROM conversation_messages WHERE payload LIKE '%must roll back%'") == 0,
            "failed message insert rolled back");
        expect(readFile(path) == original, "legacy JSON never rewritten");
    }
    {
        ConversationManager reopened(path.string());
        expect(reopened.conversation("newest").messages.size() == 2, "append survives restart");
        expect(reopened.conversation(newId).messages.size() == 1, "rollback survives restart");
        expect(reopened.conversation("older").title == "renamed", "rename survives restart");
        expect(reopened.currentConversationId() == newId, "newest remains initial conversation");
        expect(reopened.deleteConversation(newId), "delete new conversation");
        expect(reopened.conversation(newId).id.empty(), "deleted cache/body unavailable");
        Database control(path.parent_path() / "conversations.sqlite3");
        expect(control.scalar("SELECT COUNT(*) FROM conversation_messages "
            "WHERE conversation_id NOT IN (SELECT id FROM conversations)") == 0,
            "foreign-key cascade removes only deleted conversation messages");
    }
    {
        ConversationManager reopened(path.string());
        expect(reopened.conversation(newId).id.empty()
            && reopened.conversation("empty").id.empty(), "migration is not repeated on restart");
        expect(reopened.summaries().size() == 2, "no duplicate imports");
        expect(readFile(path) == original, "original still byte-for-byte unchanged");
    }
    std::cout << "PASS conversations: migration, lazy bodies, append/rename/delete, transaction rollback, restart\n";
}

void testMigrationRollback(const fs::path& root)
{
    const auto path = root / "broken-import" / "conversations.json";
    auto legacy = legacyConversations();
    legacy[2]["id"] = "newest"; // Fails after an earlier row has already inserted.
    const auto invalid = legacy.dump();
    writeFile(path, invalid);
    expectThrow([&] { ConversationManager manager(path.string()); }, "duplicate ID aborts migration");
    {
        Database control(path.parent_path() / "conversations.sqlite3");
        expect(control.scalar("SELECT COUNT(*) FROM conversations") == 0, "partial import rolled back");
        expect(control.scalar("SELECT COUNT(*) FROM conversation_messages") == 0, "partial messages rolled back");
        expect(control.scalar("SELECT COUNT(*) FROM conversation_metadata") == 0, "no premature migration marker");
    }
    expect(readFile(path) == invalid, "failed import preserves source");
    writeFile(path, legacyConversations().dump());
    ConversationManager recovered(path.string());
    expect(recovered.summaries().size() == 2, "corrected import can be retried once");
    std::cout << "PASS migration failure: no partial rows or completion marker\n";
}

int main()
{
    try
    {
        TemporaryDirectory temporary;
        testUsage(temporary.path);
        testConversations(temporary.path);
        testMigrationRollback(temporary.path);
        std::cout << "All storage regression tests passed.\n";
        return 0;
    }
    catch (const std::exception& error)
    {
        std::cerr << "FAIL: " << error.what() << '\n';
        return 1;
    }
}
