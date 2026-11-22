#include "JsonEmbeddingRoutes.h"
#include "HttpRouter.h"
#include "JsonEmbedding.h"
#include "Utf8Path.h"

#include <cstdint>
#include <exception>
#include <filesystem>
#include <stdexcept>
#include <string>

#ifdef _WIN32
#include <shellapi.h>
#pragma comment(lib, "shell32.lib")
#endif

namespace http_router
{
using json = nlohmann::json;
namespace fs = std::filesystem;

void registerJsonEmbeddingStartRoute(httplib::Server& svr, JsonEmbedding& jsonEmbedding)
{
    svr.Post("/api/json-embedding/start", withCors([&jsonEmbedding](const httplib::Request& req, httplib::Response& res) {
        try { jsonEmbedding.start(json::parse(req.body)); res.set_content(jsonEmbedding.status().dump(), "application/json"); }
        catch (const std::exception& e) { res.status = 400; res.set_content(errorJson(e.what()).dump(), "application/json"); }
    }));
}

void registerJsonEmbeddingPatchDetectionRoute(httplib::Server& svr, JsonEmbedding& jsonEmbedding)
{
    svr.Post("/api/json-embedding/detect-patch", withCors([&jsonEmbedding](const httplib::Request& req, httplib::Response& res){try{res.set_content(jsonEmbedding.detectPatch(utf8path::pathFromUtf8(json::parse(req.body).at("gamePath").get<std::string>())).dump(),"application/json");}catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}}));
}

void registerJsonEmbeddingRoutes(httplib::Server& svr, JsonEmbedding& jsonEmbedding)
{
    svr.Post("/api/json-embedding/launch", withCors([](const httplib::Request& req, httplib::Response& res) {
        try {
            const auto game = utf8path::pathFromUtf8(json::parse(req.body).at("gamePath").get<std::string>());
            if (game.empty() || !fs::is_directory(game)) throw std::runtime_error("游戏目录不存在");
            const auto games = JsonEmbedding::detect(game);
            if (games.size() != 1 || !games[0].value("supported", false) ||
                !fs::equivalent(game, utf8path::pathFromUtf8(games[0].at("path").get<std::string>())))
                throw std::runtime_error("无法识别当前游戏目录");
            const auto root = fs::absolute(game);
            auto exe = games[0].at("engine").get<std::string>() == unreal::engine ? unreal::executable(root) : root / "Game.exe";
            if (!fs::is_regular_file(exe)) exe = root / (root.filename().wstring() + L".exe");
            if (!fs::is_regular_file(exe) || gamefiles::reparsePoint(exe)) throw std::runtime_error("未找到有效的游戏主程序");
#ifdef _WIN32
            const auto directory = exe.parent_path();
            const auto result = reinterpret_cast<intptr_t>(ShellExecuteW(nullptr, L"open", exe.c_str(), nullptr, directory.c_str(), SW_SHOWNORMAL));
            if (result <= 32) throw std::runtime_error("Windows 无法启动游戏（错误 " + std::to_string(result) + "）");
            res.set_content(json{{"ok", true}, {"gameExe", utf8path::pathUtf8(exe.filename())}}.dump(), "application/json");
#else
            throw std::runtime_error("当前平台不支持启动 Windows 游戏");
#endif
        } catch (const std::exception& e) { res.status = 400; res.set_content(errorJson(e.what()).dump(), "application/json"); }
    }));

    svr.Get("/api/json-embedding/patch", withCors([](const httplib::Request& req, httplib::Response& res) {
        try {res.set_content(JsonEmbedding::patchInfo(utf8path::pathFromUtf8(req.get_param_value("gamePath"))).dump(),"application/json");}
        catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}
    }));
    svr.Get("/api/json-embedding/status", withCors([&jsonEmbedding](const httplib::Request&, httplib::Response& res) { res.set_content(jsonEmbedding.status().dump(), "application/json"); }));
    svr.Post("/api/json-embedding/detect", withCors([](const httplib::Request& req, httplib::Response& res) {
        try { res.set_content(JsonEmbedding::detect(utf8path::pathFromUtf8(json::parse(req.body).at("path").get<std::string>())).dump(), "application/json"); }
        catch (const std::exception& e) { res.status = 400; res.set_content(errorJson(e.what()).dump(-1, ' ', false, json::error_handler_t::replace), "application/json"); }
    }));
    svr.Get("/api/json-embedding/backups", withCors([](const httplib::Request& req, httplib::Response& res) {
        try { res.set_content(JsonEmbedding::backups(utf8path::pathFromUtf8(req.get_param_value("gamePath"))).dump(), "application/json"); }
        catch (const std::exception& e) { res.status = 400; res.set_content(errorJson(e.what()).dump(-1, ' ', false, json::error_handler_t::replace), "application/json"); }
    }));
    svr.Post("/api/json-embedding/stop", withCors([&jsonEmbedding](const httplib::Request&, httplib::Response& res) { jsonEmbedding.cancel(); res.set_content(json{{"ok", true}}.dump(), "application/json"); }));
}

}
