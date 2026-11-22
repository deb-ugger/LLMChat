#pragma once

#include <functional>
#include <nlohmann/json.hpp>

struct UsageEvent;
namespace httplib { class Server; }
namespace request_cancel { class Registry; }

namespace http_router
{
using ReadVendorModels = std::function<nlohmann::json()>;
using WithOllamaUsageLog = std::function<void(UsageEvent, const std::function<void(UsageEvent&)>&)>;

void registerLlmCatalogRoutes(httplib::Server& svr, ReadVendorModels loadVendorModelsFile);
void registerOllamaTestRoute(httplib::Server& svr, request_cancel::Registry& translationTasks, WithOllamaUsageLog withUsageLog);
}
