#pragma once

#include "ExportRoutes.h"

class ConfigStore;
class RpgImageProject;
class UsageStore;
struct LlmRequest;
struct LlmResponse;
namespace httplib { class Server; }
namespace request_cancel { class Registry; }

namespace http_router
{
using GameModelCall = LlmResponse (*)(const LlmRequest&);

void registerGameModelRoute(httplib::Server& svr, const ConfigStore& config, UsageStore& usage,
    request_cancel::Registry& translationTasks, GameModelCall callModel);
void registerGameTextProjectRoutes(httplib::Server& svr);
void registerGameImageProjectRoutes(httplib::Server& svr, RpgImageProject& gameImages);
void registerGameMosaicRoutes(httplib::Server& svr);
}
