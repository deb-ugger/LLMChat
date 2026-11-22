#include "ConversationRoutes.h"
#include "HttpRouter.h"
#include "ConversationManager.h"

namespace http_router
{
using json = nlohmann::json;

void registerConversationRoutes(httplib::Server& svr, ConversationManager& conversations_)
{
    svr.Get("/api/conversations", withCors([&conversations_](const httplib::Request&, httplib::Response& res) {
        json arr = conversations_.summaries();
        json body{
            {"items", arr},
            {"currentId", conversations_.currentConversationId()},
        };
        res.set_content(body.dump(), "application/json");
    }));

    svr.Post("/api/conversations", withCors([&conversations_](const httplib::Request&, httplib::Response& res) {
        const auto conv = conversations_.createConversation();
        res.set_content(conversations_.toJson(conv, true).dump(), "application/json");
    }));
}
}
