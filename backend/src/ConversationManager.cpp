#include "ConversationManager.h"
#include "SqliteSupport.h"
#include "Utf8Path.h"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <optional>
#include <random>
#include <sstream>
#include <stdexcept>
#include <vector>

using json = nlohmann::json;
namespace fs = std::filesystem;
using namespace sqlite_support;

namespace {

std::string creationTime()
{
    const auto now = std::chrono::system_clock::now();
    const auto t = std::chrono::system_clock::to_time_t(now);
    std::tm tm{};
#ifdef _WIN32
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    std::ostringstream out;
    out << std::put_time(&tm, "%Y-%m-%dT%H:%M:%SZ");
    return out.str();
}

} // namespace

struct ConversationManager::Impl {
    SqliteApi& api = sqliteApi();
    sqlite3* db = nullptr;
    // One recently accessed body, not all historical conversations.
    mutable std::optional<Conversation> cached;

    ~Impl()
    {
        if (db)
            api.close(db);
    }

    void check(bool ok) const
    {
        if (!ok)
            throw std::runtime_error(
                std::string("会话数据库操作失败: ") + (db ? api.errorMessage(db) : "SQLite 不可用"));
    }

    void execute(const char* sql) const
    {
        check(sqlite_support::execute(api, db, sql));
    }

    struct Transaction {
        const Impl& store;
        bool committed = false;
        explicit Transaction(const Impl& value) : store(value)
        {
            store.execute("BEGIN IMMEDIATE");
        }
        ~Transaction()
        {
            if (!committed)
                sqlite_support::execute(store.api, store.db, "ROLLBACK");
        }
        void commit()
        {
            store.execute("COMMIT");
            committed = true;
        }
    };

    void write(
        const std::string& sql,
        const std::vector<std::string>& parameters = {}) const
    {
        Statement statement(api, db, sql);
        check(statement.valid());
        for (size_t i = 0; i < parameters.size(); ++i)
            check(bindText(api, statement.get(), static_cast<int>(i + 1), parameters[i]));
        check(api.step(statement.get()) == kSqliteDone);
    }

    std::optional<Conversation> metadata(const std::string& id) const
    {
        Statement statement(api, db,
            "SELECT id,title,create_time FROM conversations WHERE id=?");
        check(statement.valid() && bindText(api, statement.get(), 1, id));
        const int result = api.step(statement.get());
        if (result == kSqliteDone)
            return std::nullopt;
        check(result == kSqliteRow);
        Conversation conv;
        conv.id = columnText(api, statement.get(), 0);
        conv.title = columnText(api, statement.get(), 1);
        conv.createTime = columnText(api, statement.get(), 2);
        return conv;
    }

    std::string firstId() const
    {
        Statement statement(api, db, "SELECT id FROM conversations ORDER BY seq DESC LIMIT 1");
        check(statement.valid());
        const int result = api.step(statement.get());
        check(result == kSqliteRow || result == kSqliteDone);
        return result == kSqliteRow ? columnText(api, statement.get(), 0) : "";
    }

    int count() const
    {
        Statement statement(api, db, "SELECT COUNT(*) FROM conversations");
        check(statement.valid() && api.step(statement.get()) == kSqliteRow);
        return static_cast<int>(api.columnInt64(statement.get(), 0));
    }

    void insert(const Conversation& conv) const
    {
        write("INSERT INTO conversations(id,title,create_time,message_count) VALUES(?,?,?,?)",
            {conv.id, conv.title, conv.createTime, std::to_string(conv.messages.size())});
        for (const auto& message : conv.messages)
            write("INSERT INTO conversation_messages(conversation_id,payload) VALUES(?,?)",
                {conv.id, message.dump()});
    }

    void initialize(const std::string& legacyPath)
    {
        if (!api.ready())
            throw std::runtime_error("无法初始化会话数据库：系统 SQLite 不可用");
        fs::path path(legacyPath);
        path.replace_extension(".sqlite3");
        if (path.has_parent_path())
            fs::create_directories(path.parent_path());
        check(api.openV2(utf8path::pathUtf8(path).c_str(), &db,
            kSqliteOpenReadWrite | kSqliteOpenCreate | kSqliteOpenFullMutex, nullptr) == kSqliteOk);
        check(api.busyTimeout(db, 5000) == kSqliteOk);
        execute("PRAGMA journal_mode=WAL");
        execute("PRAGMA synchronous=FULL");
        execute("PRAGMA foreign_keys=ON");
        execute("CREATE TABLE IF NOT EXISTS conversation_metadata("
            "key TEXT PRIMARY KEY,value TEXT NOT NULL)");
        execute("CREATE TABLE IF NOT EXISTS conversations("
            "seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,"
            "title TEXT NOT NULL,create_time TEXT NOT NULL,message_count INTEGER NOT NULL DEFAULT 0)");
        execute("CREATE TABLE IF NOT EXISTS conversation_messages("
            "seq INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT NOT NULL,"
            "payload TEXT NOT NULL,FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE)");
        execute("CREATE INDEX IF NOT EXISTS conversation_messages_parent_idx "
            "ON conversation_messages(conversation_id,seq)");
        migrate(legacyPath);
    }

    void migrate(const std::string& legacyPath)
    {
        {
            Statement migrated(api, db,
                "SELECT value FROM conversation_metadata WHERE key='json_migrated_v1'");
            check(migrated.valid());
            const int result = api.step(migrated.get());
            if (result == kSqliteRow)
                return;
            check(result == kSqliteDone);
        }

        // Keep the original JSON untouched. The marker is committed with ALL
        // imported rows, so an interrupted or invalid import is safely retried.
        json legacy = json::array();
        if (fs::exists(legacyPath))
        {
            std::ifstream in(legacyPath, std::ios::binary);
            if (!in)
                throw std::runtime_error("无法读取原会话文件，尚未迁移: " + legacyPath);
            in >> legacy;
            if (!legacy.is_array())
                throw std::runtime_error("原会话文件格式错误，尚未迁移: " + legacyPath);
        }

        Transaction transaction(*this);
        // Legacy file is newest-first, whereas seq is insertion order.
        for (auto it = legacy.rbegin(); it != legacy.rend(); ++it)
        {
            if (!it->is_object())
                continue;
            Conversation conv;
            conv.id = it->value("id", "");
            if (conv.id.empty())
                continue;
            conv.title = it->value("title", "新对话");
            conv.createTime = it->value("createTime", "");
            if (it->contains("messages") && (*it)["messages"].is_array())
                conv.messages = (*it)["messages"];
            insert(conv);
        }
        write("INSERT INTO conversation_metadata(key,value) VALUES('json_migrated_v1','1')");
        transaction.commit();
    }

    Conversation read(const std::string& id) const
    {
        if (cached && cached->id == id)
            return *cached;
        auto conv = metadata(id);
        if (!conv)
            return {};
        Statement statement(api, db,
            "SELECT payload FROM conversation_messages WHERE conversation_id=? ORDER BY seq");
        check(statement.valid() && bindText(api, statement.get(), 1, id));
        while (true)
        {
            const int result = api.step(statement.get());
            if (result == kSqliteDone)
                break;
            check(result == kSqliteRow);
            conv->messages.push_back(json::parse(columnText(api, statement.get(), 0)));
        }
        cached = std::move(conv);
        return *cached;
    }
};

ConversationManager::ConversationManager(std::string filePath)
    : impl_(std::make_unique<Impl>())
{
    impl_->initialize(filePath);
    currentConvId_ = impl_->firstId();
    if (currentConvId_.empty())
        createConversation();
}

ConversationManager::~ConversationManager() = default;

Conversation ConversationManager::createConversation()
{
    std::lock_guard lock(mutex_);
    Conversation conv;
    conv.id = generateId();
    conv.title = "新对话";
    conv.createTime = creationTime();
    Impl::Transaction transaction(*impl_);
    impl_->write("DELETE FROM conversations WHERE message_count=0");
    impl_->insert(conv);
    transaction.commit();
    currentConvId_ = conv.id;
    impl_->cached = conv;
    return conv;
}

bool ConversationManager::deleteConversation(const std::string& id)
{
    std::lock_guard lock(mutex_);
    if (impl_->count() <= 1 || !impl_->metadata(id))
        return false;
    Impl::Transaction transaction(*impl_);
    impl_->write("DELETE FROM conversations WHERE id=?", {id});
    transaction.commit();
    if (impl_->cached && impl_->cached->id == id)
        impl_->cached.reset();
    if (currentConvId_ == id)
        currentConvId_ = impl_->firstId();
    return true;
}

bool ConversationManager::addMessage(
    const std::string& convId,
    const std::string& role,
    const std::string& content)
{
    std::lock_guard lock(mutex_);
    auto conv = impl_->metadata(convId);
    if (!conv)
        return false;
    json message{{"role", role}, {"content", content}};
    if (role == "user" && conv->title == "新对话")
    {
        size_t end = std::min<size_t>(20, content.size());
        // Do not split a UTF-8 character at the byte-length title limit.
        while (end > 0 && end < content.size()
            && (static_cast<unsigned char>(content[end]) & 0xc0) == 0x80)
            --end;
        conv->title = content.substr(0, end);
    }
    Impl::Transaction transaction(*impl_);
    impl_->write("INSERT INTO conversation_messages(conversation_id,payload) VALUES(?,?)",
        {convId, message.dump()});
    impl_->write("UPDATE conversations SET title=?,message_count=message_count+1 WHERE id=?",
        {conv->title, convId});
    transaction.commit();
    if (impl_->cached && impl_->cached->id == convId)
    {
        impl_->cached->title = conv->title;
        impl_->cached->messages.push_back(std::move(message));
    }
    return true;
}

bool ConversationManager::setTitle(const std::string& convId, const std::string& title)
{
    std::lock_guard lock(mutex_);
    if (!impl_->metadata(convId))
        return false;
    impl_->write("UPDATE conversations SET title=? WHERE id=?", {title, convId});
    if (impl_->cached && impl_->cached->id == convId)
        impl_->cached->title = title;
    return true;
}

json ConversationManager::summaries() const
{
    std::lock_guard lock(mutex_);
    Statement statement(impl_->api, impl_->db,
        "SELECT id,title,create_time,message_count FROM conversations "
        "WHERE message_count>0 ORDER BY seq DESC");
    impl_->check(statement.valid());
    json summaries = json::array();
    while (true)
    {
        const int result = impl_->api.step(statement.get());
        if (result == kSqliteDone)
            break;
        impl_->check(result == kSqliteRow);
        summaries.push_back(json{
            {"id", columnText(impl_->api, statement.get(), 0)},
            {"title", columnText(impl_->api, statement.get(), 1)},
            {"createTime", columnText(impl_->api, statement.get(), 2)},
            {"messageCount", impl_->api.columnInt64(statement.get(), 3)},
        });
    }
    return summaries;
}

Conversation ConversationManager::conversation(const std::string& id) const
{
    std::lock_guard lock(mutex_);
    return impl_->read(id);
}

std::string ConversationManager::currentConversationId() const
{
    std::lock_guard lock(mutex_);
    return currentConvId_;
}

void ConversationManager::switchToConversation(const std::string& id)
{
    std::lock_guard lock(mutex_);
    if (impl_->metadata(id))
        currentConvId_ = id;
}

json ConversationManager::toJson(const Conversation& conv, bool includeMessages) const
{
    json obj{
        {"id", conv.id}, {"title", conv.title}, {"createTime", conv.createTime},
    };
    if (includeMessages)
        obj["messages"] = conv.messages;
    else
        obj["messageCount"] = conv.messages.size();
    return obj;
}

std::string ConversationManager::generateId() const
{
    using namespace std::chrono;
    const auto ms = duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
    static thread_local std::mt19937 rng{std::random_device{}()};
    std::uniform_int_distribution<int> dist(0, 9999);
    return std::to_string(ms) + std::to_string(dist(rng));
}
