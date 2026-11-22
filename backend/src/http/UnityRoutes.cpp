#include "UnityRoutes.h"
#include "HttpRouter.h"
#include "UnityAutoTranslator.h"

#include <exception>

namespace http_router
{
using json = nlohmann::json;

void registerUnityRoutes(httplib::Server& svr, UnityDetection detection)
{
    svr.Post("/api/unity/detect", withCors([detect = detection.detect](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            const std::string path = body.value("path", "");
            const auto info = detect(path, !body.value("directOnly", false));
            json games = json::array();
            for (const auto& g : info.games)
            {
                games.push_back({
                    {"isUnity", g.isUnity},
                    {"isIl2Cpp", g.isIl2Cpp},
                    {"hasAutoTranslator", g.hasAutoTranslator},
                    {"hasBepInEx", g.hasBepInEx},
                    {"gameDir", g.gameDir},
                    {"gameExe", g.gameExe},
                    {"runtime", g.runtime},
                    {"installMethod", g.installMethod},
                    {"arch", g.arch},
                    {"plugins", g.plugins},
                    {"autoTranslatorVersion", g.autoTranslatorVersion},
                    {"loaderName", g.loaderName},
                    {"loaderVersion", g.loaderVersion},
                });
            }
            res.set_content(json{
                {"ok", info.ok},
                {"error", info.error},
                {"isUnity", info.isUnity},
                {"isIl2Cpp", info.isIl2Cpp},
                {"hasAutoTranslator", info.hasAutoTranslator},
                {"hasBepInEx", info.hasBepInEx},
                {"gameDir", info.gameDir},
                {"gameExe", info.gameExe},
                {"runtime", info.runtime},
                {"installMethod", info.installMethod},
                {"scanRoot", info.scanRoot},
                {"count", info.count},
                {"games", games},
            }.dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Post("/api/unity/detect-stream", withCors([detectStream = detection.detectStream](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const json body = json::parse(req.body.empty() ? "{}" : req.body);
            const std::string path = body.value("path", "");
            res.set_chunked_content_provider(
                "application/x-ndjson",
                [path, detectStream](size_t offset, httplib::DataSink& sink) {
                    if (offset > 0)
                    {
                        sink.done();
                        return true;
                    }
                    bool connected = true;
                    detectStream(path, [&](const std::string& line) {
                        connected = sink.write(line.data(), line.size());
                    }, [&] { return !connected || !sink.is_writable(); });
                    if (!connected || !sink.is_writable()) return false;
                    sink.done();
                    return true;
                });
        }
        catch (const std::exception& ex)
        {
            res.status = 400;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));
}
}
