#pragma once

#ifdef _WIN32
#include "GameImageExportPackage.h"
#include "GameResourceBackup.h"

#include <bcrypt.h>
#include <utility>

#pragma comment(lib, "bcrypt.lib")

namespace gameimageexport::io {

using Path = std::filesystem::path;
using Json = nlohmann::json;
namespace fs = std::filesystem;

constexpr uint64_t maxImageBytes = 512ull << 20;
constexpr uint64_t maxMetadataBytes = 32ull << 20;
inline std::string utf8(const Path& path) { return utf8path::pathUtf8(path); }

inline std::string hex(const unsigned char* bytes, size_t size) {
    std::string result;
    result.reserve(size * 2);
    for (size_t i = 0; i < size; ++i) {
        result += "0123456789abcdef"[bytes[i] >> 4];
        result += "0123456789abcdef"[bytes[i] & 15];
    }
    return result;
}

inline void requireHash(NTSTATUS status) {
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

inline std::string hash(std::string_view bytes) {
    Sha256 digest;
    digest.add(bytes);
    return digest.finish();
}

inline bool hexString(std::string_view text) {
    return !text.empty() && text.find_first_not_of("0123456789abcdef") == std::string_view::npos;
}

inline bool uuid(std::string_view value) {
    if (value.size() != 36) return false;
    for (size_t i = 0; i < value.size(); ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (value[i] != '-') return false;
        } else if (!hexString(value.substr(i, 1))) return false;
    }
    return true;
}

inline std::string newId() {
    std::array<unsigned char, 16> data{};
    if (BCryptGenRandom(nullptr, data.data(), static_cast<ULONG>(data.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
        throw Error("IO_ERROR", "无法创建导出编号");
    data[6] = (data[6] & 0xf) | 0x40;
    data[8] = (data[8] & 0x3f) | 0x80;
    const auto value = hex(data.data(), data.size());
    return value.substr(0, 8) + "-" + value.substr(8, 4) + "-" + value.substr(12, 4) + "-" +
        value.substr(16, 4) + "-" + value.substr(20);
}

inline int ordinal(std::wstring_view left, std::wstring_view right) {
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

inline bool reserved(std::wstring_view name) {
    auto stem = name.substr(0, name.find(L'.'));
    while (!stem.empty() && stem.back() == L' ') stem.remove_suffix(1);
    if (stem.empty()) return false;
    for (const auto device : {L"CON", L"PRN", L"AUX", L"NUL", L"CONIN$", L"CONOUT$"})
        if (ordinal(stem, device) == CSTR_EQUAL) return true;
    return stem.size() == 4 && std::wstring_view(L"123456789¹²³").find(stem.back()) != std::wstring_view::npos &&
        (ordinal(stem.substr(0, 3), L"COM") == CSTR_EQUAL || ordinal(stem.substr(0, 3), L"LPT") == CSTR_EQUAL);
}

inline bool illegal(wchar_t c) {
    return c < 32 || (c >= 127 && c <= 159) || std::wstring_view(L"<>:\"/\\|?*").find(c) != std::wstring_view::npos;
}

inline bool validComponent(std::wstring_view value) {
    return !value.empty() && value != L"." && value != L".." && value.back() != L'.' && value.back() != L' ' &&
        std::none_of(value.begin(), value.end(), illegal) && !reserved(value) && value.size() <= 255;
}

inline Path relative(const std::string& text) {
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

[[noreturn]] inline void winError(const char* code, const char* action, const Path& path, DWORD status) {
    auto detail = utf8(path);
    throw Error(code, std::string(action) + "：" + detail + "（Windows " + std::to_string(status) + "）", detail);
}

inline Handle openNode(const Path& path, bool directory, bool optional = false, DWORD extraAccess = 0) {
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

inline std::string identity(const Handle& handle, const Path& path) {
    FILE_ID_INFO info{};
    if (!GetFileInformationByHandleEx(handle.value, FileIdInfo, &info, sizeof(info)))
        winError("IO_ERROR", "无法读取路径标识", path, GetLastError());
    return std::to_string(info.VolumeSerialNumber) + "-" + hex(info.FileId.Identifier, sizeof(info.FileId.Identifier));
}

inline std::vector<Handle> pinParents(const Path& root, const Path& name) {
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

inline Handle openSource(const Path& root, const Path& name, bool optional = false) {
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

inline uint64_t length(const Handle& file, const Path& path) {
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file.value, &size))
        winError("IO_ERROR", "无法读取文件长度", path, GetLastError());
    return static_cast<uint64_t>(size.QuadPart);
}

template<class Consume>
inline void readChunks(const Handle& file, const Path& path, Consume consume) {
    std::array<char, 65536> buffer{};
    DWORD count;
    do {
        if (!ReadFile(file.value, buffer.data(), static_cast<DWORD>(buffer.size()), &count, nullptr))
            winError("IO_ERROR", "读取文件失败", path, GetLastError());
        if (count) consume(std::string_view(buffer.data(), count));
    } while (count);
}

inline std::string read(const Handle& file, const Path& path, uint64_t limit = maxMetadataBytes) {
    const auto size = length(file, path);
    if (size > limit) throw Error("INPUT_TOO_LARGE", "输入文件超出允许大小：" + utf8(path), utf8(path));
    std::string bytes;
    bytes.reserve(static_cast<size_t>(size));
    readChunks(file, path, [&](std::string_view chunk) { bytes.append(chunk); });
    if (bytes.size() != size) throw Error("INPUT_STALE", "读取期间文件大小改变：" + utf8(path), utf8(path));
    return bytes;
}

inline void writeChunk(const Handle& file, const Path& path, std::string_view bytes) {
    DWORD count = 0;
    if (!WriteFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) || count != bytes.size())
        winError("OUTPUT_WRITE_FAILED", "写入成品失败", path, GetLastError());
}

inline Handle newFile(const Path& path) {
    Handle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!file) winError("OUTPUT_WRITE_FAILED", "无法创建成品文件", path, GetLastError());
    return file;
}

inline std::vector<Handle> createParents(const Path& root, const Path& name) {
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

inline std::string write(const Path& root, const Path& name, std::string_view bytes) {
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

struct Engine {
    std::string name;
    Path marker;
    Path imageRoot;
};

inline bool hasFile(const Path& root, const Path& file) { return bool(openSource(root, file, true)); }

inline Engine detectEngine(const Path& game) {
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

inline void targetPath(const Path& root, const Engine& engine, const Json& row, const Path& file, const std::string& name) {
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

inline void removeTree(const Path& path) {
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

} // namespace gameimageexport::io
#endif
