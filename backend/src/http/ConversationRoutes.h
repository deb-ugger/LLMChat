#pragma once

class ConfigStore;
class ConversationManager;
namespace httplib { class Server; }

namespace http_router
{
void registerConversationRoutes(httplib::Server& svr, ConversationManager& conversations, const ConfigStore& config);
}
