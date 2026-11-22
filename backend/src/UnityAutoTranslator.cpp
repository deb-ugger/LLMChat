#include "UnityAutoTranslator.h"
#include "unity_runtime/UnityGameDetection.h"
#include "unity_runtime/UnityRuntimeInstall.h"
#include "Utf8Path.h"
#include "StoragePaths.h"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
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

using unity_runtime::checkOverrideFontStatus;
using unity_runtime::findPatchAndRunShortcut;
using unity_runtime::findReiPatcherIni;
using unity_runtime::resolveDetectedGame;

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
    return unity_runtime::install(req, control);
}

UnityInstallResult UnityAutoTranslator::fixFont(const UnityFixFontRequest& req)
{
    return unity_runtime::fixFont(req);
}

UnityUninstallResult UnityAutoTranslator::uninstall(const UnityUninstallRequest& req)
{
    return unity_runtime::uninstall(req);
}

UnityInstallResult UnityAutoTranslator::installLoader(const UnityLoaderRequest& req, const UnityInstallControl& control)
{
    return unity_runtime::installLoader(req, control);
}

UnityUninstallResult UnityAutoTranslator::uninstallLoader(const UnityLoaderRequest& req)
{
    return unity_runtime::uninstallLoader(req);
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
    return unity_runtime::getConfig(gamePath);
}

UnityConfigResult UnityAutoTranslator::saveConfig(
    const std::string& gamePath,
    const std::vector<UnityIniSection>& sections)
{
    return unity_runtime::saveConfig(gamePath, sections);
}
