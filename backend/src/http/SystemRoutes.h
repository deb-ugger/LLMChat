#pragma once

#include <filesystem>

class ConfigStore;
class PricingStore;
class UsageStore;
namespace httplib { class Server; }
namespace request_cancel { class Registry; }

namespace http_router
{
std::filesystem::path dataDirectory(const ConfigStore& config);
void registerSystemRoutes(httplib::Server& svr, UsageStore& usage, PricingStore& pricing);
void registerSettingsRoutes(httplib::Server& svr, ConfigStore& config);
void registerOutputLogRoutes(httplib::Server& svr, const ConfigStore& config);
void registerSpeechRoutes(httplib::Server& svr, const ConfigStore& config, UsageStore& usage, request_cancel::Registry& translationTasks);
}
