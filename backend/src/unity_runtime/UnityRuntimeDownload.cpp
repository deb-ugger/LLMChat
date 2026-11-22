#include "UnityRuntimeDownload.h"

#ifdef _WIN32
#include "StoragePaths.h"
#include "UnityAutoTranslator.h"
#include "Utf8Path.h"

#include <fstream>
#include <stdexcept>
#include <objbase.h>
#include <winhttp.h>

namespace fs = std::filesystem;
using utf8path::toWide;

namespace unity_runtime
{
namespace
{
constexpr const char* kSevenZrUrl = "https://www.7-zip.org/a/7zr.exe";

fs::path toolsCacheDir()
{
    return storage::get("unity") / "tools";
}
}

/** Local cache dir next to backend: resources/bepinex/ */
fs::path bepinexCacheDir()
{
    return storage::get("unity") / "bepinex";
}

/** Local cache dir next to backend: resources/fonts/ */
fs::path fontsCacheDir()
{
    return storage::get("unity") / "fonts";
}

fs::path resolveCachedArtifact(const ArtifactSpec& artifact)
{
    const fs::path& p = artifact.path;
    std::error_code ec;
    if (fs::exists(p, ec) && fs::is_regular_file(p, ec))
    {
        const auto sz = fs::file_size(p, ec);
        if (!ec && sz > artifact.minimumSize)
            return p;
    }
    return {};
}

fs::path ensureSevenZr(
    std::vector<std::string>& steps, const UnityInstallControl* control, std::string& error)
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
    if (!downloadFile(kSevenZrUrl, dest, control, error))
        return {};
    return dest;
}

bool downloadFile(
    const std::string& url, const fs::path& dest, const UnityInstallControl* control, std::string& error)
{
    const auto installCancelled = [control] { return control && control->stop.stop_requested(); };
    if (installCancelled()) throw std::runtime_error("安装已取消，已写入的文件可能保留");
    if (control) control->progress("正在下载安装资源");
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

    // Each installer writes a sibling file, leaving an existing cache entry intact.
    auto receive = [&]() -> bool {
        DWORD expected = 0, size = sizeof(expected);
        if (status != 200 || !WinHttpQueryHeaders(request, WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER,
                WINHTTP_HEADER_NAME_BY_INDEX, &expected, &size, WINHTTP_NO_HEADER_INDEX) || !expected) {
            error = "下载响应缺少可校验的完整文件长度";
            return false;
        }
        GUID guid;
        wchar_t suffix[40]{};
        if (FAILED(CoCreateGuid(&guid)) || !StringFromGUID2(guid, suffix, 40)) {
            error = "无法生成临时下载文件名";
            return false;
        }
        const fs::path temporary = dest.wstring() + L"." + suffix + L".part";
        struct Cleanup {
            const fs::path& path;
            ~Cleanup() { std::error_code ec; fs::remove(path, ec); }
        } cleanup{temporary};
        std::ofstream out(temporary, std::ios::binary);
        if (!out) { error = "无法创建临时下载文件"; return false; }

        char buffer[64 * 1024];
        uint64_t received = 0;
        for (;;) {
            if (installCancelled()) { error = "下载已取消"; return false; }
            DWORD count = 0;
            if (!WinHttpReadData(request, buffer, sizeof(buffer), &count)) {
                error = "读取下载响应失败，Windows 错误 " + std::to_string(GetLastError());
                return false;
            }
            if (!count) break;
            received += count;
            if (received > expected) break;
            if (!out.write(buffer, count)) { error = "写入下载文件失败"; return false; }
        }
        if (received != expected) {
            error = "下载长度不符，预期 " + std::to_string(expected) + " 字节，收到 " + std::to_string(received);
            return false;
        }
        out.close();
        if (!out) { error = "保存下载文件失败"; return false; }
        if (installCancelled()) { error = "下载已取消"; return false; }
        if (!MoveFileExW(temporary.c_str(), dest.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
            error = "发布下载文件失败，Windows 错误 " + std::to_string(GetLastError());
            return false;
        }
        return true;
    };
    const bool ok = receive();
    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);
    return ok;
}
}
#endif
