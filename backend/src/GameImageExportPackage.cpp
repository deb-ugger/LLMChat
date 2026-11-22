#include "GameImageExportPackage.h"

#include <utility>

namespace gameimageexport {

Error::Error(std::string code, std::string message, std::string detail)
    : std::runtime_error(std::move(message)), code(std::move(code)), detail(std::move(detail)) {}

} // namespace gameimageexport

#ifdef _WIN32
#include "RpgImageProject.h"

#include <algorithm>
#include <array>
#include <bcrypt.h>
#include <chrono>
#include <cstddef>
#include <ctime>
#include <exception>
#include <map>
#include <memory>
#include <set>

#pragma comment(lib, "bcrypt.lib")

namespace gameimageexport {
namespace {

using Path = std::filesystem::path;
using Json = nlohmann::json;
namespace fs = std::filesystem;

constexpr uint64_t maxImageBytes = 512ull << 20;
constexpr uint64_t maxMetadataBytes = 32ull << 20;
constexpr uint64_t maxPixels = 64ull << 20;
constexpr uint64_t maxWorkingBytes = 1ull << 30;

std::string utf8(const Path& path) { return utf8path::pathUtf8(path); }

std::string hex(const unsigned char* bytes, size_t size) {
    std::string result;
    result.reserve(size * 2);
    for (size_t i = 0; i < size; ++i) {
        result += "0123456789abcdef"[bytes[i] >> 4];
        result += "0123456789abcdef"[bytes[i] & 15];
    }
    return result;
}

void requireHash(NTSTATUS status) {
    if (status < 0) throw Error("HASH_FAILED", "无法计算 SHA-256");
}

class Sha256 {
    BCRYPT_HASH_HANDLE hash_ = nullptr;
public:
    Sha256() { requireHash(BCryptCreateHash(BCRYPT_SHA256_ALG_HANDLE, &hash_, nullptr, 0, nullptr, 0, 0)); }
    ~Sha256() { BCryptDestroyHash(hash_); }
    Sha256(const Sha256&) = delete;
    Sha256& operator=(const Sha256&) = delete;

    void add(std::string_view bytes) {
        requireHash(BCryptHashData(hash_, reinterpret_cast<PUCHAR>(const_cast<char*>(bytes.data())),
            static_cast<ULONG>(bytes.size()), 0));
    }

    void field(std::string_view value) {
        add(value);
        add(std::string_view("\0", 1));
    }

    std::string finish() {
        std::array<unsigned char, 32> digest{};
        requireHash(BCryptFinishHash(hash_, digest.data(), static_cast<ULONG>(digest.size()), 0));
        return hex(digest.data(), digest.size());
    }
};

std::string hash(std::string_view bytes) {
    Sha256 digest;
    digest.add(bytes);
    return digest.finish();
}

bool hexString(std::string_view text) {
    return !text.empty() && text.find_first_not_of("0123456789abcdef") == std::string_view::npos;
}

bool uuid(std::string_view value) {
    if (value.size() != 36) return false;
    for (size_t i = 0; i < value.size(); ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (value[i] != '-') return false;
        } else if (!hexString(value.substr(i, 1))) return false;
    }
    return true;
}

std::string newId() {
    std::array<unsigned char, 16> data{};
    if (BCryptGenRandom(nullptr, data.data(), static_cast<ULONG>(data.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
        throw Error("IO_ERROR", "无法创建导出编号");
    data[6] = (data[6] & 0xf) | 0x40;
    data[8] = (data[8] & 0x3f) | 0x80;
    const auto value = hex(data.data(), data.size());
    return value.substr(0, 8) + "-" + value.substr(8, 4) + "-" + value.substr(12, 4) + "-" +
        value.substr(16, 4) + "-" + value.substr(20);
}

int ordinal(std::wstring_view left, std::wstring_view right) {
    const auto result = CompareStringOrdinal(left.data(), static_cast<int>(left.size()),
        right.data(), static_cast<int>(right.size()), TRUE);
    if (!result) throw Error("INVALID_PATH", "无法比较 Windows 路径");
    return result;
}

struct CaseLess {
    bool operator()(const std::wstring& left, const std::wstring& right) const {
        return ordinal(left, right) == CSTR_LESS_THAN;
    }
};

bool reserved(std::wstring_view name) {
    auto stem = name.substr(0, name.find(L'.'));
    while (!stem.empty() && stem.back() == L' ') stem.remove_suffix(1);
    if (stem.empty()) return false;
    for (const auto device : {L"CON", L"PRN", L"AUX", L"NUL", L"CONIN$", L"CONOUT$"})
        if (ordinal(stem, device) == CSTR_EQUAL) return true;
    return stem.size() == 4 && std::wstring_view(L"123456789¹²³").find(stem.back()) != std::wstring_view::npos &&
        (ordinal(stem.substr(0, 3), L"COM") == CSTR_EQUAL || ordinal(stem.substr(0, 3), L"LPT") == CSTR_EQUAL);
}

bool illegal(wchar_t c) {
    return c < 32 || (c >= 127 && c <= 159) || std::wstring_view(L"<>:\"/\\|?*").find(c) != std::wstring_view::npos;
}

bool validComponent(std::wstring_view value) {
    return !value.empty() && value != L"." && value != L".." && value.back() != L'.' && value.back() != L' ' &&
        std::none_of(value.begin(), value.end(), illegal) && !reserved(value) && value.size() <= 255;
}

Path relative(const std::string& text) {
    if (text.size() > 32767 * 4) throw Error("INVALID_PATH", "资源路径过长");
    Path result;
    for (size_t begin = 0;;) {
        const auto end = text.find('/', begin);
        const auto count = static_cast<int>((end == std::string::npos ? text.size() : end) - begin);
        const auto length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data() + begin, count, nullptr, 0);
        std::wstring part(static_cast<size_t>(length), L'\0');
        if (!length || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data() + begin, count, part.data(), length) ||
            !validComponent(part))
            throw Error("INVALID_PATH", "资源路径含非法路径段：" +
                Json(text).dump(-1, ' ', false, Json::error_handler_t::replace), text);
        result /= part;
        if (end == std::string::npos) break;
        begin = end + 1;
    }
    return result;
}

struct Handle {
    HANDLE value = INVALID_HANDLE_VALUE;
    explicit Handle(HANDLE value = INVALID_HANDLE_VALUE) : value(value) {}
    ~Handle() { if (*this) CloseHandle(value); }
    Handle(Handle&& other) noexcept : value(std::exchange(other.value, INVALID_HANDLE_VALUE)) {}
    Handle& operator=(Handle&& other) noexcept {
        if (*this) CloseHandle(value);
        value = std::exchange(other.value, INVALID_HANDLE_VALUE);
        return *this;
    }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    explicit operator bool() const { return value && value != INVALID_HANDLE_VALUE; }
};

[[noreturn]] void winError(const char* code, const char* action, const Path& path, DWORD status) {
    auto detail = utf8(path);
    throw Error(code, std::string(action) + "：" + detail + "（Windows " + std::to_string(status) + "）", detail);
}

Handle openNode(const Path& path, bool directory, bool optional = false, DWORD extraAccess = 0) {
    const DWORD access = (directory ? FILE_READ_ATTRIBUTES : GENERIC_READ) | extraAccess;
    const DWORD share = FILE_SHARE_READ | (directory ? FILE_SHARE_WRITE : 0);
    Handle handle(CreateFileW(path.c_str(), access, share, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    if (!handle) {
        const auto status = GetLastError();
        if (optional && (status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND)) return Handle();
        const auto code = status == ERROR_SHARING_VIOLATION ? "BUSY" : "IO_ERROR";
        winError(code, "无法只读打开路径", path, status);
    }
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(handle.value, &info))
        winError("IO_ERROR", "无法读取文件信息", path, GetLastError());
    if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        directory != ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) ||
        (!directory && info.nNumberOfLinks != 1)) {
        const auto detail = utf8(path);
        throw Error("INVALID_PATH", "路径包含链接、重解析点或非预期文件类型：" + detail, detail);
    }
    return handle;
}

std::string identity(const Handle& handle, const Path& path) {
    FILE_ID_INFO info{};
    if (!GetFileInformationByHandleEx(handle.value, FileIdInfo, &info, sizeof(info)))
        winError("IO_ERROR", "无法读取路径标识", path, GetLastError());
    return std::to_string(info.VolumeSerialNumber) + "-" + hex(info.FileId.Identifier, sizeof(info.FileId.Identifier));
}

std::vector<Handle> pinParents(const Path& root, const Path& name) {
    auto current = root;
    std::vector<Handle> entries;
    for (const auto& part : name.parent_path()) {
        current /= part;
        auto directory = openNode(current, true, true);
        if (!directory) return {};
        entries.push_back(std::move(directory));
    }
    return entries;
}

Handle openSource(const Path& root, const Path& name, bool optional = false) {
    // Once the leaf is open its content stays fixed. Parent handles prevent
    // a directory from being exchanged for a reparse point while opening it.
    auto parents = pinParents(root, name);
    if (name.has_parent_path() && parents.empty()) {
        if (optional) return Handle();
        throw Error("INPUT_STALE", "输入文件已不存在：" + utf8(name), utf8(name));
    }
    auto file = openNode(root / name, false, true);
    if (!file && !optional) throw Error("INPUT_STALE", "输入文件已不存在：" + utf8(name), utf8(name));
    return file;
}

struct Root {
    Path path;
    std::vector<Handle> handles;
    std::vector<std::string> ids;

    explicit Root(const Path& requested) {
        if (!requested.is_absolute() || requested.native().starts_with(L"\\\\?\\") ||
            requested.native().starts_with(L"\\\\.\\"))
            throw Error("INVALID_PATH", "请选择普通绝对目录路径", utf8(requested));
        path = requested.root_path();
        const auto tail = requested.relative_path();
        auto part = tail.begin();
        if (requested.root_name().native().starts_with(L"\\\\")) {
            if (part == tail.end() || !validComponent(part->native()))
                throw Error("INVALID_PATH", "无效的网络共享目录", utf8(requested));
            path /= *part++;
        }
        append({});
        for (; part != tail.end(); ++part) {
            if (part->empty()) continue;
            if (!validComponent(part->native()))
                throw Error("INVALID_PATH", "目录路径中包含非法路径段", utf8(requested));
            append(*part);
        }
    }

private:
    void append(const Path& part) {
        if (!part.empty()) path /= part;
        handles.push_back(openNode(path, true));
        ids.push_back(identity(handles.back(), path));
    }
};

class DirectoryLock {
    Handle mutex_;
public:
    explicit DirectoryLock(const std::string& identity)
        : mutex_(CreateMutexW(nullptr, TRUE, utf8path::toWide("Global\\LLMChat-game-image-export-" + identity).c_str())) {
        const auto status = GetLastError();
        if (!mutex_) throw Error("IO_ERROR", "无法创建导出目录锁");
        if (status == ERROR_ALREADY_EXISTS) throw Error("BUSY", "同一目录已有成品导出任务");
    }

    ~DirectoryLock() { ReleaseMutex(mutex_.value); }
};

uint64_t length(const Handle& file, const Path& path) {
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file.value, &size))
        winError("IO_ERROR", "无法读取文件长度", path, GetLastError());
    return static_cast<uint64_t>(size.QuadPart);
}

template<class Consume>
void readChunks(const Handle& file, const Path& path, Consume consume) {
    std::array<char, 65536> buffer{};
    DWORD count;
    do {
        if (!ReadFile(file.value, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr))
            winError("IO_ERROR", "读取文件失败", path, GetLastError());
        if (count) consume(std::string_view(buffer.data(), count));
    } while (count);
}

std::string read(const Handle& file, const Path& path, uint64_t limit = maxMetadataBytes) {
    const auto size = length(file, path);
    if (size > limit) throw Error("INPUT_TOO_LARGE", "输入文件超出允许大小：" + utf8(path), utf8(path));
    std::string bytes;
    bytes.reserve(static_cast<size_t>(size));
    readChunks(file, path, [&](std::string_view chunk) { bytes.append(chunk); });
    if (bytes.size() != size) throw Error("INPUT_STALE", "读取期间文件大小改变：" + utf8(path), utf8(path));
    return bytes;
}

void writeChunk(const Handle& file, const Path& path, std::string_view bytes) {
    DWORD count = 0;
    if (!WriteFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) || count != bytes.size())
        winError("OUTPUT_WRITE_FAILED", "写入成品失败", path, GetLastError());
}

Handle newFile(const Path& path) {
    Handle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!file) winError("OUTPUT_WRITE_FAILED", "无法创建成品文件", path, GetLastError());
    return file;
}

std::vector<Handle> createParents(const Path& root, const Path& name) {
    auto current = root;
    std::vector<Handle> pins;
    for (const auto& part : name.parent_path()) {
        current /= part;
        if (!CreateDirectoryW(current.c_str(), nullptr)) {
            const auto status = GetLastError();
            if (status != ERROR_ALREADY_EXISTS)
                winError("OUTPUT_WRITE_FAILED", "无法创建成品目录", current, status);
        }
        pins.push_back(openNode(current, true));
    }
    return pins;
}

std::string write(const Path& root, const Path& name, std::string_view bytes) {
    const auto parents = createParents(root, name);
    const auto path = root / name;
    const auto file = newFile(path);
    Sha256 digest;
    while (!bytes.empty()) {
        const auto chunk = bytes.substr(0, 65536);
        writeChunk(file, path, chunk);
        digest.add(chunk);
        bytes.remove_prefix(chunk.size());
    }
    if (!FlushFileBuffers(file.value))
        winError("OUTPUT_WRITE_FAILED", "无法刷盘", path, GetLastError());
    return digest.finish();
}

Json parse(const Handle& file, const Path& path) {
    try {
        return Json::parse(read(file, path));
    } catch (const Json::exception& error) {
        throw Error("INPUT_STALE", "项目 JSON 无效：" + utf8(path) + "，" + error.what(), utf8(path));
    }
}

void cancel(const Control& control) {
    if (control.cancelled && control.cancelled()) throw Error("CANCELLED", "已取消生成成品");
}

void copySnapshot(const Handle& source, const Path& path, const Control& control) {
    const auto file = newFile(path);
    readChunks(source, path, [&](std::string_view chunk) { cancel(control); writeChunk(file, path, chunk); });
}

void report(const Control& control, std::string_view phase, size_t done, size_t total, std::string_view path = {}) {
    if (control.progress) control.progress({phase, done, total, path});
    cancel(control);
}

struct Engine {
    std::string name;
    Path marker;
    Path imageRoot;
};

bool hasFile(const Path& root, const Path& file) { return bool(openSource(root, file, true)); }

Engine detectEngine(const Path& game) {
    for (const auto marker : {L"Data/BasicData/Game.dat", L"Data/BasicData.wolf", L"Data.wolf"})
        if (hasFile(game, marker)) return {"wolf", marker, L"Data"};
    if (hasFile(game, L"www/data/System.json")) return {"rpg-maker-mv", L"www/data/System.json", L"www/img"};
    if (hasFile(game, L"data/System.json")) {
        const bool mv = hasFile(game, L"js/rpg_core.js");
        const bool mz = hasFile(game, L"js/rmmz_core.js");
        if (mv != mz) return {mz ? "rpg-maker-mz" : "rpg-maker-mv", L"data/System.json", L"img"};
    }
    throw Error("UNSUPPORTED_ENGINE", "请选择可识别的 RPG Maker MV/MZ 或 WOLF RPG 游戏目录");
}

void targetPath(const Path& root, const Engine& engine, const Json& row, const Path& file, const std::string& name) {
    auto it = file.begin();
    for (const auto& prefix : engine.imageRoot) {
        if (it == file.end() || ordinal(it->native(), prefix.native()) != CSTR_EQUAL)
            throw Error("INVALID_PATH", "目标不在引擎图片目录内：" + name, name);
        ++it;
    }
    if (it == file.end() || !gameresourcebackup::isImage(file) ||
        (engine.name == "wolf" && gameresourcebackup::imageExtension(file) != ".png"))
        throw Error("INVALID_PATH", "不是支持的游戏图片路径：" + name, name);
    if (engine.name != "wolf") return;
    const auto reject = [&](const std::string& archive) {
        throw Error("WOLF_ARCHIVE_ENTRY_UNSUPPORTED", "首版无法导出 WOLF 封包中的图片：" + name + "（" + archive + "）", name);
    };
    if (row.contains("archive")) reject(row.at("archive").get<std::string>());
    Path directory;
    for (const auto& part : file.parent_path()) {
        directory /= part;
        auto archive = directory;
        archive += L".wolf";
        if (hasFile(root, archive)) reject(utf8(archive));
    }
}

struct Selection {
    const ImageSelection* expected;
    const Json* row;
    std::string name;
    Path relative;
};

using Rows = std::map<std::string, Json>;

void removeTree(const Path& path);

Rows stateRows(const Path& game, const Path& stage, const Path& folder, const Control& control) {
    Rows rows;
    const auto dbPath = folder / "state.sqlite3";
    auto database = openSource(game, dbPath, true);
    if (database) {
        const auto walPath = folder / "state.sqlite3-wal";
        const auto wal = openSource(game, walPath, true);
        // The existing game mutex and deny-write handles freeze the pair while
        // it is copied. SQLite only opens the copies and writes SHM in staging.
        const auto snapshot = stage / ".snapshot";
        if (!CreateDirectoryW(snapshot.c_str(), nullptr))
            winError("OUTPUT_WRITE_FAILED", "无法创建项目暂存目录", snapshot, GetLastError());
        {
            const auto pins = openNode(snapshot, true);
            copySnapshot(database, snapshot / "state.sqlite3", control);
            if (wal) copySnapshot(wal, snapshot / "state.sqlite3-wal", control);
            auto& api = sqlite_support::sqliteApi();
            if (!api.ready()) throw Error("IO_ERROR", "Windows SQLite 不可用");
            sqlite_support::sqlite3* raw = nullptr;
            const int status = api.openV2(utf8(snapshot / "state.sqlite3").c_str(), &raw,
                sqlite_support::kSqliteOpenReadWrite, nullptr);
            std::unique_ptr<sqlite_support::sqlite3, decltype(api.close)> db(raw, api.close);
            if (status != sqlite_support::kSqliteOk) throw Error("INPUT_STALE", "无法打开项目数据库快照");
            sqlite_support::Statement version(api, db.get(), "PRAGMA user_version");
            if (!version.valid() || api.step(version.get()) != sqlite_support::kSqliteRow)
                throw Error("INPUT_STALE", "无法读取项目数据库版本");
            if (api.columnInt64(version.get(), 0) == 1) {
                sqlite_support::Statement query(api, db.get(), "SELECT id,payload FROM image_state");
                if (!query.valid()) throw Error("INPUT_STALE", "无法读取项目图片状态");
                int next;
                while ((next = api.step(query.get())) == sqlite_support::kSqliteRow) {
                    cancel(control);
                    rows.emplace(sqlite_support::columnText(api, query.get(), 0),
                        Json::parse(sqlite_support::columnText(api, query.get(), 1)));
                }
                if (next != sqlite_support::kSqliteDone) throw Error("INPUT_STALE", "项目图片状态读取失败");
            } else {
                database = Handle();
            }
        }
        removeTree(snapshot);
        if (database) return rows;
    }
    const auto legacy = folder / "state";
    auto pins = pinParents(game, legacy / "entry");
    if (pins.empty()) return rows;
    for (const auto& entry : fs::directory_iterator(game / legacy)) {
        cancel(control);
        if (entry.path().extension() != ".json") continue;
        const auto file = openNode(entry.path(), false);
        auto value = parse(file, entry.path());
        rows.insert_or_assign(value.at("id").get<std::string>(), std::move(value));
    }
    return rows;
}

void removeTree(const Path& path) {
    {
        const auto pin = openNode(path, true);
        for (const auto& item : fs::directory_iterator(path)) {
            const auto child = item.path();
            const auto attributes = GetFileAttributesW(child.c_str());
            if (attributes == INVALID_FILE_ATTRIBUTES)
                winError("CLEANUP_FAILED", "无法读取暂存项", child, GetLastError());
            if (attributes & FILE_ATTRIBUTE_REPARSE_POINT)
                throw Error("CLEANUP_FAILED", "暂存中出现重解析点，保留目录供检查", utf8(path));
            if (attributes & FILE_ATTRIBUTE_DIRECTORY) removeTree(child);
            else {
                // A hard link under staging still changes the shared file's
                // link count when removed. Leave unexpected entries untouched.
                openNode(child, false);
                if (!DeleteFileW(child.c_str())) winError("CLEANUP_FAILED", "无法清理暂存文件", child, GetLastError());
            }
        }
    }
    if (!RemoveDirectoryW(path.c_str())) winError("CLEANUP_FAILED", "无法清理暂存目录", path, GetLastError());
}

constexpr std::string_view markerPrefix = "llmchat-game-image-export-v1:";
constexpr std::wstring_view markerSuffix = L".export-owner";

void eraseMarker(const Path& path) {
    if (!DeleteFileW(path.c_str())) winError("CLEANUP_FAILED", "无法清理生成标记", path, GetLastError());
}

void cleanAbandoned(const Path& output) {
    for (const auto& item : fs::directory_iterator(output)) {
        const auto name = item.path().filename().native();
        if (name.size() != 37 + markerSuffix.size() || name.front() != L'.' || !name.ends_with(markerSuffix)) continue;
        auto id = utf8path::toUtf8(name.substr(1, 36));
        if (!uuid(id)) continue;
        const auto marker = item.path();
        bool owned;
        {
            const auto handle = openNode(marker, false);
            owned = read(handle, marker, 1024) == std::string(markerPrefix) + id;
        }
        if (!owned) continue;
        const auto stage = output / ("." + id + ".partial");
        if (openNode(stage, true, true)) removeTree(stage);
        eraseMarker(marker);
    }
}

std::string formattedTime(std::tm utc, const char* format) {
    char buffer[32]{};
    if (!std::strftime(buffer, sizeof(buffer), format, &utc)) throw Error("IO_ERROR", "无法格式化生成时间");
    return buffer;
}

std::wstring gameName(std::wstring name) {
    std::erase_if(name, illegal);
    if (name.size() > 60) {
        name.resize(60);
        if (name.back() >= 0xd800 && name.back() <= 0xdbff) name.pop_back();
    }
    while (!name.empty() && (name.back() == L'.' || name.back() == L' ')) name.pop_back();
    return name.empty() || reserved(name) ? L"game" : name;
}

void publish(const Handle& source, const Path& target) {
    const auto nameBytes = target.native().size() * sizeof(wchar_t);
    const auto size = offsetof(FILE_RENAME_INFO, FileName) + nameBytes + sizeof(wchar_t);
    std::vector<std::byte> buffer(size);
    const auto rename = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
    rename->ReplaceIfExists = FALSE;
    rename->FileNameLength = static_cast<DWORD>(nameBytes);
    std::memcpy(rename->FileName, target.c_str(), nameBytes);
    if (!SetFileInformationByHandle(source.value, FileRenameInfo, rename, static_cast<DWORD>(size))) {
        const auto status = GetLastError();
        if (status == ERROR_ALREADY_EXISTS || status == ERROR_FILE_EXISTS ||
            GetFileAttributesW(target.c_str()) != INVALID_FILE_ATTRIBUTES)
            throw Error("OUTPUT_EXISTS", "同名成品目录已存在：" + utf8(target), utf8(target));
        winError("OUTPUT_WRITE_FAILED", "无法发布成品目录", target, status);
    }
}

void verifyBoxes(const Json& layer, uint32_t width, uint32_t height, bool translation) {
    const auto mode = layer.at("maskMode").get<std::string>();
    const auto& boxes = layer.at("boxes");
    if (!boxes.is_array() || (mode != "boxes" && mode != "whole-image") ||
        (mode == "whole-image" && (!boxes.empty() || !translation)) || (mode == "boxes" && boxes.empty()))
        throw Error("INPUT_STALE", "确认记录的蒙版范围无效");
    const auto& group = layer.at("groupId");
    if (!group.is_null() && !group.is_string()) throw Error("INPUT_STALE", "确认记录的分组无效");
    std::set<std::pair<std::string, std::array<int64_t, 4>>> seen;
    unsigned translated = 0, repaired = 0, protectedCount = 0;
    for (const auto& box : boxes) {
        const auto role = box.at("role").get<std::string>();
        const auto& rect = box.at("rect");
        if (!rect.is_array() || rect.size() != 4 ||
            !std::all_of(rect.begin(), rect.end(), [](const auto& coordinate) { return coordinate.is_number_integer(); }))
            throw Error("INPUT_STALE", "确认记录的蒙版坐标无效");
        const auto coordinates = rect.get<std::array<int64_t, 4>>();
        const auto [left, top, right, bottom] = coordinates;
        if (left < 0 || top < 0 || right <= left || bottom <= top ||
            right > width || bottom > height || !seen.emplace(role, coordinates).second)
            throw Error("INPUT_STALE", "确认记录的蒙版坐标无效或重复");
        std::string id;
        if (translation && role == "translate") id = "t" + std::to_string(++translated);
        else if (!translation && role == "repair") id = "m" + std::to_string(++repaired);
        else if (!translation && role == "protect") id = "p" + std::to_string(++protectedCount);
        if (id.empty() || box.at("id") != id) throw Error("INPUT_STALE", "确认记录的蒙版编号无效");
    }
    if (!translation && !repaired) throw Error("INPUT_STALE", "去码确认记录缺少重绘框");
}

struct Layer {
    Json record;
    std::string pixels;
};

} // namespace

class PackageGenerator {
    const Request& request_;
    const Control& control_;
    const Path& game_;
    const Path& stage_;
    const Path projectDir_;
    const Engine engine_;

    Json catalog(RpgImageProject& project) const {
        if (project.restored_.contains(game_)) return project.catalogs_.at(game_);
        const auto file = projectDir_ / "project.json";
        auto projectJson = parse(openSource(game_, file), game_ / file);
        const auto rows = stateRows(game_, stage_, projectDir_, control_);
        for (auto& image : projectJson.at("images")) {
            cancel(control_);
            const auto saved = rows.find(image.at("id").get<std::string>());
            if (saved != rows.end() && saved->second.at("sourceHash") == image.at("sourceHash")) image = saved->second;
        }
        return projectJson;
    }

    std::vector<Selection> selections(const Json& project) const {
        std::map<std::string, const Json*> rows;
        for (const auto& image : project.at("images"))
            if (!rows.emplace(image.at("id").get<std::string>(), &image).second)
                throw Error("INPUT_STALE", "项目索引中出现重复图片编号");
        std::set<std::string> ids;
        std::set<std::wstring, CaseLess> targets;
        std::vector<Selection> selected;
        for (const auto& image : request_.images) {
            cancel(control_);
            if (!hexString(image.imageId) || image.imageId.size() > 16 ||
                (!image.translation && !image.mosaic) || !ids.insert(image.imageId).second)
                throw Error("INVALID_REQUEST", "图片编号或导出层无效：" + image.imageId, image.imageId);
            const auto found = rows.find(image.imageId);
            if (found == rows.end() || found->second->at("sourceHash") != image.sourceHash ||
                image.sourceHash.empty() || image.sourceHash.find_first_not_of("0123456789-") != std::string::npos)
                throw Error("INPUT_STALE", "图片版本已改变，请重新确认：" + image.imageId, image.imageId);
            const auto& row = *found->second;
            auto name = row.at("file").get<std::string>();
            auto file = relative(name);
            targetPath(game_, engine_, row, file, name);
            if (!targets.insert(file.native()).second)
                throw Error("INVALID_PATH", "多个图片目标只有大小写不同：" + name, name);
            const auto source = relative(row.at("sourceFile").get<std::string>());
            if (ordinal(file.native(), source.native()) != CSTR_EQUAL)
                throw Error("INPUT_STALE", "散装原图与目标路径不一致：" + name, name);
            selected.push_back({&image, &row, std::move(name), std::move(file)});
        }
        std::sort(selected.begin(), selected.end(), [](const Selection& left, const Selection& right) {
            return left.name.compare(right.name) < 0;
        });
        return selected;
    }

    Layer layer(const Selection& selected, bool translation, uint32_t width, uint32_t height, uint64_t byteBudget) const {
        const auto& row = *selected.row;
        const auto& image = *selected.expected;
        const auto& chosen = translation ? *image.translation : *image.mosaic;
        const auto layerName = translation ? "translation" : "mosaic";
        const auto metadata = projectDir_ / "export-inputs" / image.imageId / (std::string(layerName) + ".json");
        const auto file = openSource(game_, metadata, true);
        const auto input = translation ? projectDir_ / "rendered" / (image.imageId + ".png") :
            RpgImageProject::mosaicImage(game_, row).lexically_relative(game_);
        if (!file)
            throw Error("CONFIRMATION_REQUIRED", "缺少已确认的图片版本，请重新保存：" + selected.name, selected.name);
        if (translation && (!row.value("selected", false) || !row.value("completed", false) ||
            row.value("noTranslationNeeded", false) || row.value("renderedFile", "") != "rendered/" + image.imageId + ".png"))
            throw Error("INPUT_STALE", "译图已取消选择或失效：" + selected.name, selected.name);

        auto record = parse(file, game_ / metadata);
        if (!uuid(chosen.confirmationId) || record.at("confirmationId") != chosen.confirmationId ||
            record.at("imageId") != image.imageId || record.at("sourceHash") != image.sourceHash ||
            record.at("candidateVersion") != chosen.version ||
            (record.contains("layer") && record.at("layer") != layerName))
            throw Error("INPUT_STALE", "确认记录已改变，请重新确认：" + selected.name, selected.name);
        verifyBoxes(record, width, height, translation);
        Json result = {{"layer", layerName}};
        for (const auto field : {"confirmationId", "groupId", "candidateVersion", "pngSha256", "maskMode", "boxes"})
            result[field] = record.at(field);

        const auto parents = pinParents(game_, input);
        const auto png = openSource(game_, input);
        const auto limit = std::min(maxImageBytes, byteBudget);
        if (length(png, game_ / input) > limit)
            throw Error("IMAGE_TOO_LARGE", "候选图片超出处理大小：" + selected.name, selected.name);
        auto pixels = read(png, game_ / input, limit);
        const auto digest = hash(pixels);
        const bool matches = translation ?
            row.value("renderedHash", "") == chosen.version && RpgImageProject::stamp(game_ / input) == chosen.version :
            digest == chosen.version;
        if (!matches || record.at("pngSha256") != digest)
            throw Error("INPUT_STALE", "候选图片已改变，请重新确认：" + selected.name, selected.name);
        if (RpgImageProject::dimensions(pixels) != std::pair{width, height})
            throw Error("INPUT_STALE", "候选图片与原图尺寸不同：" + selected.name, selected.name);
        if (translation) {
            const auto imported = record.at("maskMode") == "whole-image";
            const auto origin = row.value("renderedKind", imported ? "imported" : "generated");
            if (origin != (imported ? "imported" : "generated"))
                throw Error("INPUT_STALE", "译图来源与确认记录不一致：" + selected.name, selected.name);
            result["renderedKind"] = origin;
            result["targetLanguage"] = row.value("renderedTarget", "");
        } else {
            const auto model = record.value("modelId", Json(nullptr));
            if (!model.is_null() && !model.is_string())
                throw Error("INPUT_STALE", "重绘模型记录无效：" + selected.name, selected.name);
            result["modelId"] = model;
        }
        return {std::move(result), std::move(pixels)};
    }

    std::optional<Json> compose(const Selection& selected, const std::string& key, std::set<std::string>& sourceIds) const {
        const auto& row = *selected.row;
        const auto& image = *selected.expected;
        const auto parents = pinParents(game_, selected.relative);
        const auto original = openSource(game_, selected.relative);
        if (!sourceIds.insert(identity(original, game_ / selected.relative)).second)
            throw Error("INVALID_PATH", "多个目标指向同一个游戏文件：" + selected.name, selected.name);
        const auto current = read(original, game_ / selected.relative, maxImageBytes);
        for (const auto dir : {"installed", "mosaic-installed", "composed-installed"}) {
            const auto marker = projectDir_ / dir / (image.imageId + ".bin");
            const auto installed = openSource(game_, marker, true);
            if (installed && length(installed, game_ / marker) == current.size() &&
                read(installed, game_ / marker, maxImageBytes) == current)
                throw Error("LEGACY_PATCH_ACTIVE", "请先卸载已应用的旧图片补丁：" + selected.name, selected.name);
        }
        if (RpgImageProject::stamp(game_ / selected.relative) != image.sourceHash)
            throw Error("INPUT_STALE", "原图已改变，请重新扫描：" + selected.name, selected.name);
        const auto encrypted = gameresourcebackup::imageExtension(selected.relative) != ".png";
        if (encrypted != row.value("encrypted", false))
            throw Error("INPUT_STALE", "原图格式与项目记录不一致：" + selected.name, selected.name);

        const auto decoded = RpgImageProject::imageBytes(row, current, key, false);
        const auto [width, height] = RpgImageProject::dimensions(decoded);
        if (width != row.at("width") || height != row.at("height"))
            throw Error("INPUT_STALE", "原图尺寸与项目记录不一致：" + selected.name, selected.name);
        const auto pixels = static_cast<uint64_t>(width) * height;
        if (pixels > maxPixels)
            throw Error("IMAGE_TOO_LARGE", "原图像素数量超出允许上限：" + selected.name, selected.name);
        const auto workingPixels = pixels * (image.translation && image.mosaic ? 12 : 4);
        const auto encodedBudget = (maxWorkingBytes - workingPixels) / 2;
        const auto originalBytes = current.size() + decoded.size();
        if (originalBytes >= encodedBudget)
            throw Error("IMAGE_TOO_LARGE", "图片处理预计内存超出允许上限：" + selected.name, selected.name);
        auto remaining = encodedBudget - originalBytes;
        auto translation = image.translation ?
            std::optional(layer(selected, true, width, height, remaining)) : std::nullopt;
        if (translation) remaining -= translation->pixels.size();
        auto mosaic = image.mosaic ?
            std::optional(layer(selected, false, width, height, remaining)) : std::nullopt;

        Json layers = Json::array();
        Json boxes = Json::array();
        for (auto* layer : {&translation, &mosaic}) {
            if (!*layer) continue;
            for (const auto& box : (*layer)->record.at("boxes")) boxes.push_back(box.at("id"));
            layers.push_back(std::move((*layer)->record));
        }
        const bool combined = translation && mosaic;
        const auto kind = combined ? "composed" : translation ? "translated" : "mosaic";
        const bool processPixels = combined && mosaic->pixels != translation->pixels &&
            mosaic->pixels != decoded && translation->pixels != decoded;
        auto final = combined ? rpgimagecompose::combine(decoded, mosaic->pixels, translation->pixels) :
            std::move(translation ? translation->pixels : mosaic->pixels);
        // The pure combine function can take an equality fast path. Validate
        // these PNGs too, including imported single-layer candidates.
        if (!processPixels) {
            const rpgimagecompose::PngCodec codec;
            codec.read(decoded);
            codec.read(final);
        }
        final = RpgImageProject::imageBytes(row, std::move(final), key, true);
        if (final == current) return std::nullopt;
        if (final.size() > maxImageBytes)
            throw Error("IMAGE_TOO_LARGE", "成品图片超出允许大小：" + selected.name, selected.name);
        const auto digest = write(stage_, Path("payload") / selected.relative, final);
        return Json{{"relativePath", selected.name}, {"kind", kind}, {"bytes", final.size()}, {"sha256", digest},
            {"original", {{"bytes", current.size()}, {"sha256", hash(current)}}},
            {"sourceImage", {{"id", image.imageId}, {"relativePath", selected.name}, {"sourceHash", image.sourceHash},
                {"width", width}, {"height", height}, {"layers", std::move(layers)}}}, {"boxIds", std::move(boxes)}};
    }

    PackageGenerator(const Request& request, const Control& control, const Path& game, const Path& stage)
        : request_(request), control_(control), game_(game), stage_(stage),
          projectDir_(RpgImageProject::folder(game).lexically_relative(game)), engine_(detectEngine(game)) {}

    Result manifest(RpgImageProject& project, const std::string& id, std::tm utc, const Path& target) const {
        report(control_, "snapshot", 0, request_.images.size());
        const auto projectJson = catalog(project);
        const auto inputs = selections(projectJson);
        const auto engineMarker = openSource(game_, engine_.marker);
        const auto markerPath = gamefiles::key(engine_.marker);
        const auto markerLength = length(engineMarker, game_ / engine_.marker);
        Sha256 markerHash;
        std::string markerJson;
        if (engine_.name != "wolf" && markerLength > maxMetadataBytes)
            throw Error("INPUT_TOO_LARGE", "System.json 超出允许大小", markerPath);
        readChunks(engineMarker, game_ / engine_.marker, [&](std::string_view bytes) {
            cancel(control_);
            markerHash.add(bytes);
            if (engine_.name != "wolf") markerJson.append(bytes);
        });
        const auto markerDigest = markerHash.finish();
        const auto key = markerJson.empty() ? std::string() : Json::parse(markerJson).value("encryptionKey", "");

        Sha256 fingerprint;
        for (const auto field : {"llmchat-game-image-baseline-v1", engine_.name.c_str(), "marker",
            markerPath.c_str()}) fingerprint.field(field);
        fingerprint.field(std::to_string(markerLength));
        fingerprint.field(markerDigest);
        Json outputs = Json::array();
        std::set<std::string> sourceIds;
        for (size_t i = 0; i < inputs.size(); ++i) {
            report(control_, "compose", i, inputs.size(), inputs[i].name);
            auto item = compose(inputs[i], key, sourceIds);
            if (!item) continue;
            fingerprint.field("file");
            fingerprint.field(inputs[i].name);
            fingerprint.field(std::to_string(item->at("original").at("bytes").get<uint64_t>()));
            fingerprint.field(item->at("original").at("sha256").get_ref<const std::string&>());
            outputs.push_back(std::move(*item));
        }
        if (outputs.empty()) throw Error("NO_OUTPUT", "选择的图片没有需要导出的改动");
        const auto count = outputs.size();
        auto data = Json{{"schemaVersion", 1}, {"packageId", id}, {"engine", engine_.name},
            {"gameRootFingerprint", fingerprint.finish()}, {"composeRuleVersion", 1},
            {"generatedAt", formattedTime(utc, "%Y-%m-%dT%H:%M:%SZ")}, {"toolVersion", request_.toolVersion},
            {"baseline", {{"algorithm", "sha256-anchors-and-targets-v1"}, {"marker",
                {{"relativePath", markerPath}, {"bytes", markerLength}, {"sha256", markerDigest}}}}},
            {"files", std::move(outputs)}}.dump(2) + "\n";
        if (data.size() > maxMetadataBytes) throw Error("OUTPUT_TOO_LARGE", "成品清单超出允许大小");
        const auto digest = write(stage_, "manifest.json", data);
        const auto receipts = stage_ / "receipts";
        if (!CreateDirectoryW(receipts.c_str(), nullptr))
            winError("OUTPUT_WRITE_FAILED", "无法创建收据目录", receipts, GetLastError());
        return {id, target, digest, count, inputs.size() - count};
    }

public:
    static Result run(RpgImageProject& project, const Request& request, const Control& control) {
        if (request.images.empty() || request.images.size() > 20000 || request.toolVersion.empty())
            throw Error("INVALID_REQUEST", "请指定待导出的图片和工具版本");
        cancel(control);
        const Root game(request.gamePath);
        const Root output(request.outputDir);
        const auto contains = [](const Root& ancestor, const Root& candidate) {
            return std::find(candidate.ids.begin(), candidate.ids.end(), ancestor.ids.back()) != candidate.ids.end();
        };
        if (contains(game, output) || contains(output, game))
            throw Error("INVALID_PATH", "输出目录与游戏目录必须互不包含", utf8(output.path));
        const DirectoryLock gameLock(game.ids.back());
        const DirectoryLock outputLock(output.ids.back());
        const std::unique_lock projectLock(project.mutex_, std::try_to_lock);
        if (!projectLock) throw Error("BUSY", "图片项目正在更新，请稍后重试");

        const auto id = newId();
        const auto stage = output.path / ("." + id + ".partial");
        const auto marker = output.path / ("." + id + ".export-owner");
        const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
        std::tm utc{};
        if (gmtime_s(&utc, &now) != 0) throw Error("IO_ERROR", "无法读取生成时间");
        const auto suffix = "-" + formattedTime(utc, "%Y%m%dT%H%M%SZ") + "-" + id.substr(0, 8) + ".llmchat-images";
        const auto target = output.path / (gameName(game.path.filename().native()) + utf8path::toWide(suffix));
        cleanAbandoned(output.path);
        bool marked = false;
        bool staged = false;
        try {
            {
                const auto file = newFile(marker);
                marked = true;
                writeChunk(file, marker, std::string(markerPrefix) + id);
                if (!FlushFileBuffers(file.value))
                    winError("OUTPUT_WRITE_FAILED", "无法刷盘生成标记", marker, GetLastError());
            }
            if (!CreateDirectoryW(stage.c_str(), nullptr))
                winError("OUTPUT_WRITE_FAILED", "无法创建成品暂存目录", stage, GetLastError());
            staged = true;
            auto source = openNode(stage, true, false, DELETE);
            PackageGenerator generator(request, control, game.path, stage);
            auto result = generator.manifest(project, id, utc, target);
            report(control, "publish", request.images.size(), request.images.size());
            publish(source, target);
            staged = false;
            // The package is already published; the next operation can remove
            // the ownership marker if its immediate deletion fails.
            DeleteFileW(marker.c_str());
            return result;
        } catch (...) {
            try {
                if (staged) removeTree(stage);
                if (marked) eraseMarker(marker);
            } catch (const std::exception& cleanup) {
                throw Error("CLEANUP_FAILED", std::string(cleanup.what()) + "；暂存目录：" + utf8(stage), utf8(stage));
            }
            throw;
        }
    }
};

Result generate(RpgImageProject& project, const Request& request, const Control& control) {
    try {
        return PackageGenerator::run(project, request, control);
    } catch (const Error&) {
        throw;
    } catch (const Json::exception& error) {
        throw Error("INPUT_STALE", std::string("图片项目或确认记录无效：") + error.what());
    } catch (const fs::filesystem_error& error) {
        throw Error("IO_ERROR", std::string("成品生成文件操作失败：") + error.what());
    } catch (const std::runtime_error& error) {
        throw Error("INPUT_STALE", std::string("无法读取或合成图片：") + error.what());
    }
}

} // namespace gameimageexport
#else
namespace gameimageexport {

Result generate(RpgImageProject&, const Request&, const Control&) {
    throw Error("UNSUPPORTED_PLATFORM", "图片成品导出需要 Windows");
}

} // namespace gameimageexport
#endif
