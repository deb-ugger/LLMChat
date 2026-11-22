#pragma once

#include <functional>

class ConfigStore;
class UsageStore;
struct UsageEvent;
namespace httplib { class Server; }
namespace request_cancel { class Registry; }

namespace http_router
{
using WithOllamaUsageLog = std::function<void(UsageEvent, const std::function<void(UsageEvent&)>&)>;

void registerLlmCatalogRoutes(httplib::Server& svr, const ConfigStore& config, UsageStore& usage);
void registerOllamaTestRoute(httplib::Server& svr, request_cancel::Registry& translationTasks, WithOllamaUsageLog withUsageLog);
}
