#include "HttpServer.h"
#include "LlmClient.h"

#include <httplib.h>
#include <iostream>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace {

void setCors(httplib::Response& res)
{
    res.set_header("Access-Control-Allow-Origin", "*");
    res.set_header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}

json errorJson(const std::string& message)
{
    return json{{"ok", false}, {"error", message}};
}

} // namespace

HttpServer::HttpServer(ConfigStore& config, ConversationManager& conversations)
    : config_(config)
    , conversations_(conversations)
{
}

int HttpServer::run()
{
    httplib::Server svr;

    svr.Options(R"(.*)", [](const httplib::Request&, httplib::Response& res) {
        setCors(res);
        res.status = 204;
    });

    auto withCors = [](auto handler) {
        return [handler](const httplib::Request& req, httplib::Response& res) {
            setCors(res);
            handler(req, res);
            if (!res.get_header_value("Content-Type").empty()
                && res.get_header_value("Content-Type").find("charset=") == std::string::npos
                && res.get_header_value("Content-Type").find("application/json") != std::string::npos)
            {
                res.set_header("Content-Type", "application/json; charset=utf-8");
            }
        };
    };

    svr.Get("/api/health", withCors([](const httplib::Request&, httplib::Response& res) {
        res.set_content(json{{"ok", true}, {"service", "llmchat-backend"}}.dump(), "application/json; charset=utf-8");
    }));

    svr.Get("/api/settings", withCors([this](const httplib::Request&, httplib::Response& res) {
        const auto& c = config_.get();
        json body{
            {"apiUrl", c.apiUrl},
            {"apiKey", c.apiKey},
            {"model", c.model},
            {"messagePageSize", c.messagePageSize},
            {"port", c.port},
        };
        res.set_content(body.dump(), "application/json");
    }));

    svr.Put("/api/settings", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body);
            auto& c = config_.get();
            if (body.contains("apiUrl"))
            {
                c.apiUrl = body["apiUrl"].get<std::string>();
            }
            if (body.contains("apiKey"))
            {
                c.apiKey = body["apiKey"].get<std::string>();
            }
            if (body.contains("model"))
            {
                c.model = body["model"].get<std::string>();
            }
            if (body.contains("messagePageSize"))
            {
                c.messagePageSize = body["messagePageSize"].get<int>();
            }
            config_.save();
            res.set_content(json{{"ok", true}}.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Get("/api/conversations", withCors([this](const httplib::Request&, httplib::Response& res) {
        json arr = json::array();
        for (const auto& conv : conversations_.conversations())
        {
            if (conv.messages.empty())
            {
                continue;
            }
            arr.push_back(conversations_.toJson(conv, false));
        }
        json body{
            {"items", arr},
            {"currentId", conversations_.currentConversationId()},
        };
        res.set_content(body.dump(), "application/json");
    }));

    svr.Post("/api/conversations", withCors([this](const httplib::Request&, httplib::Response& res) {
        const auto conv = conversations_.createConversation();
        res.set_content(conversations_.toJson(conv, true).dump(), "application/json");
    }));

    svr.Get(R"(/api/conversations/([^/]+))", withCors([this](const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.matches[1];
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

    svr.Delete(R"(/api/conversations/([^/]+))", withCors([this](const httplib::Request& req, httplib::Response& res) {
        const std::string id = req.matches[1];
        if (!conversations_.deleteConversation(id))
        {
            res.status = 400;
            res.set_content(errorJson("Cannot delete conversation").dump(), "application/json");
            return;
        }
        const auto current = conversations_.conversation(conversations_.currentConversationId());
        res.set_content(json{
            {"ok", true},
            {"current", conversations_.toJson(current, true)},
        }.dump(), "application/json");
    }));

    svr.Post(R"(/api/conversations/([^/]+)/messages)", withCors([this](const httplib::Request& req, httplib::Response& res) {
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

    svr.Post("/api/chat", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body);
            const std::string conversationId = body.value("conversationId", "");
            const std::string content = body.value("content", "");
            if (conversationId.empty() || content.empty())
            {
                res.status = 400;
                res.set_content(errorJson("conversationId and content required").dump(), "application/json");
                return;
            }

            if (!conversations_.addMessage(conversationId, "user", content))
            {
                res.status = 404;
                res.set_content(errorJson("Conversation not found").dump(), "application/json");
                return;
            }

            auto conv = conversations_.conversation(conversationId);
            const auto& cfg = config_.get();

            LlmRequest llmReq;
            llmReq.apiUrl = cfg.apiUrl;
            llmReq.apiKey = cfg.apiKey;
            llmReq.model = cfg.model;
            llmReq.messages = conv.messages;

            const LlmResponse llmRes = LlmClient::chat(llmReq);
            if (!llmRes.ok)
            {
                res.status = 502;
                res.set_content(errorJson(llmRes.error).dump(), "application/json");
                return;
            }

            conversations_.addMessage(conversationId, "assistant", llmRes.content);
            conv = conversations_.conversation(conversationId);

            res.set_content(json{
                {"ok", true},
                {"reply", llmRes.content},
                {"conversation", conversations_.toJson(conv, true)},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    const int port = config_.get().port;
    std::cout << "LLMChat backend listening on http://127.0.0.1:" << port << std::endl;
    if (!svr.listen("127.0.0.1", port))
    {
        std::cerr << "Failed to bind 127.0.0.1:" << port << std::endl;
        return 1;
    }
    return 0;
}
