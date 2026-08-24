#pragma once

#include <filesystem>
#include <fstream>
#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace atomicfile {

inline bool writeText(
    const std::filesystem::path& target,
    const std::string& content,
    std::string* error = nullptr)
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
        {
            std::ofstream out(temporary, std::ios::binary | std::ios::trunc);
            if (!out)
            {
                if (error) *error = "无法创建临时文件";
                return false;
            }
            out.write(content.data(), static_cast<std::streamsize>(content.size()));
            out.flush();
            if (!out)
            {
                if (error) *error = "写入临时文件失败";
                out.close();
                fs::remove(temporary, ec);
                return false;
            }
        }

        if (fs::exists(target, ec) && !ec)
        {
            fs::path backup = target;
            backup += ".bak";
            std::error_code backupEc;
            fs::copy_file(target, backup, fs::copy_options::overwrite_existing, backupEc);
        }

#ifdef _WIN32
        if (!MoveFileExW(
                temporary.c_str(),
                target.c_str(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        {
            if (error) *error = "替换文件失败，Windows 错误码 " + std::to_string(GetLastError());
            fs::remove(temporary, ec);
            return false;
        }
#else
        fs::rename(temporary, target, ec);
        if (ec)
        {
            if (error) *error = "替换文件失败: " + ec.message();
            fs::remove(temporary, ec);
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
