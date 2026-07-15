#include "ConversationManager.h"

#include <algorithm>
#include <chrono>
#include <fstream>
#include <iomanip>
#include <random>
#include <sstream>

using json = nlohmann::json;

ConversationManager::ConversationManager(std::string filePath)
    : filePath_(std::move(filePath))
{
    loadFromFile();

    if (conversations_.empty())
    {
        Conversation conv;
        conv.id = generateId();
        conv.title = "新对话";
        conv.messages = json::array();

        const auto now = std::chrono::system_clock::now();
        const auto t = std::chrono::system_clock::to_time_t(now);
        std::tm tm{};
#ifdef _WIN32
        gmtime_s(&tm, &t);
#else
        gmtime_r(&t, &tm);
#endif
        std::ostringstream oss;
        oss << std::put_time(&tm, "%Y-%m-%dT%H:%M:%SZ");
        conv.createTime = oss.str();

        conversations_.push_back(conv);
        saveToFile();
    }

    currentConvId_ = conversations_.front().id;
}

Conversation ConversationManager::createConversation()
{
    std::lock_guard lock(mutex_);

    std::vector<Conversation> cleaned;
    for (const auto& conv : conversations_)
    {
        if (!conv.messages.empty())
        {
            cleaned.push_back(conv);
        }
    }
    conversations_ = std::move(cleaned);

    Conversation conv;
    conv.id = generateId();
    conv.title = "新对话";
    conv.messages = json::array();

    const auto now = std::chrono::system_clock::now();
    const auto t = std::chrono::system_clock::to_time_t(now);
    std::tm tm{};
#ifdef _WIN32
    gmtime_s(&tm, &t);
#else
    gmtime_r(&t, &tm);
#endif
    std::ostringstream oss;
    oss << std::put_time(&tm, "%Y-%m-%dT%H:%M:%SZ");
    conv.createTime = oss.str();

    conversations_.insert(conversations_.begin(), conv);
    currentConvId_ = conv.id;
    saveToFile();
    return conv;
}

bool ConversationManager::deleteConversation(const std::string& id)
{
    std::lock_guard lock(mutex_);
    if (conversations_.size() <= 1)
    {
        return false;
    }

    const auto it = std::remove_if(
        conversations_.begin(),
        conversations_.end(),
        [&](const Conversation& c) { return c.id == id; });

    if (it == conversations_.end())
    {
        return false;
    }

    conversations_.erase(it, conversations_.end());

    if (currentConvId_ == id)
    {
        currentConvId_ = conversations_.front().id;
    }

    saveToFile();
    return true;
}

bool ConversationManager::addMessage(
    const std::string& convId,
    const std::string& role,
    const std::string& content)
{
    std::lock_guard lock(mutex_);
    for (auto& conv : conversations_)
    {
        if (conv.id != convId)
        {
            continue;
        }

        json msg;
        msg["role"] = role;
        msg["content"] = content;
        conv.messages.push_back(msg);

        if (role == "user" && conv.title == "新对话")
        {
            conv.title = content.substr(0, std::min<size_t>(20, content.size()));
        }

        saveToFile();
        return true;
    }
    return false;
}

bool ConversationManager::setTitle(const std::string& convId, const std::string& title)
{
    std::lock_guard lock(mutex_);
    for (auto& conv : conversations_)
    {
        if (conv.id == convId)
        {
            conv.title = title;
            saveToFile();
            return true;
        }
    }
    return false;
}

std::vector<Conversation> ConversationManager::conversations() const
{
    std::lock_guard lock(mutex_);
    return conversations_;
}

Conversation ConversationManager::conversation(const std::string& id) const
{
    std::lock_guard lock(mutex_);
    for (const auto& conv : conversations_)
    {
        if (conv.id == id)
        {
            return conv;
        }
    }
    return {};
}

std::string ConversationManager::currentConversationId() const
{
    std::lock_guard lock(mutex_);
    return currentConvId_;
}

void ConversationManager::switchToConversation(const std::string& id)
{
    std::lock_guard lock(mutex_);
    for (const auto& conv : conversations_)
    {
        if (conv.id == id)
        {
            currentConvId_ = id;
            return;
        }
    }
}

json ConversationManager::toJson(const Conversation& conv, bool includeMessages) const
{
    json obj;
    obj["id"] = conv.id;
    obj["title"] = conv.title;
    obj["createTime"] = conv.createTime;
    if (includeMessages)
    {
        obj["messages"] = conv.messages;
    }
    else
    {
        obj["messageCount"] = conv.messages.size();
    }
    return obj;
}

void ConversationManager::saveToFile()
{
    json arr = json::array();
    for (const auto& conv : conversations_)
    {
        json obj;
        obj["id"] = conv.id;
        obj["title"] = conv.title;
        obj["messages"] = conv.messages;
        obj["createTime"] = conv.createTime;
        arr.push_back(obj);
    }

    std::ofstream out(filePath_, std::ios::trunc);
    if (!out)
    {
        return;
    }
    out << arr.dump(2);
}

void ConversationManager::loadFromFile()
{
    std::ifstream in(filePath_);
    if (!in)
    {
        return;
    }

    json arr;
    try
    {
        in >> arr;
    }
    catch (...)
    {
        return;
    }

    if (!arr.is_array())
    {
        return;
    }

    for (const auto& val : arr)
    {
        if (!val.is_object())
        {
            continue;
        }
        Conversation conv;
        conv.id = val.value("id", "");
        conv.title = val.value("title", "新对话");
        conv.messages = val.contains("messages") && val["messages"].is_array()
            ? val["messages"]
            : json::array();
        conv.createTime = val.value("createTime", "");
        if (!conv.id.empty())
        {
            conversations_.push_back(conv);
        }
    }
}

std::string ConversationManager::generateId() const
{
    using namespace std::chrono;
    const auto now = system_clock::now();
    const auto ms = duration_cast<milliseconds>(now.time_since_epoch()).count();

    static thread_local std::mt19937 rng{std::random_device{}()};
    std::uniform_int_distribution<int> dist(0, 9999);

    std::ostringstream oss;
    oss << ms << dist(rng);
    return oss.str();
}
