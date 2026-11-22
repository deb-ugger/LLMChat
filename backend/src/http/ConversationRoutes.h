#pragma once

class ConversationManager;
namespace httplib { class Server; }

namespace http_router
{
void registerConversationRoutes(httplib::Server& svr, ConversationManager& conversations);
}
