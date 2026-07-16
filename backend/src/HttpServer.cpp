#include "HttpServer.h"
#include "LlmClient.h"
#include "TranslateClient.h"

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
            {"proxyMode", c.proxyMode},
            {"httpProxy", c.httpProxy},
            {"translateProvider", c.translateProvider},
            {"translateSource", c.translateSource},
            {"translateTarget", c.translateTarget},
            {"translateMaxLength", c.translateMaxLength},
            {"translateAutoChunk", c.translateAutoChunk},
            {"ocrLang", c.ocrLang},
            {"ocrAutoTranslate", c.ocrAutoTranslate},
            {"ocrTranslateProvider", c.ocrTranslateProvider},
            {"ocrTranslateSource", c.ocrTranslateSource},
            {"ocrTranslateTarget", c.ocrTranslateTarget},
            {"ocrTranslateMaxLength", c.ocrTranslateMaxLength},
            {"ocrTranslateAutoChunk", c.ocrTranslateAutoChunk},
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
            if (body.contains("proxyMode"))
            {
                c.proxyMode = body["proxyMode"].get<std::string>();
            }
            if (body.contains("httpProxy"))
            {
                c.httpProxy = body["httpProxy"].get<std::string>();
            }
            if (body.contains("translateProvider"))
            {
                c.translateProvider = body["translateProvider"].get<std::string>();
            }
            if (body.contains("translateSource"))
            {
                c.translateSource = body["translateSource"].get<std::string>();
            }
            if (body.contains("translateTarget"))
            {
                c.translateTarget = body["translateTarget"].get<std::string>();
            }
            if (body.contains("translateMaxLength"))
            {
                c.translateMaxLength = body["translateMaxLength"].get<int>();
            }
            if (body.contains("translateAutoChunk"))
            {
                c.translateAutoChunk = body["translateAutoChunk"].get<bool>();
            }
            if (body.contains("ocrLang"))
            {
                c.ocrLang = body["ocrLang"].get<std::string>();
            }
            if (body.contains("ocrAutoTranslate"))
            {
                c.ocrAutoTranslate = body["ocrAutoTranslate"].get<bool>();
            }
            if (body.contains("ocrTranslateProvider"))
            {
                c.ocrTranslateProvider = body["ocrTranslateProvider"].get<std::string>();
            }
            if (body.contains("ocrTranslateSource"))
            {
                c.ocrTranslateSource = body["ocrTranslateSource"].get<std::string>();
            }
            if (body.contains("ocrTranslateTarget"))
            {
                c.ocrTranslateTarget = body["ocrTranslateTarget"].get<std::string>();
            }
            if (body.contains("ocrTranslateMaxLength"))
            {
                c.ocrTranslateMaxLength = body["ocrTranslateMaxLength"].get<int>();
            }
            if (body.contains("ocrTranslateAutoChunk"))
            {
                c.ocrTranslateAutoChunk = body["ocrTranslateAutoChunk"].get<bool>();
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

    svr.Put(R"(/api/conversations/([^/]+))", withCors([this](const httplib::Request& req, httplib::Response& res) {
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
            const auto conv = conversations_.conversation(id);
            res.set_content(conversations_.toJson(conv, true).dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
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

    svr.Post("/api/translate", withCors([this](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body);
            const std::string text = body.value("text", "");
            if (text.empty())
            {
                res.status = 400;
                res.set_content(errorJson("text required").dump(), "application/json");
                return;
            }

            const auto& cfg = config_.get();
            const std::string source = body.value("source", cfg.translateSource);
            const std::string target = body.value("target", cfg.translateTarget);
            const std::string provider = body.value("provider", cfg.translateProvider);
            const int maxLength = body.value("maxLength", cfg.translateMaxLength);
            const bool autoChunk = body.value("autoChunk", cfg.translateAutoChunk);

            TranslateResult tr;
            if (provider == "llm")
            {
                const std::string apiUrl = body.value("apiUrl", cfg.apiUrl);
                const std::string apiKey = body.value("apiKey", cfg.apiKey);
                const std::string model = body.value("model", cfg.model);
                tr = TranslateClient::translateWithLlm(
                    text, apiUrl, apiKey, model, source, target,
                    cfg.proxyMode, cfg.httpProxy);
            }
            else
            {
                tr = TranslateClient::translateFree(
                    text, source, target, provider, maxLength, autoChunk,
                    cfg.proxyMode, cfg.httpProxy);
            }

            if (!tr.ok)
            {
                res.status = tr.code == "LENGTH_LIMIT" ? 400 : 502;
                res.set_content(json{
                    {"ok", false},
                    {"error", tr.error},
                    {"code", tr.code.empty() ? "ERROR" : tr.code},
                    {"provider", tr.provider},
                }.dump(), "application/json");
                return;
            }

            res.set_content(json{
                {"ok", true},
                {"source", text},
                {"translation", tr.translation},
                {"provider", tr.provider},
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
