#include "ImageRoutes.h"
#include "HttpRouter.h"
#include "ScopedUsageLog.h"
#include "TextRoutes.h"
#include "Config.h"
#include "GameMosaicPatch.h"
#include "GameTextProject.h"
#include "JsonEmbedding.h"
#include "LlmClient.h"
#include "RequestCancellation.h"
#include "RpgImageProject.h"
#include "UsageStore.h"
#include "Utf8Path.h"

#include <algorithm>
#include <exception>
#include <filesystem>
#include <stdexcept>
#include <string>

namespace http_router
{
using json = nlohmann::json;
namespace fs = std::filesystem;

void registerGameModelRoute(httplib::Server& svr, const ConfigStore& config_, UsageStore& usage_, request_cancel::Registry& translationTasks, GameModelCall callModel)
{
    svr.Post(R"(/api/(game-images|game-text)/model)", withCors([&config_, &usage_, &translationTasks, callModel](const httplib::Request& req, httplib::Response& res) {
        try {
            const bool textScreening = req.path == "/api/game-text/model";
            const auto body = json::parse(req.body);
            const bool textReview = textScreening && body.value("textSemanticReview", false);
            const auto id = body.at("taskId").get<std::string>();
            if (id.empty() || id.size() > 96) throw std::runtime_error("invalid taskId");
            LlmRequest request;
            request.apiUrl = body.at("apiUrl").get<std::string>(); request.apiKey = body.value("apiKey", "");
            request.model = body.at("model").get<std::string>(); request.requireComplete = true;
            request.nativeOllama = body.value("localModel", false) && body.value("ollamaNative", false);
            request.ollamaContextLength = body.value("ollamaContextLength", 0);
            const int maxOutputTokens = body.value("maxOutputTokens", 0);
            if (maxOutputTokens > 0 && maxOutputTokens <= 1048576) request.options["max_tokens"] = maxOutputTokens;
            const auto cfg = config_.snapshot();
            request.proxyMode = body.value("localModel", false) ? "direct" : cfg.proxyMode; request.httpProxy = cfg.httpProxy;
            const auto prompt = body.at("prompt").get<std::string>(), image = body.value("image", "");
            const bool imageClassification = !image.empty() && body.value("imageClassification", false);
            if (imageClassification) {
                request.options["max_tokens"] = maxOutputTokens > 0 ? std::min(maxOutputTokens, 256) : 256;
                request.options["temperature"] = 0;
                if (request.nativeOllama) {
                    request.options["reasoning_effort"] = "none";
                    request.options["keep_alive"] = "5m";
                    request.options["format"] = json::parse(R"schema({
                        "type":"object","required":["text_probability"],"additionalProperties":false,
                        "properties":{"text_probability":{"type":"number","minimum":0,"maximum":100}}
                    })schema");
                }
            }
            if (!image.empty() && body.value("mosaicReview", false)) {
                request.options["temperature"] = 0;
                if (request.nativeOllama) {
                    request.options["max_tokens"] = maxOutputTokens > 0 ? std::min(maxOutputTokens, 256) : 256;
                    request.options["reasoning_effort"] = "none";
                    request.options["keep_alive"] = "5m";
                    request.options["format"] = json::parse(R"schema({
                        "type":"object","required":["pixelation","boxes","confidence"],"additionalProperties":false,
                        "properties":{
                            "pixelation":{"type":"boolean"},
                            "confidence":{"type":"number","minimum":0,"maximum":1},
                            "boxes":{"type":"array","maxItems":3,"items":{
                                "type":"array","minItems":4,"maxItems":4,
                                "items":{"type":"number","minimum":0,"maximum":1000}
                            }}
                        }
                    })schema");
                }
            }
            if (request.nativeOllama && !imageClassification && !image.empty() && body.value("groupedImageOcr", false)) {
                request.options["temperature"] = 0;
                request.options["format"] = json::parse(R"schema({
                    "type":"object","required":["regions"],"additionalProperties":false,
                    "properties":{"regions":{"type":"array","maxItems":10,"items":{
                        "type":"object","required":["index","text","confidence"],"additionalProperties":false,
                        "properties":{"index":{"type":"integer","minimum":1,"maximum":10},
                            "text":{"type":"string","minLength":1},"confidence":{"type":"number","minimum":0,"maximum":100}}
                    }}}})schema");
            } else if (request.nativeOllama && !imageClassification && !image.empty() && body.value("imageOcr", false)) {
                request.options["format"] = json::parse(R"schema({
                    "type":"object","required":["regions"],"additionalProperties":false,
                    "properties":{"regions":{"type":"array","items":{
                        "type":"object","required":["text","confidence","x0","y0","x1","y1"],"additionalProperties":false,
                        "properties":{"text":{"type":"string","minLength":1},"confidence":{"type":"number","minimum":0,"maximum":100},
                        "x0":{"type":"number","minimum":0,"maximum":1000},"y0":{"type":"number","minimum":0,"maximum":1000},
                        "x1":{"type":"number","minimum":0,"maximum":1000},"y1":{"type":"number","minimum":0,"maximum":1000}}
                    }}}})schema");
            }
            if (request.nativeOllama && image.empty() && body.value("imageLayout", false)) {
                request.options["format"] = json::parse(R"schema({
                    "type":"object","required":["regions"],"additionalProperties":false,
                    "properties":{"regions":{"type":"array","items":{
                        "type":"object","required":["index","breakAfter"],"additionalProperties":false,
                        "properties":{"index":{"type":"integer","minimum":0},
                            "breakAfter":{"type":"array","items":{"type":"integer","minimum":1}}}
                    }}}})schema");
            }
            if (request.apiUrl.empty() || request.model.empty() || prompt.empty() || prompt.size() > 2000000) throw std::runtime_error("处理模型、接口或请求内容无效");
            json content = json::array({json{{"type","text"},{"text",prompt}}});
            if (!image.empty()) {
                if (image.rfind("data:image/png;base64,", 0) != 0 || image.size() > 20000000) throw std::runtime_error("图片输入须为不超过 20 MB 的 PNG 数据");
                content.push_back(json{{"type","image_url"},{"image_url",json{{"url",image}}}});
            }
            request.messages = json::array({json{{"role","user"},{"content",textScreening ? json(prompt) : content}}});
            const auto task = translationTasks.begin(id);
            if (!task) { res.status = 429; res.set_content(errorJson("在线任务较多，请稍后重试").dump(), "application/json"); return; }
            request_cancel::Scope cancellation(translationTasks, id, task);
            if (task->stopped()) { res.status = 499; res.set_content(errorJson("任务已取消").dump(), "application/json"); return; }
            auto event = UsageStore::makeEventSkeleton();
            event.feature = textReview ? "unity" : textScreening ? "game_text_screening" : "game_image_model";
            event.endpoint = textReview ? "game-text/review" : textScreening ? "game-text/model" : "game-images/model"; event.channel = "llm"; event.model = request.model;
            event.apiHost = UsageStore::hostFromApiUrl(request.apiUrl);
            event.vendor = UsageStore::vendorFromHostOrModel(event.apiHost, request.model, "");
            ScopedUsageLog usageLog(usage_, event);
            const auto response = callModel(request);
            auto& ev = usageLog.ev();
            const bool cancelled = task->cancelled.load();
            const bool timedOut = !cancelled && request_cancel::Clock::now() >= task->deadline;
            ev.ok = response.ok && !cancelled && !timedOut;
            ev.promptTokens = response.promptTokens; ev.completionTokens = response.completionTokens;
            ev.totalTokens = response.totalTokens; ev.cacheReadTokens = response.cacheReadTokens; ev.cacheWriteTokens = response.cacheWriteTokens;
            if (response.externalCall && response.totalTokens <= 0) {
                ev.promptTokens = ev.completionTokens = ev.totalTokens = kUsageTokensUnknown;
                ev.cacheReadTokens = ev.cacheWriteTokens = kUsageTokensUnknown;
            }
            ev.errorCode = ev.ok ? "" : cancelled ? "CANCELLED" : timedOut ? "TIMEOUT" : "ERROR";
            ev.errorMessage = ev.ok ? "" : cancelled ? "模型请求已取消" : timedOut ? "模型请求超时，未在时限内返回结果" : response.error;
            if (!ev.ok) {
                res.status = cancelled ? 499 : timedOut ? 504 : 502;
                res.set_content(json{{"error", ev.errorMessage}, {"code", cancelled || timedOut ? ev.errorCode : response.errorCode},
                    {"outputTokenLimit", request.options.value("max_tokens", 0)},
                    {"promptTokens", response.promptTokens}, {"completionTokens", response.completionTokens}}.dump(), "application/json");
                return;
            }
            json result = {{"ok", true}, {"content", response.content}, {"completionTokens", response.completionTokens},
                {"generationTokensPerSecond", response.generationTokensPerSecond}};
            appendServiceTiming(result, response.serviceTiming);
            res.set_content(result.dump(), "application/json");
        } catch (const std::exception& error) { res.status = 400; res.set_content(errorJson(error.what()).dump(), "application/json"); }
    }));
}

void registerGameTextProjectRoutes(httplib::Server& svr)
{
    for (const std::string operation : {"load", "save", "workflow", "checkpoint"}) svr.Post("/api/game-text/" + operation, withCors([operation](const httplib::Request& req, httplib::Response& res) {
        try { const auto body = json::parse(req.body); res.set_content((operation == "load" ? gametext::load(body) : operation == "workflow" ? gametext::workflow(body) : operation == "checkpoint" ? gametext::checkpoint(body) : gametext::save(body)).dump(), "application/json"); }
        catch (const std::exception& e) { res.status = 400; res.set_content(errorJson(e.what()).dump(), "application/json"); }
    }));
}

void registerGameImageProjectRoutes(httplib::Server& svr, RpgImageProject& gameImages)
{
    for(const std::string operation:{"info","load","scan","save","save-many","apply","uninstall","stop-read","current-sources","mosaic-status","mosaic-prepare","mosaic-apply","mosaic-uninstall"})svr.Post("/api/game-images/"+operation,withCors([&gameImages,operation](const httplib::Request& req,httplib::Response& res){try{const auto body=json::parse(req.body);const auto game=utf8path::pathFromUtf8(body.at("gamePath").get<std::string>());json value;if(operation=="info")value=gameImages.info(game);else if(operation=="current-sources")value=gameImages.currentSources(game,body.at("sources"));else if(operation=="stop-read")value=gameImages.stopReading(game);else if(operation=="load")value=gameImages.load(game);else if(operation=="scan")value=gameImages.scan(game);else if(operation=="save-many")value=gameImages.saveMany(game,body.at("images"));else if(operation=="save")value=gameImages.saveImage(game,body.at("image"));else if(operation=="uninstall")value=gameImages.uninstall(game);else if(operation=="mosaic-uninstall")value=gameImages.uninstall(game,true,body.at("imageIds"));else if(operation=="mosaic-status")value=gameImages.mosaicStatus(game);else if(operation=="mosaic-prepare")value=gameImages.prepareMosaic(game,body.at("imageIds"),body.at("patchId").get<std::string>());else value=gameImages.apply(game,body.value("backupMode","auto")!="manual",body.value("backupScopes",json::array({"images"})),body.value("imageIds",json(nullptr)),operation=="mosaic-apply",body.value("patchId",""));res.set_content(value.dump(),"application/json");}catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}}));
    svr.Post("/api/game-images/load-stream",withCors([&gameImages](const httplib::Request& req,httplib::Response& res){
        try{const auto game=utf8path::pathFromUtf8(json::parse(req.body).at("gamePath").get<std::string>());res.set_chunked_content_provider("application/x-ndjson",[&gameImages,game](size_t,httplib::DataSink& sink){auto send=[&](const json& event){const auto line=event.dump()+"\n";if(!sink.write(line.data(),line.size()))throw std::runtime_error("图片工程读取已取消");};try{send({{"type","progress"},{"completed",0},{"total",0},{"detail","正在读取已有图片工程"}});auto project=gameImages.load(game,[&](size_t completed,size_t total,const std::string& detail){send({{"type","progress"},{"completed",completed},{"total",total},{"detail",detail}});});send({{"type","result"},{"project",project}});}catch(const std::exception& e){const auto line=json({{"type","error"},{"error",e.what()}}).dump()+"\n";sink.write(line.data(),line.size());}sink.done();return true;});}catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}
    }));
    svr.Post("/api/game-images/scan-stream",withCors([&gameImages](const httplib::Request& req,httplib::Response& res){
        try{const auto game=utf8path::pathFromUtf8(json::parse(req.body).at("gamePath").get<std::string>());res.set_chunked_content_provider("application/x-ndjson",[&gameImages,game](size_t,httplib::DataSink& sink){auto send=[&](const json& event){auto line=event.dump()+"\n";if(!sink.write(line.data(),line.size()))throw std::runtime_error("图片扫描已取消");};try{send({{"type","progress"},{"completed",0},{"total",0},{"detail","正在准备图片扫描"}});auto project=gameImages.scan(game,[&](size_t completed,size_t total,const std::string& detail){send({{"type","progress"},{"completed",completed},{"total",total},{"detail",detail}});});send({{"type","result"},{"project",project}});}catch(const std::exception& e){auto line=json({{"type","error"},{"error",e.what()}}).dump()+"\n";sink.write(line.data(),line.size());}sink.done();return true;});}catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}
    }));
    svr.Get("/api/game-images/preview",withCors([&gameImages](const httplib::Request& req,httplib::Response& res){try{res.set_content(gameImages.preview(utf8path::pathFromUtf8(req.get_param_value("gamePath")),req.get_param_value("id"),req.get_param_value("translated")=="1"),"image/png");}catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}}));
    svr.Get("/api/game-images/mosaic",withCors([&gameImages](const httplib::Request& req,httplib::Response& res){
        try{res.set_content(gameImages.previewMosaic(utf8path::pathFromUtf8(req.get_param_value("gamePath")),req.get_param_value("id")),"image/png");}
        catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}
    }));
    svr.Post("/api/game-images/mosaic",withCors([&gameImages](const httplib::Request& req,httplib::Response& res){
        try{res.set_content(gameImages.saveMosaic(utf8path::pathFromUtf8(req.get_param_value("gamePath")),req.get_param_value("id"),req.get_param_value("sourceHash"),req.body).dump(),"application/json");}
        catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}
    }));
    svr.Post("/api/game-images/render",withCors([&gameImages](const httplib::Request& req,httplib::Response& res){try{res.set_content(gameImages.render(utf8path::pathFromUtf8(req.get_param_value("gamePath")),req.get_param_value("id"),req.body).dump(),"application/json");}catch(const std::exception& e){res.status=400;res.set_content(errorJson(e.what()).dump(),"application/json");}}));
}

void registerGameMosaicRoutes(httplib::Server& svr)
{
    for (const std::string operation : {"status","preview","install","rule","uninstall"}) {
        svr.Post("/api/game-mosaic/" + operation, withCors([operation](const httplib::Request& req, httplib::Response& res) {
            try {
                const auto body = json::parse(req.body);
                const auto game = fs::canonical(utf8path::pathFromUtf8(body.at("gamePath").get<std::string>()));
                const auto detected = JsonEmbedding::detect(game);
                if (detected.size() != 1 || !fs::equivalent(game,utf8path::pathFromUtf8(detected[0].at("path").get<std::string>())))
                    throw std::runtime_error("无法识别当前游戏目录");
                const auto engine = detected[0].at("engine").get<std::string>();
                const bool isUnreal = engine == unreal::engine;
                if (!isUnreal && engine != "Unity") throw std::runtime_error("请打开 UE 或 Unity 游戏工程");
                json result;
                if (operation == "status") result = mosaic::status(game,isUnreal);
                else if (operation == "uninstall") result = mosaic::uninstall(game,isUnreal);
                else if (operation == "rule") result = mosaic::installRule(game,isUnreal,body);
                else {
                    const auto source = utf8path::pathFromUtf8(body.at("source").get<std::string>());
                    const auto target = body.value("target","game");
                    if (operation == "preview") {
                        const auto bundle = mosaic::package(game,isUnreal,source,target);
                        result = {{"files",bundle.list},{"ignored",bundle.ignored}};
                    } else result = mosaic::install(game,isUnreal,source,target,body.at("files"));
                }
                res.set_content(result.dump(),"application/json");
            } catch (const std::exception& e) {
                res.status=400;
                res.set_content(errorJson(e.what()).dump(-1,' ',false,json::error_handler_t::replace),"application/json");
            }
        }));
    }
}

}
