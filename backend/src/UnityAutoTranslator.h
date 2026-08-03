#pragma once

#include <functional>
#include <string>
#include <vector>

struct UnityGameItem
{
    bool isUnity = false;
    bool isIl2Cpp = false;
    bool hasAutoTranslator = false;
    bool hasBepInEx = false;
    std::string gameDir;
    std::string gameExe;
    std::string runtime;       // mono | il2cpp | unknown
    std::string installMethod; // ReiPatcher | BepInEx | BepInEx-IL2CPP | none
    std::string arch;          // x64 | x86 | arm64 | unknown
    std::vector<std::string> plugins;
    /** Detected XUnity.AutoTranslator file version, or Config.ini Migrations Tag. */
    std::string autoTranslatorVersion;
    /** BepInEx | ReiPatcher | empty */
    std::string loaderName;
    std::string loaderVersion;
};

struct UnityIniKey
{
    std::string key;
    std::string value;
    std::string comment;
};

struct UnityIniSection
{
    std::string name;
    std::vector<UnityIniKey> keys;
};

struct UnityConfigResult
{
    bool ok = false;
    std::string error;
    bool exists = false;
    std::string path;
    std::string installMethod;
    std::vector<UnityIniSection> sections;
};

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
    std::string runtime;
    std::string installMethod;
    std::string scanRoot;
    int count = 0;
    std::vector<UnityGameItem> games;
};

struct UnityInstallRequest
{
    std::string gamePath;
    std::string language = "zh-CN";
    std::string fromLanguage = "ja";
    std::string endpoint = "GoogleTranslate";
    std::string fallbackEndpoint;
    bool runSetup = true;
    /** If non-empty, written as Config.ini instead of the short built-in template. */
    std::string configIni;
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

struct UnityUninstallRequest
{
    std::string gamePath;
};

struct UnityUninstallResult
{
    bool ok = false;
    std::string error;
    std::string gameDir;
    std::string installMethod;
    std::vector<std::string> steps;
    std::vector<std::string> removed;
};

struct UnityLoaderRequest
{
    std::string gamePath;
};

struct UnityLaunchResult
{
    bool ok = false;
    std::string error;
    std::string gameDir;
    std::string gameExe;
};

struct UnitySelfCheckItem
{
    std::string id;
    std::string level; // ok | warn | error
    std::string title;
    std::string detail;
};

struct UnitySelfCheckResult
{
    bool ok = false;
    std::string error;
    std::string gameDir;
    /** ok | arch_mismatch | log_suggests_outdated | missing_loader | path_has_chinese | not_unity */
    std::string verdict;
    std::string verdictLabel;
    std::string summary;
    std::string gameArch;
    std::string loaderArch;
    std::string runtime;
    std::vector<UnitySelfCheckItem> checks;
    std::vector<std::string> suggestions;
    bool hasLog = false;
    std::string logPath;
    std::string logSnippet;
};

struct UnityEndpointInfo
{
    std::string id;
    std::string label;
    bool needsKey = false;
};

struct UnityFixFontRequest
{
    std::string gamePath;
    std::string language = "zh-CN";
};

class UnityAutoTranslator
{
public:
    static UnityDetectInfo detect(const std::string& gamePath);
    /** Emit NDJSON lines: start / game / done (one line each). */
    static void detectStream(const std::string& gamePath, const std::function<void(const std::string&)>& emitLine);
    static UnityLaunchResult launch(const std::string& gamePath);
    /**
     * Launch via ReiPatcher "Patch and Run" shortcut (requires translator installed).
     * Finds "{Game} (Patch and Run).lnk", or falls back to ReiPatcher.exe + game .ini.
     */
    static UnityLaunchResult launchPatchAndRun(const std::string& gamePath);
    static UnitySelfCheckResult selfCheck(const std::string& gamePath);
    static UnityInstallResult install(const UnityInstallRequest& req);
    /** Detect system CJK font or download Noto Sans SC; write OverrideFont into AutoTranslator config. */
    static UnityInstallResult fixFont(const UnityFixFontRequest& req);
    static UnityUninstallResult uninstall(const UnityUninstallRequest& req);
    static UnityInstallResult installLoader(const UnityLoaderRequest& req);
    static UnityUninstallResult uninstallLoader(const UnityLoaderRequest& req);
    static std::vector<UnityEndpointInfo> endpoints();
    static UnityConfigResult getConfig(const std::string& gamePath);
    static UnityConfigResult saveConfig(
        const std::string& gamePath,
        const std::vector<UnityIniSection>& sections);
    /**
     * Native picker that accepts a folder or a .exe (auto-detected later by detect()).
     * When defaultPath is set, the dialog opens in that folder (or its parent if a file).
     * Returns empty string if cancelled / unsupported.
     */
    static std::string pickPath(const std::string& defaultPath = {});
};
