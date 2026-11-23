#pragma once

#include <filesystem>

class UsageStore;
namespace httplib { class Server; }

namespace http_router {
void registerSystemPerformanceRoutes(httplib::Server& svr, const std::filesystem::path& logs, UsageStore& usage);
}
