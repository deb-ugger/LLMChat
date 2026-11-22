#include "UnityGameDetection.h"
#include "Utf8Path.h"

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <deque>
#include <fstream>
#include <sstream>
#include <unordered_set>
#include <utility>

#ifdef _WIN32
#include <winver.h>
#pragma comment(lib, "version.lib")
#endif

namespace fs = std::filesystem;

using utf8path::pathFromUtf8;
using utf8path::pathUtf8;

namespace unity_runtime
{
namespace detail
{
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
}

using detail::iequals;
using detail::trimCopy;

static std::string jsonEscape(const std::string& s)
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

static bool looksLikeExe(const fs::path& p)
{
    return iequals(pathUtf8(p.extension()), ".exe");
}

static fs::path resolveGameDir(const fs::path& input, std::string& gameExe)
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
static std::string readFileVersion(const fs::path& file)
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
static std::string readFileVersion(const fs::path&)
{
    return {};
}
#endif

static fs::path findNamedFileUnder(const fs::path& root, const std::string& fileName, int maxDepth)
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

static bool detectUnity(const fs::path& gameDir, const std::string& gameExe)
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

static bool detectIl2Cpp(const fs::path& gameDir)
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
    // Actual plugin / cache markers only — ReiPatcher.exe alone is the framework.
    if (fs::exists(gameDir / "AutoTranslator", ec))
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

    // Any other XUnity*.dll under ReiPatcher/Patches
    {
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
                if (lower.find("xunity") != std::string::npos
                    && lower.ends_with(".dll"))
                    return true;
            }
        }
    }

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
        if (fs::exists(
                it->path() / "Managed" / "XUnity.Common.dll",
                ec))
            return true;
        if (fs::exists(
                it->path() / "Managed" / "XUnity.ResourceRedirector.dll",
                ec))
            return true;
        if (fs::is_directory(it->path() / "Managed" / "Translators", ec))
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

bool detectReiPatcher(const fs::path& gameDir)
{
    std::error_code ec;
    return fs::exists(gameDir / "ReiPatcher" / "ReiPatcher.exe", ec)
           || fs::exists(gameDir / "ReiPatcher" / "Patches", ec);
}

static std::vector<std::string> listBepInExPlugins(const fs::path& gameDir)
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

static std::string chooseMethod(bool isUnity, bool isIl2Cpp, bool /*hasBepInEx*/)
{
    if (!isUnity)
        return "none";
    // Policy: Mono always ReiPatcher; IL2CPP always BepInEx.
    if (isIl2Cpp)
        return "BepInEx-IL2CPP";
    return "ReiPatcher";
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

    // Plugin framework: Mono → ReiPatcher, IL2CPP → BepInEx (report what matches policy first)
    const bool hasRei = detectReiPatcher(gameDir);
    if (item.hasBepInEx && (item.isIl2Cpp || !hasRei))
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

static bool shouldSkipScanDir(const std::string& name)
{
    return iequals(name, ".git") || iequals(name, "node_modules") || iequals(name, "Windows")
           || iequals(name, "$RECYCLE.BIN") || iequals(name, "System Volume Information") || iequals(name, "LLMChat-Unity");
}

static void applyGameToDetectInfo(UnityDetectInfo& info, const UnityGameItem& g)
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

static std::string gameItemToJson(const UnityGameItem& g)
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

static void scanUnityGamesRecursive(
    const fs::path& dir,
    int depth,
    int maxDepth,
    std::unordered_set<std::string>& seen,
    std::vector<UnityGameItem>& games,
    const std::function<void(const UnityGameItem&)>& onGame,
    const std::function<bool()>& shouldStop = {})
{
    std::deque<std::pair<fs::path, int>> queue;
    queue.emplace_back(dir, depth);

    while (!queue.empty())
    {
        if (shouldStop && shouldStop()) return;
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
            if (shouldStop && shouldStop()) return;
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
                if (shouldStop && shouldStop()) return;
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

UnityDetectInfo detect(const std::string& gamePath, bool recursive)
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

    if (!recursive) { info.error = "所选目录不是可识别的 Unity 游戏，请重新选择游戏目录或主程序"; return info; }
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

void detectStream(
    const std::string& gamePath,
    const std::function<void(const std::string&)>& emitLine,
    const std::function<bool()>& shouldStop)
{
    const auto stopped = [&] { return shouldStop && shouldStop(); };
    if (stopped()) return;
    const auto emit = [&](const std::string& line) {
        if (emitLine)
            emitLine(line);
    };

    const std::string path = trimCopy(gamePath);
    emit("{\"type\":\"start\",\"path\":\"" + jsonEscape(path) + "\"}\n");
    if (stopped()) return;

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
        if (stopped()) return;
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
        if (stopped()) return;
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
            scanUnityGamesRecursive(root, 0, 16, seen, games, onGame, shouldStop);
        }
    }

    if (stopped()) return;
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
}
