#pragma once

#include "LlmClient.h"

#include <atomic>
#include <filesystem>
#include <functional>
#include <optional>
#include <string>

class ConfigStore;
class ConversationManager;
class TextRunStore;
class TextTaskQueue;
class UsageStore;
namespace httplib { class Server; struct Request; struct Response; }
namespace request_cancel { class Registry; }

namespace http_router
{
using DictionaryLookup = std::string (*)(const std::string&, const std::string&, const std::string&,
    const std::string&, const std::string&);
using TranslateHandler = std::function<void(const httplib::Request&, httplib::Response&)>;

std::string readFileUtf8(const std::filesystem::path& path);
void writeFileUtf8(const std::filesystem::path& path, const std::string& content);
void appendServiceTiming(nlohmann::json& result, const std::optional<LlmServiceTiming>& timing);

void registerTextProjectRoutes(httplib::Server& svr);
void registerTextProjectFileRoute(httplib::Server& svr);
void registerChatAndDictionaryRoutes(httplib::Server& svr, const ConfigStore& config, ConversationManager& conversations,
    UsageStore& usage, DictionaryLookup lookupDictionaryJson);
void registerTranslateCancelRoute(httplib::Server& svr, request_cancel::Registry& translationTasks);
TranslateHandler registerTranslationRoute(httplib::Server& svr, const ConfigStore& config, UsageStore& usage,
    request_cancel::Registry& translationTasks, std::atomic<unsigned long long>& nextTask);
void registerTextRequestRoutes(httplib::Server& svr, TextTaskQueue& textQueue, const TranslateHandler& translateHandler,
    request_cancel::Registry& translationTasks);
void registerTextRunRoutes(httplib::Server& svr, TextRunStore& textRuns);
}
