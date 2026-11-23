#include "UnityRuntimeDownload.h"

#ifdef _WIN32
#include "StoragePaths.h"
#include "UnityAutoTranslator.h"
#include "Utf8Path.h"

#include <fstream>
#include <stdexcept>
#include <objbase.h>
#include "http/HttpTransport.h"

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

    const http_transport::Request request{
        {host, uc.nPort, uc.nScheme == INTERNET_SCHEME_HTTPS},
        {L"LLMChat-UnityInstaller/1.0", {WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY}, {15000, 15000, 60000, 120000}},
        L"GET", path, {}, {}, {}, WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS,
    };

    // Each installer writes a sibling file, leaving an existing cache entry intact.
    struct Cleanup {
        fs::path path;
        ~Cleanup() { if (!path.empty()) { std::error_code ec; fs::remove(path, ec); } }
    } temporary;
    std::ofstream out;
    DWORD expected = 0;
    uint64_t received = 0;
    const auto result = http_transport::perform(request, {
        [&](DWORD status, const http_transport::ResponseHeaders& headers) {
            if (status < 200 || status >= 300) {
                error = "下载失败，HTTP " + std::to_string(status);
                return false;
            }
            expected = status == 200 ? headers.number(WINHTTP_QUERY_CONTENT_LENGTH).value_or(0) : 0;
            if (!expected) {
                error = "下载响应缺少可校验的完整文件长度";
                return false;
            }
            GUID guid;
            wchar_t suffix[40]{};
            if (FAILED(CoCreateGuid(&guid)) || !StringFromGUID2(guid, suffix, 40)) {
                error = "无法生成临时下载文件名";
                return false;
            }
            temporary.path = dest.wstring() + L"." + suffix + L".part";
            out.open(temporary.path, std::ios::binary);
            if (!out) { error = "无法创建临时下载文件"; return false; }
            return true;
        },
        [&](std::string_view bytes) {
            if (installCancelled()) { error = "下载已取消"; return false; }
            received += bytes.size();
            if (received > expected) return false;
            if (!out.write(bytes.data(), bytes.size())) { error = "写入下载文件失败"; return false; }
            return true;
        },
    }, {control ? control->stop : std::stop_token{}});
    if (result.failure) {
        using http_transport::Stage;
        const auto [stage, code] = *result.failure;
        if (code == ERROR_WINHTTP_OPERATION_CANCELLED && installCancelled()) error = "下载已取消";
        else if (stage == Stage::session) error = "无法初始化下载组件";
        else if (stage == Stage::connection) error = "无法连接下载服务器";
        else if (stage == Stage::request) error = "无法创建下载请求";
        else if (stage == Stage::read) error = "读取下载响应失败，Windows 错误 " + std::to_string(code);
        else error = "下载请求失败";
        return false;
    }
    if (!out.is_open() || !out) return false;
    if (installCancelled()) { error = "下载已取消"; return false; }
    if (received != expected) {
        error = "下载长度不符，预期 " + std::to_string(expected) + " 字节，收到 " + std::to_string(received);
        return false;
    }
    out.close();
    if (!out) { error = "保存下载文件失败"; return false; }
    if (installCancelled()) { error = "下载已取消"; return false; }
    if (!MoveFileExW(temporary.path.c_str(), dest.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        error = "发布下载文件失败，Windows 错误 " + std::to_string(GetLastError());
        return false;
    }
    return true;
}
}
#endif
