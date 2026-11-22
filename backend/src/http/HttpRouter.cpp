#include "HttpRouter.h"

#include <set>

namespace http_router
{
using nlohmann::json;

bool isAllowedBrowserOrigin(const httplib::Request& req)
{
    const std::string origin = req.get_header_value("Origin");
    if (origin.empty())
    {
        const std::string fetchSite = req.get_header_value("Sec-Fetch-Site");
        return fetchSite.empty() || fetchSite == "same-origin" || fetchSite == "same-site";
    }
    static const std::set<std::string> allowed{
        "http://localhost:1420",
        "http://127.0.0.1:1420",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
    };
    return allowed.contains(origin);
}

void setCors(const httplib::Request& req, httplib::Response& res)
{
    const std::string origin = req.get_header_value("Origin");
    if (!origin.empty())
    {
        res.set_header("Access-Control-Allow-Origin", origin);
        res.set_header("Vary", "Origin");
    }
    res.set_header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.set_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
}

json errorJson(const std::string& message)
{
    return json{{"ok", false}, {"error", message}};
}

void corsPreflight(const httplib::Request& req, httplib::Response& res)
{
    if (!isAllowedBrowserOrigin(req))
    {
        res.status = 403;
        res.set_content(errorJson("不允许的请求来源").dump(), "application/json");
        return;
    }
    setCors(req, res);
    res.status = 204;
}
}
