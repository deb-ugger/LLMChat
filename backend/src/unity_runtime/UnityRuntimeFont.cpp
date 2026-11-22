#include "UnityRuntimeFont.h"

#ifdef _WIN32
#include "StoragePaths.h"
#include "UnityGameDetection.h"
#include "UnityRuntimeDownload.h"
#include "Utf8Path.h"

#include <algorithm>
#include <cctype>
#include <fstream>
#include <iterator>

namespace fs = std::filesystem;
using utf8path::pathFromUtf8;
using utf8path::pathUtf8;

namespace unity_runtime
{
namespace
{
using detail::iequals;

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
fs::path tmpFontBundlesCacheDir()
{
    return fontsCacheDir() / "tmp-bundles";
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
    // Reject Git LFS pointer stubs / truncated downloads
    return resolveCachedArtifact({fontsCacheDir() / pathFromUtf8(kNotoScFileName), 200 * 1024});
}

bool downloadNotoFontToCache(
    std::vector<std::string>& steps, std::string& error,
    const UnityInstallControl* control, const FontArchiveOperations& archives)
{
    const fs::path cached = findCachedNotoFont();
    if (!cached.empty())
        return true;

    const fs::path cacheDir = fontsCacheDir();
    fs::create_directories(cacheDir);
    const fs::path dest = cacheDir / pathFromUtf8(kNotoScFileName);

    steps.push_back(std::string("下载中文字体 ") + kNotoScFileName + " 到 resources/fonts/");
    if (downloadFile(kNotoScDownloadUrl, dest, control, error))
    {
        const fs::path ok = findCachedNotoFont();
        if (!ok.empty())
            return true;
        std::error_code ec;
        fs::remove(dest, ec);
        error = "字体下载不完整（可能是镜像返回了占位文件）";
    }

    // Fallback: language zip from GitHub Releases, extract Regular OTF
    storage::TemporaryDirectory temporary("noto-sc");
    const fs::path& tempDir = temporary.path;
    const fs::path zipPath = tempDir / L"NotoSansCJKsc.zip";
    steps.push_back("回退：下载 Noto Sans CJK SC 压缩包");
    std::string zipErr;
    if (!downloadFile(kNotoScZipUrl, zipPath, control, zipErr))
    {
        if (error.empty())
            error = zipErr;
        else
            error += "；回退下载也失败: " + zipErr;
        return false;
    }
    steps.push_back("解压 Noto Sans CJK SC");
    if (!archives.extractZip(zipPath, tempDir, zipErr))
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

bool ensureTmpFontBundlesCached(
    std::vector<std::string>& steps, std::string& error,
    const UnityInstallControl* control, const FontArchiveOperations& archives)
{
    if (tmpBundlesReady())
        return true;

    const fs::path sevenZr = ensureSevenZr(steps, control, error);
    if (sevenZr.empty())
        return false;

    const fs::path archive = fontsCacheDir() / pathFromUtf8(kTmpFontBundle7zName);
    std::error_code ec;
    fs::create_directories(fontsCacheDir(), ec);
    if (!fs::exists(archive, ec) || fs::file_size(archive, ec) < 1024 * 1024)
    {
        steps.push_back(
            "下载 TextMeshPro 中文字体资源包（约 130MB，仅首次；解决译文显示为口）");
        if (!downloadFile(kTmpFontBundle7zUrl, archive, control, error))
            return false;
    }

    const fs::path outDir = tmpFontBundlesCacheDir();
    fs::create_directories(outDir, ec);
    steps.push_back("解压 TMP 字体资源包到 resources/fonts/tmp-bundles/");
    // 7zr: -oPATH has no space after -o
    const std::wstring args = L"x \"" + archive.wstring() + L"\" -o\"" + outDir.wstring() + L"\" -y";
    if (!archives.runTool(sevenZr, args, error))
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
}

/**
 * Configure fonts for CJK target language:
 * - UGUI: system face (YaHei etc.) or downloaded OTF path
 * - TextMeshPro: prefer existing version-matched asset in game dir (ziti_Unity_YYYY),
 *   else install official arialuni_sdf_* and set Override+Fallback
 */
CjkFontSettings resolveRuntimeFonts(
    const fs::path& gameDir,
    const std::string& language,
    const UnityInstallControl* control,
    std::vector<std::string>& steps,
    std::string& warning,
    const FontArchiveOperations& archives)
{
    CjkFontSettings fonts;
    warning.clear();
    if (!isCjkTargetLanguage(language))
    {
        steps.push_back("目标语言非中文，跳过字体处理");
        return fonts;
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
        if (downloadNotoFontToCache(steps, err, control, archives))
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
        return fonts;
    }

    // 2) Install official arialuni pack
    const std::string preferred = preferredTmpFontAssetName(unityVer);
    std::string tmpErr;
    if (!ensureTmpFontBundlesCached(steps, tmpErr, control, archives))
    {
        const std::string msg =
            tmpErr.empty() ? "无法下载/解压 TMP 字体资源包" : tmpErr;
        steps.push_back("TMP 字体失败: " + msg);
        if (warning.empty())
            warning = msg
                + "。若译文仍显示为「口」，请检查网络后重试「修复缺字字体」";
        return fonts;
    }

    const fs::path assetSrc = findTmpFontAssetInCache(preferred);
    if (assetSrc.empty())
    {
        warning = "TMP 字体包中未找到可用的 arialuni_sdf 资源";
        steps.push_back(warning);
        return fonts;
    }

    const std::string assetName = pathUtf8(assetSrc.filename());
    const fs::path assetDst = gameDir / pathFromUtf8(assetName);
    std::error_code ec;
    fs::copy_file(assetSrc, assetDst, fs::copy_options::overwrite_existing, ec);
    if (ec)
    {
        warning = "无法将 TMP 字体复制到游戏目录: " + ec.message();
        steps.push_back(warning);
        return fonts;
    }
    fonts.tmpFont = assetName;
    steps.push_back(
        "TMP：已安装 " + assetName + "（Override+Fallback，解决译文缺字）");
    if (!iequals(assetName, preferred))
        steps.push_back("（优选 " + preferred + " 不可用，已改用 " + assetName + "）");
    return fonts;
}

/** Upsert UGUI/TMP font keys + redirected-resource strategy in an AutoTranslator ini. */
std::string applyFontOverrides(std::string content, const CjkFontSettings& fonts)
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

std::string checkRuntimeFontStatus(const fs::path& gameDir, const CjkFontSettings& fonts)
{
    const auto& [ugui, tmpFont] = fonts;
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
        std::ifstream log(logPath, std::ios::binary);
        std::string lower((std::istreambuf_iterator<char>(log)), std::istreambuf_iterator<char>());
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
}
#endif
