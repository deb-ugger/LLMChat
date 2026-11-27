#pragma once

#include <filesystem>
#include <fstream>
#include <string>
#include <system_error>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <cerrno>
#include <fcntl.h>
#include <unistd.h>
#endif

namespace atomicfile {

struct WriteOptions {
    bool backup = true;
    bool durable = false;
};

inline std::error_code syncPath(const std::filesystem::path& path)
{
#ifdef _WIN32
    const auto handle = CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE)
        return {static_cast<int>(GetLastError()), std::system_category()};
    const auto result = FlushFileBuffers(handle) ? 0 : static_cast<int>(GetLastError());
    CloseHandle(handle);
#else
    const auto handle = open(path.c_str(), O_RDONLY);
    if (handle < 0) return {errno, std::system_category()};
    const auto result = fsync(handle) == 0 ? 0 : errno;
    close(handle);
#endif
    return {result, std::system_category()};
}

inline bool writeText(
    const std::filesystem::path& target,
    const std::string& content,
    std::string* error = nullptr,
    WriteOptions options = {})
{
    namespace fs = std::filesystem;
    try
    {
        std::error_code ec;
        if (target.has_parent_path())
        {
            fs::create_directories(target.parent_path(), ec);
            if (ec)
            {
                if (error) *error = "无法创建目录: " + ec.message();
                return false;
            }
        }

        fs::path temporary = target;
        temporary += ".tmp";
        struct TemporaryGuard {
            fs::path path;
            ~TemporaryGuard() { std::error_code ignored; fs::remove(path, ignored); }
        } guard{temporary};
        {
            std::ofstream out(temporary, std::ios::binary | std::ios::trunc);
            if (!out)
            {
                if (error) *error = "无法创建临时文件";
                return false;
            }
            out.write(content.data(), static_cast<std::streamsize>(content.size()));
            out.close();
            if (!out)
            {
                if (error) *error = "写入临时文件失败";
                return false;
            }
        }

        if (options.durable && (ec = syncPath(temporary)))
        {
            if (error) *error = "无法同步临时文件: " + ec.message();
            return false;
        }

        if (options.backup && fs::exists(target, ec) && !ec)
        {
            fs::path backup = target;
            backup += ".bak";
            std::error_code backupEc;
            fs::copy_file(target, backup, fs::copy_options::overwrite_existing, backupEc);
        }

#ifdef _WIN32
        for (unsigned attempt = 0;; ++attempt)
        {
            if (MoveFileExW(temporary.c_str(), target.c_str(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) break;
            const auto code = GetLastError();
            const bool busy = code == ERROR_ACCESS_DENIED || code == ERROR_SHARING_VIOLATION || code == ERROR_LOCK_VIOLATION;
            // Windows file scanners can briefly hold a file without delete sharing.
            if (busy && attempt < 5) { Sleep(25u << attempt); continue; }
            if (error) {
                const auto path = target.u8string();
                *error = "替换文件失败：" + std::string(path.begin(), path.end()) +
                    "，Windows 错误码 " + std::to_string(code) +
                    (busy ? "（访问被拒绝或文件被占用）" : "");
            }
            return false;
        }
#else
        fs::rename(temporary, target, ec);
        if (ec)
        {
            if (error) *error = "替换文件失败: " + ec.message();
            return false;
        }
        if (options.durable && (ec = syncPath(target.has_parent_path() ? target.parent_path() : fs::path("."))))
        {
            if (error) *error = "无法同步目标目录: " + ec.message();
            return false;
        }
#endif
        return true;
    }
    catch (const std::exception& ex)
    {
        if (error) *error = ex.what();
        return false;
    }
}

} // namespace atomicfile
