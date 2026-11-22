#pragma once

#include <httplib.h>
#include <nlohmann/json.hpp>
#include <string>

namespace http_router
{
bool isAllowedBrowserOrigin(const httplib::Request& req);
void setCors(const httplib::Request& req, httplib::Response& res);
nlohmann::json errorJson(const std::string& message);
void corsPreflight(const httplib::Request& req, httplib::Response& res);

template <typename Handler>
auto withCors(Handler handler)
{
    return [handler](const httplib::Request& req, httplib::Response& res) {
        if (!isAllowedBrowserOrigin(req))
        {
            res.status = 403;
            res.set_content(errorJson("不允许的请求来源").dump(), "application/json");
            return;
        }
        setCors(req, res);
        handler(req, res);
        if (!res.get_header_value("Content-Type").empty()
            && res.get_header_value("Content-Type").find("charset=") == std::string::npos
            && res.get_header_value("Content-Type").find("application/json") != std::string::npos)
        {
            res.set_header("Content-Type", "application/json; charset=utf-8");
        }
    };
}
}
