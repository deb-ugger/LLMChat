#include "UnityAutoTranslator.h"
#include "unity_runtime/UnityGameDetection.h"
#include "unity_runtime/UnityRuntimeDownload.h"
#include "unity_runtime/UnityRuntimeFont.h"
#include "Utf8Path.h"
#include "StoragePaths.h"

#include <algorithm>
#include <cctype>
#include <deque>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <map>
#include <regex>
#include <sstream>
#include <unordered_set>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <shellapi.h>
#include <shlobj.h>
#include <wrl/implements.h>
#include <objbase.h>
#include <windows.h>
#include <winver.h>
#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "version.lib")
#endif

namespace fs = std::filesystem;

using utf8path::pathFromUtf8;
using utf8path::pathUtf8;
using utf8path::toWide;
using utf8path::toUtf8;

namespace
{

using unity_runtime::detectAutoTranslator;
using unity_runtime::detectBepInEx;
using unity_runtime::detectReiPatcher;
using unity_runtime::inspectGameDir;
using unity_runtime::nameLooksLikeXUnityConfig;
using unity_runtime::readPeArch;
using unity_runtime::detail::iequals;
using unity_runtime::detail::trimCopy;

constexpr const char* kReleaseTag = "v5.6.1";
constexpr const char* kReleaseVersion = "5.6.1";
constexpr const char* kGithubReleaseBase =
    "https://github.com/bbepis/XUnity.AutoTranslator/releases/download/";

constexpr const char* kBepInExTag = "v6.0.0-pre.2";
constexpr const char* kBepInExVersion = "6.0.0-pre.2";
constexpr const char* kBepInExReleaseBase =
    "https://github.com/BepInEx/BepInEx/releases/download/";

/** True if UTF-8 path contains CJK ideographs (common cause of Doorstop/BepInEx launch failures). */
bool pathContainsChinese(const std::string& utf8Path)
{
    if (utf8Path.empty())
        return false;
#ifdef _WIN32
    const std::wstring w = toWide(utf8Path);
    for (wchar_t ch : w)
    {
        const auto u = static_cast<unsigned int>(ch);
        if ((u >= 0x4E00u && u <= 0x9FFFu)   // CJK Unified Ideographs
            || (u >= 0x3400u && u <= 0x4DBFu) // Extension A
            || (u >= 0xF900u && u <= 0xFAFFu) // Compatibility Ideographs
            || (u >= 0x3000u && u <= 0x303Fu) // CJK Symbols and Punctuation
        )
            return true;
    }
    return false;
#else
    for (size_t i = 0; i < utf8Path.size();)
    {
        const unsigned char c = static_cast<unsigned char>(utf8Path[i]);
        unsigned int cp = 0;
        size_t n = 1;
        if (c < 0x80)
        {
            cp = c;
        }
        else if ((c & 0xE0) == 0xC0 && i + 1 < utf8Path.size())
        {
            cp = ((c & 0x1Fu) << 6) | (static_cast<unsigned char>(utf8Path[i + 1]) & 0x3Fu);
            n = 2;
        }
        else if ((c & 0xF0) == 0xE0 && i + 2 < utf8Path.size())
        {
            cp = ((c & 0x0Fu) << 12)
                | ((static_cast<unsigned char>(utf8Path[i + 1]) & 0x3Fu) << 6)
                | (static_cast<unsigned char>(utf8Path[i + 2]) & 0x3Fu);
            n = 3;
        }
        else if ((c & 0xF8) == 0xF0 && i + 3 < utf8Path.size())
        {
            cp = ((c & 0x07u) << 18)
                | ((static_cast<unsigned char>(utf8Path[i + 1]) & 0x3Fu) << 12)
                | ((static_cast<unsigned char>(utf8Path[i + 2]) & 0x3Fu) << 6)
                | (static_cast<unsigned char>(utf8Path[i + 3]) & 0x3Fu);
            n = 4;
        }
        else
        {
            ++i;
            continue;
        }
        if ((cp >= 0x4E00u && cp <= 0x9FFFu) || (cp >= 0x3400u && cp <= 0x4DBFu)
            || (cp >= 0xF900u && cp <= 0xFAFFu) || (cp >= 0x3000u && cp <= 0x303Fu))
            return true;
        i += n;
    }
    return false;
#endif
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

bool resolveDetectedGame(const UnityDetectInfo& detected, std::string& gameDir, UnityGameItem& game, std::string& error)
{
    if (!detected.ok && detected.games.empty()) {
        error = detected.error.empty() ? "检测失败" : detected.error;
        return false;
    }
    return resolveGameTarget(detected, gameDir, game, error);
}


/**
 * Uninstall targets = translation plugin this module installs
 * + files the plugin generates at runtime (caches / configs)
 * + Patch and Run shortcuts + TMP/CJK font assets we copied into the game root
 * + XUnity files injected into *_Data/Managed.
 * Keeps the plugin framework itself (ReiPatcher / BepInEx loader).
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
    // Keep ReiPatcher/ framework; remove XUnity patch DLLs under Patches/
    {
        std::error_code ec;
        const fs::path patches = gameDir / "ReiPatcher" / "Patches";
        if (fs::is_directory(patches, ec))
        {
            for (fs::directory_iterator it(patches, ec), end; !ec && it != end;
                 it.increment(ec))
            {
                if (ec || !it->is_regular_file(ec))
                    continue;
                const std::string name = pathUtf8(it->path().filename());
                std::string lower = name;
                for (char& c : lower)
                    c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
                if (lower.find("xunity") != std::string::npos)
                    out.push_back(it->path());
            }
        }
    }
    add(gameDir / "BepInEx" / "plugins" / "XUnity.AutoTranslator");
    add(gameDir / "BepInEx" / "plugins" / "XUnity.ResourceRedirector");
    add(gameDir / "BepInEx" / "core" / "XUnity.Common.dll");

    add(gameDir / "Translation");
    add(gameDir / "BepInEx" / "Translation");
    add(gameDir / "BepInEx" / "config" / "Translation");
    add(gameDir / "BepInEx" / "config" / "AutoTranslatorConfig.ini");
    add(gameDir / "BepInEx" / "config" / "gravydevsupreme.xunity.autotranslator.ini");

    // UGUI font copied by this tool (do not wipe unrelated files under Fonts/)
    add(gameDir / "Fonts" / "NotoSansSC-Regular.otf");

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

    // Patch and Run shortcuts + TMP / SDF font assets installed into game root
    {
        std::error_code ec;
        for (fs::directory_iterator it(gameDir, ec), end; !ec && it != end; it.increment(ec))
        {
            if (ec || !it->is_regular_file(ec))
                continue;
            const std::string name = pathUtf8(it->path().filename());
            std::string lower = name;
            for (char& c : lower)
                c = static_cast<char>(tolower(static_cast<unsigned char>(c)));

            if (lower.ends_with(".lnk") && lower.find("patch and run") != std::string::npos)
            {
                out.push_back(it->path());
                continue;
            }

            // Official / tool-installed TMP asset bundles (often no extension)
            if (lower.rfind("arialuni_sdf", 0) == 0
                || lower.find("arialuni_sdf") != std::string::npos
                || lower.find("notosanscjk-regular_sdf") != std::string::npos
                || lower.rfind("ziti_arialuni_sdf", 0) == 0)
            {
                out.push_back(it->path());
            }
        }
    }

    // ReiPatcher Setup injects XUnity + helpers into *_Data/Managed (not only ReiPatcher/)
    // Keep ReiPatcher.exe in Managed — that belongs to the framework.
    static const char* kManagedInjected[] = {
        "XUnity.AutoTranslator.Plugin.Core.dll",
        "XUnity.AutoTranslator.Plugin.ExtProtocol.dll",
        "XUnity.Common.dll",
        "XUnity.ResourceRedirector.dll",
        "0Harmony.dll",
        "ExIni.dll",
        "Mono.Cecil.dll",
        "MonoMod.RuntimeDetour.dll",
        "MonoMod.Utils.dll",
    };
    {
        std::error_code ec;
        for (fs::directory_iterator it(gameDir, ec), end; !ec && it != end; it.increment(ec))
        {
            if (ec || !it->is_directory(ec))
                continue;
            const std::string folder = pathUtf8(it->path().filename());
            if (folder.size() <= 5 || !folder.ends_with("_Data"))
                continue;
            const fs::path managed = it->path() / "Managed";
            if (!fs::is_directory(managed, ec))
                continue;

            for (const char* name : kManagedInjected)
                add(managed / name);
            add(managed / "Translators");

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

/** Plugin files only — keeps ReiPatcher framework and its .bak backups intact. */
std::vector<fs::path> listAutoTranslatorPluginOnlyTargets(const fs::path& gameDir)
{
    std::vector<fs::path> out;
    for (const auto& p : listXUnityUninstallTargets(gameDir))
    {
        const std::string name = pathUtf8(p.filename());
        std::string lower = name;
        for (char& c : lower)
            c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
        // Keep ReiPatcher DLL backups so the framework injection stays valid.
        if (lower.ends_with(".bak"))
            continue;
        out.push_back(p);
    }
    return out;
}

void removePathsQuiet(
    const std::vector<fs::path>& paths,
    const fs::path& gameDir,
    std::vector<std::string>& steps)
{
    auto sorted = paths;
    std::sort(sorted.begin(), sorted.end(), [](const fs::path& a, const fs::path& b) {
        return pathUtf8(a).size() > pathUtf8(b).size();
    });
    for (const auto& p : sorted)
    {
        std::error_code ec;
        if (!fs::exists(p, ec))
            continue;
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
            steps.push_back("清理失败：" + shown + "（" + ec.message() + "）");
            continue;
        }
        steps.push_back(std::string("已移除顺带安装的 ") + (isDir ? shown + "/" : shown));
    }
}

std::vector<fs::path> listReiPatcherLoaderTargets(const fs::path& gameDir)
{
    std::vector<fs::path> out;
    auto add = [&](const fs::path& p) {
        std::error_code ec;
        if (fs::exists(p, ec))
            out.push_back(p);
    };
    add(gameDir / "ReiPatcher");
    add(gameDir / "SetupReiPatcherAndAutoTranslator.exe");
    {
        std::error_code ec;
        for (fs::directory_iterator it(gameDir, ec), end; !ec && it != end; it.increment(ec))
        {
            if (ec || !it->is_directory(ec))
                continue;
            const std::string folder = pathUtf8(it->path().filename());
            if (folder.size() <= 5 || !folder.ends_with("_Data"))
                continue;
            add(it->path() / "Managed" / "ReiPatcher.exe");
        }
    }
    return out;
}

/** Restore ReiPatcher backups like UnityEngine.CoreModule.dll.2026-08-03_04-36-36.bak */
void restoreReiPatcherDllBackups(
    const fs::path& gameDir,
    std::vector<std::string>& steps,
    std::vector<std::string>& removed)
{
    const std::regex backupName(R"((.+\.dll)\.\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.bak)", std::regex::icase);
    const auto orderPaths = [](const fs::path& left, const fs::path& right) {
#ifdef _WIN32
        return CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) == CSTR_LESS_THAN;
#else
        return left < right;
#endif
    };
    std::map<fs::path, std::vector<fs::path>, decltype(orderPaths)> groups(orderPaths);
    for (const auto& directory : fs::directory_iterator(gameDir))
    {
        if (!directory.is_directory() || !pathUtf8(directory.path().filename()).ends_with("_Data"))
            continue;
        const auto managed = directory.path() / "Managed";
        if (!fs::is_directory(managed))
            continue;
        for (const auto& backup : fs::directory_iterator(managed))
        {
            std::smatch match;
            const auto name = pathUtf8(backup.path().filename());
            if (backup.is_regular_file() && std::regex_match(name, match, backupName))
                groups[managed / pathFromUtf8(match[1].str())].push_back(backup.path());
        }
    }
    for (auto& [original, backups] : groups)
    {
        std::sort(backups.begin(), backups.end());
        const auto& first = backups.front();
        for (auto candidate = std::next(backups.begin()); candidate != backups.end(); ++candidate)
        {
            using Bytes = std::istreambuf_iterator<char>;
            std::ifstream left(first, std::ios::binary), right(*candidate, std::ios::binary);
            if (!left || !right) throw std::runtime_error("无法读取 DLL 备份：" + pathUtf8(original));
            if (!std::equal(Bytes(left), Bytes(), Bytes(right), Bytes()))
            {
                std::string detail = "DLL 备份有多个不同版本：" + pathUtf8(original);
                for (const auto& backup : backups) detail += "\n" + pathUtf8(backup.filename());
                throw std::runtime_error(detail + "\n请确认原版 DLL 对应的备份，将其他候选移到游戏目录外后重试。");
            }
        }
    }
    for (const auto& [original, backups] : groups)
    {
        auto temporary = original;
        temporary += ".llmchat-restore.tmp";
        fs::copy_file(backups.front(), temporary, fs::copy_options::overwrite_existing);
#ifdef _WIN32
        if (!MoveFileExW(temporary.c_str(), original.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        {
            const auto error = GetLastError();
            std::error_code ignored;
            fs::remove(temporary, ignored);
            throw std::runtime_error("恢复 DLL 失败：" + pathUtf8(original) + "（Windows 错误码 " + std::to_string(error) + "）");
        }
#else
        fs::rename(temporary, original);
#endif
        steps.push_back("已从备份恢复 " + pathUtf8(original.filename()));
        for (const auto& backup : backups)
        {
            std::error_code error;
            if (fs::remove(backup, error)) removed.push_back(pathUtf8(backup));
            if (error) steps.push_back("备份已保留：" + pathUtf8(backup) + "（" + error.message() + "）");
        }
    }
}

void removeUninstallTarget(const fs::path& gameDir, const fs::path& p, UnityUninstallResult& result)
{
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
thread_local const UnityInstallControl* installControl = nullptr;

struct InstallControlScope {
    explicit InstallControlScope(const UnityInstallControl& control) { installControl = &control; }
    ~InstallControlScope() { installControl = nullptr; }
};

bool installCancelled()
{
    return installControl && installControl->stop.stop_requested();
}

void installStage(const std::string& detail)
{
    if (installCancelled()) throw std::runtime_error("安装已取消，已写入的文件可能保留");
    if (installControl) installControl->progress(detail);
}

bool runInstallerProcess(std::wstring command, const wchar_t* directory, DWORD flags, DWORD timeoutMs, DWORD& code, std::string& error)
{
    error.clear();
    if (installCancelled()) { error = "安装已取消"; return false; }
    struct Handle {
        HANDLE value;
        ~Handle() { if (value) CloseHandle(value); }
    };
    const Handle job{CreateJobObjectW(nullptr, nullptr)};
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!job.value || !SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        error = "无法管理安装进程，Windows 错误 " + std::to_string(GetLastError());
        return false;
    }

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE,
            flags | CREATE_SUSPENDED, nullptr, directory, &si, &pi)) {
        error = "无法启动安装进程，Windows 错误 " + std::to_string(GetLastError());
        return false;
    }
    const Handle process{pi.hProcess}, thread{pi.hThread};
    if (!AssignProcessToJobObject(job.value, process.value)) {
        error = "无法接管安装进程，Windows 错误 " + std::to_string(GetLastError());
        TerminateProcess(process.value, 1);
        WaitForSingleObject(process.value, INFINITE);
        return false;
    }

    if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) {
        error = "无法运行安装进程，Windows 错误 " + std::to_string(GetLastError());
        TerminateJobObject(job.value, 1);
    }
    const ULONGLONG started = GetTickCount64();
    for (;;) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
        const bool known = QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation,
            &accounting, sizeof(accounting), nullptr);
        if (known && accounting.ActiveProcesses == 0) break;
        if (error.empty() && (!known || installCancelled() || GetTickCount64() - started >= timeoutMs)) {
            error = !known ? "无法查询安装进程状态" : installCancelled() ? "安装已取消" : "安装进程超时";
            TerminateJobObject(job.value, 1);
        }
        Sleep(100);
    }

    if (!error.empty()) return false;
    if (!GetExitCodeProcess(process.value, &code)) {
        error = "无法读取安装进程退出码";
        return false;
    }
    return true;
}

using unity_runtime::CjkFontSettings;
using unity_runtime::bepinexCacheDir;
using unity_runtime::downloadFile;
using unity_runtime::resolveCachedArtifact;
using unity_runtime::resolveRuntimeFonts;

std::string buildConfigIni(const UnityInstallRequest& req, const CjkFontSettings& fonts);

bool runToolProcess(const fs::path& exe, const std::wstring& args, std::string& error)
{
    DWORD code = 1;
    if (!runInstallerProcess(L"\"" + exe.wstring() + L"\" " + args, nullptr, CREATE_NO_WINDOW, 600000, code, error))
        return false;
    if (code != 0)
    {
        error = pathUtf8(exe.filename()) + " 退出码 " + std::to_string(code);
        return false;
    }
    return true;
}

std::string readFileUtf8(const fs::path& path)
{
    std::ifstream in(path, std::ios::binary);
    if (!in)
        return {};
    return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

bool writeFileUtf8(const fs::path& path, const std::string& content)
{
    fs::create_directories(path.parent_path());
    std::ofstream out(path, std::ios::binary);
    if (!out)
        return false;
    out << content;
    return static_cast<bool>(out);
}

std::string readIniValue(const std::string& content, const std::string& key)
{
    const std::string prefix = key + "=";
    size_t pos = 0;
    while (pos < content.size())
    {
        const size_t lineStart = pos;
        size_t lineEnd = content.find('\n', pos);
        if (lineEnd == std::string::npos)
            lineEnd = content.size();
        std::string row = content.substr(lineStart, lineEnd - lineStart);
        if (!row.empty() && row.back() == '\r')
            row.pop_back();
        if (row.rfind(prefix, 0) == 0)
            return trimCopy(row.substr(prefix.size()));
        pos = lineEnd == content.size() ? lineEnd : lineEnd + 1;
    }
    return {};
}

std::vector<fs::path> autoTranslatorConfigPaths(const fs::path& gameDir, const std::string& method)
{
    std::vector<fs::path> paths;
    if (method.rfind("BepInEx", 0) == 0)
    {
        paths.push_back(gameDir / "BepInEx" / "config" / "AutoTranslatorConfig.ini");
        paths.push_back(gameDir / "AutoTranslator" / "Config.ini");
    }
    else
    {
        paths.push_back(gameDir / "AutoTranslator" / "Config.ini");
        paths.push_back(gameDir / "BepInEx" / "config" / "AutoTranslatorConfig.ini");
    }
    return paths;
}

bool applyOverrideFontToGameConfigs(
    const fs::path& gameDir,
    const std::string& method,
    const CjkFontSettings& fonts,
    const UnityInstallRequest& fallbackReq,
    std::string& configPathOut)
{
    if (fonts.uguiFont.empty() && fonts.tmpFont.empty())
        return false;

    const auto paths = autoTranslatorConfigPaths(gameDir, method);
    bool wrote = false;
    for (const auto& p : paths)
    {
        std::error_code ec;
        std::string content;
        if (fs::exists(p, ec) && fs::is_regular_file(p, ec))
            content = readFileUtf8(p);
        if (content.empty())
        {
            // Only create the primary config path for the install method
            if (method.rfind("BepInEx", 0) == 0)
            {
                if (p.filename() != "AutoTranslatorConfig.ini")
                    continue;
            }
            else if (pathUtf8(p.filename()) != "Config.ini")
            {
                continue;
            }
            content = buildConfigIni(fallbackReq, fonts);
        }
        else
        {
            content = unity_runtime::applyFontOverrides(content, fonts);
        }
        if (!writeFileUtf8(p, content))
            continue;
        if (!wrote)
            configPathOut = pathUtf8(p);
        wrote = true;
    }
    return wrote;
}

/** Inspect configs for TMP/UGUI font; returns warn detail if missing/broken. */
std::string checkOverrideFontStatus(const fs::path& gameDir, const std::string& method)
{
    const auto paths = autoTranslatorConfigPaths(gameDir, method);
    std::string ugui;
    std::string tmpFont;
    for (const auto& p : paths)
    {
        std::error_code ec;
        if (!fs::exists(p, ec))
            continue;
        const std::string content = readFileUtf8(p);
        if (ugui.empty())
            ugui = readIniValue(content, "OverrideFont");
        if (tmpFont.empty())
            tmpFont = readIniValue(content, "OverrideFontTextMeshPro");
        if (tmpFont.empty())
            tmpFont = readIniValue(content, "FallbackFontTextMeshPro");
        if (!ugui.empty() && !tmpFont.empty())
            break;
    }
    return unity_runtime::checkRuntimeFontStatus(gameDir, {ugui, tmpFont});
}

#endif

#ifdef _WIN32
bool looksLikeZip(const fs::path& zipPath, std::string& error)
{
    std::error_code ec;
    if (!fs::is_regular_file(zipPath, ec))
    {
        error = "安装包不存在: " + pathUtf8(zipPath);
        return false;
    }
    const auto sz = fs::file_size(zipPath, ec);
    if (ec || sz < 64)
    {
        error = "安装包过小或损坏（" + std::to_string(static_cast<unsigned long long>(sz))
            + " 字节），请检查网络后重试";
        return false;
    }
    std::ifstream in(zipPath, std::ios::binary);
    char mag[2]{};
    in.read(mag, 2);
    if (!in || mag[0] != 'P' || mag[1] != 'K')
    {
        error = "安装包不是有效的 ZIP（可能下载失败或被截断）";
        return false;
    }
    return true;
}

bool runHiddenProcess(std::wstring cmdLine, DWORD timeoutMs, DWORD& outCode, std::string& error)
{
    return runInstallerProcess(std::move(cmdLine), nullptr, CREATE_NO_WINDOW, timeoutMs, outCode, error)
        && outCode == 0;
}

bool copyExtractedContents(const fs::path& from, const fs::path& to, std::string& error)
{
    std::error_code ec;
    fs::create_directories(to, ec);
    if (ec)
    {
        error = "无法创建目标目录: " + pathUtf8(to) + "（" + ec.message() + "）";
        return false;
    }
    std::size_t copied = 0;
    for (const auto& entry : fs::directory_iterator(from, ec))
    {
        if (ec)
            break;
        if (installCancelled()) { error = "复制已取消，已写入的文件可能保留"; return false; }
        const fs::path dest = to / entry.path().filename();
        std::error_code copyEc;
        fs::copy(
            entry.path(),
            dest,
            fs::copy_options::recursive | fs::copy_options::overwrite_existing,
            copyEc);
        if (copyEc)
        {
            error = "复制到游戏目录失败: " + pathUtf8(dest) + "（" + copyEc.message()
                + "）。若目录在网盘同步盘，请暂停同步或移到本地磁盘后重试";
            return false;
        }
        ++copied;
    }
    if (copied == 0)
    {
        error = "解压结果为空";
        return false;
    }
    return true;
}

std::size_t countFilesRecursive(const fs::path& dir)
{
    std::size_t n = 0;
    std::error_code ec;
    for (const auto& entry : fs::recursive_directory_iterator(dir, ec))
    {
        if (ec)
            break;
        if (entry.is_regular_file(ec))
            ++n;
    }
    return n;
}

bool extractZip(const fs::path& zipPath, const fs::path& destDir, std::string& error)
{
    installStage("正在解压安装包");
    if (!looksLikeZip(zipPath, error))
        return false;

    // Extract to a short ASCII temp path first. Windows tar often fails on
    // sync folders (BaiduNetdisk) or non-ASCII game paths; copy afterward.
    storage::TemporaryDirectory staging("xunity-extract");
    const fs::path& stagingRoot = staging.path;
    std::error_code ec;

    const fs::path tarExe = fs::path(L"C:\\Windows\\System32\\tar.exe");
    const bool hasTar = fs::is_regular_file(tarExe, ec);
    DWORD tarCode = 1;
    DWORD psCode = 1;
    std::string tarErr;
    std::string psErr;
    bool extracted = false;

    if (hasTar)
    {
        std::wstring cmd = L"\"" + tarExe.wstring() + L"\" -xf \"" + zipPath.wstring()
            + L"\" -C \"" + stagingRoot.wstring() + L"\"";
        if (runHiddenProcess(std::move(cmd), 180000, tarCode, tarErr)
            && countFilesRecursive(stagingRoot) > 0)
        {
            extracted = true;
        }
        else if (tarErr.empty())
        {
            tarErr = "退出码 " + std::to_string(tarCode);
        }
    }
    else
    {
        tarErr = "未找到 C:\\Windows\\System32\\tar.exe";
    }

    if (!extracted)
    {
        // Fallback: PowerShell Expand-Archive (handles more zip edge cases)
        auto psLiteral = [](const fs::path& p) {
            std::wstring s = p.wstring();
            std::wstring out;
            out.reserve(s.size() + 8);
            for (wchar_t c : s)
            {
                if (c == L'\'')
                    out += L"''";
                else
                    out += c;
            }
            return out;
        };
        std::wstring cmd =
            L"powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
            L"\"Expand-Archive -LiteralPath '"
            + psLiteral(zipPath) + L"' -DestinationPath '" + psLiteral(stagingRoot)
            + L"' -Force\"";
        if (!runHiddenProcess(std::move(cmd), 180000, psCode, psErr)
            || countFilesRecursive(stagingRoot) == 0)
        {
            if (psErr.empty())
                psErr = "退出码 " + std::to_string(psCode);
            error = "解压安装包失败（tar: " + tarErr + "；PowerShell: " + psErr + "）";
            return false;
        }
    }

    installStage("正在复制文件到游戏目录");
    if (!copyExtractedContents(stagingRoot, destDir, error))
        return false;
    return true;
}

bool unpackTranslatorPackage(const std::string& method, const fs::path& gameDir, UnityInstallResult& result)
{
    result.package = packageFileName(method);
    storage::TemporaryDirectory temporary("xunity");
    const auto zip = temporary.path / pathFromUtf8(result.package);
    const auto url = std::string(kGithubReleaseBase) + kReleaseTag + "/" + result.package;
    result.steps.push_back("下载 " + result.package);
    if (!downloadFile(url, zip, installControl, result.error)) return false;

    result.steps.push_back("解压到游戏目录");
    return extractZip(zip, gameDir, result.error);
}

bool runProcess(const fs::path& exe, const fs::path& workDir, std::string& error)
{
    const std::wstring dir = workDir.wstring();
    DWORD code = 1;
    if (!runInstallerProcess(L"\"" + exe.wstring() + L"\"", dir.c_str(), 0, 180000, code, error))
        throw std::runtime_error(error);
    if (code != 0)
    {
        if (code == 0xE0434352u)
        {
            error =
                "安装程序异常退出（.NET 0xE0434352，常见于创建桌面快捷方式失败）；"
                "若游戏目录已有 ReiPatcher，多数情况下插件仍可用";
        }
        else
        {
            error = "安装程序退出码 " + std::to_string(code);
        }
        return false;
    }
    return true;
}
#endif

std::string defaultAutoTranslatorIniTemplate()
{
    // Official XUnity.AutoTranslator default keys (comments omitted for storage).
    return
        "[Service]\n"
        "Endpoint=GoogleTranslate\n"
        "FallbackEndpoint=\n"
        "\n"
        "[General]\n"
        "Language=zh-CN\n"
        "FromLanguage=ja\n"
        "\n"
        "[Files]\n"
        "Directory=Translation\\{Lang}\\Text\n"
        "OutputFile=Translation\\{Lang}\\Text\\_AutoGeneratedTranslations.txt\n"
        "SubstitutionFile=Translation\\{Lang}\\Text\\_Substitutions.txt\n"
        "PreprocessorsFile=Translation\\{Lang}\\Text\\_Preprocessors.txt\n"
        "PostprocessorsFile=Translation\\{Lang}\\Text\\_Postprocessors.txt\n"
        "\n"
        "[TextFrameworks]\n"
        "EnableUGUI=True\n"
        "EnableNGUI=True\n"
        "EnableTextMeshPro=True\n"
        "EnableTextMesh=False\n"
        "EnableIMGUI=False\n"
        "EnableFairyGUI=True\n"
        "EnableUIElements=True\n"
        "\n"
        "[Behaviour]\n"
        "MaxCharactersPerTranslation=200\n"
        "IgnoreWhitespaceInDialogue=True\n"
        "IgnoreWhitespaceInNGUI=True\n"
        "MinDialogueChars=20\n"
        "ForceSplitTextAfterCharacters=0\n"
        "CopyToClipboard=False\n"
        "MaxClipboardCopyCharacters=450\n"
        "ClipboardDebounceTime=1.25\n"
        "EnableUIResizing=True\n"
        "EnableBatching=True\n"
        "UseStaticTranslations=True\n"
        "OverrideFont=\n"
        "OverrideFontSize=\n"
        "OverrideFontTextMeshPro=\n"
        "FallbackFontTextMeshPro=\n"
        "ResizeUILineSpacingScale=\n"
        "ForceUIResizing=True\n"
        "IgnoreTextStartingWith=\\u180e;\n"
        "TextGetterCompatibilityMode=False\n"
        "GameLogTextPaths=\n"
        "RomajiPostProcessing=ReplaceMacronWithCircumflex;RemoveApostrophes;ReplaceHtmlEntities\n"
        "TranslationPostProcessing=ReplaceMacronWithCircumflex;ReplaceHtmlEntities\n"
        "RegexPostProcessing=None\n"
        "CacheRegexLookups=False\n"
        "CacheWhitespaceDifferences=False\n"
        "CacheRegexPatternResults=False\n"
        "CacheParsedTranslations=False\n"
        "GenerateStaticSubstitutionTranslations=False\n"
        "GeneratePartialTranslations=False\n"
        "EnableTranslationScoping=True\n"
        "EnableSilentMode=True\n"
        "BlacklistedIMGUIPlugins=\n"
        "OutputUntranslatableText=False\n"
        "IgnoreVirtualTextSetterCallingRules=False\n"
        "MaxTextParserRecursion=1\n"
        "HtmlEntityPreprocessing=True\n"
        "HandleRichText=True\n"
        "PersistRichTextMode=Final\n"
        "EnableTranslationHelper=False\n"
        "ForceMonoModHooks=False\n"
        "InitializeHarmonyDetourBridge=False\n"
        "RedirectedResourceDetectionStrategy=AppendMongolianVowelSeparatorAndRemoveAll\n"
        "OutputTooLongText=False\n"
        "ReloadTranslationsOnFileChange=False\n"
        "EnableTextPathLogging=False\n"
        "TemplateAllNumberAway=False\n"
        "\n"
        "[Texture]\n"
        "TextureDirectory=Translation\\{Lang}\\Texture\n"
        "EnableTextureTranslation=False\n"
        "EnableTextureDumping=False\n"
        "EnableTextureToggling=False\n"
        "EnableTextureScanOnSceneLoad=False\n"
        "EnableSpriteRendererHooking=False\n"
        "LoadUnmodifiedTextures=False\n"
        "TextureHashGenerationStrategy=FromImageName\n"
        "DuplicateTextureNames=\n"
        "DetectDuplicateTextureNames=False\n"
        "EnableLegacyTextureLoading=False\n"
        "CacheTexturesInMemory=True\n"
        "\n"
        "[ResourceRedirector]\n"
        "PreferredStoragePath=Translation\\{Lang}\\RedirectedResources\n"
        "EnableTextAssetRedirector=False\n"
        "LogAllLoadedResources=False\n"
        "EnableDumping=False\n"
        "CacheMetadataForAllFiles=True\n"
        "\n"
        "[Http]\n"
        "UserAgent=\n"
        "DisableCertificateValidation=False\n"
        "\n"
        "[TranslationAggregator]\n"
        "Width=400\n"
        "Height=100\n"
        "EnabledTranslators=\n"
        "\n"
        "[Google]\n"
        "ServiceUrl=\n"
        "\n"
        "[GoogleLegitimate]\n"
        "GoogleAPIKey=\n"
        "\n"
        "[BingLegitimate]\n"
        "OcpApimSubscriptionKey=\n"
        "\n"
        "[Baidu]\n"
        "BaiduAppId=\n"
        "BaiduAppSecret=\n"
        "\n"
        "[Yandex]\n"
        "YandexAPIKey=\n"
        "\n"
        "[Watson]\n"
        "Url=\n"
        "Key=\n"
        "\n"
        "[DeepL]\n"
        "MinDelay=2\n"
        "MaxDelay=7\n"
        "\n"
        "[DeepLLegitimate]\n"
        "ApiKey=\n"
        "Free=False\n"
        "\n"
        "[Custom]\n"
        "Url=\n"
        "\n"
        "[LecPowerTranslator15]\n"
        "InstallationPath=\n"
        "\n"
        "[LingoCloud]\n"
        "LingoCloudToken=\n"
        "\n"
        "[Debug]\n"
        "EnableConsole=False\n"
        "EnableLog=False\n"
        "\n"
        "[Migrations]\n"
        "Enable=True\n"
        "Tag=5.6.1\n";
}

std::vector<UnityIniSection> parseIniSections(const std::string& content)
{
    std::vector<UnityIniSection> sections;
    UnityIniSection* cur = nullptr;
    size_t pos = 0;
    while (pos < content.size())
    {
        size_t lineEnd = content.find('\n', pos);
        if (lineEnd == std::string::npos)
            lineEnd = content.size();
        std::string row = content.substr(pos, lineEnd - pos);
        if (!row.empty() && row.back() == '\r')
            row.pop_back();
        pos = lineEnd == content.size() ? lineEnd : lineEnd + 1;

        std::string comment;
        const size_t semi = row.find(';');
        if (semi != std::string::npos)
        {
            comment = trimCopy(row.substr(semi + 1));
            row = trimCopy(row.substr(0, semi));
        }
        else
        {
            row = trimCopy(row);
        }
        if (row.empty())
            continue;
        if (row.front() == '[' && row.back() == ']' && row.size() >= 2)
        {
            sections.push_back({});
            cur = &sections.back();
            cur->name = row.substr(1, row.size() - 2);
            continue;
        }
        if (!cur)
            continue;
        const size_t eq = row.find('=');
        if (eq == std::string::npos)
            continue;
        UnityIniKey k;
        k.key = trimCopy(row.substr(0, eq));
        k.value = trimCopy(row.substr(eq + 1));
        k.comment = comment;
        cur->keys.push_back(std::move(k));
    }
    return sections;
}

std::string serializeIniSections(const std::vector<UnityIniSection>& sections)
{
    std::ostringstream oss;
    for (size_t si = 0; si < sections.size(); ++si)
    {
        const auto& sec = sections[si];
        if (si)
            oss << "\n";
        oss << "[" << sec.name << "]\n";
        for (const auto& k : sec.keys)
        {
            oss << k.key << "=" << k.value;
            if (!k.comment.empty())
                oss << " ;" << k.comment;
            oss << "\n";
        }
    }
    return oss.str();
}

void setIniKey(
    std::vector<UnityIniSection>& sections,
    const std::string& section,
    const std::string& key,
    const std::string& value)
{
    for (auto& sec : sections)
    {
        if (!iequals(sec.name, section))
            continue;
        for (auto& k : sec.keys)
        {
            if (iequals(k.key, key))
            {
                k.value = value;
                return;
            }
        }
        sec.keys.push_back({key, value, ""});
        return;
    }
    sections.push_back({section, {{key, value, ""}}});
}

std::vector<UnityIniSection> mergeIniOverDefaults(
    const std::vector<UnityIniSection>& defaults,
    const std::vector<UnityIniSection>& fileSecs)
{
    std::vector<UnityIniSection> out = defaults;
    for (const auto& fsec : fileSecs)
    {
        UnityIniSection* target = nullptr;
        for (auto& sec : out)
        {
            if (iequals(sec.name, fsec.name))
            {
                target = &sec;
                break;
            }
        }
        if (!target)
        {
            out.push_back(fsec);
            continue;
        }
        for (const auto& fk : fsec.keys)
        {
            bool found = false;
            for (auto& tk : target->keys)
            {
                if (iequals(tk.key, fk.key))
                {
                    tk.value = fk.value;
                    if (!fk.comment.empty())
                        tk.comment = fk.comment;
                    found = true;
                    break;
                }
            }
            if (!found)
                target->keys.push_back(fk);
        }
    }
    return out;
}

std::string buildConfigIni(const UnityInstallRequest& req, const CjkFontSettings& fonts)
{
    if (!req.configIni.empty())
    {
        auto sections = parseIniSections(req.configIni);
        if (!fonts.uguiFont.empty())
            setIniKey(sections, "Behaviour", "OverrideFont", fonts.uguiFont);
        if (!fonts.tmpFont.empty())
        {
            setIniKey(sections, "Behaviour", "OverrideFontTextMeshPro", fonts.tmpFont);
            setIniKey(sections, "Behaviour", "FallbackFontTextMeshPro", fonts.tmpFont);
        }
        setIniKey(
            sections,
            "Behaviour",
            "RedirectedResourceDetectionStrategy",
            "AppendMongolianVowelSeparatorAndRemoveAll");
        return serializeIniSections(sections);
    }

    auto sections = parseIniSections(defaultAutoTranslatorIniTemplate());
    setIniKey(sections, "Service", "Endpoint", req.endpoint);
    setIniKey(sections, "Service", "FallbackEndpoint", req.fallbackEndpoint);
    setIniKey(sections, "General", "Language", req.language);
    setIniKey(sections, "General", "FromLanguage", req.fromLanguage);
    if (!fonts.uguiFont.empty())
        setIniKey(sections, "Behaviour", "OverrideFont", fonts.uguiFont);
    if (!fonts.tmpFont.empty())
    {
        setIniKey(sections, "Behaviour", "OverrideFontTextMeshPro", fonts.tmpFont);
        setIniKey(sections, "Behaviour", "FallbackFontTextMeshPro", fonts.tmpFont);
    }
    return serializeIniSections(sections);
}

fs::path writeConfig(
    const fs::path& gameDir,
    const std::string& method,
    const UnityInstallRequest& req,
    const CjkFontSettings& fonts)
{
    const std::string content = buildConfigIni(req, fonts);
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

bool createShellShortcut(
    const fs::path& lnkPath,
    const fs::path& targetExe,
    const std::wstring& args,
    const fs::path& workDir,
    std::string& error)
{
    HRESULT hrInit = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    const bool needUninit = SUCCEEDED(hrInit) || hrInit == S_FALSE;

    IShellLinkW* psl = nullptr;
    HRESULT hr = CoCreateInstance(
        CLSID_ShellLink,
        nullptr,
        CLSCTX_INPROC_SERVER,
        IID_IShellLinkW,
        reinterpret_cast<void**>(&psl));
    if (FAILED(hr) || !psl)
    {
        error = "无法创建快捷方式（ShellLink）";
        if (needUninit)
            CoUninitialize();
        return false;
    }

    psl->SetPath(targetExe.wstring().c_str());
    if (!args.empty())
        psl->SetArguments(args.c_str());
    psl->SetWorkingDirectory(workDir.wstring().c_str());

    IPersistFile* ppf = nullptr;
    hr = psl->QueryInterface(IID_IPersistFile, reinterpret_cast<void**>(&ppf));
    bool ok = false;
    if (SUCCEEDED(hr) && ppf)
    {
        hr = ppf->Save(lnkPath.wstring().c_str(), TRUE);
        ok = SUCCEEDED(hr);
        ppf->Release();
        if (!ok)
            error = "保存快捷方式失败";
    }
    else
    {
        error = "无法写入快捷方式";
    }
    psl->Release();
    if (needUninit)
        CoUninitialize();
    return ok;
}

/** Setup often crashes on shortcut creation after ReiPatcher files are already ready. */
bool ensurePatchAndRunShortcut(
    const fs::path& gameDir,
    const std::string& gameExe,
    std::vector<std::string>& steps)
{
    std::error_code ec;
    if (!findPatchAndRunShortcut(gameDir, gameExe).empty())
        return true;

    const fs::path reiExe = gameDir / "ReiPatcher" / "ReiPatcher.exe";
    const fs::path ini = findReiPatcherIni(gameDir, gameExe);
    if (!fs::is_regular_file(reiExe, ec) || ini.empty())
        return false;

    std::string stem = "Game";
    if (!gameExe.empty())
        stem = pathUtf8(pathFromUtf8(gameExe).stem());
    else
        stem = pathUtf8(ini.stem());

    const fs::path lnk = gameDir / pathFromUtf8(stem + " (Patch and Run).lnk");
    std::string err;
    const std::wstring args = L"\"" + ini.filename().wstring() + L"\"";
    if (!createShellShortcut(lnk, reiExe, args, gameDir / "ReiPatcher", err))
    {
        steps.push_back("未能自动创建「与插件一同启动」快捷方式：" + err);
        return false;
    }
    steps.push_back("已自动创建「" + stem + " (Patch and Run).lnk」");
    return true;
}
#endif

} // namespace

UnityDetectInfo UnityAutoTranslator::detect(const std::string& gamePath, bool recursive)
{
    return unity_runtime::detect(gamePath, recursive);
}

void UnityAutoTranslator::detectStream(
    const std::string& gamePath,
    const std::function<void(const std::string&)>& emitLine,
    const std::function<bool()>& shouldStop)
{
    unity_runtime::detectStream(gamePath, emitLine, shouldStop);
}

#ifdef _WIN32
namespace
{
using Microsoft::WRL::ComPtr;

class GamePathDialogEvents final : public Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>, IFileDialogEvents, IFileDialogControlEvents>
{
public:
    static constexpr DWORD chooseFolder = 1001;
    ComPtr<IShellItem> selectedFolder;

    HRESULT STDMETHODCALLTYPE OnFolderChange(IFileDialog* dialog) override
    {
        ComPtr<IFileDialogCustomize> controls;
        const HRESULT hr = dialog->QueryInterface(IID_PPV_ARGS(controls.GetAddressOf()));
        if (FAILED(hr)) return hr;
        return controls->SetControlState(chooseFolder, currentFolder(dialog) ? CDCS_ENABLEDVISIBLE : CDCS_VISIBLE);
    }

    HRESULT STDMETHODCALLTYPE OnButtonClicked(IFileDialogCustomize* controls, DWORD control) override
    {
        if (control != chooseFolder) return S_OK;
        ComPtr<IFileDialog> dialog;
        const HRESULT hr = controls->QueryInterface(IID_PPV_ARGS(dialog.GetAddressOf()));
        if (FAILED(hr)) return hr;
        selectedFolder = currentFolder(dialog.Get());
        if (!selectedFolder) return S_OK;
        const HRESULT closed = dialog->Close(S_OK);
        if (FAILED(closed)) selectedFolder.Reset();
        return closed;
    }

    HRESULT STDMETHODCALLTYPE OnFileOk(IFileDialog*) override { return S_OK; }
    HRESULT STDMETHODCALLTYPE OnFolderChanging(IFileDialog*, IShellItem*) override { return S_OK; }
    HRESULT STDMETHODCALLTYPE OnSelectionChange(IFileDialog*) override { return S_OK; }
    HRESULT STDMETHODCALLTYPE OnTypeChange(IFileDialog*) override { return S_OK; }
    HRESULT STDMETHODCALLTYPE OnShareViolation(IFileDialog*, IShellItem*, FDE_SHAREVIOLATION_RESPONSE* response) override
    {
        *response = FDESVR_DEFAULT;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE OnOverwrite(IFileDialog*, IShellItem*, FDE_OVERWRITE_RESPONSE* response) override
    {
        *response = FDEOR_DEFAULT;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE OnItemSelected(IFileDialogCustomize*, DWORD, DWORD) override { return S_OK; }
    HRESULT STDMETHODCALLTYPE OnCheckButtonToggled(IFileDialogCustomize*, DWORD, BOOL) override { return S_OK; }
    HRESULT STDMETHODCALLTYPE OnControlActivating(IFileDialogCustomize*, DWORD) override { return S_OK; }

private:
    static ComPtr<IShellItem> currentFolder(IFileDialog* dialog)
    {
        ComPtr<IShellItem> folder;
        if (FAILED(dialog->GetFolder(folder.GetAddressOf()))) return {};
        constexpr SFGAOF wanted = SFGAO_FOLDER | SFGAO_FILESYSTEM;
        SFGAOF attributes = 0;
        if (FAILED(folder->GetAttributes(wanted, &attributes)) || (attributes & wanted) != wanted) return {};
        return folder;
    }
};

void checkGamePathDialog(HRESULT result)
{
    if (FAILED(result)) throw std::runtime_error("无法打开 Windows 游戏位置选择窗口");
}
}
#endif

std::string UnityAutoTranslator::pickPath(const std::string& defaultPath)
{
#ifndef _WIN32
    (void)defaultPath;
    return {};
#else
    checkGamePathDialog(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED));
    struct Apartment { ~Apartment() { CoUninitialize(); } } apartment;

    ComPtr<IFileOpenDialog> dialog;
    checkGamePathDialog(CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(dialog.GetAddressOf())));
    FILEOPENDIALOGOPTIONS options{};
    checkGamePathDialog(dialog->GetOptions(&options));
    checkGamePathDialog(dialog->SetOptions(options | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR));
    checkGamePathDialog(dialog->SetTitle(L"选择游戏目录或主程序（.exe）"));
    checkGamePathDialog(dialog->SetOkButtonLabel(L"选择程序"));
    const COMDLG_FILTERSPEC fileTypes[] = {{L"游戏程序 (*.exe)", L"*.exe"}};
    checkGamePathDialog(dialog->SetFileTypes(1, fileTypes));

    auto folder = pathFromUtf8(defaultPath);
    std::error_code error;
    while (!folder.empty() && !fs::is_directory(folder, error))
    {
        const auto parent = folder.parent_path();
        if (parent == folder) { folder.clear(); break; }
        folder = parent;
    }
    ComPtr<IShellItem> start;
    if (!folder.empty() && SUCCEEDED(SHCreateItemFromParsingName(folder.c_str(), nullptr, IID_PPV_ARGS(start.GetAddressOf()))))
        dialog->SetFolder(start.Get());

    ComPtr<IFileDialogCustomize> controls;
    checkGamePathDialog(dialog.As(&controls));
    checkGamePathDialog(controls->AddPushButton(GamePathDialogEvents::chooseFolder, L"选择当前文件夹"));
    checkGamePathDialog(controls->MakeProminent(GamePathDialogEvents::chooseFolder));
    const auto events = Microsoft::WRL::Make<GamePathDialogEvents>();
    if (!events) throw std::bad_alloc();
    DWORD cookie = 0;
    checkGamePathDialog(dialog->Advise(events.Get(), &cookie));
    const HRESULT shown = dialog->Show(GetForegroundWindow());
    dialog->Unadvise(cookie);
    if (shown == HRESULT_FROM_WIN32(ERROR_CANCELLED)) return {};
    checkGamePathDialog(shown);

    ComPtr<IShellItem> item = events->selectedFolder;
    if (!item) checkGamePathDialog(dialog->GetResult(item.GetAddressOf()));
    PWSTR path = nullptr;
    checkGamePathDialog(item->GetDisplayName(SIGDN_FILESYSPATH, &path));
    const auto result = toUtf8(path);
    CoTaskMemFree(path);
    return result;
#endif
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
        std::string targetDir;
        UnityGameItem item;
        if (!resolveDetectedGame(detected, targetDir, item, result.error))
            return result;

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
        std::string targetDir;
        UnityGameItem item;
        if (!resolveDetectedGame(detected, targetDir, item, result.error))
            return result;

        result.gameDir = targetDir;
        result.gameExe = item.gameExe;

        if (!item.hasAutoTranslator)
        {
            result.error = "请先安装翻译插件后再与插件一同启动游戏";
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
            "未找到与插件一同启动所需的快捷方式或 ReiPatcher。"
            "请重新安装翻译插件，或手动运行游戏目录中的「(Patch and Run).lnk」";
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
        std::string targetDir;
        UnityGameItem item;
        if (!resolveDetectedGame(detected, targetDir, item, result.error))
            return result;

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

        const bool pathHasChinese = pathContainsChinese(targetDir);
        if (pathHasChinese)
        {
            addCheck(
                "path_chinese",
                "warn",
                "路径是否含中文",
                "游戏目录路径包含中文（或 CJK）字符。BepInEx / Doorstop / ReiPatcher "
                "在含中文的路径下常见闪退、无法注入或打不开；建议把游戏移到纯英文路径"
                "（例如 D:\\Games\\GameName）。当前路径：" + targetDir);
        }
        else
        {
            addCheck("path_chinese", "ok", "路径是否含中文", "路径未发现中文字符");
        }

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

#ifdef _WIN32
        if (item.hasAutoTranslator)
        {
            const std::string fontIssue = checkOverrideFontStatus(gameDir, item.installMethod);
            if (fontIssue.empty())
            {
                addCheck("font", "ok", "中文字体覆盖", "已配置 UGUI/TMP 字体，可降低译文缺字（口）风险");
            }
            else
            {
                addCheck("font", "warn", "中文字体覆盖", fontIssue);
            }
        }
#endif

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
            if (pathHasChinese)
            {
                result.suggestions.push_back(
                    "另外：当前路径含中文，纠正位数前建议先把游戏移到纯英文路径");
            }
        }
        else if (missingLoader)
        {
            result.verdict = "missing_loader";
            result.verdictLabel = "缺少加载器";
            result.summary = "IL2CPP 游戏需要先安装 BepInEx 6 加载器，再安装翻译插件。";
            result.suggestions.push_back("点击「安装加载器」安装与游戏位数匹配的 BepInEx");
            result.suggestions.push_back("启动一次游戏完成 BepInEx 初始化");
            result.suggestions.push_back("再安装翻译插件");
            if (pathHasChinese)
            {
                result.suggestions.push_back(
                    "另外：当前路径含中文，安装前建议先把游戏移到纯英文路径再操作");
            }
        }
        else if (pathHasChinese)
        {
            result.verdict = "path_has_chinese";
            result.verdictLabel = "优先怀疑：路径含中文";
            result.summary =
                "游戏目录路径包含中文字符。Doorstop / BepInEx / ReiPatcher 在含中文路径下"
                "经常无法正常注入或导致游戏打不开。";
            result.suggestions.push_back(
                "将整个游戏文件夹移动到仅含英文与数字的路径，例如 D:\\Games\\GameName");
            result.suggestions.push_back("移动后回到本页重新选择路径并检测，再安装加载器/插件");
            result.suggestions.push_back("避免放在桌面中文用户名下的深层中文文件夹里");
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
#ifdef _WIN32
                const std::string fontIssue = checkOverrideFontStatus(gameDir, item.installMethod);
                if (!fontIssue.empty())
                {
                    result.suggestions.push_back(
                        "译文若显示为「口」，请点击「修复缺字字体」自动配置中文字体后重启游戏");
                }
#endif
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

UnityInstallResult UnityAutoTranslator::install(const UnityInstallRequest& req, const UnityInstallControl& control)
{
    UnityInstallResult result;
#ifndef _WIN32
    result.error = "仅支持 Windows";
    return result;
#else
    try
    {
        const InstallControlScope scope(control);
        installStage("正在检测游戏");
        const auto detected = detect(req.gamePath, false);
        result.steps.push_back("检测游戏目录");
        std::string targetDir;
        UnityGameItem item;
        if (!resolveDetectedGame(detected, targetDir, item, result.error))
            return result;

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
            result.error =
                "检测到 IL2CPP 游戏，请先安装插件框架（BepInEx），再安装翻译插件。";
            result.steps.push_back("IL2CPP 缺少 BepInEx，已中止");
            return result;
        }
        if (!item.isIl2Cpp && !detectReiPatcher(pathFromUtf8(targetDir)))
        {
            result.error =
                "检测到 Mono 游戏，请先安装插件框架（ReiPatcher），再安装翻译插件。";
            result.steps.push_back("Mono 缺少 ReiPatcher，已中止");
            return result;
        }

        const fs::path gameDirPath = pathFromUtf8(targetDir);
        if (!unpackTranslatorPackage(item.installMethod, gameDirPath, result))
            return result;

        if (item.installMethod == "ReiPatcher" && req.runSetup)
        {
            const fs::path setup = gameDirPath / "SetupReiPatcherAndAutoTranslator.exe";
            std::error_code ec;
            if (fs::exists(setup, ec))
            {
                result.steps.push_back("运行 SetupReiPatcherAndAutoTranslator.exe");
                std::string setupErr;
                installStage("正在运行 ReiPatcher 安装程序");
                const bool setupOk = runProcess(setup, gameDirPath, setupErr);
                if (!setupOk)
                {
                    // Setup frequently crashes (.NET 0xE0434352) while creating shortcuts
                    // after ReiPatcher files are already in place — treat as soft success.
                    if (detectAutoTranslator(gameDirPath))
                    {
                        result.steps.push_back(
                            "Setup 退出异常（" + setupErr
                            + "），但已检测到 ReiPatcher/插件文件，继续完成配置");
                        ensurePatchAndRunShortcut(gameDirPath, item.gameExe, result.steps);
                    }
                    else
                    {
                        result.error = setupErr + "（文件已解压，可手动运行 Setup）";
                    }
                }
                else
                {
                    ensurePatchAndRunShortcut(gameDirPath, item.gameExe, result.steps);
                }
            }
            else
            {
                result.steps.push_back("未找到 Setup 程序，已跳过自动补丁");
            }
        }

        if (result.error.empty() && item.installMethod == "ReiPatcher")
            ensurePatchAndRunShortcut(gameDirPath, item.gameExe, result.steps);

        result.steps.push_back("写入 AutoTranslator 配置");
        UnityInstallRequest cfg = req;
        if (cfg.language.empty())
            cfg.language = "zh-CN";
        if (cfg.fromLanguage.empty())
            cfg.fromLanguage = "ja";
        if (cfg.endpoint.empty())
            cfg.endpoint = "GoogleTranslate";

        std::string fontWarning;
        installStage("正在准备字体");
        const auto fonts = resolveRuntimeFonts(
            gameDirPath, cfg.language, installControl, result.steps, fontWarning, {extractZip, runToolProcess});
        installStage("正在保存翻译插件配置");

        const fs::path configPath = writeConfig(gameDirPath, item.installMethod, cfg, fonts);
        result.configPath = pathUtf8(configPath);

        result.ok = result.error.empty();
        if (result.ok)
        {
            if (!fontWarning.empty())
                result.steps.push_back("警告: " + fontWarning);
            result.steps.push_back("完成。请启动游戏；游戏内 Alt+0 可打开翻译面板");
        }
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

UnityInstallResult UnityAutoTranslator::fixFont(const UnityFixFontRequest& req)
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
        std::string targetDir;
        UnityGameItem item;
        if (!resolveDetectedGame(detected, targetDir, item, result.error))
            return result;
        if (!item.isUnity)
        {
            result.error = "不是有效的 Unity 游戏";
            return result;
        }

        result.gameDir = targetDir;
        result.installMethod = item.installMethod;
        result.version = kReleaseVersion;

        if (!item.hasAutoTranslator && !detectAutoTranslator(pathFromUtf8(targetDir)))
        {
            result.error = "未检测到翻译插件，请先安装翻译插件再修复字体";
            return result;
        }

        UnityInstallRequest cfg;
        cfg.gamePath = targetDir;
        cfg.language = req.language.empty() ? "zh-CN" : req.language;
        cfg.fromLanguage = "ja";
        cfg.endpoint = "GoogleTranslate";

        // Prefer language already written in config
        {
            const auto paths = autoTranslatorConfigPaths(pathFromUtf8(targetDir), item.installMethod);
            for (const auto& p : paths)
            {
                std::error_code ec;
                if (!fs::exists(p, ec))
                    continue;
                const std::string content = readFileUtf8(p);
                const std::string lang = readIniValue(content, "Language");
                if (!lang.empty())
                {
                    cfg.language = lang;
                    break;
                }
            }
        }

        std::string fontWarning;
        const auto fonts = resolveRuntimeFonts(
            pathFromUtf8(targetDir), cfg.language, installControl, result.steps, fontWarning, {extractZip, runToolProcess});

        if (fonts.uguiFont.empty() && fonts.tmpFont.empty())
        {
            result.ok = false;
            result.error = fontWarning.empty()
                ? "未能配置中文字体（目标语言可能不是中文，或下载失败）"
                : fontWarning;
            return result;
        }

        std::string configPath;
        if (!applyOverrideFontToGameConfigs(
                pathFromUtf8(targetDir), item.installMethod, fonts, cfg, configPath))
        {
            result.ok = false;
            result.error = "无法写入 AutoTranslator 字体配置";
            return result;
        }

        result.configPath = configPath;
        result.ok = true;
        if (!fonts.uguiFont.empty())
            result.steps.push_back("已写入 OverrideFont=" + fonts.uguiFont);
        if (!fonts.tmpFont.empty())
        {
            result.steps.push_back("已写入 OverrideFontTextMeshPro=" + fonts.tmpFont);
            result.steps.push_back("已写入 FallbackFontTextMeshPro=" + fonts.tmpFont);
        }
        result.steps.push_back("完成。请完全退出并重新启动游戏使字体生效");
        if (!fontWarning.empty())
            result.steps.push_back("警告: " + fontWarning);
        return result;
    }
    catch (const std::exception& ex)
    {
        result.ok = false;
        result.error = std::string("修复字体异常: ") + ex.what();
        return result;
    }
    catch (...)
    {
        result.ok = false;
        result.error = "修复字体异常：无法访问该目录";
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


        result.steps.push_back("删除翻译插件及其生成文件");

        // Restore patched Unity DLLs from ReiPatcher .bak before deleting leftovers
        restoreReiPatcherDllBackups(gameDir, result.steps, result.removed);

        auto targets = listXUnityUninstallTargets(gameDir);
        std::sort(targets.begin(), targets.end(), [](const fs::path& a, const fs::path& b) {
            return pathUtf8(a).size() > pathUtf8(b).size();
        });
        for (const auto& p : targets)
            removeUninstallTarget(gameDir, p, result);

        // Remove Fonts/ if it became empty after deleting our Noto file
        {
            std::error_code ec;
            const fs::path fontsDir = gameDir / "Fonts";
            if (fs::is_directory(fontsDir, ec) && fs::is_empty(fontsDir, ec))
                removeUninstallTarget(gameDir, fontsDir, result);
        }

        if (result.removed.empty())
        {
            if (detectAutoTranslator(gameDir))
            {
                result.error =
                    "仍检测到翻译插件残留，但未能删除（文件可能被占用或权限不足）。"
                    "请先关闭游戏后重试，或手动删除 AutoTranslator 目录以及 "
                    "*_Data/Managed 下的 XUnity*.dll";
                result.steps.push_back("卸载目标为空或删除失败，但仍有残留标记");
            }
            else
            {
                result.error = "未找到可删除的插件或缓存文件（可能已被手动移除）";
            }
            return result;
        }

        if (detectAutoTranslator(gameDir))
        {
            result.error =
                "部分文件已删除，但仍检测到翻译插件残留。请关闭游戏后再次卸载；"
                "若仍失败，请手动检查 AutoTranslator 与 *_Data/Managed 下的 XUnity 文件";
            result.steps.push_back("卸载未完全干净");
            return result;
        }

        result.ok = true;
        result.steps.push_back(
            "完成。已删除翻译插件及相关缓存；插件框架（ReiPatcher / BepInEx）仍保留。");
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

UnityInstallResult UnityAutoTranslator::installLoader(const UnityLoaderRequest& req, const UnityInstallControl& control)
{
    UnityInstallResult result;
#ifndef _WIN32
    result.error = "仅支持 Windows";
    return result;
#else
    try
    {
        const InstallControlScope scope(control);
        installStage("正在检测游戏");
        const auto detected = detect(req.gamePath, false);
        result.steps.push_back("检测游戏目录");
        std::string targetDir;
        UnityGameItem item;
        if (!resolveDetectedGame(detected, targetDir, item, result.error))
            return result;

        result.gameDir = targetDir;
        const fs::path targetPath = pathFromUtf8(targetDir);

        if (!item.isUnity)
        {
            result.error = "不是有效的 Unity 游戏";
            return result;
        }

        // —— Mono：只安装 ReiPatcher 框架（Setup 会顺带装插件，装完后剥离）——
        if (!item.isIl2Cpp)
        {
            result.installMethod = "ReiPatcher";
            result.version = kReleaseVersion;

            if (detectReiPatcher(targetPath))
            {
                result.error = "该游戏已安装 ReiPatcher 插件框架，无需重复安装";
                result.steps.push_back("已检测到 ReiPatcher");
                return result;
            }

            if (!unpackTranslatorPackage("ReiPatcher", targetPath, result))
                return result;

            const fs::path setup = targetPath / "SetupReiPatcherAndAutoTranslator.exe";
            std::error_code ec;
            if (fs::exists(setup, ec))
            {
                result.steps.push_back("运行 Setup（注入 ReiPatcher 框架）");
                std::string setupErr;
                installStage("正在运行 ReiPatcher 安装程序");
                const bool setupOk = runProcess(setup, targetPath, setupErr);
                if (!setupOk)
                {
                    if (detectReiPatcher(targetPath) || detectAutoTranslator(targetPath))
                    {
                        result.steps.push_back(
                            "Setup 退出异常（" + setupErr
                            + "），但已检测到框架文件，继续剥离翻译插件");
                    }
                    else
                    {
                        result.error = setupErr + "（文件已解压，可手动运行 Setup）";
                        return result;
                    }
                }
            }
            else
            {
                result.steps.push_back("未找到 Setup 程序，已跳过自动注入");
            }

            installStage("正在完成 ReiPatcher 框架安装");
            // Official Setup always installs AutoTranslator too — strip plugin, keep framework.
            if (detectAutoTranslator(targetPath)
                || fs::exists(targetPath / "AutoTranslator", ec)
                || fs::exists(targetPath / "SetupReiPatcherAndAutoTranslator.exe", ec))
            {
                result.steps.push_back("剥离官方 Setup 顺带安装的翻译插件，仅保留 ReiPatcher 框架");
                removePathsQuiet(
                    listAutoTranslatorPluginOnlyTargets(targetPath),
                    targetPath,
                    result.steps);
            }

            if (!detectReiPatcher(targetPath))
            {
                result.error = "安装完成但仍未检测到 ReiPatcher，请检查目录权限或手动安装";
                return result;
            }
            if (detectAutoTranslator(targetPath))
            {
                result.error =
                    "框架已装上，但未能完全移除顺带安装的翻译插件；可再点「卸载翻译插件」清理后重试";
                result.steps.push_back("仍检测到翻译插件残留");
                // Still treat as soft-ok for framework presence
                result.ok = true;
                return result;
            }

            result.ok = true;
            result.steps.push_back(
                "插件框架（ReiPatcher）安装完成。请再点击「安装翻译插件」。");
            return result;
        }

        // —— IL2CPP：安装 BepInEx ——
        result.installMethod = "BepInEx-IL2CPP";
        result.version = kBepInExVersion;

        if (item.hasBepInEx)
        {
            result.error = "该游戏已安装 BepInEx 插件框架，无需重复安装";
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

        fs::path zipPath = resolveCachedArtifact({bepinexCacheDir() / pathFromUtf8(pkg), 1024 * 1024});
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
            if (!downloadFile(url, zipPath, installControl, err))
            {
                result.error = err;
                return result;
            }
        }

        result.steps.push_back("解压插件框架到游戏目录");
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
            "插件框架（BepInEx）安装完成。请先启动一次游戏完成初始化，再安装翻译插件。");
        return result;
    }
    catch (const std::exception& ex)
    {
        result.ok = false;
        result.error = std::string("安装插件框架异常: ") + ex.what();
        return result;
    }
    catch (...)
    {
        result.ok = false;
        result.error = "安装插件框架异常：无法访问该目录";
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
        std::string targetDir;
        UnityGameItem item;
        if (!resolveDetectedGame(detected, targetDir, item, result.error))
            return result;

        result.gameDir = targetDir;
        const fs::path gameDir = pathFromUtf8(targetDir);

        if (detectAutoTranslator(gameDir) || item.hasAutoTranslator)
        {
            result.error = "请先卸载翻译插件，再卸载插件框架";
            result.steps.push_back("仍检测到翻译插件，已中止");
            return result;
        }


        if (!item.isIl2Cpp)
        {
            result.installMethod = "ReiPatcher";
            if (!detectReiPatcher(gameDir) && listReiPatcherLoaderTargets(gameDir).empty())
            {
                result.error = "未检测到 ReiPatcher 插件框架，无需卸载";
                return result;
            }

            result.steps.push_back("删除 ReiPatcher 插件框架");
            restoreReiPatcherDllBackups(gameDir, result.steps, result.removed);
            auto targets = listReiPatcherLoaderTargets(gameDir);
            std::sort(targets.begin(), targets.end(), [](const fs::path& a, const fs::path& b) {
                return pathUtf8(a).size() > pathUtf8(b).size();
            });
            for (const auto& p : targets)
                removeUninstallTarget(gameDir, p, result);

            if (result.removed.empty())
            {
                result.error = "未找到可删除的插件框架文件";
                return result;
            }
            if (detectReiPatcher(gameDir))
            {
                result.error = "部分文件已删除，但仍检测到 ReiPatcher 残留";
                return result;
            }

            result.ok = true;
            result.steps.push_back("完成。已卸载 ReiPatcher 插件框架。");
            return result;
        }

        result.installMethod = "BepInEx-IL2CPP";
        if (!detectBepInEx(gameDir) && listBepInExLoaderTargets(gameDir).empty())
        {
            result.error = "未检测到 BepInEx 插件框架，无需卸载";
            return result;
        }

        result.steps.push_back("删除 BepInEx 插件框架及其下全部文件");
        auto targets = listBepInExLoaderTargets(gameDir);
        std::sort(targets.begin(), targets.end(), [](const fs::path& a, const fs::path& b) {
            return pathUtf8(a).size() > pathUtf8(b).size();
        });
        for (const auto& p : targets)
            removeUninstallTarget(gameDir, p, result);

        if (result.removed.empty())
        {
            result.error = "未找到可删除的插件框架文件";
            return result;
        }
        if (detectBepInEx(gameDir))
        {
            result.error = "部分文件已删除，但仍检测到 BepInEx 残留";
            return result;
        }

        result.ok = true;
        result.steps.push_back("完成。已卸载 BepInEx 插件框架。");
        return result;
    }
    catch (const std::exception& ex)
    {
        result.ok = false;
        result.error = std::string("卸载插件框架异常: ") + ex.what();
        return result;
    }
    catch (...)
    {
        result.ok = false;
        result.error = "卸载插件框架异常：无法访问该目录";
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
        {"CustomTranslate", "LLMChat 大模型（需本软件运行）", false},
        {"", "禁用自动翻译", false},
    };
}

UnityConfigResult UnityAutoTranslator::getConfig(const std::string& gamePath)
{
    UnityConfigResult result;
    try
    {
        const auto detected = detect(gamePath);
        std::string targetDir;
        UnityGameItem item;
        std::string err;
        if (!resolveGameTarget(detected, targetDir, item, err))
        {
            // Still return defaults so the UI can edit before install
            result.ok = true;
            result.exists = false;
            result.sections = parseIniSections(defaultAutoTranslatorIniTemplate());
            if (!gamePath.empty())
            {
                result.path = gamePath;
                result.error = err;
            }
            return result;
        }

        const fs::path gameDir = pathFromUtf8(targetDir);
        result.installMethod = item.installMethod;
        const auto paths = autoTranslatorConfigPaths(gameDir, item.installMethod);
        fs::path found;
        std::error_code ec;
        for (const auto& p : paths)
        {
            if (fs::is_regular_file(p, ec))
            {
                found = p;
                break;
            }
        }

        auto defaults = parseIniSections(defaultAutoTranslatorIniTemplate());
        if (found.empty())
        {
            result.ok = true;
            result.exists = false;
            result.path = paths.empty() ? "" : pathUtf8(paths.front());
            result.sections = std::move(defaults);
            return result;
        }

        const std::string content = readFileUtf8(found);
        result.ok = true;
        result.exists = true;
        result.path = pathUtf8(found);
        result.sections = mergeIniOverDefaults(defaults, parseIniSections(content));
        return result;
    }
    catch (const std::exception& ex)
    {
        result.ok = false;
        result.error = ex.what();
        return result;
    }
}

UnityConfigResult UnityAutoTranslator::saveConfig(
    const std::string& gamePath,
    const std::vector<UnityIniSection>& sections)
{
    UnityConfigResult result;
    try
    {
        const auto detected = detect(gamePath);
        std::string targetDir;
        UnityGameItem item;
        std::string err;
        if (!resolveGameTarget(detected, targetDir, item, err))
        {
            result.error = err.empty() ? "请先选择游戏" : err;
            return result;
        }

        const fs::path gameDir = pathFromUtf8(targetDir);
        const std::string content = serializeIniSections(sections);
        const auto paths = autoTranslatorConfigPaths(gameDir, item.installMethod);
        if (paths.empty())
        {
            result.error = "无法确定配置文件路径";
            return result;
        }

        bool wrote = false;
        for (size_t i = 0; i < paths.size(); ++i)
        {
            const auto& p = paths[i];
            // Always write primary; for BepInEx also mirror secondary
            if (i > 0 && item.installMethod.rfind("BepInEx", 0) != 0)
                break;
            fs::create_directories(p.parent_path());
            if (!writeFileUtf8(p, content))
                continue;
            if (!wrote)
            {
                result.path = pathUtf8(p);
                wrote = true;
            }
        }
        if (!wrote)
        {
            result.error = "写入配置失败";
            return result;
        }
        result.ok = true;
        result.exists = true;
        result.installMethod = item.installMethod;
        result.sections = sections;
        return result;
    }
    catch (const std::exception& ex)
    {
        result.ok = false;
        result.error = ex.what();
        return result;
    }
}
