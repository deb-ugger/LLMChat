#pragma once

#include <filesystem>

namespace httplib { class Server; }

namespace http_router {
void registerSystemPerformanceRoutes(httplib::Server& svr, const std::filesystem::path& logs);
}
