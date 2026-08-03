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
#include <shlobj.h>
#include <objbase.h>
#include <windows.h>
#include <winhttp.h>
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

#ifdef _WIN32
std::string readFileVersion(const fs::path& file)
{
    std::error_code ec;
    if (file.empty() || !fs::is_regular_file(file, ec))
        return {};
    const std::wstring wpath = file.wstring();
    DWORD handle = 0;
    const DWORD size = GetFileVersionInfoSizeW(wpath.c_str(), &handle);
    if (size == 0)
        return {};
    std::vector<char> buf(size);
    if (!GetFileVersionInfoW(wpath.c_str(), 0, size, buf.data()))
        return {};
    VS_FIXEDFILEINFO* info = nullptr;
    UINT len = 0;
    if (!VerQueryValueW(buf.data(), L"\\", reinterpret_cast<LPVOID*>(&info), &len) || !info)
        return {};
    const DWORD ms = info->dwFileVersionMS;
    const DWORD ls = info->dwFileVersionLS;
    std::ostringstream oss;
    oss << HIWORD(ms) << '.' << LOWORD(ms) << '.' << HIWORD(ls) << '.' << LOWORD(ls);
    std::string v = oss.str();
    // Trim trailing .0.0 style noise when major.minor only meaningful
    while (v.size() > 3 && v.ends_with(".0"))
    {
        const auto cut = v.size() - 2;
        if (std::count(v.begin(), v.end(), '.') <= 1)
            break;
        v.resize(cut);
    }
    return v;
}
#else
std::string readFileVersion(const fs::path&)
{
    return {};
}
#endif

fs::path findNamedFileUnder(const fs::path& root, const std::string& fileName, int maxDepth)
{
    std::error_code ec;
    if (root.empty() || !fs::exists(root, ec))
        return {};
    std::deque<std::pair<fs::path, int>> q;
    q.push_back({root, 0});
    while (!q.empty())
    {
        const auto [dir, depth] = q.front();
        q.pop_front();
        for (fs::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec))
        {
            if (ec)
                break;
            const fs::path p = it->path();
            if (it->is_regular_file(ec))
            {
                if (iequals(pathUtf8(p.filename()), fileName))
                    return p;
            }
            else if (it->is_directory(ec) && depth < maxDepth)
            {
                q.push_back({p, depth + 1});
            }
        }
    }
    return {};
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
    // Setup.exe alone only means zip was extracted; require real plugin/ReiPatcher markers.
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
    if (fs::exists(gameDir / "ReiPatcher" / "ReiPatcher.exe", ec)
        && fs::exists(gameDir / "ReiPatcher" / "Patches", ec))
        return true;

    // ReiPatcher Setup copies plugin DLLs into *_Data/Managed
    for (fs::directory_iterator it(gameDir, ec), end; !ec && it != end; it.increment(ec))
    {
        if (ec || !it->is_directory(ec))
            continue;
        const std::string folder = pathUtf8(it->path().filename());
        if (folder.size() <= 5 || !folder.ends_with("_Data"))
            continue;
        if (fs::exists(
                it->path() / "Managed" / "XUnity.AutoTranslator.Plugin.Core.dll",
                ec))
            return true;
        if (fs::exists(it->path() / "Managed" / "ReiPatcher.exe", ec))
            return true;
    }

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

    // Plugin framework
    const bool hasRei =
        fs::exists(gameDir / "ReiPatcher" / "ReiPatcher.exe", ec)
        || fs::exists(gameDir / "ReiPatcher" / "Patches", ec);
    if (item.hasBepInEx)
    {
        item.loaderName = "BepInEx";
        fs::path core = gameDir / "BepInEx" / "core" / "BepInEx.Core.dll";
        if (!fs::is_regular_file(core, ec))
            core = findNamedFileUnder(gameDir / "BepInEx" / "core", "BepInEx.Core.dll", 2);
        if (!fs::is_regular_file(core, ec))
            core = findNamedFileUnder(gameDir / "BepInEx" / "core", "BepInEx.dll", 2);
        item.loaderVersion = readFileVersion(core);
    }
    else if (hasRei)
    {
        item.loaderName = "ReiPatcher";
        item.loaderVersion = readFileVersion(gameDir / "ReiPatcher" / "ReiPatcher.exe");
    }

    // Translation plugin version
    if (item.hasAutoTranslator)
    {
        fs::path coreDll = findNamedFileUnder(
            gameDir / "BepInEx" / "plugins",
            "XUnity.AutoTranslator.Plugin.Core.dll",
            4);
        if (coreDll.empty())
        {
            for (fs::directory_iterator it(gameDir, ec), end; !ec && it != end; it.increment(ec))
            {
                if (ec || !it->is_directory(ec))
                    continue;
                const auto name = pathUtf8(it->path().filename());
                if (name.size() > 5 && name.ends_with("_Data"))
                {
                    coreDll = it->path() / "Managed" / "XUnity.AutoTranslator.Plugin.Core.dll";
                    if (fs::is_regular_file(coreDll, ec))
                        break;
                    coreDll.clear();
                }
            }
        }
        item.autoTranslatorVersion = readFileVersion(coreDll);
        if (item.autoTranslatorVersion.empty())
        {
            const fs::path patcher = gameDir / "ReiPatcher" / "Patches"
                                     / "XUnity.AutoTranslator.Patcher.dll";
            item.autoTranslatorVersion = readFileVersion(patcher);
        }
        if (item.autoTranslatorVersion.empty())
        {
            // Fallback: Migrations Tag= in config
            const fs::path cfgs[] = {
                gameDir / "BepInEx" / "config" / "AutoTranslatorConfig.ini",
                gameDir / "AutoTranslator" / "Config.ini",
            };
            for (const auto& cfg : cfgs)
            {
                if (!fs::is_regular_file(cfg, ec))
                    continue;
                std::ifstream in(cfg, std::ios::binary);
                std::string line;
                while (std::getline(in, line))
                {
                    if (!line.empty() && line.back() == '\r')
                        line.pop_back();
                    if (line.rfind("Tag=", 0) == 0)
                    {
                        item.autoTranslatorVersion = trimCopy(line.substr(4));
                        break;
                    }
                }
                if (!item.autoTranslatorVersion.empty())
                    break;
            }
        }
    }

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
 * + files the plugin generates at runtime (caches / configs)
 * + Patch and Run shortcuts + TMP/CJK font assets we copied into the game root
 * + ReiPatcher / XUnity files injected into *_Data/Managed.
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
    static const char* kManagedInjected[] = {
        "ReiPatcher.exe",
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

            // Leftover ReiPatcher timestamped backups: Foo.dll.YYYY-MM-DD_HH-MM-SS.bak
            for (fs::directory_iterator mit(managed, ec), mend; !ec && mit != mend;
                 mit.increment(ec))
            {
                if (ec || !mit->is_regular_file(ec))
                    continue;
                const std::string name = pathUtf8(mit->path().filename());
                std::string lower = name;
                for (char& c : lower)
                    c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
                if (lower.ends_with(".bak")
                    && (lower.find(".dll.") != std::string::npos || lower.ends_with(".dll.bak")))
                    out.push_back(mit->path());
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

/** Restore ReiPatcher backups like UnityEngine.CoreModule.dll.2026-08-03_04-36-36.bak */
void restoreReiPatcherDllBackups(
    const fs::path& gameDir,
    std::vector<std::string>& steps,
    std::vector<std::string>& removed)
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

        for (fs::directory_iterator mit(managed, ec), mend; !ec && mit != mend; mit.increment(ec))
        {
            if (ec || !mit->is_regular_file(ec))
                continue;
            const fs::path bakPath = mit->path();
            const std::string name = pathUtf8(bakPath.filename());
            if (name.size() < 10 || !name.ends_with(".bak"))
                continue;

            // Expect: <dllName>.<YYYY-MM-DD_HH-MM-SS>.bak
            const std::string stem = name.substr(0, name.size() - 4); // drop .bak
            const auto dot = stem.rfind('.');
            if (dot == std::string::npos || dot == 0)
                continue;
            const std::string stamp = stem.substr(dot + 1);
            if (stamp.size() < 15 || stamp[4] != '-' || stamp.find('_') == std::string::npos)
                continue;
            const std::string originalName = stem.substr(0, dot);
            if (originalName.find(".dll") == std::string::npos)
                continue;

            const fs::path original = managed / pathFromUtf8(originalName);
            fs::copy_file(bakPath, original, fs::copy_options::overwrite_existing, ec);
            if (ec)
            {
                steps.push_back(
                    "恢复备份失败：" + originalName + "（" + ec.message() + "）");
                continue;
            }
            steps.push_back("已从备份恢复 " + originalName);
            fs::remove(bakPath, ec);
            if (!ec)
            {
                removed.push_back(pathUtf8(bakPath));
                steps.push_back("已删除备份 " + name);
            }
        }
    }
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

bool downloadFile(const std::string& url, const fs::path& dest, std::string& error);
bool extractZip(const fs::path& zipPath, const fs::path& destDir, std::string& error);
struct CjkFontSettings
{
    std::string uguiFont;    // OverrideFont (UGUI system face or path)
    std::string tmpFont;     // TMP asset bundle name for Override + Fallback
};
std::string buildConfigIni(const UnityInstallRequest& req, const CjkFontSettings& fonts);

/** Local cache dir next to backend: resources/bepinex/ */
fs::path bepinexCacheDir()
{
    return backendModuleDir() / "resources" / "bepinex";
}

/** Local cache dir next to backend: resources/fonts/ */
fs::path fontsCacheDir()
{
    return backendModuleDir() / "resources" / "fonts";
}

constexpr const char* kNotoScFileName = "NotoSansSC-Regular.otf";
/** Subset OTF (~several MB); preferred over full CJK language zip. */
constexpr const char* kNotoScDownloadUrl =
    "https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@Sans2.004/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf";
/** Fallback: language-specific zip from GitHub Releases (~90MB). */
constexpr const char* kNotoScZipUrl =
    "https://github.com/notofonts/noto-cjk/releases/download/Sans2.004/08_NotoSansCJKsc.zip";
constexpr const char* kNotoScZipMember = "NotoSansCJKsc-Regular.otf";

/** Official XUnity TMP SDF asset bundles (needed for TextMeshPro Chinese glyphs). */
constexpr const char* kTmpFontBundle7zUrl =
    "https://github.com/bbepis/XUnity.AutoTranslator/releases/download/v5.5.0/"
    "TMP_Font_AssetBundles_2025-12-08.7z";
constexpr const char* kTmpFontBundle7zName = "TMP_Font_AssetBundles_2025-12-08.7z";
constexpr const char* kSevenZrUrl = "https://www.7-zip.org/a/7zr.exe";

fs::path toolsCacheDir()
{
    return backendModuleDir() / "resources" / "tools";
}

fs::path tmpFontBundlesCacheDir()
{
    return fontsCacheDir() / "tmp-bundles";
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

bool isCjkTargetLanguage(const std::string& lang)
{
    std::string l = lang;
    for (char& c : l)
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if (l.empty())
        return true;
    return l == "zh" || l.rfind("zh-", 0) == 0 || l.rfind("zh_", 0) == 0 || l == "chs"
           || l == "cht" || l.find("chinese") != std::string::npos;
}

/** Return installed system CJK face name, or empty. */
std::string detectSystemCjkFont()
{
    struct Candidate
    {
        const wchar_t* file;
        const char* face;
    };
    static const Candidate kCandidates[] = {
        {L"msyh.ttc", "Microsoft YaHei"},
        {L"msyh.ttf", "Microsoft YaHei"},
        {L"msyhbd.ttc", "Microsoft YaHei"},
        {L"msyhl.ttc", "Microsoft YaHei"},
        {L"simhei.ttf", "SimHei"},
        {L"simsun.ttc", "SimSun"},
        {L"simsun.ttf", "SimSun"},
        {L"simfang.ttf", "FangSong"},
        {L"simkai.ttf", "KaiTi"},
        {L"Deng.ttf", "DengXian"},
        {L"Dengb.ttf", "DengXian"},
        {L"NotoSansSC-Regular.otf", "Noto Sans SC"},
        {L"NotoSansCJKsc-Regular.otf", "Noto Sans CJK SC"},
        {L"SourceHanSansSC-Regular.otf", "Source Han Sans SC"},
    };

    wchar_t winDir[MAX_PATH]{};
    if (!GetWindowsDirectoryW(winDir, MAX_PATH))
        return {};
    const fs::path fontsDir = fs::path(winDir) / L"Fonts";
    std::error_code ec;
    for (const auto& c : kCandidates)
    {
        if (fs::exists(fontsDir / c.file, ec))
            return c.face;
    }
    return {};
}

fs::path findCachedNotoFont()
{
    const fs::path p = fontsCacheDir() / pathFromUtf8(kNotoScFileName);
    std::error_code ec;
    if (fs::exists(p, ec) && fs::is_regular_file(p, ec))
    {
        const auto sz = fs::file_size(p, ec);
        // Reject Git LFS pointer stubs / truncated downloads
        if (!ec && sz > 200 * 1024)
            return p;
    }
    return {};
}

bool downloadNotoFontToCache(std::vector<std::string>& steps, std::string& error)
{
    const fs::path cached = findCachedNotoFont();
    if (!cached.empty())
        return true;

    const fs::path cacheDir = fontsCacheDir();
    fs::create_directories(cacheDir);
    const fs::path dest = cacheDir / pathFromUtf8(kNotoScFileName);

    steps.push_back(std::string("下载中文字体 ") + kNotoScFileName + " 到 resources/fonts/");
    if (downloadFile(kNotoScDownloadUrl, dest, error))
    {
        const fs::path ok = findCachedNotoFont();
        if (!ok.empty())
            return true;
        std::error_code ec;
        fs::remove(dest, ec);
        error = "字体下载不完整（可能是镜像返回了占位文件）";
    }

    // Fallback: language zip from GitHub Releases, extract Regular OTF
    const fs::path tempDir = fs::temp_directory_path() / "llmchat-noto-sc";
    fs::create_directories(tempDir);
    const fs::path zipPath = tempDir / L"NotoSansCJKsc.zip";
    steps.push_back("回退：下载 Noto Sans CJK SC 压缩包");
    std::string zipErr;
    if (!downloadFile(kNotoScZipUrl, zipPath, zipErr))
    {
        if (error.empty())
            error = zipErr;
        else
            error += "；回退下载也失败: " + zipErr;
        return false;
    }
    steps.push_back("解压 Noto Sans CJK SC");
    if (!extractZip(zipPath, tempDir, zipErr))
    {
        error = zipErr;
        return false;
    }

    fs::path found;
    std::error_code ec;
    for (fs::recursive_directory_iterator it(tempDir, ec), end; !ec && it != end; it.increment(ec))
    {
        if (!it->is_regular_file(ec))
            continue;
        const std::string name = pathUtf8(it->path().filename());
        if (iequals(name, kNotoScZipMember) || iequals(name, kNotoScFileName))
        {
            found = it->path();
            break;
        }
    }
    if (found.empty())
    {
        error = "压缩包中未找到 Regular 字体文件";
        return false;
    }
    fs::copy_file(found, dest, fs::copy_options::overwrite_existing, ec);
    if (ec || findCachedNotoFont().empty())
    {
        error = "无法写入字体缓存: " + ec.message();
        return false;
    }
    return true;
}

bool runToolProcess(const fs::path& exe, const std::wstring& args, std::string& error)
{
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    std::wstring cmd = L"\"" + exe.wstring() + L"\" " + args;
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
        error = "无法启动工具: " + pathUtf8(exe.filename());
        return false;
    }
    WaitForSingleObject(pi.hProcess, 600000);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    if (code != 0)
    {
        error = pathUtf8(exe.filename()) + " 退出码 " + std::to_string(code);
        return false;
    }
    return true;
}

fs::path ensureSevenZr(std::vector<std::string>& steps, std::string& error)
{
    const fs::path dest = toolsCacheDir() / L"7zr.exe";
    std::error_code ec;
    if (fs::exists(dest, ec))
    {
        const auto sz = fs::file_size(dest, ec);
        if (!ec && sz > 100 * 1024)
            return dest;
    }
    fs::create_directories(toolsCacheDir(), ec);
    steps.push_back("下载 7zr.exe（用于解压 TMP 字体包）");
    if (!downloadFile(kSevenZrUrl, dest, error))
        return {};
    return dest;
}

bool tmpBundlesReady()
{
    const fs::path dir = tmpFontBundlesCacheDir();
    std::error_code ec;
    if (!fs::exists(dir, ec))
        return false;
    int count = 0;
    for (fs::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec))
    {
        if (!it->is_regular_file(ec))
            continue;
        const std::string name = pathUtf8(it->path().filename());
        if (name.rfind("arialuni_sdf", 0) == 0 || name.find("arialuni_sdf") != std::string::npos)
        {
            const auto sz = fs::file_size(it->path(), ec);
            if (!ec && sz > 1024 * 1024)
                ++count;
        }
    }
    return count > 0;
}

bool ensureTmpFontBundlesCached(std::vector<std::string>& steps, std::string& error)
{
    if (tmpBundlesReady())
        return true;

    const fs::path sevenZr = ensureSevenZr(steps, error);
    if (sevenZr.empty())
        return false;

    const fs::path archive = fontsCacheDir() / pathFromUtf8(kTmpFontBundle7zName);
    std::error_code ec;
    fs::create_directories(fontsCacheDir(), ec);
    if (!fs::exists(archive, ec) || fs::file_size(archive, ec) < 1024 * 1024)
    {
        steps.push_back(
            "下载 TextMeshPro 中文字体资源包（约 130MB，仅首次；解决译文显示为口）");
        if (!downloadFile(kTmpFontBundle7zUrl, archive, error))
            return false;
    }

    const fs::path outDir = tmpFontBundlesCacheDir();
    fs::create_directories(outDir, ec);
    steps.push_back("解压 TMP 字体资源包到 resources/fonts/tmp-bundles/");
    // 7zr: -oPATH has no space after -o
    const std::wstring args = L"x \"" + archive.wstring() + L"\" -o\"" + outDir.wstring() + L"\" -y";
    if (!runToolProcess(sevenZr, args, error))
        return false;
    if (!tmpBundlesReady())
    {
        error = "解压完成但未找到 arialuni_sdf 字体资源";
        return false;
    }
    return true;
}

/** Read Unity engine version string from *_Data/globalgamemanagers (best-effort). */
std::string detectUnityEngineVersion(const fs::path& gameDir)
{
    std::error_code ec;
    std::vector<fs::path> candidates;
    for (const auto& entry : fs::directory_iterator(gameDir, ec))
    {
        if (ec || !entry.is_directory(ec))
            continue;
        const auto name = pathUtf8(entry.path().filename());
        if (name.size() > 5 && name.ends_with("_Data"))
        {
            candidates.push_back(entry.path() / "globalgamemanagers");
            candidates.push_back(entry.path() / "data.unity3d");
        }
    }
    candidates.push_back(gameDir / "globalgamemanagers");

    auto tryScan = [](const fs::path& filePath) -> std::string {
        std::error_code lec;
        if (!fs::exists(filePath, lec) || !fs::is_regular_file(filePath, lec))
            return {};
        std::ifstream in(filePath, std::ios::binary);
        if (!in)
            return {};
        // Cap scan size — globalgamemanagers can be large
        constexpr std::size_t kMaxScan = 4 * 1024 * 1024;
        in.seekg(0, std::ios::end);
        const auto endPos = in.tellg();
        in.seekg(0, std::ios::beg);
        std::size_t toRead = 0;
        if (endPos > 0)
            toRead = static_cast<std::size_t>(endPos);
        if (toRead > kMaxScan)
            toRead = kMaxScan;
        std::string bytes(toRead, '\0');
        if (toRead == 0 || !in.read(bytes.data(), static_cast<std::streamsize>(toRead)))
        {
            // partial read still usable
            bytes.resize(static_cast<std::size_t>(std::max<std::streamsize>(0, in.gcount())));
        }
        // Prefer 6000.x / 20xx.x patterns
        for (size_t i = 0; i + 6 < bytes.size(); ++i)
        {
            if (bytes[i] == '6' && bytes[i + 1] == '0' && bytes[i + 2] == '0' && bytes[i + 3] == '0'
                && bytes[i + 4] == '.' && std::isdigit(static_cast<unsigned char>(bytes[i + 5])))
            {
                size_t j = i;
                while (j < bytes.size()
                       && (std::isdigit(static_cast<unsigned char>(bytes[j])) || bytes[j] == '.'
                           || bytes[j] == 'f' || bytes[j] == 'b' || bytes[j] == 'a'
                           || bytes[j] == 'p'))
                    ++j;
                return bytes.substr(i, j - i);
            }
        }
        for (size_t i = 0; i + 6 < bytes.size(); ++i)
        {
            if (bytes[i] == '2' && bytes[i + 1] == '0'
                && std::isdigit(static_cast<unsigned char>(bytes[i + 2]))
                && std::isdigit(static_cast<unsigned char>(bytes[i + 3])) && bytes[i + 4] == '.'
                && std::isdigit(static_cast<unsigned char>(bytes[i + 5])))
            {
                size_t j = i;
                while (j < bytes.size()
                       && (std::isdigit(static_cast<unsigned char>(bytes[j])) || bytes[j] == '.'
                           || bytes[j] == 'f' || bytes[j] == 'b' || bytes[j] == 'a'
                           || bytes[j] == 'p'))
                    ++j;
                return bytes.substr(i, j - i);
            }
        }
        return {};
    };

    for (const auto& c : candidates)
    {
        const std::string v = tryScan(c);
        if (!v.empty())
            return v;
    }
    return {};
}

std::string preferredTmpFontAssetName(const std::string& unityVersion)
{
    int major = 0;
    if (unityVersion.rfind("6000", 0) == 0)
        return "arialuni_sdf_u6000";
    if (unityVersion.size() >= 4 && unityVersion[0] == '2' && unityVersion[1] == '0')
        major = (unityVersion[2] - '0') * 10 + (unityVersion[3] - '0');
    // Official pack has no u2020; use u2021 for 2020.x (closer TMP gen)
    if (major >= 22)
        return "arialuni_sdf_u2022";
    if (major >= 20)
        return "arialuni_sdf_u2021";
    if (major >= 19)
        return "arialuni_sdf_u2019";
    if (major >= 18)
        return "arialuni_sdf_u2018";
    if (major > 0 || unityVersion.rfind("5.", 0) == 0)
        return "arialuni_sdf-u55to2017";
    return "arialuni_sdf_u2019";
}

/** Prefer already-present Chinese TMP assets in the game folder (often version-matched). */
std::string findExistingGameTmpFont(const fs::path& gameDir, const std::string& unityVersion)
{
    int year = 0;
    if (unityVersion.rfind("6000", 0) == 0)
        year = 6000;
    else if (unityVersion.size() >= 4 && unityVersion[0] == '2' && unityVersion[1] == '0')
        year = 2000 + (unityVersion[2] - '0') * 10 + (unityVersion[3] - '0');

    std::vector<std::string> prefer;
    if (year == 6000)
    {
        prefer = {
            "ziti_Unity 6",
            "ziti_Unity_6000",
            "ziti_SourceHanSans_U6000-2-10",
            "ziti_arialuni_sdf_u6000",
            "arialuni_sdf_u6000",
        };
    }
    else if (year >= 2017)
    {
        prefer.push_back("ziti_Unity_" + std::to_string(year));
        prefer.push_back("ziti_fangti_u" + std::to_string(year));
        prefer.push_back("ziti_sourcehansanscn_u" + std::to_string(year));
        prefer.push_back("ziti_arialuni_sdf_u" + std::to_string(year));
        // Noto SC optimized packs often named ..._2020 / ..._2021
        prefer.push_back("ziti_NotoSansSC_sdf32_optimized_12k_lz4_" + std::to_string(year));
        if (year == 2020)
        {
            // no official arialuni u2020 — try neighbors already in many packs
            prefer.push_back("ziti_arialuni_sdf_u2021");
            prefer.push_back("ziti_arialuni_sdf_u2019");
            prefer.push_back("ziti_SourceHanSans_U2019-4-41");
        }
        prefer.push_back("arialuni_sdf_u" + std::to_string(year));
    }

    auto existsFile = [&](const std::string& name) -> bool {
        std::error_code ec;
        const fs::path p = gameDir / pathFromUtf8(name);
        if (!fs::exists(p, ec) || !fs::is_regular_file(p, ec))
            return false;
        const auto sz = fs::file_size(p, ec);
        return !ec && sz > 100 * 1024;
    };

    for (const auto& name : prefer)
    {
        if (existsFile(name))
            return name;
    }

    // Fuzzy: any ziti_Unity_* or ziti_*arialuni* / NotoSansSC in game root
    std::error_code ec;
    std::string bestUnity;
    std::string bestNoto;
    std::string bestArial;
    for (fs::directory_iterator it(gameDir, ec), end; !ec && it != end; it.increment(ec))
    {
        if (!it->is_regular_file(ec))
            continue;
        const std::string name = pathUtf8(it->path().filename());
        const auto sz = fs::file_size(it->path(), ec);
        if (ec || sz < 100 * 1024)
            continue;
        std::string lower = name;
        for (char& c : lower)
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if (lower.rfind("ziti_unity_", 0) == 0 || lower == "ziti_unity 6")
        {
            if (year > 0 && name.find(std::to_string(year)) != std::string::npos)
                return name;
            if (bestUnity.empty())
                bestUnity = name;
        }
        else if (lower.find("notosanssc") != std::string::npos)
        {
            if (year > 0 && name.find(std::to_string(year)) != std::string::npos)
                bestNoto = name;
            else if (bestNoto.empty())
                bestNoto = name;
        }
        else if (lower.find("arialuni_sdf") != std::string::npos)
        {
            if (bestArial.empty())
                bestArial = name;
        }
    }
    if (!bestUnity.empty())
        return bestUnity;
    if (!bestNoto.empty())
        return bestNoto;
    if (!bestArial.empty())
        return bestArial;
    return {};
}

fs::path findTmpFontAssetInCache(const std::string& preferred)
{
    static const char* kFallbacks[] = {
        "arialuni_sdf_u6000",
        "arialuni_sdf_u2022",
        "arialuni_sdf_u2021",
        "arialuni_sdf_u2019",
        "arialuni_sdf_u2018plus",
        "arialuni_sdf_u2018",
        "arialuni_sdf-u55to2017",
        "arialuni_sdf",
        "notosanscjk-regular_sdf_u2018plus",
        "notosanscjk-regular_sdf",
    };

    auto findExact = [](const std::string& name) -> fs::path {
        const fs::path dir = tmpFontBundlesCacheDir();
        std::error_code ec;
        for (fs::recursive_directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec))
        {
            if (!it->is_regular_file(ec))
                continue;
            if (iequals(pathUtf8(it->path().filename()), name))
            {
                const auto sz = fs::file_size(it->path(), ec);
                if (!ec && sz > 100 * 1024)
                    return it->path();
            }
        }
        return {};
    };

    fs::path p = findExact(preferred);
    if (!p.empty())
        return p;
    for (const char* name : kFallbacks)
    {
        if (iequals(name, preferred))
            continue;
        p = findExact(name);
        if (!p.empty())
            return p;
    }
    return {};
}

/**
 * Configure fonts for CJK target language:
 * - UGUI: system face (YaHei etc.) or downloaded OTF path
 * - TextMeshPro: prefer existing version-matched asset in game dir (ziti_Unity_YYYY),
 *   else install official arialuni_sdf_* and set Override+Fallback
 */
bool ensureCjkFontForGame(
    const fs::path& gameDir,
    const std::string& language,
    std::vector<std::string>& steps,
    CjkFontSettings& fonts,
    std::string& warning)
{
    fonts = {};
    warning.clear();
    if (!isCjkTargetLanguage(language))
    {
        steps.push_back("目标语言非中文，跳过字体处理");
        return true;
    }

    // --- UGUI ---
    const std::string systemFace = detectSystemCjkFont();
    if (!systemFace.empty())
    {
        fonts.uguiFont = systemFace;
        steps.push_back("UGUI：使用系统中文字体 " + systemFace);
    }
    else
    {
        steps.push_back("UGUI：未检测到系统中文字体，尝试下载 Noto Sans SC");
        std::string err;
        if (downloadNotoFontToCache(steps, err))
        {
            const fs::path cached = findCachedNotoFont();
            const fs::path fontsDir = gameDir / "Fonts";
            std::error_code ec;
            fs::create_directories(fontsDir, ec);
            const fs::path dest = fontsDir / pathFromUtf8(kNotoScFileName);
            fs::copy_file(cached, dest, fs::copy_options::overwrite_existing, ec);
            if (!ec)
            {
                fonts.uguiFont = std::string("Fonts/") + kNotoScFileName;
                steps.push_back("UGUI：已安装 " + fonts.uguiFont);
            }
            else
            {
                warning = "UGUI 字体无法复制到游戏目录: " + ec.message();
            }
        }
        else if (warning.empty())
        {
            warning = err;
        }
    }

    // --- TextMeshPro (critical for 「口」) ---
    const std::string unityVer = detectUnityEngineVersion(gameDir);
    if (!unityVer.empty())
        steps.push_back("检测到 Unity 版本: " + unityVer);
    else
        steps.push_back("未能读取 Unity 版本，将尝试匹配游戏目录已有 TMP 字体");

    // 1) Prefer already-present Chinese TMP assets (often match this game's TMP version)
    const std::string existing = findExistingGameTmpFont(gameDir, unityVer);
    if (!existing.empty())
    {
        fonts.tmpFont = existing;
        steps.push_back(
            "TMP：使用游戏目录已有字体 " + existing
            + "（优先于通用包，避免 TextMeshPro 版本不匹配导致口字）");
        return true;
    }

    // 2) Install official arialuni pack
    const std::string preferred = preferredTmpFontAssetName(unityVer);
    std::string tmpErr;
    if (!ensureTmpFontBundlesCached(steps, tmpErr))
    {
        const std::string msg =
            tmpErr.empty() ? "无法下载/解压 TMP 字体资源包" : tmpErr;
        steps.push_back("TMP 字体失败: " + msg);
        if (warning.empty())
            warning = msg
                + "。若译文仍显示为「口」，请检查网络后重试「修复缺字字体」";
        return true;
    }

    const fs::path assetSrc = findTmpFontAssetInCache(preferred);
    if (assetSrc.empty())
    {
        warning = "TMP 字体包中未找到可用的 arialuni_sdf 资源";
        steps.push_back(warning);
        return true;
    }

    const std::string assetName = pathUtf8(assetSrc.filename());
    const fs::path assetDst = gameDir / pathFromUtf8(assetName);
    std::error_code ec;
    fs::copy_file(assetSrc, assetDst, fs::copy_options::overwrite_existing, ec);
    if (ec)
    {
        warning = "无法将 TMP 字体复制到游戏目录: " + ec.message();
        steps.push_back(warning);
        return true;
    }
    fonts.tmpFont = assetName;
    steps.push_back(
        "TMP：已安装 " + assetName + "（Override+Fallback，解决译文缺字）");
    if (!iequals(assetName, preferred))
        steps.push_back("（优选 " + preferred + " 不可用，已改用 " + assetName + "）");
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

/** Upsert UGUI/TMP font keys + redirected-resource strategy in an AutoTranslator ini. */
std::string upsertOverrideFontInIni(std::string content, const CjkFontSettings& fonts)
{
    auto upsertLine = [&](const std::string& key, const std::string& value) {
        const std::string prefix = key + "=";
        const std::string line = prefix + value;
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
            {
                content.replace(lineStart, lineEnd - lineStart, line);
                return;
            }
            pos = lineEnd == content.size() ? lineEnd : lineEnd + 1;
        }
        const size_t behaviour = content.find("[Behaviour]");
        if (behaviour != std::string::npos)
        {
            size_t insertAt = content.find('\n', behaviour);
            if (insertAt == std::string::npos)
                content.append("\n").append(line).append("\n");
            else
                content.insert(insertAt + 1, line + "\n");
        }
        else
        {
            if (!content.empty() && content.back() != '\n')
                content.push_back('\n');
            content.append("[Behaviour]\n").append(line).append("\n");
        }
    };
    if (!fonts.uguiFont.empty())
        upsertLine("OverrideFont", fonts.uguiFont);
    // Override + Fallback both point at the TMP asset bundle (Fallback alone is often not enough)
    if (!fonts.tmpFont.empty())
    {
        upsertLine("OverrideFontTextMeshPro", fonts.tmpFont);
        upsertLine("FallbackFontTextMeshPro", fonts.tmpFont);
    }
    upsertLine(
        "RedirectedResourceDetectionStrategy",
        "AppendMongolianVowelSeparatorAndRemoveAll");
    return content;
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
            content = upsertOverrideFontInIni(content, fonts);
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
    if (tmpFont.empty())
        return "未配置 TextMeshPro 字体（OverrideFontTextMeshPro）；译文易显示为「口」，请点「修复缺字字体」";

    std::error_code ec;
    const fs::path fontPath = gameDir / pathFromUtf8(tmpFont);
    if (!fs::exists(fontPath, ec))
        return "OverrideFontTextMeshPro=" + tmpFont
            + " 文件不在游戏目录；请点「修复缺字字体」重新安装 TMP 字体";

    // Detect known TMP version-mismatch from BepInEx log
    const fs::path logPath = gameDir / "BepInEx" / "LogOutput.log";
    if (fs::exists(logPath, ec))
    {
        const std::string log = readFileUtf8(logPath);
        std::string lower = log;
        for (char& c : lower)
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if (lower.find("version mismatch") != std::string::npos
            || lower.find("font asset version") != std::string::npos)
        {
            return "BepInEx 日志出现 TextMeshPro 字体版本不匹配；当前字体可能仍会显示「口」。"
                   "请点「修复缺字字体」改用与游戏 Unity 版本匹配的字体后重启";
        }
    }

    if (ugui.empty())
        return "已配置 TMP 字体，但未设置 UGUI OverrideFont（部分界面仍可能缺字）";
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
        << "\"autoTranslatorVersion\":\"" << jsonEscape(g.autoTranslatorVersion) << "\","
        << "\"loaderName\":\"" << jsonEscape(g.loaderName) << "\","
        << "\"loaderVersion\":\"" << jsonEscape(g.loaderVersion) << "\","
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

bool runProcess(const fs::path& exe, const fs::path& workDir, std::string& error, DWORD* outCode = nullptr)
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
    if (outCode)
        *outCode = code;
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

    // .exe → resolve to game folder and check that game only
    if (fs::is_regular_file(root, ec) && looksLikeExe(root))
    {
        const UnityGameItem direct = inspectGameDir(root);
        if (direct.isUnity)
        {
            info.games.push_back(direct);
            info.count = 1;
            info.ok = true;
            applyGameToDetectInfo(info, direct);
            info.scanRoot = direct.gameDir;
            return info;
        }
        info.error = "所选程序不是可识别的 Unity 游戏";
        info.ok = false;
        return info;
    }

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

    std::string scanRoot = pathUtf8(fs::absolute(root, ec));
    std::vector<UnityGameItem> games;
    std::unordered_set<std::string> seen;

    const auto onGame = [&](const UnityGameItem& g) {
        emit("{\"type\":\"game\",\"game\":" + gameItemToJson(g) + "}\n");
    };

    // .exe → only judge that one game
    if (fs::is_regular_file(root, ec) && looksLikeExe(root))
    {
        const UnityGameItem direct = inspectGameDir(root);
        if (direct.isUnity)
        {
            if (seen.insert(direct.gameDir).second)
            {
                games.push_back(direct);
                onGame(direct);
            }
            scanRoot = direct.gameDir;
        }
        else
        {
            emit("{\"type\":\"done\",\"ok\":false,\"error\":\"所选程序不是可识别的 Unity 游戏\",\"scanRoot\":\""
                 + jsonEscape(scanRoot) + "\",\"count\":0}\n");
            return;
        }
    }
    else
    {
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

std::string UnityAutoTranslator::pickPath(const std::string& defaultPath)
{
#ifndef _WIN32
    (void)defaultPath;
    return {};
#else
    // Prefer IFileOpenDialog: pick folder OR .exe in one modern dialog via
    // FOS_PATHMUSTEXIST without FOS_PICKFOLDERS, using a custom filter that
    // still can't open folders — so use SHBrowseForFolder with files included.
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    const bool needUninit = (hr == S_OK);

    std::wstring startWide;
    if (!defaultPath.empty())
    {
        fs::path start = pathFromUtf8(defaultPath);
        std::error_code ec;
        if (fs::is_regular_file(start, ec))
            start = start.parent_path();
        while (!start.empty() && !fs::is_directory(start, ec))
            start = start.parent_path();
        if (!start.empty())
            startWide = start.wstring();
    }

    wchar_t display[MAX_PATH]{};
    BROWSEINFOW bi{};
    bi.hwndOwner = GetForegroundWindow();
    bi.pszDisplayName = display;
    bi.lpszTitle = L"选择游戏目录或主程序（.exe）";
    bi.ulFlags = BIF_NEWDIALOGSTYLE | BIF_USENEWUI | BIF_BROWSEINCLUDEFILES;
    if (!startWide.empty())
    {
        bi.lpfn = [](HWND hwnd, UINT uMsg, LPARAM /*lParam*/, LPARAM lpData) -> int {
            if (uMsg == BFFM_INITIALIZED && lpData)
                SendMessageW(hwnd, BFFM_SETSELECTIONW, TRUE, lpData);
            return 0;
        };
        bi.lParam = reinterpret_cast<LPARAM>(startWide.c_str());
    }

    PIDLIST_ABSOLUTE pidl = SHBrowseForFolderW(&bi);
    std::string result;
    if (pidl)
    {
        wchar_t pathBuf[MAX_PATH]{};
        if (SHGetPathFromIDListW(pidl, pathBuf))
            result = toUtf8(pathBuf);
        CoTaskMemFree(pidl);
    }
    if (needUninit)
        CoUninitialize();
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
                std::string setupErr;
                DWORD setupCode = 0;
                const bool setupOk = runProcess(setup, gameDirPath, setupErr, &setupCode);
                (void)setupCode;
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

        CjkFontSettings fonts;
        std::string fontWarning;
        ensureCjkFontForGame(gameDirPath, cfg.language, result.steps, fonts, fontWarning);

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

        CjkFontSettings fonts;
        std::string fontWarning;
        ensureCjkFontForGame(
            pathFromUtf8(targetDir), cfg.language, result.steps, fonts, fontWarning);

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

        // Restore patched Unity DLLs from ReiPatcher .bak before deleting leftovers
        restoreReiPatcherDllBackups(gameDir, result.steps, result.removed);

        auto targets = listXUnityUninstallTargets(gameDir);
        std::sort(targets.begin(), targets.end(), [](const fs::path& a, const fs::path& b) {
            return pathUtf8(a).size() > pathUtf8(b).size();
        });
        for (const auto& p : targets)
            tryRemove(p);

        // Remove Fonts/ if it became empty after deleting our Noto file
        {
            std::error_code ec;
            const fs::path fontsDir = gameDir / "Fonts";
            if (fs::is_directory(fontsDir, ec) && fs::is_empty(fontsDir, ec))
                tryRemove(fontsDir);
        }

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
        result.steps.push_back(
            "完成。已删除翻译插件、Managed 注入文件、中文字体、Patch and Run 快捷方式，并尝试恢复 ReiPatcher 备份的 DLL。");
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
