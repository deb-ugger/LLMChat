#pragma once

#include "AtomicFile.h"
#include "Config.h"
#include "Utf8Path.h"
#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <nlohmann/json.hpp>
#include <set>
#include <stdexcept>
#include <array>
#ifdef _WIN32
#include <windows.h>
#endif

// The locator stays beside the executable. All moves and removals happen before
// SQLite, the WebView and background downloads open their files.
namespace storage {
namespace fs = std::filesystem;
using json = nlohmann::json;
inline fs::path base;
inline json active = json::object();
inline std::mutex mutex;
inline std::string startupError;
inline const std::vector<std::string> keys{"data", "projects", "ocr", "unity", "temp", "webview"};
inline const std::vector<std::string> dataNames{
    "config.ini", "conversations.json", "conversations.sqlite3", "usage.db",
    "usage-events.jsonl", "pricing.json", "vendor-models.json", "unity-output.log"};

inline fs::path normalized(const fs::path& p) { return fs::weakly_canonical(fs::absolute(p)); }
inline std::string pathKey(const fs::path& p)
{
    auto s = utf8path::pathUtf8(normalized(p));
#ifdef _WIN32
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
#endif
    return s;
}
inline bool within(const fs::path& child, const fs::path& parent)
{
    auto c = pathKey(child), p = pathKey(parent);
    if (c == p) return true;
    if (p.back() != '/' && p.back() != '\\') p += fs::path::preferred_separator;
    return c.starts_with(p);
}
inline bool linked(const fs::path& p)
{
#ifdef _WIN32
    auto attributes = GetFileAttributesW(p.c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return true;
#endif
    return fs::is_symlink(fs::symlink_status(p));
}
inline void rejectLinks(const fs::path& p)
{
    for (auto part = fs::absolute(p); !part.empty(); part = part.parent_path()) {
        if (linked(part)) throw std::runtime_error("路径包含符号链接或目录联接，无法管理: " + utf8path::pathUtf8(part));
        if (part == part.root_path()) break;
    }
}
inline fs::path locator() { return base / "storage-paths.json"; }
inline json readManifest()
{
    if (!fs::exists(locator())) return json::object();
    std::ifstream in(locator(), std::ios::binary);
    auto j = json::parse(in);
    if (!j.is_object()) throw std::runtime_error("存储路径配置格式错误");
    return j;
}
inline void persist(const json& j)
{
    std::string error;
    if (!atomicfile::writeText(locator(), j.dump(2, ' ', false, json::error_handler_t::replace), &error)) throw std::runtime_error(error);
}
inline fs::path get(const std::string& key)
{
    return utf8path::pathFromUtf8(active.at(key).get<std::string>());
}
inline std::vector<fs::path> dataFiles(const fs::path& dir)
{
    std::vector<fs::path> out;
    for (const auto& name : dataNames)
        for (const auto& suffix : {"", ".bak", ".tmp", "-wal", "-shm", "-journal"})
            out.push_back(dir / (name + suffix));
    return out;
}
inline bool filesEqual(const fs::path& a, const fs::path& b)
{
    if (fs::file_size(a) != fs::file_size(b)) return false;
    std::ifstream left(a, std::ios::binary), right(b, std::ios::binary);
    if (!left || !right) return false;
    std::array<char, 65536> x{}, y{};
    do {
        left.read(x.data(), x.size()); right.read(y.data(), y.size());
        if (left.gcount() != right.gcount() || !std::equal(x.begin(), x.begin() + left.gcount(), y.begin())) return false;
    } while (left && right);
    return left.eof() && right.eof();
}
inline void copyTree(const fs::path& from, const fs::path& to)
{
    rejectLinks(from);
    rejectLinks(to);
    if (!fs::exists(from)) return;
    if (linked(from)) throw std::runtime_error("不能迁移链接文件");
    if (fs::is_regular_file(from)) {
        fs::create_directories(to.parent_path());
        // Never overwrite destination data, including a previously interrupted copy.
        if (fs::exists(to)) throw std::runtime_error("迁移目标已存在: " + utf8path::pathUtf8(to));
        fs::copy_file(from, to);
        if (!filesEqual(from, to)) throw std::runtime_error("迁移文件内容校验失败");
    } else if (fs::is_directory(from)) {
        fs::create_directories(to);
        for (const auto& e : fs::directory_iterator(from)) copyTree(e.path(), to / e.path().filename());
    } else throw std::runtime_error("不支持的文件类型");
}
inline void removeTree(const fs::path& p)
{
    rejectLinks(p);
    if (!fs::exists(p)) return;
    // Do not follow junctions, even ones introduced after scheduling a cleanup.
    if (fs::is_directory(p)) {
        for (const auto& e : fs::directory_iterator(p)) removeTree(e.path());
    }
    fs::remove(p);
}
inline std::uintmax_t bytes(const fs::path& p)
{
    try {
        if (linked(p)) return 0;
        if (fs::is_regular_file(p)) return fs::file_size(p);
        std::uintmax_t n = 0;
        if (fs::is_directory(p)) for (const auto& e : fs::directory_iterator(p)) n += bytes(e.path());
        return n;
    } catch (...) { return 0; }
}
inline void validate(const json& paths, const json& current)
{
    if (!paths.is_object() || paths.size() != keys.size()) throw std::runtime_error("请提交全部六类存储路径");
    for (const auto& key : keys) {
        if (!paths.contains(key) || !paths[key].is_string()) throw std::runtime_error("存储路径缺失");
        const auto raw = paths[key].get<std::string>();
        auto p = utf8path::pathFromUtf8(raw);
        if (raw.empty() || !p.is_absolute()) throw std::runtime_error("请选择绝对路径");
        rejectLinks(p);
        p = normalized(p);
        if (p == p.root_path()) throw std::runtime_error("不能使用磁盘根目录");
        if (pathKey(p) == pathKey(utf8path::pathFromUtf8(current.at(key).get<std::string>()))) continue;
        if (within(base, p)) throw std::runtime_error("目标不能是程序目录或其父目录");
        if (fs::exists(p) && (!fs::is_directory(p) || !fs::is_empty(p)))
            throw std::runtime_error("新路径必须是不存在的目录或空目录，避免覆盖已有文件");
        for (const auto& other : keys) {
            auto old = utf8path::pathFromUtf8(current.at(other).get<std::string>());
            auto next = utf8path::pathFromUtf8(paths.at(other).get<std::string>());
            if (within(p, old) || within(old, p) || (other != key && (within(p, next) || within(next, p))))
                throw std::runtime_error("新路径不能与现有存储路径或其他新路径相互包含，请分别选择独立目录");
        }
    }
}
inline std::vector<fs::path> cleanTargets(const std::string& id)
{
    std::vector<fs::path> out;
    if (id == "chats" || id == "usage" || id == "logs") {
        for (const auto& p : dataFiles(get("data"))) {
            auto name = utf8path::pathUtf8(p.filename());
            if ((id == "chats" && name.starts_with("conversations.")) ||
                (id == "usage" && (name.starts_with("usage.db") || name.starts_with("usage-events.jsonl"))) ||
                (id == "logs" && name.starts_with("unity-output.log"))) out.push_back(p);
        }
    } else if (id == "projects") {
        auto root = get("projects");
        rejectLinks(root);
        if (fs::is_directory(root)) for (const auto& e : fs::directory_iterator(root)) {
            if (!linked(e.path()) && fs::is_directory(e.path()) &&
                (fs::is_regular_file(e.path() / "project.lcproj") || fs::is_regular_file(e.path() / "project.llmchat-proj.json")))
                out.push_back(e.path());
        }
    } else if (id == "ocr" || id == "unity" || id == "temp") {
        auto root = get(id);
        rejectLinks(root);
        if (fs::is_directory(root)) for (const auto& e : fs::directory_iterator(root)) out.push_back(e.path());
        if (id == "temp") for (const auto& name : {"llmchat-xunity", "llmchat-xunity-extract", "llmchat-noto-sc"})
            out.push_back(fs::temp_directory_path() / name);
    } else if (id == "webcache") {
        for (const auto& name : {"Cache", "Code Cache", "GPUCache", "DawnCache", "GrShaderCache", "Service Worker/CacheStorage"})
            out.push_back(get("webview") / "EBWebView" / "Default" / name);
    } else throw std::runtime_error("未知清理类别");
    return out;
}
inline json cleanupInfo()
{
    json rows = json::array();
    for (const auto& item : std::vector<std::pair<std::string, std::string>>{
        {"logs", "Unity 输出日志及备份"}, {"temp", "Unity 下载与解压临时文件（含旧版临时目录）"},
        {"webcache", "WebView 渲染、网络及浏览器下载的模型缓存（模型需重新下载；保留账号、设置和阅读记录）"},
        {"ocr", "已下载 OCR 模型（使用时需要重新下载）"}, {"unity", "Unity 安装包、字体和工具缓存"},
        {"chats", "全部聊天记录及历史备份（不可恢复）"}, {"usage", "全部用量记录及历史备份（不可恢复）"},
        {"projects", "全部托管翻译工程（包括工程内原文和译文，不可恢复）"}}) {
        auto targets = cleanTargets(item.first);
        json paths = json::array(); std::uintmax_t size = 0;
        for (const auto& p : targets) { size += bytes(p); paths.push_back(utf8path::pathUtf8(p)); }
        rows.push_back({{"id", item.first}, {"label", item.second}, {"bytes", size}, {"paths", paths},
            {"destructive", item.first == "chats" || item.first == "usage" || item.first == "projects"}});
    }
    return rows;
}
inline void initialize(const fs::path& programBase, const fs::path& profile = {}, bool applyChanges = true)
{
    base = normalized(programBase);
    auto manifest = readManifest();
    active = manifest.value("active", json::object());
    auto defaultProfile = profile;
    if (defaultProfile.empty()) {
#ifdef _WIN32
        wchar_t local[32768]{};
        GetEnvironmentVariableW(L"LOCALAPPDATA", local, 32768);
        defaultProfile = fs::path(local) / "com.llmchat.desktop";
#else
        defaultProfile = base / "webview";
#endif
    }
    auto def = [&](const std::string& key, const fs::path& p) {
        if (!active.contains(key)) active[key] = utf8path::pathUtf8(normalized(p));
    };
    def("data", base);
    ConfigStore preview((get("data") / "config.ini").string());
    auto project = utf8path::pathFromUtf8(preview.snapshot().textProjectsDir);
    if (project.empty()) project = get("data") / "text-projects";
    else if (!project.is_absolute()) project = get("data") / project;
    def("projects", project); def("ocr", get("data") / "ocr-models");
    def("unity", base / "resources"); def("temp", fs::temp_directory_path() / "llmchat-storage");
    def("webview", defaultProfile);
    for (const auto& key : keys) {
        auto p = get(key);
        if (!p.is_absolute() || normalized(p) == p.root_path()) throw std::runtime_error("存储索引含无效路径");
        rejectLinks(p);
    }
    // Failure leaves the old active paths in service and preserves all originals.
    if (applyChanges && manifest.contains("pending")) {
        try {
            auto next = manifest.at("pending");
            validate(next, active);
            for (const auto& key : keys) {
                auto from = get(key), to = utf8path::pathFromUtf8(next.at(key).get<std::string>());
                if (pathKey(from) == pathKey(to)) continue;
                if (key == "data") for (const auto& p : dataFiles(from)) copyTree(p, to / p.filename());
                else copyTree(from, to);
            }
            auto committed = manifest;
            committed["active"] = next; committed.erase("pending"); committed.erase("error");
            auto retained = committed.value("retained", json::array());
            for (const auto& key : keys) if (pathKey(get(key)) != pathKey(utf8path::pathFromUtf8(next.at(key).get<std::string>())))
                retained.push_back({{"id", key}, {"path", active.at(key)}});
            committed["retained"] = retained;
            persist(committed); manifest = std::move(committed); active = next;
        } catch (const std::exception& e) {
            startupError = "路径迁移未完成，继续使用原路径：" + std::string(e.what());
            manifest["error"] = startupError;
            persist(manifest);
        }
    }
    if (applyChanges && !manifest.contains("pending") && manifest.contains("cleanup")) {
        json remaining = json::array();
        for (const auto& id : manifest.at("cleanup")) {
            try { for (const auto& p : cleanTargets(id.get<std::string>())) removeTree(p); }
            catch (const std::exception& e) { remaining.push_back(id); startupError += std::string(e.what()) + "；"; }
        }
        manifest["cleanup"] = remaining;
        if (!startupError.empty()) manifest["error"] = startupError;
        else manifest.erase("error");
    }
    manifest["active"] = active;
    // Do not create a locator just by running an unconfigured standalone backend.
    if (fs::exists(locator()) || !profile.empty()) persist(manifest);
}
inline json status()
{
    std::lock_guard lock(mutex);
    auto manifest = readManifest();
    json entries = json::array();
    const std::vector<std::string> labels{"软件数据", "翻译工程", "OCR 模型", "Unity 资源缓存", "临时文件", "WebView 用户数据"};
    const std::vector<std::string> descriptions{
        "config.ini（含 API 配置）、conversations.sqlite3、usage.db、旧版 JSON/JSONL、pricing.json、vendor-models.json、unity-output.log，以及 .bak/.tmp 和 SQLite 辅助文件。仅迁移这些软件数据文件。",
        "每个工程的 project.lcproj、原文、译文和导出文件。可清理带工程标识的子目录；用户在其他位置另存的文件不会被清理。",
        "下载的 PaddleOCR / Manga OCR 模型、分词器与下载中 .part 文件。内置快速模型打包在程序中。",
        "resources 下的 bepinex 安装包、fonts 字体 / TMP 资源包、tools 工具。游戏目录内的补丁和配置由 Unity 页面管理。",
        "Unity 下载、解压及字体处理临时文件。旧版在系统临时目录留下的 llmchat-xunity、llmchat-xunity-extract、llmchat-noto-sc 也可清理。",
        "WebView2 的 EBWebView：界面偏好、模型连接档案（可能含密钥）、PDF/EPUB 阅读记录（IndexedDB）、网络/图形缓存，以及通过浏览器下载的语音模型（Service Worker/CacheStorage）。迁移时完整保留，仅缓存清理不会删除档案。"};
    for (size_t i = 0; i < keys.size(); ++i) {
        auto key = keys[i]; auto p = get(key); std::uintmax_t size = 0;
        if (key == "data") for (const auto& f : dataFiles(p)) size += bytes(f);
        else size = bytes(p);
        entries.push_back({{"id", key}, {"label", labels[i]}, {"path", utf8path::pathUtf8(p)},
            {"description", descriptions[i]}, {"bytes", size}, {"exists", fs::exists(p)}});
    }
    return {{"ok", true}, {"entries", entries}, {"cleanupOptions", cleanupInfo()},
        {"pending", manifest.value("pending", json(nullptr))}, {"cleanup", manifest.value("cleanup", json::array())},
        {"error", manifest.value("error", startupError)}, {"locator", utf8path::pathUtf8(locator())},
        {"programDir", utf8path::pathUtf8(base)}, {"retained", manifest.value("retained", json::array())}};
}
inline void schedulePaths(json paths)
{
    std::lock_guard lock(mutex);
    validate(paths, active);
    for (const auto& key : keys) paths[key] = utf8path::pathUtf8(normalized(utf8path::pathFromUtf8(paths[key].get<std::string>())));
    auto manifest = readManifest(); manifest["active"] = active;
    if (paths == active) manifest.erase("pending"); else manifest["pending"] = paths;
    manifest.erase("error"); persist(manifest);
}
inline void scheduleCleanup(const json& ids)
{
    std::lock_guard lock(mutex);
    if (!ids.is_array()) throw std::runtime_error("清理类别格式错误");
    std::set<std::string> seen;
    for (const auto& id : ids) { auto s = id.get<std::string>(); cleanTargets(s); seen.insert(s); }
    auto manifest = readManifest(); manifest["active"] = active; manifest["cleanup"] = seen;
    manifest.erase("error"); persist(manifest);
}
} // namespace storage
