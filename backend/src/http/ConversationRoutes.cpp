#include "ConversationRoutes.h"
#include "HttpRouter.h"
#include "Config.h"
#include "ConversationManager.h"

namespace http_router
{
using json = nlohmann::json;

void registerConversationRoutes(httplib::Server& svr, ConversationManager& conversations_, const ConfigStore& config_)
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

    svr.Get(R"(/api/conversations/([^/]+))", withCors([&conversations_](const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.matches[1];
        if (req.has_param("limit")) {
            try {
                auto page = conversations_.page(id, std::stoi(req.get_param_value("limit")), req.has_param("before") ? std::stoi(req.get_param_value("before")) : -1);
                if (page.is_null()) { res.status = 404; res.set_content(errorJson("Conversation not found").dump(), "application/json"); return; }
                if (!req.has_param("before")) conversations_.switchToConversation(id);
                res.set_content(page.dump(), "application/json");
            } catch (const std::exception& ex) { res.status = 400; res.set_content(errorJson(ex.what()).dump(), "application/json"); }
            return;
        }
        const auto conv = conversations_.conversation(id);
        if (conv.id.empty())
        {
            res.status = 404;
            res.set_content(errorJson("Conversation not found").dump(), "application/json");
            return;
        }
        conversations_.switchToConversation(id);
        res.set_content(conversations_.toJson(conv, true).dump(), "application/json");
    }));

    svr.Delete(R"(/api/conversations/([^/]+))", withCors([&conversations_, &config_](const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.matches[1];
        if (!conversations_.deleteConversation(id))
        {
            res.status = 400;
            res.set_content(errorJson("Cannot delete conversation").dump(), "application/json");
            return;
        }
        const auto current = conversations_.page(conversations_.currentConversationId(), config_.snapshot().messagePageSize);
        res.set_content(json{
            {"ok", true},
            {"current", current},
        }.dump(), "application/json");
    }));

    svr.Put(R"(/api/conversations/([^/]+))", withCors([&conversations_, &config_](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const std::string id = req.matches[1];
            const json body = json::parse(req.body);
            const std::string title = body.value("title", "");
            if (title.empty())
            {
                res.status = 400;
                res.set_content(errorJson("title required").dump(), "application/json");
                return;
            }
            if (!conversations_.setTitle(id, title))
            {
                res.status = 404;
                res.set_content(errorJson("Conversation not found").dump(), "application/json");
                return;
            }
            res.set_content(conversations_.page(id, config_.snapshot().messagePageSize).dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post(R"(/api/conversations/([^/]+)/messages)", withCors([&conversations_](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const std::string id = req.matches[1];
            const json body = json::parse(req.body);
            const std::string role = body.value("role", "user");
            const std::string content = body.value("content", "");
            if (content.empty())
            {
                res.status = 400;
                res.set_content(errorJson("content required").dump(), "application/json");
                return;
            }
            if (!conversations_.addMessage(id, role, content))
            {
                res.status = 404;
                res.set_content(errorJson("Conversation not found").dump(), "application/json");
                return;
            }
            const auto conv = conversations_.conversation(id);
            res.set_content(conversations_.toJson(conv, true).dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));
}
}
