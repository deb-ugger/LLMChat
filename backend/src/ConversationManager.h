#pragma once

#include <nlohmann/json.hpp>
#include <mutex>
#include <string>
#include <vector>

struct Conversation {
    std::string id;
    std::string title;
    nlohmann::json messages = nlohmann::json::array();
    std::string createTime;
};

class ConversationManager {
public:
    explicit ConversationManager(std::string filePath);

    Conversation createConversation();
    bool deleteConversation(const std::string& id);
    bool addMessage(const std::string& convId, const std::string& role, const std::string& content);
    bool setTitle(const std::string& convId, const std::string& title);

    std::vector<Conversation> conversations() const;
    Conversation conversation(const std::string& id) const;
    std::string currentConversationId() const;
    void switchToConversation(const std::string& id);

    nlohmann::json toJson(const Conversation& conv, bool includeMessages) const;

private:
    void loadFromFile();
    void saveToFile();
    std::string generateId() const;

    mutable std::mutex mutex_;
    std::string filePath_;
    std::vector<Conversation> conversations_;
    std::string currentConvId_;
};
