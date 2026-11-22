#pragma once

class ConfigStore;
class OcrModelStore;
namespace httplib { class Server; }

namespace http_router
{
void registerOcrModelRoutes(httplib::Server& svr, OcrModelStore& ocrModels, const ConfigStore& config);
void registerOcrModelFileRoute(httplib::Server& svr, OcrModelStore& ocrModels);
}
