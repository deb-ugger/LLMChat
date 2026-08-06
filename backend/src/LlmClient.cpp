#include "LlmClient.h"

#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#pragma comment(lib, "winhttp.lib")
#endif

#include <cctype>
#include <sstream>
#include <vector>

using json = nlohmann::json;

namespace {

#ifdef _WIN32

std::wstring toWide(const std::string& s)
{
    if (s.empty())
    {
        return {};
    }
    const int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    std::wstring out(static_cast<size_t>(len), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), len);
    if (!out.empty() && out.back() == L'\0')
    {
        out.pop_back();
    }
    return out;
}

std::string toUtf8(const std::wstring& s)
{
    if (s.empty())
    {
        return {};
    }
    const int len = WideCharToMultiByte(CP_UTF8, 0, s.c_str(), -1, nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<size_t>(len), '\0');
    WideCharToMultiByte(CP_UTF8, 0, s.c_str(), -1, out.data(), len, nullptr, nullptr);
    if (!out.empty() && out.back() == '\0')
    {
        out.pop_back();
    }
    return out;
}

bool parseUrl(const std::string& url, bool& https, std::wstring& host, INTERNET_PORT& port, std::wstring& path)
{
    URL_COMPONENTS uc{};
    uc.dwStructSize = sizeof(uc);
    uc.dwSchemeLength = static_cast<DWORD>(-1);
    uc.dwHostNameLength = static_cast<DWORD>(-1);
    uc.dwUrlPathLength = static_cast<DWORD>(-1);
    uc.dwExtraInfoLength = static_cast<DWORD>(-1);

    const std::wstring wurl = toWide(url);
    if (!WinHttpCrackUrl(wurl.c_str(), 0, 0, &uc))
    {
        return false;
    }

    https = (uc.nScheme == INTERNET_SCHEME_HTTPS);
    host.assign(uc.lpszHostName, uc.dwHostNameLength);
    port = uc.nPort;
    path.assign(uc.lpszUrlPath, uc.dwUrlPathLength);
    if (uc.dwExtraInfoLength > 0 && uc.lpszExtraInfo)
    {
        path.append(uc.lpszExtraInfo, uc.dwExtraInfoLength);
    }
    if (path.empty())
    {
        path = L"/";
    }
    return true;
}

LlmResponse winHttpPost(const std::string& url, const std::string& bearer, const std::string& body)
{
    LlmResponse result;

    bool https = true;
    std::wstring host;
    INTERNET_PORT port = INTERNET_DEFAULT_HTTPS_PORT;
    std::wstring path;
    if (!parseUrl(url, https, host, port, path))
    {
        result.error = "Invalid API URL（请检查 API URL）";
        return result;
    }

    HINTERNET session = WinHttpOpen(
        L"LLMChatBackend/1.0",
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS,
        0);
    if (!session)
    {
        result.error = "WinHttpOpen failed";
        return result;
    }

    HINTERNET connect = WinHttpConnect(session, host.c_str(), port, 0);
    if (!connect)
    {
        WinHttpCloseHandle(session);
        result.error = "WinHttpConnect failed";
        return result;
    }

    DWORD flags = https ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET request = WinHttpOpenRequest(
        connect,
        L"POST",
        path.c_str(),
        nullptr,
        WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES,
        flags);
    if (!request)
    {
        WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
        result.error = "WinHttpOpenRequest failed";
        return result;
    }

    std::wstring headers = L"Content-Type: application/json\r\n";
    if (!bearer.empty())
    {
        headers += L"Authorization: Bearer " + toWide(bearer) + L"\r\n";
    }

    result.externalCall = true;
    const BOOL sent = WinHttpSendRequest(
        request,
        headers.c_str(),
        static_cast<DWORD>(-1),
        (LPVOID)body.data(),
        static_cast<DWORD>(body.size()),
        static_cast<DWORD>(body.size()),
        0);

    if (!sent || !WinHttpReceiveResponse(request, nullptr))
    {
        result.error = "HTTP request failed";
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
        return result;
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
    result.statusCode = static_cast<int>(status);

    std::string responseBody;
    for (;;)
    {
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(request, &available))
        {
            break;
        }
        if (available == 0)
        {
            break;
        }
        std::vector<char> buffer(available);
        DWORD read = 0;
        if (!WinHttpReadData(request, buffer.data(), available, &read))
        {
            break;
        }
        responseBody.append(buffer.data(), read);
    }

    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);

    if (status < 200 || status >= 300)
    {
        result.error = "LLM HTTP " + std::to_string(status) + ": " + responseBody.substr(0, 500);
        return result;
    }

    // Trim BOM / whitespace — empty body often yields nlohmann parse_error.101
    while (!responseBody.empty() &&
           (unsigned char)responseBody.front() <= 0x20)
    {
        responseBody.erase(responseBody.begin());
    }
    if (responseBody.size() >= 3
        && (unsigned char)responseBody[0] == 0xEF
        && (unsigned char)responseBody[1] == 0xBB
        && (unsigned char)responseBody[2] == 0xBF)
    {
        responseBody.erase(0, 3);
    }
    while (!responseBody.empty() &&
           (unsigned char)responseBody.back() <= 0x20)
    {
        responseBody.pop_back();
    }
    if (responseBody.empty())
    {
        result.error =
            "Empty LLM HTTP body (HTTP " + std::to_string(status)
            + "). Check API URL points to chat/completions and the model is reachable.";
        return result;
    }

    try
    {
        const json root = json::parse(responseBody);
        if (!root.contains("choices") || !root["choices"].is_array()
            || root["choices"].empty())
        {
            result.error =
                "Empty choices in LLM response: "
                + responseBody.substr(0, 300);
            return result;
        }
        const json& message = root["choices"][0].at("message");
        std::string content;
        if (message.contains("content"))
        {
            const auto& c = message["content"];
            if (c.is_string())
            {
                content = c.get<std::string>();
            }
            else if (c.is_array())
            {
                for (const auto& part : c)
                {
                    if (part.is_string())
                        content += part.get<std::string>();
                    else if (part.is_object())
                        content += part.value("text", "");
                }
            }
        }
        if (content.empty() && message.contains("reasoning_content")
            && message["reasoning_content"].is_string())
        {
            content = message["reasoning_content"].get<std::string>();
        }
        result.content = content;
        if (root.contains("usage") && root["usage"].is_object())
        {
            const auto& usage = root["usage"];
            result.promptTokens = usage.value("prompt_tokens", 0);
            if (result.promptTokens <= 0)
                result.promptTokens = usage.value("input_tokens", 0);
            result.completionTokens = usage.value("completion_tokens", 0);
            if (result.completionTokens <= 0)
                result.completionTokens = usage.value("output_tokens", 0);
            result.totalTokens = usage.value("total_tokens", 0);

            // Cache read: DeepSeek / Anthropic-style / OpenAI details
            result.cacheReadTokens = usage.value("prompt_cache_hit_tokens", 0);
            if (result.cacheReadTokens <= 0)
                result.cacheReadTokens = usage.value("cache_read_input_tokens", 0);
            if (result.cacheReadTokens <= 0)
                result.cacheReadTokens = usage.value("cached_tokens", 0);

            // Cache write / creation
            result.cacheWriteTokens = usage.value("cache_creation_input_tokens", 0);
            if (result.cacheWriteTokens <= 0)
                result.cacheWriteTokens = usage.value("prompt_cache_write_tokens", 0);
            if (result.cacheWriteTokens <= 0)
                result.cacheWriteTokens = usage.value("cache_write_tokens", 0);

            auto readDetails = [&](const char* key) {
                if (!usage.contains(key) || !usage[key].is_object())
                    return;
                const auto& d = usage[key];
                if (result.cacheReadTokens <= 0)
                    result.cacheReadTokens = d.value("cached_tokens", 0);
                if (result.cacheReadTokens <= 0)
                    result.cacheReadTokens = d.value("cache_read_tokens", 0);
                if (result.cacheWriteTokens <= 0)
                    result.cacheWriteTokens = d.value("cache_write_tokens", 0);
                if (result.cacheWriteTokens <= 0)
                    result.cacheWriteTokens = d.value("cache_creation_tokens", 0);
            };
            readDetails("prompt_tokens_details");
            readDetails("input_tokens_details");

            if (result.totalTokens <= 0)
            {
                result.totalTokens = result.promptTokens + result.completionTokens;
            }
        }
        result.ok = true;
    }
    catch (const std::exception& ex)
    {
        const std::string head = responseBody.substr(0, 180);
        result.error = std::string("Parse LLM response failed: ") + ex.what()
            + " | body[:180]=" + head;
    }

    return result;
}

#endif

} // namespace

std::string LlmClient::modelsUrlFromChatUrl(const std::string& apiUrl)
{
    std::string u = apiUrl;
    while (!u.empty() && (u.back() == ' ' || u.back() == '\t' || u.back() == '\r' || u.back() == '\n'))
        u.pop_back();
    size_t start = 0;
    while (start < u.size() && (u[start] == ' ' || u[start] == '\t'))
        ++start;
    if (start > 0)
        u.erase(0, start);

    const std::string needle = "chat/completions";
    const auto pos = u.rfind(needle);
    if (pos != std::string::npos)
    {
        u.replace(pos, needle.size(), "models");
        return u;
    }
    if (!u.empty() && u.back() == '/')
        return u + "models";
    return u + "/models";
}

LlmResponse LlmClient::chat(const LlmRequest& request)
{
    LlmResponse early;
    if (request.apiUrl.empty())
    {
        early.error = "请先填写 API URL";
        return early;
    }

    json body;
    body["model"] = request.model;
    body["messages"] = request.messages;
    body["stream"] = false;

#ifdef _WIN32
    return winHttpPost(request.apiUrl, request.apiKey, body.dump());
#else
    early.error = "LLM client is only implemented for Windows in this build";
    return early;
#endif
}

LlmListModelsResponse LlmClient::listModels(const LlmListModelsRequest& request)
{
    LlmListModelsResponse result;
    if (request.apiUrl.empty())
    {
        result.error = "请先填写 API URL";
        return result;
    }

    const std::string url = modelsUrlFromChatUrl(request.apiUrl);

#ifdef _WIN32
    // Local helpers mirroring TranslateClient proxy behavior
    auto toLower = [](std::string s) {
        for (char& c : s)
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        return s;
    };
    auto trimCopy = [](std::string s) {
        while (!s.empty() && (unsigned char)s.front() <= 0x20) s.erase(s.begin());
        while (!s.empty() && (unsigned char)s.back() <= 0x20) s.pop_back();
        return s;
    };
    auto normalizeProxyList = [&](const std::string& proxy) -> std::wstring {
        std::string p = trimCopy(proxy);
        if (p.rfind("http://", 0) == 0) p = p.substr(7);
        else if (p.rfind("https://", 0) == 0) p = p.substr(8);
        return toWide(p);
    };

    bool https = true;
    std::wstring host;
    INTERNET_PORT port = INTERNET_DEFAULT_HTTPS_PORT;
    std::wstring path;
    if (!parseUrl(url, https, host, port, path))
    {
        result.error = "接口地址无效";
        return result;
    }

    DWORD accessType = WINHTTP_ACCESS_TYPE_NO_PROXY;
    LPCWSTR proxyName = WINHTTP_NO_PROXY_NAME;
    std::wstring proxyBuf;
    const std::string mode = toLower(request.proxyMode.empty() ? "auto" : request.proxyMode);
    if (mode == "direct" || mode == "none" || mode == "off")
    {
        accessType = WINHTTP_ACCESS_TYPE_NO_PROXY;
    }
    else if ((mode == "custom" || mode == "manual") && !trimCopy(request.httpProxy).empty())
    {
        accessType = WINHTTP_ACCESS_TYPE_NAMED_PROXY;
        proxyBuf = normalizeProxyList(request.httpProxy);
        proxyName = proxyBuf.c_str();
    }
    else
    {
        accessType = WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY;
    }

    HINTERNET session = WinHttpOpen(
        L"LLMChatBackend/1.0",
        accessType,
        proxyName,
        WINHTTP_NO_PROXY_BYPASS,
        0);
    if (!session && accessType == WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY)
    {
        session = WinHttpOpen(
            L"LLMChatBackend/1.0",
            WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
            WINHTTP_NO_PROXY_NAME,
            WINHTTP_NO_PROXY_BYPASS,
            0);
    }
    if (!session)
    {
        result.error = "无法初始化网络组件";
        return result;
    }

    WinHttpSetTimeouts(session, 5000, 5000, 15000, 15000);

    HINTERNET connect = WinHttpConnect(session, host.c_str(), port, 0);
    if (!connect)
    {
        WinHttpCloseHandle(session);
        result.error = "无法连接服务器";
        return result;
    }

    DWORD flags = https ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET req = WinHttpOpenRequest(
        connect,
        L"GET",
        path.c_str(),
        nullptr,
        WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES,
        flags);
    if (!req)
    {
        WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
        result.error = "无法创建请求";
        return result;
    }

    std::wstring headers = L"Accept: application/json\r\n";
    if (!request.apiKey.empty())
        headers += L"Authorization: Bearer " + toWide(request.apiKey) + L"\r\n";

    result.externalCall = true;
    const BOOL sent = WinHttpSendRequest(
        req,
        headers.c_str(),
        static_cast<DWORD>(-1),
        WINHTTP_NO_REQUEST_DATA,
        0,
        0,
        0);

    if (!sent || !WinHttpReceiveResponse(req, nullptr))
    {
        result.error = "HTTP 请求失败（请检查网络或代理）";
        WinHttpCloseHandle(req);
        WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
        return result;
    }

    DWORD status = 0;
    DWORD statusSize = sizeof(status);
    WinHttpQueryHeaders(
        req,
        WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX,
        &status,
        &statusSize,
        WINHTTP_NO_HEADER_INDEX);
    result.statusCode = static_cast<int>(status);

    std::string responseBody;
    for (;;)
    {
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(req, &available) || available == 0)
            break;
        std::vector<char> buffer(available);
        DWORD read = 0;
        if (!WinHttpReadData(req, buffer.data(), available, &read))
            break;
        responseBody.append(buffer.data(), read);
    }

    WinHttpCloseHandle(req);
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);

    if (status < 200 || status >= 300)
    {
        std::string hint = "拉取模型列表失败 HTTP " + std::to_string(status);
        if (status == 401 || status == 403)
            hint += "（请检查 API Key）";
        else if (status == 404)
            hint += "（该厂商可能不支持 /v1/models，请手动添加）";
        if (!responseBody.empty())
            hint += ": " + responseBody.substr(0, 400);
        result.error = hint;
        return result;
    }

    try
    {
        const json root = json::parse(responseBody);
        if (!root.contains("data") || !root["data"].is_array())
        {
            result.error = "返回格式无法识别（缺少 data 数组），请手动添加模型";
            return result;
        }
        for (const auto& item : root["data"])
        {
            if (!item.is_object())
                continue;
            std::string id = item.value("id", "");
            if (id.empty())
                continue;
            result.modelIds.push_back(std::move(id));
        }
        if (result.modelIds.empty())
        {
            result.error = "模型列表为空";
            return result;
        }
        result.ok = true;
    }
    catch (const std::exception& ex)
    {
        result.error = std::string("解析模型列表失败: ") + ex.what()
            + "（可改用手动添加）";
    }
    return result;
#else
    result.error = "仅 Windows 支持拉取模型列表";
    return result;
#endif
}
