#pragma once

#include <functional>
#include <string>

struct UnityDetectInfo;
namespace httplib { class Server; }

namespace http_router
{
struct UnityDetection
{
    UnityDetectInfo (*detect)(const std::string&, bool);
    void (*detectStream)(const std::string&, const std::function<void(const std::string&)>&,
        const std::function<bool()>&);
};

void registerUnityRoutes(httplib::Server& svr, UnityDetection detection);
}
