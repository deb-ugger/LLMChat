#pragma once

#include <filesystem>
#include <string>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace utf8path {

inline std::wstring toWide(const std::string& s)
{
    if (s.empty())
        return L"";
#ifdef _WIN32
    const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    std::wstring out(n > 0 ? static_cast<size_t>(n - 1) : 0, L'\0');
    if (n > 1)
        MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), n);
    return out;
#else
    return std::wstring(s.begin(), s.end());
#endif
}

inline std::string toUtf8(const std::wstring& s)
{
    if (s.empty())
        return "";
#ifdef _WIN32
    const int n = WideCharToMultiByte(CP_UTF8, 0, s.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string out(n > 0 ? static_cast<size_t>(n - 1) : 0, '\0');
    if (n > 1)
        WideCharToMultiByte(CP_UTF8, 0, s.c_str(), -1, out.data(), n, nullptr, nullptr);
    return out;
#else
    return std::string(s.begin(), s.end());
#endif
}

/** Windows path.string() is ACP/GBK — never put that into JSON. */
inline std::string pathUtf8(const std::filesystem::path& p)
{
#ifdef _WIN32
    return toUtf8(p.native());
#else
    const auto u8 = p.u8string();
    return std::string(u8.begin(), u8.end());
#endif
}

/** Build fs::path from a UTF-8 string (API / JSON). Do not use fs::path(std::string) on Windows. */
inline std::filesystem::path pathFromUtf8(const std::string& utf8)
{
#ifdef _WIN32
    return std::filesystem::path(toWide(utf8));
#else
    return std::filesystem::path(std::u8string(utf8.begin(), utf8.end()));
#endif
}

} // namespace utf8path
