#pragma once

class RpgImageProject;
namespace httplib { class Server; }

namespace http_router {
void registerExportRoutes(httplib::Server& svr, RpgImageProject& gameImages);
}
