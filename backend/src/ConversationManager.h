#pragma once

#include <nlohmann/json.hpp>
#include <memory>
#include <mutex>
#include <string>

struct Conversation {
    std::string id;
    std::string title;
    nlohmann::json messages = nlohmann::json::array();
    std::string createTime;
};

class ConversationManager {
public:
    explicit ConversationManager(std::string filePath);
    ~ConversationManager();

    Conversation createConversation();
    bool deleteConversation(const std::string& id);
    bool addMessage(const std::string& convId, const std::string& role, const std::string& content);
    bool setTitle(const std::string& convId, const std::string& title);

    /** Only id/title/createTime/messageCount; never loads message bodies. */
    nlohmann::json summaries() const;
    Conversation conversation(const std::string& id) const;
    std::string currentConversationId() const;
    void switchToConversation(const std::string& id);

    nlohmann::json toJson(const Conversation& conv, bool includeMessages) const;

private:
    std::string generateId() const;
    struct Impl;
    std::unique_ptr<Impl> impl_;
    mutable std::mutex mutex_;
    std::string currentConvId_;
};
