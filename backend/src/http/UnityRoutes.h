#pragma once

#include <functional>
#include <string>

class ConfigStore;
class RuntimeLlmBatcher;
class UnityInstallJobs;
class UsageStore;
struct UnityDetectInfo;
struct UnityInstallControl;
struct UnityInstallRequest;
struct UnityInstallResult;
struct UnityLoaderRequest;
namespace httplib { class Server; }

namespace http_router
{
struct UnityDetection
{
    UnityDetectInfo (*detect)(const std::string&, bool);
    void (*detectStream)(const std::string&, const std::function<void(const std::string&)>&,
        const std::function<bool()>&);
};

void registerUnityRuntimeRoutes(httplib::Server& svr, const ConfigStore& config, UsageStore& usage, RuntimeLlmBatcher& runtimeLlm);
void registerUnityConfigRoutes(httplib::Server& svr, UnityInstallJobs& unityInstalls);
void registerUnityRoutes(httplib::Server& svr, UnityDetection detection);

struct UnityInstallOperations
{
    UnityInstallResult (*install)(const UnityInstallRequest&, const UnityInstallControl&);
    UnityInstallResult (*installLoader)(const UnityLoaderRequest&, const UnityInstallControl&);
};

void registerUnityInstallRoutes(httplib::Server& svr, UnityInstallJobs& unityInstalls, UnityInstallOperations operations);
}
