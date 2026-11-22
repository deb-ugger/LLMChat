#include "OcrRoutes.h"
#include "HttpRouter.h"
#include "Config.h"
#include "OcrModelStore.h"

#include <exception>
#include <string>

namespace http_router
{
void registerOcrModelRoutes(httplib::Server& svr, OcrModelStore& ocrModels_, const ConfigStore& config_)
{
    svr.Get("/api/ocr/models", withCors([&ocrModels_](const httplib::Request&, httplib::Response& res) {
        res.set_content(ocrModels_.status().dump(), "application/json");
    }));

    svr.Post(R"(/api/ocr/models/(fast|precise|english|manga))", withCors([&ocrModels_, &config_](const httplib::Request& req, httplib::Response& res) {
        try
        {
            const std::string mode = req.matches[1].str();
            res.set_content(ocrModels_.ensureMode(mode, config_.snapshot()).dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 502;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));

    svr.Delete(R"(/api/ocr/models/(precise|english|manga))", withCors([&ocrModels_](const httplib::Request& req, httplib::Response& res) {
        try
        {
            res.set_content(ocrModels_.removeMode(req.matches[1].str()).dump(), "application/json");
        }
        catch (const std::exception& ex)
        {
            res.status = 409;
            res.set_content(errorJson(ex.what()).dump(), "application/json");
        }
    }));
}

void registerOcrModelFileRoute(httplib::Server& svr, OcrModelStore& ocrModels_)
{
    svr.Get(R"(/api/ocr/model-files/(.+))", withCors([&ocrModels_](const httplib::Request& req, httplib::Response& res) {
        const std::string fileName = req.matches[1].str();
        if (!ocrModels_.isAllowedModelFile(fileName))
        {
            res.status = 404;
            res.set_content(errorJson("OCR 模型文件尚未下载").dump(), "application/json");
            return;
        }
        res.set_header("Cache-Control", "private, max-age=31536000, immutable");
        const std::string contentType = fileName.ends_with(".onnx")
            ? "application/octet-stream"
            : fileName.ends_with(".json")
                ? "application/json; charset=utf-8"
                : fileName.ends_with(".txt")
                    ? "text/plain; charset=utf-8"
                    : "application/x-tar";
        res.set_file_content(ocrModels_.modelFile(fileName).string(), contentType);
    }));
}
}
