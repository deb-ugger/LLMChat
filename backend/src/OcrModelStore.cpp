#include "OcrModelStore.h"
#include "Utf8Path.h"

#include <algorithm>
#include <array>
#include <fstream>
#include <functional>
#include <stdexcept>
#include <system_error>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winhttp.h>
#endif

using json = nlohmann::json;
namespace fs = std::filesystem;

namespace {

struct ModelSpec {
    const char* name;
    const char* fileName;
    const char* url;
    std::uintmax_t bytes;
};

constexpr ModelSpec kMediumDet{
    "PP-OCRv6_medium_det",
    "PP-OCRv6_medium_det_infer.tar",
    "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_medium_det_infer.tar",
    62279680,
};
constexpr ModelSpec kMediumRec{
    "PP-OCRv6_medium_rec",
    "PP-OCRv6_medium_rec_infer.tar",
    "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_medium_rec_infer.tar",
    76851200,
};
constexpr ModelSpec kEnglishRec{
    "en_PP-OCRv5_mobile_rec",
    "en_PP-OCRv5_mobile_rec_infer.tar",
    "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/en_PP-OCRv5_mobile_rec_infer.tar",
    8007680,
};
constexpr std::array<const ModelSpec*, 3> kDownloadable{
    &kMediumDet,
    &kMediumRec,
    &kEnglishRec,
};
constexpr std::uintmax_t kFastModelBytes = 9891840 + 21319680;

bool isComplete(const fs::path& root, const ModelSpec& spec)
{
    std::error_code ec;
    return fs::is_regular_file(root / spec.fileName, ec)
        && fs::file_size(root / spec.fileName, ec) == spec.bytes && !ec;
}

std::uintmax_t cachedBytes(const fs::path& root)
{
    std::uintmax_t total = 0;
    for (const auto* spec : kDownloadable)
    {
        std::error_code ec;
        const fs::path path = root / spec->fileName;
        if (fs::is_regular_file(path, ec))
            total += fs::file_size(path, ec);
    }
    return total;
}

#ifdef _WIN32

struct WinHttpHandle {
    HINTERNET value = nullptr;
    ~WinHttpHandle() { if (value) WinHttpCloseHandle(value); }
    WinHttpHandle(const WinHttpHandle&) = delete;
    WinHttpHandle& operator=(const WinHttpHandle&) = delete;
    WinHttpHandle() = default;
};

std::wstring normalizeProxy(const std::string& value)
{
    std::string proxy = value;
    const auto scheme = proxy.find("://");
    if (scheme != std::string::npos)
        proxy.erase(0, scheme + 3);
    while (!proxy.empty() && proxy.back() == '/')
        proxy.pop_back();
    return utf8path::toWide(proxy);
}

void downloadFile(const ModelSpec& spec, const fs::path& destination, const AppConfig& config,
                  const std::function<void(std::uintmax_t, std::uintmax_t)>& onProgress)
{
    const std::wstring url = utf8path::toWide(spec.url);
    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    parts.dwSchemeLength = static_cast<DWORD>(-1);
    parts.dwHostNameLength = static_cast<DWORD>(-1);
    parts.dwUrlPathLength = static_cast<DWORD>(-1);
    parts.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(url.c_str(), 0, 0, &parts))
        throw std::runtime_error("扩展 OCR 模型地址无效");

    const std::wstring host(parts.lpszHostName, parts.dwHostNameLength);
    std::wstring path(parts.lpszUrlPath, parts.dwUrlPathLength);
    if (parts.dwExtraInfoLength && parts.lpszExtraInfo)
        path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);

    std::wstring proxy;
    DWORD accessType = WINHTTP_ACCESS_TYPE_NO_PROXY;
    LPCWSTR proxyName = WINHTTP_NO_PROXY_NAME;
    if (config.proxyMode == "auto")
    {
#ifdef WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY
        accessType = WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY;
#else
        accessType = WINHTTP_ACCESS_TYPE_DEFAULT_PROXY;
#endif
    }
    else if (config.proxyMode == "custom" && !config.httpProxy.empty())
    {
        proxy = normalizeProxy(config.httpProxy);
        accessType = WINHTTP_ACCESS_TYPE_NAMED_PROXY;
        proxyName = proxy.c_str();
    }

    WinHttpHandle session;
    session.value = WinHttpOpen(L"LLMChat OCR Model Store/1.0", accessType, proxyName,
                                WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session.value)
        throw std::runtime_error("无法初始化模型下载连接");
    WinHttpSetTimeouts(session.value, 15000, 30000, 30000, 60000);

    WinHttpHandle connection;
    connection.value = WinHttpConnect(session.value, host.c_str(), parts.nPort, 0);
    if (!connection.value)
        throw std::runtime_error("无法连接模型下载服务器");

    WinHttpHandle request;
    request.value = WinHttpOpenRequest(
        connection.value, L"GET", path.c_str(), nullptr, WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES,
        parts.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0);
    if (!request.value)
        throw std::runtime_error("无法创建模型下载请求");

    if (!WinHttpSendRequest(request.value, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                            WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
        || !WinHttpReceiveResponse(request.value, nullptr))
        throw std::runtime_error("扩展 OCR 模型下载失败，请检查网络或代理设置");

    DWORD status = 0;
    DWORD statusSize = sizeof(status);
    WinHttpQueryHeaders(request.value,
                        WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                        WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize,
                        WINHTTP_NO_HEADER_INDEX);
    if (status != 200)
        throw std::runtime_error("模型下载服务器返回 HTTP " + std::to_string(status));

    const fs::path partial = destination.wstring() + L".part";
    std::error_code ec;
    fs::remove(partial, ec);
    std::ofstream out(partial, std::ios::binary | std::ios::trunc);
    if (!out)
        throw std::runtime_error("无法创建模型缓存文件");

    std::uintmax_t written = 0;
    try
    {
        for (;;)
        {
            DWORD available = 0;
            if (!WinHttpQueryDataAvailable(request.value, &available))
                throw std::runtime_error("读取模型下载响应失败");
            if (available == 0)
                break;
            std::vector<char> buffer(available);
            DWORD received = 0;
            if (!WinHttpReadData(request.value, buffer.data(), available, &received))
                throw std::runtime_error("读取模型数据失败");
            out.write(buffer.data(), received);
            if (!out)
                throw std::runtime_error("写入模型缓存失败，请检查磁盘空间");
            written += received;
            onProgress(written, spec.bytes);
            if (written > spec.bytes)
                throw std::runtime_error("模型文件大小异常，已终止下载");
        }
        out.close();
        if (written != spec.bytes)
            throw std::runtime_error("模型下载不完整，请重试");
        fs::remove(destination, ec);
        ec.clear();
        fs::rename(partial, destination, ec);
        if (ec)
            throw std::runtime_error("无法完成模型缓存文件替换");
    }
    catch (...)
    {
        out.close();
        fs::remove(partial, ec);
        throw;
    }
}

#else

void downloadFile(const ModelSpec&, const fs::path&, const AppConfig&,
                  const std::function<void(std::uintmax_t, std::uintmax_t)>&)
{
    throw std::runtime_error("当前平台暂不支持自动下载扩展 OCR 模型");
}

#endif

json modeStatus(const char* id, const char* label, bool builtIn, bool installed,
                std::uintmax_t downloadBytes, std::uintmax_t sizeBytes,
                std::uintmax_t cachedModeBytes)
{
    return json{
        {"id", id}, {"label", label}, {"builtIn", builtIn},
        {"installed", installed}, {"downloadBytes", downloadBytes},
        {"sizeBytes", sizeBytes}, {"cachedBytes", cachedModeBytes},
    };
}

} // namespace

OcrModelStore::OcrModelStore(fs::path dataDir)
    : root_(std::move(dataDir) / "ocr-models")
{
}

json OcrModelStore::status() const
{
    std::lock_guard lock(mutex_);
    const bool det = isComplete(root_, kMediumDet);
    const bool rec = isComplete(root_, kMediumRec);
    const bool englishRec = isComplete(root_, kEnglishRec);
    const bool precise = det && rec;
    const bool english = det && englishRec;
    return json{
        {"ok", true},
        {"cacheDir", utf8path::pathUtf8(root_)},
        {"cachedBytes", cachedBytes(root_)},
        {"download", json{
            {"active", downloadActive_},
            {"mode", downloadMode_},
            {"model", downloadModel_},
            {"downloadedBytes", downloadBytes_},
            {"totalBytes", downloadTotalBytes_},
        }},
        {"modes", json::array({
            modeStatus("fast", "快速", true, true, 0,
                       kFastModelBytes, kFastModelBytes),
            modeStatus("precise", "精确", false, precise,
                       precise ? 0 : (det ? kMediumRec.bytes : kMediumDet.bytes + kMediumRec.bytes),
                       kMediumDet.bytes + kMediumRec.bytes,
                       (det ? kMediumDet.bytes : 0) + (rec ? kMediumRec.bytes : 0)),
            modeStatus("english", "英文增强", false, english,
                       english ? 0 : (det ? kEnglishRec.bytes : kMediumDet.bytes + kEnglishRec.bytes),
                       kMediumDet.bytes + kEnglishRec.bytes,
                       (det ? kMediumDet.bytes : 0) + (englishRec ? kEnglishRec.bytes : 0)),
        })},
    };
}

json OcrModelStore::ensureMode(const std::string& mode, const AppConfig& config)
{
    if (mode == "fast")
        return status();
    if (mode != "precise" && mode != "english")
        throw std::runtime_error("未知的 OCR 模式");

    const std::array<const ModelSpec*, 2> required = mode == "precise"
        ? std::array<const ModelSpec*, 2>{&kMediumDet, &kMediumRec}
        : std::array<const ModelSpec*, 2>{&kMediumDet, &kEnglishRec};

    std::uintmax_t totalMissing = 0;
    for (const auto* spec : required)
        if (!isComplete(root_, *spec))
            totalMissing += spec->bytes;
    if (totalMissing == 0)
        return status();

    {
        std::lock_guard lock(mutex_);
        if (downloadActive_)
            throw std::runtime_error("已有 OCR 模型正在下载，请稍候");
        downloadActive_ = true;
        downloadMode_ = mode;
        downloadModel_.clear();
        downloadBytes_ = 0;
        downloadTotalBytes_ = totalMissing;
    }

    std::error_code ec;
    std::uintmax_t completedBytes = 0;
    try
    {
        fs::create_directories(root_, ec);
        if (ec)
            throw std::runtime_error("无法创建 OCR 模型缓存目录");

        for (const auto* spec : required)
        {
            if (isComplete(root_, *spec))
                continue;
            fs::remove(root_ / spec->fileName, ec);
            {
                std::lock_guard lock(mutex_);
                downloadModel_ = spec->name;
            }
            downloadFile(
                *spec, root_ / spec->fileName, config,
                [this, completedBytes](std::uintmax_t current, std::uintmax_t) {
                    std::lock_guard lock(mutex_);
                    downloadBytes_ = std::min(downloadTotalBytes_, completedBytes + current);
                });
            completedBytes += spec->bytes;
            {
                std::lock_guard lock(mutex_);
                downloadBytes_ = completedBytes;
            }
        }
    }
    catch (...)
    {
        std::lock_guard lock(mutex_);
        downloadActive_ = false;
        downloadModel_.clear();
        throw;
    }
    {
        std::lock_guard lock(mutex_);
        downloadActive_ = false;
        downloadModel_.clear();
        downloadBytes_ = downloadTotalBytes_;
    }
    return status();
}

json OcrModelStore::removeMode(const std::string& mode)
{
    if (mode != "precise" && mode != "english")
        throw std::runtime_error("内置快速模型无法卸载");
    {
        std::lock_guard lock(mutex_);
        if (downloadActive_)
            throw std::runtime_error("模型正在下载，暂时无法删除缓存");
        std::error_code ec;
        const ModelSpec& recognition = mode == "precise" ? kMediumRec : kEnglishRec;
        fs::remove(root_ / recognition.fileName, ec);
        fs::remove((root_ / recognition.fileName).wstring() + L".part", ec);

        // The medium detector is shared by precise and English modes. Keep it
        // while the other mode's recognition model is cached; otherwise this
        // uninstall can reclaim the shared file as well.
        const ModelSpec& otherRecognition = mode == "precise" ? kEnglishRec : kMediumRec;
        if (!isComplete(root_, otherRecognition))
        {
            fs::remove(root_ / kMediumDet.fileName, ec);
            fs::remove((root_ / kMediumDet.fileName).wstring() + L".part", ec);
        }
        downloadMode_.clear();
        downloadModel_.clear();
        downloadBytes_ = 0;
        downloadTotalBytes_ = 0;
    }
    return status();
}

fs::path OcrModelStore::modelFile(const std::string& fileName) const
{
    return root_ / utf8path::pathFromUtf8(fileName);
}

bool OcrModelStore::isAllowedModelFile(const std::string& fileName) const
{
    for (const auto* spec : kDownloadable)
    {
        if (fileName == spec->fileName)
            return isComplete(root_, *spec);
    }
    return false;
}
