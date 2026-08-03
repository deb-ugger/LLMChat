#include "UnityAutoTranslator.h"
#include "Utf8Path.h"

#include <algorithm>
#include <cctype>
#include <deque>
#include <filesystem>
#include <fstream>
#include <functional>
#include <sstream>
#include <unordered_set>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <shellapi.h>
#include <windows.h>
#include <winhttp.h>
#pragma comment(lib, "winhttp.lib")
#endif

namespace fs = std::filesystem;

using utf8path::pathFromUtf8;
using utf8path::pathUtf8;
using utf8path::toWide;
using utf8path::toUtf8;

namespace
{

constexpr const char* kReleaseTag = "v5.6.1";
constexpr const char* kReleaseVersion = "5.6.1";
constexpr const char* kGithubReleaseBase =
    "https://github.com/bbepis/XUnity.AutoTranslator/releases/download/";

constexpr const char* kBepInExTag = "v6.0.0-pre.2";
constexpr const char* kBepInExVersion = "6.0.0-pre.2";
constexpr const char* kBepInExReleaseBase =
    "https://github.com/BepInEx/BepInEx/releases/download/";

std::string trimCopy(std::string s)
{
    while (!s.empty()
           && (s.back() == ' ' || s.back() == '\t' || s.back() == '\r' || s.back() == '\n'))
        s.pop_back();
    size_t i = 0;
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t'))
        ++i;
    return s.substr(i);
}

bool iequals(const std::string& a, const std::string& b)
{
    if (a.size() != b.size())
        return false;
    for (size_t i = 0; i < a.size(); ++i)
    {
        const char ca = static_cast<char>(tolower(static_cast<unsigned char>(a[i])));
        const char cb = static_cast<char>(tolower(static_cast<unsigned char>(b[i])));
        if (ca != cb)
            return false;
    }
    return true;
}

std::string jsonEscape(const std::string& s)
{
    std::string out;
    out.reserve(s.size() + 8);
    for (unsigned char c : s)
    {
        switch (c)
        {
        case '"':
            out += "\\\"";
            break;
        case '\\':
            out += "\\\\";
            break;
        case '\n':
            out += "\\n";
            break;
        case '\r':
            out += "\\r";
            break;
        case '\t':
            out += "\\t";
            break;
        default:
            if (c < 0x20)
                continue;
            out += static_cast<char>(c);
        }
    }
    return out;
}

bool looksLikeExe(const fs::path& p)
{
    return iequals(pathUtf8(p.extension()), ".exe");
}

fs::path resolveGameDir(const fs::path& input, std::string& gameExe)
{
    std::error_code ec;
    fs::path p = fs::absolute(input, ec);
    if (ec)
        p = input;

    if (fs::is_regular_file(p, ec) && looksLikeExe(p))
    {
        gameExe = pathUtf8(p.filename());
        return p.parent_path();
    }

    if (fs::is_directory(p, ec))
    {
        for (const auto& entry : fs::directory_iterator(p, ec))
        {
            if (ec)
                break;
            if (!entry.is_regular_file(ec))
                continue;
            const auto file = entry.path();
            if (!looksLikeExe(file))
                continue;
            const std::string stem = pathUtf8(file.stem());
            if (stem.empty())
                continue;
            if (fs::exists(p / (stem + "_Data"), ec))
            {
                gameExe = pathUtf8(file.filename());
                return p;
            }
        }
        for (const auto& entry : fs::directory_iterator(p, ec))
        {
            if (ec)
                break;
            if (!entry.is_regular_file(ec))
                continue;
            const auto file = entry.path();
            if (!looksLikeExe(file))
                continue;
            const std::string name = pathUtf8(file.filename());
            if (iequals(name, "UnityCrashHandler64.exe") || iequals(name, "UnityCrashHandler32.exe")
                || name.find("SetupReiPatcher") != std::string::npos)
            {
                continue;
            }
            gameExe = name;
            return p;
        }
        return p;
    }

    return {};
}

std::string readPeArch(const fs::path& exe)
{
    std::ifstream in(exe, std::ios::binary);
    if (!in)
        return "unknown";

    uint16_t dosMagic = 0;
    in.read(reinterpret_cast<char*>(&dosMagic), sizeof(dosMagic));
    if (!in || dosMagic != 0x5A4D)
        return "unknown";

    in.seekg(0x3C);
    uint32_t peOffset = 0;
    in.read(reinterpret_cast<char*>(&peOffset), sizeof(peOffset));
    if (!in)
        return "unknown";

    in.seekg(static_cast<std::streamoff>(peOffset));
    uint32_t peSig = 0;
    in.read(reinterpret_cast<char*>(&peSig), sizeof(peSig));
    if (!in || peSig != 0x00004550)
        return "unknown";

    uint16_t machine = 0;
    in.read(reinterpret_cast<char*>(&machine), sizeof(machine));
    if (!in)
        return "unknown";

    switch (machine)
    {
    case 0x014C:
        return "x86";
    case 0x8664:
        return "x64";
    case 0xAA64:
        return "arm64";
    default:
        return "unknown";
    }
}

bool detectUnity(const fs::path& gameDir, const std::string& gameExe)
{
    std::error_code ec;
    if (gameDir.empty())
        return false;
    if (fs::exists(gameDir / "UnityPlayer.dll", ec))
        return true;
    if (!gameExe.empty())
    {
        const std::string stem = pathUtf8(pathFromUtf8(gameExe).stem());
        if (fs::exists(gameDir / (stem + "_Data"), ec))
            return true;
    }
    for (const auto& entry : fs::directory_iterator(gameDir, ec))
    {
        if (ec || !entry.is_directory(ec))
            continue;
        const auto name = pathUtf8(entry.path().filename());
        if (name.size() > 5 && name.ends_with("_Data"))
            return true;
    }
    return false;
}

bool detectIl2Cpp(const fs::path& gameDir)
{
    std::error_code ec;
    if (fs::exists(gameDir / "GameAssembly.dll", ec))
        return true;
    if (fs::exists(gameDir / "il2cpp_data", ec))
        return true;
    for (const auto& entry : fs::directory_iterator(gameDir, ec))
    {
        if (ec || !entry.is_directory(ec))
            continue;
        const auto name = pathUtf8(entry.path().filename());
        if (name.size() > 5 && name.ends_with("_Data"))
        {
            if (fs::exists(entry.path() / "il2cpp_data", ec)
                || fs::exists(entry.path() / "Native", ec))
            {
                return true;
            }
            if (fs::exists(entry.path() / "Managed", ec))
                return false;
        }
    }
    return false;
}

bool nameLooksLikeXUnityConfig(const std::string& fileName)
{
    std::string lower;
    lower.reserve(fileName.size());
    for (unsigned char c : fileName)
        lower.push_back(static_cast<char>(tolower(c)));
    return lower.find("autotranslator") != std::string::npos
           || lower.find("xunity") != std::string::npos;
}

bool detectAutoTranslator(const fs::path& gameDir)
{
    std::error_code ec;
    if (fs::exists(gameDir / "AutoTranslator", ec))
        return true;
    if (fs::exists(gameDir / "SetupReiPatcherAndAutoTranslator.exe", ec))
        return true;
    if (fs::exists(gameDir / "Translation", ec))
        return true;
    if (fs::exists(gameDir / "BepInEx" / "plugins" / "XUnity.AutoTranslator", ec))
        return true;
    if (fs::exists(gameDir / "BepInEx" / "plugins" / "XUnity.ResourceRedirector", ec))
        return true;
    if (fs::exists(gameDir / "BepInEx" / "core" / "XUnity.Common.dll", ec))
        return true;
    if (fs::exists(gameDir / "BepInEx" / "Translation", ec))
        return true;
    if (fs::exists(gameDir / "BepInEx" / "config" / "Translation", ec))
        return true;
    if (fs::exists(gameDir / "BepInEx" / "config" / "AutoTranslatorConfig.ini", ec))
        return true;
    if (fs::exists(
            gameDir / "ReiPatcher" / "Patches" / "XUnity.AutoTranslator.Patcher.dll",
            ec))
        return true;

    const fs::path cfgDir = gameDir / "BepInEx" / "config";
    if (fs::exists(cfgDir, ec))
    {
        for (fs::directory_iterator it(cfgDir, ec), end; !ec && it != end; it.increment(ec))
        {
            if (ec || !it->is_regular_file(ec))
                continue;
            if (nameLooksLikeXUnityConfig(pathUtf8(it->path().filename())))
                return true;
        }
    }
    return false;
}

bool detectBepInEx(const fs::path& gameDir)
{
    std::error_code ec;
    return fs::exists(gameDir / "BepInEx" / "core", ec)
           || fs::exists(gameDir / "BepInEx" / "plugins", ec);
}

std::vector<std::string> listBepInExPlugins(const fs::path& gameDir)
{
    std::vector<std::string> plugins;
    std::error_code ec;
    const fs::path pluginsDir = gameDir / "BepInEx" / "plugins";
    if (!fs::exists(pluginsDir, ec))
        return plugins;

    for (fs::directory_iterator it(pluginsDir, ec), end; !ec && it != end; it.increment(ec))
    {
        if (ec)
            break;
        const fs::path entry = it->path();
        if (it->is_directory(ec))
        {
            plugins.push_back(pathUtf8(entry.filename()));
            continue;
        }
        if (it->is_regular_file(ec) && iequals(pathUtf8(entry.extension()), ".dll"))
            plugins.push_back(pathUtf8(entry.filename()));
    }
    std::sort(plugins.begin(), plugins.end());
    plugins.erase(std::unique(plugins.begin(), plugins.end()), plugins.end());
    return plugins;
}

std::string chooseMethod(bool isUnity, bool isIl2Cpp, bool hasBepInEx)
{
    if (!isUnity)
        return "none";
    if (hasBepInEx)
        return isIl2Cpp ? "BepInEx-IL2CPP" : "BepInEx";
    if (isIl2Cpp)
        return "BepInEx-IL2CPP";
    return "ReiPatcher";
}

std::string packageFileName(const std::string& method)
{
    if (method == "BepInEx-IL2CPP")
        return std::string("XUnity.AutoTranslator-BepInEx-IL2CPP-") + kReleaseVersion + ".zip";
    if (method == "BepInEx")
        return std::string("XUnity.AutoTranslator-BepInEx-") + kReleaseVersion + ".zip";
    return std::string("XUnity.AutoTranslator-ReiPatcher-") + kReleaseVersion + ".zip";
}

std::string bepinexIl2CppPackage(const std::string& arch)
{
    if (arch == "x86")
        return std::string("BepInEx-Unity.IL2CPP-win-x86-") + kBepInExVersion + ".zip";
    return std::string("BepInEx-Unity.IL2CPP-win-x64-") + kBepInExVersion + ".zip";
}

UnityGameItem inspectGameDir(const fs::path& input)
{
    UnityGameItem item;
    std::string gameExe;
    const fs::path gameDir = resolveGameDir(input, gameExe);
    std::error_code ec;
    if (gameDir.empty() || !fs::exists(gameDir, ec))
        return item;

    item.gameDir = pathUtf8(gameDir);
    item.gameExe = gameExe;
    item.isUnity = detectUnity(gameDir, gameExe);
    item.isIl2Cpp = item.isUnity && detectIl2Cpp(gameDir);
    item.hasBepInEx = detectBepInEx(gameDir);
    item.hasAutoTranslator = detectAutoTranslator(gameDir);
    item.runtime = !item.isUnity ? "unknown" : (item.isIl2Cpp ? "il2cpp" : "mono");
    item.installMethod = chooseMethod(item.isUnity, item.isIl2Cpp, item.hasBepInEx);

    if (!gameExe.empty())
        item.arch = readPeArch(gameDir / pathFromUtf8(gameExe));
    else
        item.arch = "unknown";

    item.plugins = listBepInExPlugins(gameDir);
    return item;
}

bool resolveGameTarget(
    const UnityDetectInfo& detected,
    std::string& targetDir,
    UnityGameItem& item,
    std::string& error)
{
    targetDir = detected.gameDir;
    if (!targetDir.empty())
    {
        for (const auto& g : detected.games)
        {
            if (iequals(g.gameDir, targetDir))
            {
                item = g;
                return true;
            }
        }
        item = inspectGameDir(pathFromUtf8(targetDir));
        return true;
    }
    if (detected.games.size() == 1)
    {
        item = detected.games.front();
        targetDir = item.gameDir;
        return true;
    }
    error = "请先在列表中选择一个具体游戏";
    return false;
}

/**
 * Uninstall targets = translation plugin this module installs
 * + files the plugin generates at runtime (caches / configs).
 * Does not remove BepInEx loader itself.
 */
std::vector<fs::path> listXUnityUninstallTargets(const fs::path& gameDir)
{
    std::vector<fs::path> out;
    auto add = [&](const fs::path& p) {
        std::error_code ec;
        if (fs::exists(p, ec))
            out.push_back(p);
    };

    add(gameDir / "AutoTranslator");
    add(gameDir / "SetupReiPatcherAndAutoTranslator.exe");
    add(gameDir / "ReiPatcher");
    add(gameDir / "BepInEx" / "plugins" / "XUnity.AutoTranslator");
    add(gameDir / "BepInEx" / "plugins" / "XUnity.ResourceRedirector");
    add(gameDir / "BepInEx" / "core" / "XUnity.Common.dll");

    add(gameDir / "Translation");
    add(gameDir / "BepInEx" / "Translation");
    add(gameDir / "BepInEx" / "config" / "Translation");
    add(gameDir / "BepInEx" / "config" / "AutoTranslatorConfig.ini");
    add(gameDir / "BepInEx" / "config" / "gravydevsupreme.xunity.autotranslator.ini");

    {
        std::error_code ec;
        const fs::path cfgDir = gameDir / "BepInEx" / "config";
        if (fs::exists(cfgDir, ec))
        {
            for (fs::directory_iterator it(cfgDir, ec), end; !ec && it != end;
                 it.increment(ec))
            {
                if (ec || !it->is_regular_file(ec))
                    continue;
                if (nameLooksLikeXUnityConfig(pathUtf8(it->path().filename())))
                    out.push_back(it->path());
            }
        }
    }

    std::vector<fs::path> unique;
    for (const auto& p : out)
    {
        bool seen = false;
        for (const auto& u : unique)
        {
            if (iequals(pathUtf8(u), pathUtf8(p)))
            {
                seen = true;
                break;
            }
        }
        if (!seen)
            unique.push_back(p);
    }
    return unique;
}

std::vector<fs::path> listBepInExLoaderTargets(const fs::path& gameDir)
{
    std::vector<fs::path> out;
    auto add = [&](const fs::path& p) {
        std::error_code ec;
        if (fs::exists(p, ec))
            out.push_back(p);
    };
    add(gameDir / "BepInEx");
    add(gameDir / "doorstop_config.ini");
    add(gameDir / ".doorstop_version");
    add(gameDir / "winhttp.dll");
    add(gameDir / "version.dll");
    add(gameDir / "winmm.dll");
    add(gameDir / "changelog.txt");
    return out;
}

#ifdef _WIN32
fs::path backendModuleDir()
{
    wchar_t buffer[MAX_PATH]{};
    GetModuleFileNameW(nullptr, buffer, MAX_PATH);
    return fs::path(buffer).parent_path();
}

/** Local cache dir next to backend: resources/bepinex/ */
fs::path bepinexCacheDir()
{
    return backendModuleDir() / "resources" / "bepinex";
}

/** Return cached package if previously downloaded to resources/bepinex/<pkg>.zip */
fs::path findCachedBepInExZip(const std::string& pkg)
{
    const fs::path p = bepinexCacheDir() / pathFromUtf8(pkg);
    std::error_code ec;
    if (fs::exists(p, ec) && fs::is_regular_file(p, ec))
    {
        const auto sz = fs::file_size(p, ec);
        if (!ec && sz > 1024 * 1024)
            return p;
    }
    return {};
}
#endif

bool shouldSkipScanDir(const std::string& name)
{
    return iequals(name, ".git") || iequals(name, "node_modules") || iequals(name, "Windows")
           || iequals(name, "$RECYCLE.BIN") || iequals(name, "System Volume Information");
}

void applyGameToDetectInfo(UnityDetectInfo& info, const UnityGameItem& g)
{
    info.isUnity = g.isUnity;
    info.isIl2Cpp = g.isIl2Cpp;
    info.hasAutoTranslator = g.hasAutoTranslator;
    info.hasBepInEx = g.hasBepInEx;
    info.gameDir = g.gameDir;
    info.gameExe = g.gameExe;
    info.runtime = g.runtime;
    info.installMethod = g.installMethod;
}

std::string gameItemToJson(const UnityGameItem& g)
{
    std::ostringstream oss;
    oss << "{"
        << "\"isUnity\":" << (g.isUnity ? "true" : "false") << ","
        << "\"isIl2Cpp\":" << (g.isIl2Cpp ? "true" : "false") << ","
        << "\"hasAutoTranslator\":" << (g.hasAutoTranslator ? "true" : "false") << ","
        << "\"hasBepInEx\":" << (g.hasBepInEx ? "true" : "false") << ","
        << "\"gameDir\":\"" << jsonEscape(g.gameDir) << "\","
        << "\"gameExe\":\"" << jsonEscape(g.gameExe) << "\","
        << "\"runtime\":\"" << jsonEscape(g.runtime) << "\","
        << "\"installMethod\":\"" << jsonEscape(g.installMethod) << "\","
        << "\"arch\":\"" << jsonEscape(g.arch) << "\","
        << "\"plugins\":[";
    for (size_t i = 0; i < g.plugins.size(); ++i)
    {
        if (i)
            oss << ',';
        oss << '"' << jsonEscape(g.plugins[i]) << '"';
    }
    oss << "]}";
    return oss.str();
}

void scanUnityGamesRecursive(
    const fs::path& dir,
    int depth,
    int maxDepth,
    std::unordered_set<std::string>& seen,
    std::vector<UnityGameItem>& games,
    const std::function<void(const UnityGameItem&)>& onGame)
{
    std::deque<std::pair<fs::path, int>> queue;
    queue.emplace_back(dir, depth);

    while (!queue.empty())
    {
        const auto [current, d] = queue.front();
        queue.pop_front();
        if (d > maxDepth)
            continue;

        std::error_code ec;
        if (!fs::is_directory(current, ec))
            continue;

        try
        {
            const UnityGameItem here = inspectGameDir(current);
            if (here.isUnity)
            {
                if (seen.insert(here.gameDir).second)
                {
                    games.push_back(here);
                    if (onGame)
                        onGame(here);
                }
                continue;
            }

            for (fs::directory_iterator it(current, ec), end; !ec && it != end; it.increment(ec))
            {
                if (ec || !it->is_directory(ec))
                    continue;
                const std::string name = pathUtf8(it->path().filename());
                if (shouldSkipScanDir(name))
                    continue;
                queue.emplace_back(it->path(), d + 1);
            }
        }
        catch (...)
        {
            continue;
        }
    }
}

#ifdef _WIN32
bool downloadFile(const std::string& url, const fs::path& dest, std::string& error)
{
    const std::wstring wurl = toWide(url);
    URL_COMPONENTS uc{};
    uc.dwStructSize = sizeof(uc);
    wchar_t host[256]{};
    wchar_t path[2048]{};
    uc.lpszHostName = host;
    uc.dwHostNameLength = 256;
    uc.lpszUrlPath = path;
    uc.dwUrlPathLength = 2048;
    if (!WinHttpCrackUrl(wurl.c_str(), 0, 0, &uc))
    {
        error = "无法解析下载地址";
        return false;
    }

    HINTERNET session = WinHttpOpen(
        L"LLMChat-UnityInstaller/1.0",
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
        WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS,
        0);
    if (!session)
    {
        error = "无法初始化下载组件";
        return false;
    }
    WinHttpSetTimeouts(session, 15000, 15000, 60000, 120000);

    HINTERNET connect = WinHttpConnect(session, host, uc.nPort, 0);
    if (!connect)
    {
        WinHttpCloseHandle(session);
        error = "无法连接下载服务器";
        return false;
    }

    const DWORD flags = (uc.nScheme == INTERNET_SCHEME_HTTPS) ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET request = WinHttpOpenRequest(
        connect,
        L"GET",
        path,
        nullptr,
        WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES,
        flags);
    if (!request)
    {
        WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
        error = "无法创建下载请求";
        return false;
    }

    DWORD redirect = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
    WinHttpSetOption(request, WINHTTP_OPTION_REDIRECT_POLICY, &redirect, sizeof(redirect));

    if (!WinHttpSendRequest(
            request,
            WINHTTP_NO_ADDITIONAL_HEADERS,
            0,
            WINHTTP_NO_REQUEST_DATA,
            0,
            0,
            0)
        || !WinHttpReceiveResponse(request, nullptr))
    {
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
        error = "下载请求失败";
        return false;
    }

    DWORD status = 0;
    DWORD statusSize = sizeof(status);
    WinHttpQueryHeaders(
        request,
        WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX,
        &status,
        &statusSize,
        WINHTTP_NO_HEADER_INDEX);
    if (status < 200 || status >= 300)
    {
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
        error = "下载失败，HTTP " + std::to_string(status);
        return false;
    }

    std::ofstream out(dest, std::ios::binary);
    if (!out)
    {
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
        error = "无法写入临时文件";
        return false;
    }

    for (;;)
    {
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(request, &available))
            break;
        if (available == 0)
            break;
        std::string buffer(available, '\0');
        DWORD read = 0;
        if (!WinHttpReadData(request, buffer.data(), available, &read) || read == 0)
            break;
        out.write(buffer.data(), static_cast<std::streamsize>(read));
    }

    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    out.close();

    std::error_code ec;
    return fs::exists(dest, ec) && fs::file_size(dest, ec) > 0;
}

bool extractZip(const fs::path& zipPath, const fs::path& destDir, std::string& error)
{
    fs::create_directories(destDir);
    const std::wstring cmd =
        L"tar -xf \"" + zipPath.wstring() + L"\" -C \"" + destDir.wstring() + L"\"";
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    std::wstring mutableCmd = cmd;
    if (!CreateProcessW(
            nullptr,
            mutableCmd.data(),
            nullptr,
            nullptr,
            FALSE,
            CREATE_NO_WINDOW,
            nullptr,
            nullptr,
            &si,
            &pi))
    {
        error = "无法解压安装包（需要系统 tar）";
        return false;
    }
    WaitForSingleObject(pi.hProcess, 120000);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    if (code != 0)
    {
        error = "解压安装包失败";
        return false;
    }
    return true;
}

bool runProcess(const fs::path& exe, const fs::path& workDir, std::string& error)
{
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    std::wstring cmd = L"\"" + exe.wstring() + L"\"";
    const std::wstring dir = workDir.wstring();
    if (!CreateProcessW(
            nullptr,
            cmd.data(),
            nullptr,
            nullptr,
            FALSE,
            0,
            nullptr,
            dir.c_str(),
            &si,
            &pi))
    {
        error = "无法运行安装程序: " + pathUtf8(exe.filename());
        return false;
    }
    WaitForSingleObject(pi.hProcess, 180000);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    if (code != 0)
    {
        error = "安装程序退出码 " + std::to_string(code);
        return false;
    }
    return true;
}
#endif

std::string buildConfigIni(const UnityInstallRequest& req)
{
    std::ostringstream oss;
    oss << "[Service]\n"
        << "Endpoint=" << req.endpoint << "\n"
        << "FallbackEndpoint=" << req.fallbackEndpoint << "\n"
        << "\n"
        << "[General]\n"
        << "Language=" << req.language << "\n"
        << "FromLanguage=" << req.fromLanguage << "\n"
        << "\n"
        << "[TextFrameworks]\n"
        << "EnableUGUI=True\n"
        << "EnableUIElements=True\n"
        << "EnableNGUI=True\n"
        << "EnableTextMeshPro=True\n"
        << "EnableTextMesh=False\n"
        << "EnableIMGUI=False\n"
        << "\n"
        << "[Behaviour]\n"
        << "MaxCharactersPerTranslation=200\n"
        << "EnableUIResizing=True\n"
        << "EnableBatching=True\n"
        << "ForceUIResizing=True\n"
        << "HandleRichText=True\n"
        << "EnableSilentMode=False\n";
    return oss.str();
}

fs::path writeConfig(
    const fs::path& gameDir,
    const std::string& method,
    const UnityInstallRequest& req)
{
    const std::string content = buildConfigIni(req);
    fs::path primary;
    if (method.rfind("BepInEx", 0) == 0)
    {
        primary = gameDir / "BepInEx" / "config" / "AutoTranslatorConfig.ini";
        fs::create_directories(primary.parent_path());
    }
    else
    {
        primary = gameDir / "AutoTranslator" / "Config.ini";
        fs::create_directories(primary.parent_path());
    }
    {
        std::ofstream out(primary, std::ios::binary);
        out << content;
    }
    if (method.rfind("BepInEx", 0) == 0)
    {
        const fs::path alt = gameDir / "AutoTranslator" / "Config.ini";
        fs::create_directories(alt.parent_path());
        std::ofstream out(alt, std::ios::binary);
        out << content;
    }
    return primary;
}

std::string findDoorstopDll(const fs::path& gameDir)
{
    static const char* kNames[] = {"winhttp.dll", "version.dll", "winmm.dll"};
    std::error_code ec;
    for (const char* name : kNames)
    {
        const fs::path p = gameDir / name;
        if (fs::exists(p, ec) && fs::is_regular_file(p, ec))
            return name;
    }
    return {};
}

#ifdef _WIN32
bool shellOpenPath(const fs::path& target, const fs::path& workDir, std::string& error)
{
    const HINSTANCE rc = ShellExecuteW(
        nullptr,
        L"open",
        target.wstring().c_str(),
        nullptr,
        workDir.empty() ? nullptr : workDir.wstring().c_str(),
        SW_SHOWNORMAL);
    if (reinterpret_cast<intptr_t>(rc) <= 32)
    {
        error = "ShellExecute 启动失败";
        return false;
    }
    return true;
}

bool shellOpenWithArgs(
    const fs::path& exe,
    const std::wstring& args,
    const fs::path& workDir,
    std::string& error)
{
    const HINSTANCE rc = ShellExecuteW(
        nullptr,
        L"open",
        exe.wstring().c_str(),
        args.empty() ? nullptr : args.c_str(),
        workDir.empty() ? nullptr : workDir.wstring().c_str(),
        SW_SHOWNORMAL);
    if (reinterpret_cast<intptr_t>(rc) <= 32)
    {
        error = "ShellExecute 启动失败";
        return false;
    }
    return true;
}

fs::path findPatchAndRunShortcut(const fs::path& gameDir, const std::string& gameExe)
{
    std::error_code ec;
    if (!gameExe.empty())
    {
        const std::string stem = pathUtf8(pathFromUtf8(gameExe).stem());
        const fs::path preferred = gameDir / pathFromUtf8(stem + " (Patch and Run).lnk");
        if (fs::is_regular_file(preferred, ec))
            return preferred;
    }

    for (fs::directory_iterator it(gameDir, ec), end; !ec && it != end; it.increment(ec))
    {
        if (ec || !it->is_regular_file(ec))
            continue;
        const std::string name = pathUtf8(it->path().filename());
        std::string lower = name;
        for (char& c : lower)
            c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
        if (lower.find("patch and run") != std::string::npos && lower.ends_with(".lnk"))
            return it->path();
    }
    return {};
}

fs::path findReiPatcherIni(const fs::path& gameDir, const std::string& gameExe)
{
    const fs::path rpDir = gameDir / "ReiPatcher";
    std::error_code ec;
    if (!fs::is_directory(rpDir, ec))
        return {};

    if (!gameExe.empty())
    {
        const std::string stem = pathUtf8(pathFromUtf8(gameExe).stem());
        const fs::path preferred = rpDir / pathFromUtf8(stem + ".ini");
        if (fs::is_regular_file(preferred, ec))
            return preferred;
    }

    for (fs::directory_iterator it(rpDir, ec), end; !ec && it != end; it.increment(ec))
    {
        if (ec || !it->is_regular_file(ec))
            continue;
        if (iequals(pathUtf8(it->path().extension()), ".ini"))
            return it->path();
    }
    return {};
}
#endif

} // namespace

UnityDetectInfo UnityAutoTranslator::detect(const std::string& gamePath)
{
    UnityDetectInfo info;
    const std::string path = trimCopy(gamePath);
    if (path.empty())
    {
        info.error = "请选择游戏目录或主程序";
        return info;
    }

    std::error_code ec;
    const fs::path root = pathFromUtf8(path);
    if (!fs::exists(root, ec))
    {
        info.error = "路径不存在";
        return info;
    }

    info.scanRoot = pathUtf8(fs::absolute(root, ec));

    const UnityGameItem direct = inspectGameDir(root);
    if (direct.isUnity)
    {
        info.games.push_back(direct);
        info.count = 1;
        info.ok = true;
        applyGameToDetectInfo(info, direct);
        return info;
    }

    std::unordered_set<std::string> seen;
    scanUnityGamesRecursive(root, 0, 16, seen, info.games, nullptr);
    info.count = static_cast<int>(info.games.size());

    if (info.games.empty())
    {
        info.error = "未找到 Unity 游戏";
        info.ok = false;
        return info;
    }

    info.ok = true;
    applyGameToDetectInfo(info, info.games.front());
    return info;
}

void UnityAutoTranslator::detectStream(
    const std::string& gamePath,
    const std::function<void(const std::string&)>& emitLine)
{
    const auto emit = [&](const std::string& line) {
        if (emitLine)
            emitLine(line);
    };

    const std::string path = trimCopy(gamePath);
    emit("{\"type\":\"start\",\"path\":\"" + jsonEscape(path) + "\"}\n");

    if (path.empty())
    {
        emit("{\"type\":\"done\",\"ok\":false,\"error\":\"请选择游戏目录或主程序\",\"scanRoot\":\"\","
             "\"count\":0}\n");
        return;
    }

    std::error_code ec;
    const fs::path root = pathFromUtf8(path);
    if (!fs::exists(root, ec))
    {
        emit("{\"type\":\"done\",\"ok\":false,\"error\":\"路径不存在\",\"scanRoot\":\"\",\"count\":0}\n");
        return;
    }

    const std::string scanRoot = pathUtf8(fs::absolute(root, ec));
    std::vector<UnityGameItem> games;
    std::unordered_set<std::string> seen;

    const auto onGame = [&](const UnityGameItem& g) {
        emit("{\"type\":\"game\",\"game\":" + gameItemToJson(g) + "}\n");
    };

    const UnityGameItem direct = inspectGameDir(root);
    if (direct.isUnity)
    {
        if (seen.insert(direct.gameDir).second)
        {
            games.push_back(direct);
            onGame(direct);
        }
    }
    else
    {
        scanUnityGamesRecursive(root, 0, 16, seen, games, onGame);
    }

    const int count = static_cast<int>(games.size());
    if (games.empty())
    {
        emit("{\"type\":\"done\",\"ok\":false,\"error\":\"未找到 Unity 游戏\",\"scanRoot\":\""
             + jsonEscape(scanRoot) + "\",\"count\":0}\n");
        return;
    }

    emit("{\"type\":\"done\",\"ok\":true,\"error\":\"\",\"scanRoot\":\"" + jsonEscape(scanRoot)
         + "\",\"count\":" + std::to_string(count) + "}\n");
}

UnityLaunchResult UnityAutoTranslator::launch(const std::string& gamePath)
{
    UnityLaunchResult result;
#ifndef _WIN32
    result.error = "仅支持 Windows";
    return result;
#else
    try
    {
        const auto detected = detect(gamePath);
        if (!detected.ok && detected.games.empty())
        {
            result.error = detected.error.empty() ? "检测失败" : detected.error;
            return result;
        }

        std::string targetDir;
        UnityGameItem item;
        std::string resolveErr;
        if (!resolveGameTarget(detected, targetDir, item, resolveErr))
        {
            result.error = resolveErr;
            return result;
        }

        if (!item.isUnity)
        {
            result.error = "不是有效的 Unity 游戏";
            return result;
        }
        if (item.gameExe.empty())
        {
            result.error = "未找到游戏主程序";
            return result;
        }

        const fs::path gameDir = pathFromUtf8(targetDir);
        const fs::path exePath = gameDir / pathFromUtf8(item.gameExe);
        std::error_code ec;
        if (!fs::exists(exePath, ec))
        {
            result.error = "游戏主程序不存在";
            return result;
        }

        const HINSTANCE rc = ShellExecuteW(
            nullptr,
            L"open",
            exePath.wstring().c_str(),
            nullptr,
            gameDir.wstring().c_str(),
            SW_SHOWNORMAL);
        if (reinterpret_cast<intptr_t>(rc) <= 32)
        {
            result.error = "ShellExecute 启动失败";
            return result;
        }

        result.ok = true;
        result.gameDir = targetDir;
        result.gameExe = item.gameExe;
        return result;
    }
    catch (const std::exception& ex)
    {
        result.error = std::string("启动异常: ") + ex.what();
        return result;
    }
    catch (...)
    {
        result.error = "启动异常：无法访问该目录";
        return result;
    }
#endif
}

UnityLaunchResult UnityAutoTranslator::launchPatchAndRun(const std::string& gamePath)
{
    UnityLaunchResult result;
#ifndef _WIN32
    result.error = "仅支持 Windows";
    return result;
#else
    try
    {
        const auto detected = detect(gamePath);
        if (!detected.ok && detected.games.empty())
        {
            result.error = detected.error.empty() ? "检测失败" : detected.error;
            return result;
        }

        std::string targetDir;
        UnityGameItem item;
        std::string resolveErr;
        if (!resolveGameTarget(detected, targetDir, item, resolveErr))
        {
            result.error = resolveErr;
            return result;
        }

        result.gameDir = targetDir;
        result.gameExe = item.gameExe;

        if (!item.hasAutoTranslator)
        {
            result.error = "请先安装翻译插件后再使用 Patch and Run";
            return result;
        }

        const fs::path gameDir = pathFromUtf8(targetDir);
        std::string err;

        const fs::path shortcut = findPatchAndRunShortcut(gameDir, item.gameExe);
        if (!shortcut.empty())
        {
            if (!shellOpenPath(shortcut, gameDir, err))
            {
                result.error = err;
                return result;
            }
            result.ok = true;
            return result;
        }

        const fs::path reiExe = gameDir / "ReiPatcher" / "ReiPatcher.exe";
        const fs::path ini = findReiPatcherIni(gameDir, item.gameExe);
        std::error_code ec;
        if (fs::is_regular_file(reiExe, ec) && !ini.empty())
        {
            const std::wstring args = L"\"" + ini.filename().wstring() + L"\"";
            if (!shellOpenWithArgs(reiExe, args, gameDir / "ReiPatcher", err))
            {
                result.error = err;
                return result;
            }
            result.ok = true;
            return result;
        }

        result.error =
            "未找到 Patch and Run 快捷方式。请先重新安装插件（会运行 Setup），"
            "或手动运行游戏目录中的「(Patch and Run).lnk」";
        return result;
    }
    catch (const std::exception& ex)
    {
        result.error = std::string("启动异常: ") + ex.what();
        return result;
    }
    catch (...)
    {
        result.error = "启动异常：无法访问该目录";
        return result;
    }
#endif
}

UnitySelfCheckResult UnityAutoTranslator::selfCheck(const std::string& gamePath)
{
    UnitySelfCheckResult result;
    try
    {
        const auto detected = detect(gamePath);
        if (!detected.ok && detected.games.empty())
        {
            result.error = detected.error.empty() ? "检测失败" : detected.error;
            return result;
        }

        std::string targetDir;
        UnityGameItem item;
        std::string resolveErr;
        if (!resolveGameTarget(detected, targetDir, item, resolveErr))
        {
            result.error = resolveErr;
            return result;
        }

        result.gameDir = targetDir;
        result.runtime = item.runtime;
        result.gameArch = item.arch;
        result.loaderArch = "unknown";

        const auto addCheck = [&](const std::string& id,
                                  const std::string& level,
                                  const std::string& title,
                                  const std::string& detail) {
            result.checks.push_back({id, level, title, detail});
        };

        const fs::path gameDir = pathFromUtf8(targetDir);
        std::error_code ec;

        if (!item.isUnity)
        {
            result.ok = true;
            result.verdict = "not_unity";
            result.verdictLabel = "不是 Unity 游戏";
            result.summary = "未检测到 UnityPlayer.dll 或 *_Data 目录结构。";
            addCheck("unity", "error", "Unity 结构", "未找到 Unity 游戏特征文件");
            return result;
        }

        addCheck("unity", "ok", "Unity 结构", "已识别为 Unity 游戏");

        if (result.gameArch == "unknown")
        {
            const fs::path unityPlayer = gameDir / "UnityPlayer.dll";
            if (fs::exists(unityPlayer, ec))
                result.gameArch = readPeArch(unityPlayer);
        }

        if (result.gameArch != "unknown")
        {
            addCheck(
                "game_arch",
                "ok",
                "游戏位数",
                "主程序 / UnityPlayer 为 " + result.gameArch);
        }
        else
        {
            addCheck(
                "game_arch",
                "warn",
                "游戏位数",
                "未能从主程序或 UnityPlayer.dll 读取 PE 架构");
        }

        if (item.isIl2Cpp)
        {
            addCheck("runtime", "ok", "运行时", "IL2CPP（需 BepInEx 6 加载器）");
        }
        else if (item.runtime == "mono")
        {
            addCheck("runtime", "ok", "运行时", "Mono（可用 ReiPatcher 或 BepInEx）");
        }
        else
        {
            addCheck("runtime", "warn", "运行时", "未能判断 Mono / IL2CPP");
        }

        const std::string doorstopName = findDoorstopDll(gameDir);
        if (!doorstopName.empty())
        {
            result.loaderArch = readPeArch(gameDir / pathFromUtf8(doorstopName));
            addCheck(
                "doorstop",
                "ok",
                "Doorstop 注入",
                doorstopName + " 存在，架构为 " + result.loaderArch);
        }
        else if (item.isIl2Cpp)
        {
            addCheck(
                "doorstop",
                item.hasBepInEx ? "warn" : "error",
                "Doorstop 注入",
                item.hasBepInEx
                    ? "未找到 winhttp.dll / version.dll / winmm.dll"
                    : "未找到 Doorstop 注入 DLL");
        }

        if (item.hasBepInEx)
            addCheck("bepinex", "ok", "BepInEx", "已检测到 BepInEx 目录");
        else if (item.isIl2Cpp)
            addCheck("bepinex", "error", "BepInEx", "IL2CPP 游戏尚未安装 BepInEx 加载器");

        if (item.hasAutoTranslator)
            addCheck("plugin", "ok", "翻译插件", "已检测到 XUnity.AutoTranslator");

        bool archMismatch = false;
        if (result.loaderArch != "unknown" && result.gameArch != "unknown"
            && result.loaderArch != result.gameArch)
        {
            archMismatch = true;
            addCheck(
                "arch_match",
                "error",
                "位数一致",
                "游戏为 " + result.gameArch + "，Doorstop 为 " + result.loaderArch
                    + "，不一致可能导致闪退");
        }
        else if (result.loaderArch != "unknown" && result.gameArch != "unknown")
        {
            addCheck("arch_match", "ok", "位数一致", "游戏与 Doorstop 均为 " + result.gameArch);
        }

        bool logSuggestsOutdated = false;
        const fs::path logPath = gameDir / "BepInEx" / "LogOutput.log";
        if (fs::exists(logPath, ec))
        {
            result.hasLog = true;
            result.logPath = pathUtf8(logPath);
            std::ifstream in(logPath, std::ios::binary);
            if (in)
            {
                in.seekg(0, std::ios::end);
                const auto size = in.tellg();
                const std::streamoff readFrom =
                    size > 8192 ? static_cast<std::streamoff>(size) - 8192 : 0;
                in.seekg(readFrom);
                result.logSnippet.assign(
                    std::istreambuf_iterator<char>(in),
                    std::istreambuf_iterator<char>());

                std::string lower = result.logSnippet;
                for (char& c : lower)
                    c = static_cast<char>(tolower(static_cast<unsigned char>(c)));

                if (lower.find("il2cpp") != std::string::npos
                    || lower.find("interop") != std::string::npos
                    || lower.find("preloader") != std::string::npos
                    || lower.find("unsupported") != std::string::npos
                    || lower.find("failed") != std::string::npos)
                {
                    logSuggestsOutdated = true;
                    addCheck(
                        "log",
                        "warn",
                        "BepInEx 日志",
                        "日志末尾出现 IL2CPP / interop / unsupported / failed 等字样，"
                        "可能需更新 BepInEx Bleeding Edge");
                }
                else
                {
                    addCheck("log", "ok", "BepInEx 日志", "已读取 LogOutput.log，未发现明显异常关键字");
                }
            }
        }
        else if (item.hasBepInEx)
        {
            addCheck(
                "log",
                "warn",
                "BepInEx 日志",
                "尚未生成 BepInEx/LogOutput.log，请先启动一次游戏");
        }

        const bool missingLoader = item.isIl2Cpp && !item.hasBepInEx;

        if (archMismatch)
        {
            result.verdict = "arch_mismatch";
            result.verdictLabel = "优先怀疑：装错了 x86/x64";
            result.summary =
                "游戏主程序为 " + result.gameArch + "，Doorstop（" + doorstopName
                + "）为 " + result.loaderArch + "。位数不一致时常见闪退或无日志。";
            result.suggestions.push_back("使用「卸载加载器」清除当前 BepInEx / Doorstop 文件");
            result.suggestions.push_back(
                "按本工具识别的 " + result.gameArch + " 位数重新「安装加载器」");
            result.suggestions.push_back("位数纠正前不必先换 BepInEx Bleeding Edge");
        }
        else if (missingLoader)
        {
            result.verdict = "missing_loader";
            result.verdictLabel = "缺少加载器";
            result.summary = "IL2CPP 游戏需要先安装 BepInEx 6 加载器，再安装翻译插件。";
            result.suggestions.push_back("点击「安装加载器」安装与游戏位数匹配的 BepInEx");
            result.suggestions.push_back("启动一次游戏完成 BepInEx 初始化");
            result.suggestions.push_back("再安装翻译插件");
        }
        else if (logSuggestsOutdated)
        {
            result.verdict = "log_suggests_outdated";
            result.verdictLabel = "优先怀疑：BepInEx 版本偏旧";
            result.summary =
                "位数一致，但 BepInEx 日志出现版本/注入相关异常。可尝试同位数的 Bleeding Edge 包。";
            result.suggestions.push_back("保持与游戏相同的 " + result.gameArch + " 位数");
            result.suggestions.push_back("尝试更新的 BepInEx Bleeding Edge（BE）");
            result.suggestions.push_back("换包后删除旧 LogOutput.log 再启动一次查看新日志");
        }
        else
        {
            result.verdict = "ok";
            result.verdictLabel = "未发现明显问题";
            if (item.hasBepInEx && !result.hasLog)
            {
                result.summary =
                    "目录结构正常，但尚未生成 BepInEx 日志。请先启动一次游戏；仍无日志请检查杀软是否隔离 Doorstop。";
                result.suggestions.push_back("启动游戏一次以生成 BepInEx/LogOutput.log");
                result.suggestions.push_back("若仍无日志，检查 winhttp.dll 等是否被安全软件隔离");
            }
            else if (item.hasAutoTranslator)
            {
                result.summary = "Unity 结构、加载器与翻译插件检测正常。若仍无法启动，请查看 BepInEx 日志。";
            }
            else if (item.isIl2Cpp && item.hasBepInEx)
            {
                result.summary = "BepInEx 加载器已就绪，可安装翻译插件。";
                result.suggestions.push_back("启动一次游戏完成 BepInEx 初始化");
                result.suggestions.push_back("再点击「安装翻译插件」");
            }
            else
            {
                result.summary = "未发现位数不一致或日志异常。若游戏仍无法启动，请对照帮助文档手动排查。";
            }
        }

        result.ok = true;
        return result;
    }
    catch (const std::exception& ex)
    {
        result.ok = false;
        result.error = std::string("自检异常: ") + ex.what();
        return result;
    }
    catch (...)
    {
        result.ok = false;
        result.error = "自检异常：无法访问该目录";
        return result;
    }
}

UnityInstallResult UnityAutoTranslator::install(const UnityInstallRequest& req)
{
    UnityInstallResult result;
#ifndef _WIN32
    result.error = "仅支持 Windows";
    return result;
#else
    try
    {
        const auto detected = detect(req.gamePath);
        result.steps.push_back("检测游戏目录");
        if (!detected.ok && detected.games.empty())
        {
            result.error = detected.error.empty() ? "检测失败" : detected.error;
            return result;
        }

        std::string targetDir;
        UnityGameItem item;
        std::string resolveErr;
        if (!resolveGameTarget(detected, targetDir, item, resolveErr))
        {
            result.error = resolveErr;
            return result;
        }

        if (!item.isUnity)
        {
            result.error = "不是有效的 Unity 游戏";
            return result;
        }

        result.gameDir = targetDir;
        result.installMethod = item.installMethod;
        result.version = kReleaseVersion;

        if (item.isIl2Cpp && !item.hasBepInEx)
        {
            result.error = "检测到 IL2CPP 游戏，请先点击「安装加载器」安装 BepInEx 6，再安装翻译插件。";
            result.steps.push_back("IL2CPP 缺少 BepInEx，已中止");
            return result;
        }

        const std::string pkg = packageFileName(item.installMethod);
        result.package = pkg;
        const std::string url = std::string(kGithubReleaseBase) + kReleaseTag + "/" + pkg;

        const fs::path tempDir = fs::temp_directory_path() / "llmchat-xunity";
        fs::create_directories(tempDir);
        const fs::path zipPath = tempDir / pathFromUtf8(pkg);

        result.steps.push_back("下载 " + pkg);
        std::string err;
        if (!downloadFile(url, zipPath, err))
        {
            result.error = err;
            return result;
        }

        const fs::path gameDirPath = pathFromUtf8(targetDir);
        result.steps.push_back("解压到游戏目录");
        if (!extractZip(zipPath, gameDirPath, err))
        {
            result.error = err;
            return result;
        }

        if (item.installMethod == "ReiPatcher" && req.runSetup)
        {
            const fs::path setup = gameDirPath / "SetupReiPatcherAndAutoTranslator.exe";
            std::error_code ec;
            if (fs::exists(setup, ec))
            {
                result.steps.push_back("运行 SetupReiPatcherAndAutoTranslator.exe");
                if (!runProcess(setup, gameDirPath, err))
                    result.error = err + "（文件已解压，可手动运行 Setup）";
            }
            else
            {
                result.steps.push_back("未找到 Setup 程序，已跳过自动补丁");
            }
        }

        result.steps.push_back("写入 AutoTranslator 配置");
        UnityInstallRequest cfg = req;
        if (cfg.language.empty())
            cfg.language = "zh-CN";
        if (cfg.fromLanguage.empty())
            cfg.fromLanguage = "ja";
        if (cfg.endpoint.empty())
            cfg.endpoint = "GoogleTranslate";
        const fs::path configPath = writeConfig(gameDirPath, item.installMethod, cfg);
        result.configPath = pathUtf8(configPath);

        result.ok = result.error.empty();
        if (result.ok)
            result.steps.push_back("完成。请启动游戏；游戏内 Alt+0 可打开翻译面板");
        return result;
    }
    catch (const std::exception& ex)
    {
        result.ok = false;
        result.error = std::string("安装异常: ") + ex.what();
        return result;
    }
    catch (...)
    {
        result.ok = false;
        result.error = "安装异常：无法访问该目录";
        return result;
    }
#endif
}

UnityUninstallResult UnityAutoTranslator::uninstall(const UnityUninstallRequest& req)
{
    UnityUninstallResult result;
    try
    {
        const auto detected = detect(req.gamePath);
        result.steps.push_back("检测游戏目录");
        if (!detected.ok && detected.games.empty())
        {
            result.error = detected.error.empty() ? "检测失败" : detected.error;
            return result;
        }

        std::string targetDir = detected.gameDir;
        std::string method = detected.installMethod;
        bool hadPlugin = detected.hasAutoTranslator;
        if (targetDir.empty())
        {
            if (detected.games.size() == 1)
            {
                targetDir = detected.games.front().gameDir;
                method = detected.games.front().installMethod;
                hadPlugin = detected.games.front().hasAutoTranslator;
            }
            else
            {
                result.error = "请先在列表中选择一个具体游戏再卸载";
                return result;
            }
        }
        else
        {
            for (const auto& g : detected.games)
            {
                if (iequals(g.gameDir, targetDir))
                {
                    hadPlugin = g.hasAutoTranslator;
                    method = g.installMethod;
                    break;
                }
            }
        }

        result.gameDir = targetDir;
        result.installMethod = method;
        const fs::path gameDir = pathFromUtf8(targetDir);

        if (!hadPlugin && !detectAutoTranslator(gameDir))
        {
            result.error = "该游戏未检测到 XUnity.AutoTranslator 或缓存，无需卸载";
            result.steps.push_back("未找到插件 / 缓存文件");
            return result;
        }

        auto tryRemove = [&](const fs::path& p) {
            std::error_code ec;
            if (!fs::exists(p, ec))
                return;
            const std::string label = pathUtf8(p.lexically_relative(gameDir));
            const std::string shown =
                label.empty() || label == "." ? pathUtf8(p.filename()) : label;
            const bool isDir = fs::is_directory(p, ec);
            if (isDir)
                fs::remove_all(p, ec);
            else
                fs::remove(p, ec);
            if (ec)
            {
                result.steps.push_back("删除失败：" + shown + "（" + ec.message() + "）");
                return;
            }
            result.removed.push_back(pathUtf8(p));
            result.steps.push_back(std::string("已删除 ") + (isDir ? shown + "/" : shown));
        };

        result.steps.push_back("删除翻译插件及其生成文件");

        auto targets = listXUnityUninstallTargets(gameDir);
        std::sort(targets.begin(), targets.end(), [](const fs::path& a, const fs::path& b) {
            return pathUtf8(a).size() > pathUtf8(b).size();
        });
        for (const auto& p : targets)
            tryRemove(p);

        if (result.removed.empty())
        {
            result.error = "未找到可删除的插件或缓存文件（可能已被手动移除）";
            return result;
        }

        if (detectAutoTranslator(gameDir))
        {
            result.error = "部分文件已删除，但仍检测到残留，请手动检查游戏目录";
            result.steps.push_back("卸载未完全干净");
            return result;
        }

        result.ok = true;
        result.steps.push_back("完成。已删除翻译插件及其生成的缓存/配置文件。");
        return result;
    }
    catch (const std::exception& ex)
    {
        result.ok = false;
        result.error = std::string("卸载异常: ") + ex.what();
        return result;
    }
    catch (...)
    {
        result.ok = false;
        result.error = "卸载异常：无法访问该目录";
        return result;
    }
}

UnityInstallResult UnityAutoTranslator::installLoader(const UnityLoaderRequest& req)
{
    UnityInstallResult result;
#ifndef _WIN32
    result.error = "仅支持 Windows";
    return result;
#else
    try
    {
        const auto detected = detect(req.gamePath);
        result.steps.push_back("检测游戏目录");
        if (!detected.ok && detected.games.empty())
        {
            result.error = detected.error.empty() ? "检测失败" : detected.error;
            return result;
        }

        std::string targetDir;
        UnityGameItem item;
        std::string resolveErr;
        if (!resolveGameTarget(detected, targetDir, item, resolveErr))
        {
            result.error = resolveErr;
            return result;
        }

        result.gameDir = targetDir;
        result.installMethod = "BepInEx-IL2CPP";
        result.version = kBepInExVersion;

        if (!item.isIl2Cpp)
        {
            result.error = "仅 IL2CPP 游戏需要安装 BepInEx 加载器；Mono 游戏可直接安装翻译插件";
            return result;
        }
        if (item.hasBepInEx)
        {
            result.error = "该游戏已安装 BepInEx，无需重复安装";
            result.steps.push_back("已检测到 BepInEx");
            return result;
        }
        if (item.arch == "arm64")
        {
            result.error = "暂不支持 ARM64 游戏的 BepInEx IL2CPP 加载器自动安装";
            return result;
        }

        const std::string pkg = bepinexIl2CppPackage(item.arch);
        result.package = pkg;
        const std::string archLabel = item.arch == "x86" ? "x86" : "x64";

        fs::path zipPath = findCachedBepInExZip(pkg);
        std::string err;
        if (!zipPath.empty())
        {
            result.steps.push_back(
                "使用本地缓存 BepInEx " + std::string(kBepInExVersion) + "（" + archLabel + "）");
        }
        else
        {
            const std::string url =
                std::string(kBepInExReleaseBase) + kBepInExTag + "/" + pkg;
            const fs::path cacheDir = bepinexCacheDir();
            fs::create_directories(cacheDir);
            zipPath = cacheDir / pathFromUtf8(pkg);
            result.steps.push_back(
                "本地无缓存，下载 BepInEx " + std::string(kBepInExVersion) + "（" + archLabel
                + "）并保存到 resources/bepinex/");
            if (!downloadFile(url, zipPath, err))
            {
                result.error = err;
                std::error_code ec;
                fs::remove(zipPath, ec);
                return result;
            }
        }

        const fs::path targetPath = pathFromUtf8(targetDir);
        result.steps.push_back("解压加载器到游戏目录");
        if (!extractZip(zipPath, targetPath, err))
        {
            result.error = err;
            return result;
        }

        if (!detectBepInEx(targetPath))
        {
            result.error = "解压完成但仍未检测到 BepInEx，请检查游戏目录权限或手动安装";
            return result;
        }

        result.ok = true;
        result.steps.push_back(
            "加载器安装完成。请先启动一次游戏以完成 BepInEx 初始化，再安装翻译插件。");
        return result;
    }
    catch (const std::exception& ex)
    {
        result.ok = false;
        result.error = std::string("安装加载器异常: ") + ex.what();
        return result;
    }
    catch (...)
    {
        result.ok = false;
        result.error = "安装加载器异常：无法访问该目录";
        return result;
    }
#endif
}

UnityUninstallResult UnityAutoTranslator::uninstallLoader(const UnityLoaderRequest& req)
{
    UnityUninstallResult result;
    try
    {
        const auto detected = detect(req.gamePath);
        result.steps.push_back("检测游戏目录");
        if (!detected.ok && detected.games.empty())
        {
            result.error = detected.error.empty() ? "检测失败" : detected.error;
            return result;
        }

        std::string targetDir;
        UnityGameItem item;
        std::string resolveErr;
        if (!resolveGameTarget(detected, targetDir, item, resolveErr))
        {
            result.error = resolveErr;
            return result;
        }

        result.gameDir = targetDir;
        result.installMethod = "BepInEx-IL2CPP";
        const fs::path gameDir = pathFromUtf8(targetDir);

        if (!item.isIl2Cpp)
        {
            result.error = "仅 IL2CPP 游戏使用此加载器卸载";
            return result;
        }
        if (!detectBepInEx(gameDir) && listBepInExLoaderTargets(gameDir).empty())
        {
            result.error = "未检测到 BepInEx 加载器，无需卸载";
            return result;
        }

        auto tryRemove = [&](const fs::path& p) {
            std::error_code ec;
            if (!fs::exists(p, ec))
                return;
            const std::string label = pathUtf8(p.lexically_relative(gameDir));
            const std::string shown =
                label.empty() || label == "." ? pathUtf8(p.filename()) : label;
            const bool isDir = fs::is_directory(p, ec);
            if (isDir)
                fs::remove_all(p, ec);
            else
                fs::remove(p, ec);
            if (ec)
            {
                result.steps.push_back("删除失败：" + shown + "（" + ec.message() + "）");
                return;
            }
            result.removed.push_back(pathUtf8(p));
            result.steps.push_back(std::string("已删除 ") + (isDir ? shown + "/" : shown));
        };

        result.steps.push_back("删除 BepInEx 加载器及其下全部文件（含插件与缓存）");
        auto targets = listBepInExLoaderTargets(gameDir);
        std::sort(targets.begin(), targets.end(), [](const fs::path& a, const fs::path& b) {
            return pathUtf8(a).size() > pathUtf8(b).size();
        });
        for (const auto& p : targets)
            tryRemove(p);

        if (result.removed.empty())
        {
            result.error = "未找到可删除的加载器文件";
            return result;
        }
        if (detectBepInEx(gameDir))
        {
            result.error = "部分文件已删除，但仍检测到 BepInEx 残留";
            return result;
        }

        result.ok = true;
        result.steps.push_back("完成。已卸载加载器及其下全部内容。");
        return result;
    }
    catch (const std::exception& ex)
    {
        result.ok = false;
        result.error = std::string("卸载加载器异常: ") + ex.what();
        return result;
    }
    catch (...)
    {
        result.ok = false;
        result.error = "卸载加载器异常：无法访问该目录";
        return result;
    }
}

std::vector<UnityEndpointInfo> UnityAutoTranslator::endpoints()
{
    return {
        {"GoogleTranslate", "Google 翻译（免 Key）", false},
        {"GoogleTranslateV2", "Google 翻译 V2（免 Key）", false},
        {"GoogleTranslateCompat", "Google 兼容模式（免 Key）", false},
        {"BingTranslate", "Bing 翻译（免 Key）", false},
        {"DeepLTranslate", "DeepL（免 Key）", false},
        {"PapagoTranslate", "Papago（免 Key）", false},
        {"BaiduTranslate", "百度翻译（需 Key）", true},
        {"DeepLTranslateLegitimate", "DeepL API（需 Key）", true},
        {"BingTranslateLegitimate", "Azure 翻译（需 Key）", true},
        {"GoogleTranslateLegitimate", "Google Cloud（需 Key）", true},
        {"LingoCloudTranslate", "彩云小译（可选 Token）", false},
        {"", "禁用自动翻译", false},
    };
}
