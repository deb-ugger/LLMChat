#pragma once

namespace httplib { class Server; }

namespace http_router
{
void registerRuntimeAssetRoute(httplib::Server& svr);
void registerFileOpenRoutes(httplib::Server& svr);
void registerExportFileRoute(httplib::Server& svr);
}
