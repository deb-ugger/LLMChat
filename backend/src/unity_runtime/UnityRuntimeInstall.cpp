#include "UnityRuntimeInstall.h"
#include "UnityGameDetection.h"
#include "UnityRuntimeDownload.h"
#include "UnityRuntimeFont.h"
#include "UnityRuntimePlan.h"
#include "StoragePaths.h"
#include "Utf8Path.h"

#include <algorithm>
#include <fstream>
#include <iterator>
#include <map>
#include <regex>
#include <unordered_set>
#include <utility>

#ifdef _WIN32
#include <objbase.h>
#include <shlobj.h>
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "shell32.lib")
#endif

namespace fs = std::filesystem;
using utf8path::pathFromUtf8;
using utf8path::pathUtf8;
using utf8path::toWide;

namespace unity_runtime
{
using detail::iequals;

namespace
{
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
}

bool resolveDetectedGame(const UnityDetectInfo& detected, std::string& gameDir, UnityGameItem& game, std::string& error)
{
    if (!detected.ok && detected.games.empty()) {
        error = detected.error.empty() ? "检测失败" : detected.error;
        return false;
    }
    return resolveGameTarget(detected, gameDir, game, error);
}


namespace
{
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

#endif

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

#ifdef _WIN32
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

#endif
}

#ifdef _WIN32
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
namespace
{
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
    const auto plan = buildInstallPlan(method);
    result.package = plan.package;
    storage::TemporaryDirectory temporary("xunity");
    const auto zip = temporary.path / pathFromUtf8(result.package);
    result.steps.push_back("下载 " + result.package);
    if (!downloadFile(plan.url, zip, installControl, result.error)) return false;

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
}
#endif

#ifdef _WIN32
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

namespace
{
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
}
#endif

UnityInstallResult install(const UnityInstallRequest& req, const UnityInstallControl& control)
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
        const auto cfg = resolveInstallConfig(req);

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

UnityInstallResult fixFont(const UnityFixFontRequest& req)
{
    UnityInstallResult result;
#ifndef _WIN32
    result.error = "仅支持 Windows";
    return result;
#else
    try
    {
        const auto detected = detect(req.gamePath, true);
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

UnityUninstallResult uninstall(const UnityUninstallRequest& req)
{
    UnityUninstallResult result;
    try
    {
        const auto detected = detect(req.gamePath, true);
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

UnityInstallResult installLoader(const UnityLoaderRequest& req, const UnityInstallControl& control)
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

        const auto plan = buildBepInExInstallPlan(item.arch);
        const auto& pkg = plan.package;
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
            const fs::path cacheDir = bepinexCacheDir();
            fs::create_directories(cacheDir);
            zipPath = cacheDir / pathFromUtf8(pkg);
            result.steps.push_back(
                "本地无缓存，下载 BepInEx " + std::string(kBepInExVersion) + "（" + archLabel
                + "）并保存到 resources/bepinex/");
            if (!downloadFile(plan.url, zipPath, installControl, err))
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

UnityUninstallResult uninstallLoader(const UnityLoaderRequest& req)
{
    UnityUninstallResult result;
    try
    {
        const auto detected = detect(req.gamePath, true);
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

UnityConfigResult getConfig(const std::string& gamePath)
{
    UnityConfigResult result;
    try
    {
        const auto detected = detect(gamePath, true);
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

UnityConfigResult saveConfig(
    const std::string& gamePath,
    const std::vector<UnityIniSection>& sections)
{
    UnityConfigResult result;
    try
    {
        const auto detected = detect(gamePath, true);
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
}
