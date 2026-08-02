#include "UnityAutoTranslator.h"

#include <cctype>
#include <filesystem>
#include <fstream>
#include <sstream>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <winhttp.h>
#pragma comment(lib, "winhttp.lib")
#endif

namespace fs = std::filesystem;

namespace
{

constexpr const char* kReleaseTag = "v5.6.1";
constexpr const char* kReleaseVersion = "5.6.1";
constexpr const char* kGithubReleaseBase =
    "https://github.com/bbepis/XUnity.AutoTranslator/releases/download/";

std::string trimCopy(std::string s)
{
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '\r' || s.back() == '\n'))
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

std::wstring toWide(const std::string& s)
{
    if (s.empty())
        return L"";
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    std::wstring out(n > 0 ? n - 1 : 0, L'\0');
    if (n > 1)
        MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), n);
    return out;
}

std::string toUtf8(const std::wstring& s)
{
    if (s.empty())
        return "";
    const int n = WideCharToMultiByte(CP_UTF8, 0, s.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string out(n > 0 ? n - 1 : 0, '\0');
    if (n > 1)
        WideCharToMultiByte(CP_UTF8, 0, s.c_str(), -1, out.data(), n, nullptr, nullptr);
    return out;
}

bool looksLikeExe(const fs::path& p)
{
    const auto ext = p.extension().wstring();
    return iequals(toUtf8(ext), ".exe");
}

fs::path resolveGameDir(const fs::path& input, std::string& gameExe)
{
    std::error_code ec;
    fs::path p = fs::absolute(input, ec);
    if (ec)
        p = input;

    if (fs::is_regular_file(p) && looksLikeExe(p))
    {
        gameExe = p.filename().string();
        return p.parent_path();
    }

    if (fs::is_directory(p))
    {
        // Prefer {Name}.exe that has sibling {Name}_Data
        for (const auto& entry : fs::directory_iterator(p, ec))
        {
            if (ec)
                break;
            if (!entry.is_regular_file())
                continue;
            const auto file = entry.path();
            if (!looksLikeExe(file))
                continue;
            const std::string stem = file.stem().string();
            if (stem.empty())
                continue;
            if (fs::exists(p / (stem + "_Data")))
            {
                gameExe = file.filename().string();
                return p;
            }
        }
        // Fallback: any exe except setup helpers
        for (const auto& entry : fs::directory_iterator(p, ec))
        {
            if (ec)
                break;
            if (!entry.is_regular_file())
                continue;
            const auto file = entry.path();
            if (!looksLikeExe(file))
                continue;
            const std::string name = file.filename().string();
            if (iequals(name, "UnityCrashHandler64.exe") ||
                iequals(name, "UnityCrashHandler32.exe") ||
                name.find("SetupReiPatcher") != std::string::npos)
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

bool detectUnity(const fs::path& gameDir, const std::string& gameExe)
{
    if (gameDir.empty())
        return false;
    if (fs::exists(gameDir / "UnityPlayer.dll"))
        return true;
    if (!gameExe.empty())
    {
        const fs::path stemData = gameDir / (fs::path(gameExe).stem().string() + "_Data");
        if (fs::exists(stemData))
            return true;
    }
    for (const auto& entry : fs::directory_iterator(gameDir))
    {
        if (!entry.is_directory())
            continue;
        const auto name = entry.path().filename().string();
        if (name.size() > 5 && name.ends_with("_Data"))
            return true;
    }
    return false;
}

bool detectIl2Cpp(const fs::path& gameDir)
{
    if (fs::exists(gameDir / "GameAssembly.dll"))
        return true;
    if (fs::exists(gameDir / "il2cpp_data"))
        return true;
    for (const auto& entry : fs::directory_iterator(gameDir))
    {
        if (!entry.is_directory())
            continue;
        const auto name = entry.path().filename().string();
        if (name.size() > 5 && name.ends_with("_Data"))
        {
            if (fs::exists(entry.path() / "il2cpp_data") ||
                fs::exists(entry.path() / "Native"))
            {
                return true;
            }
            if (fs::exists(entry.path() / "Managed"))
                return false;
        }
    }
    return false;
}

bool detectAutoTranslator(const fs::path& gameDir)
{
    if (fs::exists(gameDir / "AutoTranslator"))
        return true;
    if (fs::exists(gameDir / "BepInEx" / "plugins" / "XUnity.AutoTranslator"))
        return true;
    if (fs::exists(gameDir / "ReiPatcher" / "Patches" / "XUnity.AutoTranslator.Patcher.dll"))
        return true;
    return false;
}

bool detectBepInEx(const fs::path& gameDir)
{
    return fs::exists(gameDir / "BepInEx" / "core") || fs::exists(gameDir / "BepInEx" / "plugins");
}

std::string chooseMethod(bool isUnity, bool isIl2Cpp, bool hasBepInEx)
{
    if (!isUnity)
        return "none";
    if (hasBepInEx)
        return isIl2Cpp ? "BepInEx-IL2CPP" : "BepInEx";
    if (isIl2Cpp)
        return "BepInEx-IL2CPP"; // needs BepInEx 6 first; we still extract plugin package
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

    // Follow redirects (GitHub release assets)
    DWORD redirect = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
    WinHttpSetOption(request, WINHTTP_OPTION_REDIRECT_POLICY, &redirect, sizeof(redirect));

    if (!WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
        !WinHttpReceiveResponse(request, nullptr))
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
    return fs::file_size(dest) > 0;
}

bool extractZip(const fs::path& zipPath, const fs::path& destDir, std::string& error)
{
    fs::create_directories(destDir);
    // Windows 10+ tar can extract zip
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
    std::wstring dir = workDir.wstring();
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
        error = "无法运行安装程序: " + exe.filename().string();
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
    oss
        << "[Service]\n"
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

fs::path writeConfig(const fs::path& gameDir, const std::string& method, const UnityInstallRequest& req)
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
    // Also drop a copy under AutoTranslator for ReiPatcher / compatibility
    if (method.rfind("BepInEx", 0) == 0)
    {
        const fs::path alt = gameDir / "AutoTranslator" / "Config.ini";
        fs::create_directories(alt.parent_path());
        std::ofstream out(alt, std::ios::binary);
        out << content;
    }
    return primary;
}

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

    std::string gameExe;
    const fs::path gameDir = resolveGameDir(path, gameExe);
    if (gameDir.empty() || !fs::exists(gameDir))
    {
        info.error = "路径不存在";
        return info;
    }

    info.ok = true;
    info.gameDir = gameDir.string();
    info.gameExe = gameExe;
    info.isUnity = detectUnity(gameDir, gameExe);
    info.isIl2Cpp = info.isUnity && detectIl2Cpp(gameDir);
    info.hasBepInEx = detectBepInEx(gameDir);
    info.hasAutoTranslator = detectAutoTranslator(gameDir);
    info.runtime = !info.isUnity ? "unknown" : (info.isIl2Cpp ? "il2cpp" : "mono");
    info.installMethod = chooseMethod(info.isUnity, info.isIl2Cpp, info.hasBepInEx);

    if (!info.isUnity)
        info.error = "未检测到 Unity 游戏（缺少 *_Data 或 UnityPlayer.dll）";

    return info;
}

UnityInstallResult UnityAutoTranslator::install(const UnityInstallRequest& req)
{
    UnityInstallResult result;
#ifndef _WIN32
    result.error = "仅支持 Windows";
    return result;
#else
    auto detected = detect(req.gamePath);
    result.steps.push_back("检测游戏目录");
    if (!detected.ok || !detected.isUnity)
    {
        result.error = detected.error.empty() ? "不是有效的 Unity 游戏" : detected.error;
        return result;
    }

    result.gameDir = detected.gameDir;
    result.installMethod = detected.installMethod;
    result.version = kReleaseVersion;

    if (detected.isIl2Cpp && !detected.hasBepInEx)
    {
        result.error =
            "检测到 IL2CPP 游戏，需要先安装 BepInEx 6（IL2CPP），再安装 "
            "XUnity.AutoTranslator-BepInEx-IL2CPP。"
            "请先安装 BepInEx 后再重试，或改用 Mono 游戏。";
        result.steps.push_back("IL2CPP 缺少 BepInEx，已中止");
        return result;
    }

    const std::string pkg = packageFileName(detected.installMethod);
    result.package = pkg;
    const std::string url = std::string(kGithubReleaseBase) + kReleaseTag + "/" + pkg;

    const fs::path tempDir = fs::temp_directory_path() / "llmchat-xunity";
    fs::create_directories(tempDir);
    const fs::path zipPath = tempDir / pkg;

    result.steps.push_back("下载 " + pkg);
    std::string err;
    if (!downloadFile(url, zipPath, err))
    {
        result.error = err;
        return result;
    }

    result.steps.push_back("解压到游戏目录");
    if (!extractZip(zipPath, detected.gameDir, err))
    {
        result.error = err;
        return result;
    }

    if (detected.installMethod == "ReiPatcher" && req.runSetup)
    {
        const fs::path setup = fs::path(detected.gameDir) / "SetupReiPatcherAndAutoTranslator.exe";
        if (fs::exists(setup))
        {
            result.steps.push_back("运行 SetupReiPatcherAndAutoTranslator.exe");
            if (!runProcess(setup, detected.gameDir, err))
            {
                result.error = err + "（文件已解压，可手动运行 Setup）";
                // still write config
            }
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
    const fs::path configPath = writeConfig(detected.gameDir, detected.installMethod, cfg);
    result.configPath = configPath.string();

    result.ok = true;
    result.steps.push_back("完成。请启动游戏；游戏内 Alt+0 可打开翻译面板");
    return result;
#endif
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
