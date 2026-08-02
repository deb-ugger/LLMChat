#pragma once

#include <string>
#include <vector>

struct UnityDetectInfo
{
    bool ok = false;
    std::string error;
    bool isUnity = false;
    bool isIl2Cpp = false;
    bool hasAutoTranslator = false;
    bool hasBepInEx = false;
    std::string gameDir;
    std::string gameExe;
    std::string runtime;   // mono | il2cpp | unknown
    std::string installMethod; // ReiPatcher | BepInEx | BepInEx-IL2CPP | none
};

struct UnityInstallRequest
{
    std::string gamePath;
    std::string language = "zh-CN";
    std::string fromLanguage = "ja";
    std::string endpoint = "GoogleTranslate";
    std::string fallbackEndpoint;
    bool runSetup = true;
};

struct UnityInstallResult
{
    bool ok = false;
    std::string error;
    std::string gameDir;
    std::string package;
    std::string version;
    std::string configPath;
    std::string installMethod;
    std::vector<std::string> steps;
};

struct UnityEndpointInfo
{
    std::string id;
    std::string label;
    bool needsKey = false;
};

class UnityAutoTranslator
{
public:
    static UnityDetectInfo detect(const std::string& gamePath);
    static UnityInstallResult install(const UnityInstallRequest& req);
    static std::vector<UnityEndpointInfo> endpoints();
};
