#include "TranslateClient.h"
#include "LlmClient.h"

#include <nlohmann/json.hpp>
#include <sstream>
#include <iomanip>
#include <vector>
#include <algorithm>
#include <cctype>
#include <map>
#include <functional>

#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#pragma comment(lib, "winhttp.lib")
#endif

using json = nlohmann::json;

namespace {

#ifdef _WIN32
thread_local std::string g_proxyMode = "auto";
thread_local std::string g_httpProxy;

struct ProxyScope {
    std::string prevMode;
    std::string prevProxy;
    ProxyScope(const std::string& mode, const std::string& proxy)
        : prevMode(g_proxyMode), prevProxy(g_httpProxy)
    {
        g_proxyMode = mode.empty() ? "auto" : toLowerCopy(mode);
        g_httpProxy = proxy;
    }
    ~ProxyScope()
    {
        g_proxyMode = prevMode;
        g_httpProxy = prevProxy;
    }
    static std::string toLowerCopy(std::string s)
    {
        std::transform(s.begin(), s.end(), s.begin(),
            [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return s;
    }
};
#endif

constexpr size_t kMyMemoryMaxQueryChars = 450;
constexpr size_t kGoogleMaxQueryChars = 1200;

std::string toLower(std::string s)
{
    std::transform(s.begin(), s.end(), s.begin(),
        [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}

std::string urlEncode(const std::string& value)
{
    std::ostringstream escaped;
    escaped.fill('0');
    escaped << std::hex << std::uppercase;
    for (unsigned char c : value)
    {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
            || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~')
        {
            escaped << c;
        }
        else if (c == ' ')
        {
            escaped << '+';
        }
        else
        {
            escaped << '%' << std::setw(2) << int(c);
        }
    }
    return escaped.str();
}

size_t utf8CharLen(unsigned char lead)
{
    if (lead < 0x80) return 1;
    if ((lead >> 5) == 0x6) return 2;
    if ((lead >> 4) == 0xE) return 3;
    if ((lead >> 3) == 0x1E) return 4;
    return 1;
}

size_t utf8CodepointCount(const std::string& s)
{
    size_t count = 0;
    for (size_t i = 0; i < s.size();)
    {
        const size_t n = utf8CharLen(static_cast<unsigned char>(s[i]));
        i += std::min(n, s.size() - i);
        ++count;
    }
    return count;
}

bool isBreakChar(char c)
{
    return c == '\n' || c == '\r' || c == '.' || c == '!' || c == '?'
        || c == ';' || c == ':' || c == ' ' || c == '\t';
}

std::vector<std::string> splitChunks(const std::string& text, size_t maxChars)
{
    std::vector<std::string> chunks;
    if (text.empty()) return chunks;
    if (utf8CodepointCount(text) <= maxChars)
    {
        chunks.push_back(text);
        return chunks;
    }
    size_t i = 0;
    while (i < text.size())
    {
        size_t cps = 0;
        size_t j = i;
        size_t lastBreak = i;
        while (j < text.size() && cps < maxChars)
        {
            const size_t n = utf8CharLen(static_cast<unsigned char>(text[j]));
            if (j + n > text.size()) break;
            if (isBreakChar(text[j])) lastBreak = j + n;
            j += n;
            ++cps;
        }
        size_t end = j;
        if (j < text.size() && lastBreak > i) end = lastBreak;
        if (end <= i)
        {
            const size_t n = utf8CharLen(static_cast<unsigned char>(text[i]));
            end = std::min(i + n, text.size());
        }
        chunks.push_back(text.substr(i, end - i));
        i = end;
    }
    return chunks;
}

std::string withZhHint(const std::string& english, const std::string& zh)
{
    if (english.empty()) return zh;
    if (zh.empty()) return english;
    // Already annotated
    if (english.find("（") != std::string::npos && english.find("）") != std::string::npos)
        return english;
    return english + "（" + zh + "）";
}

std::string truncateErr(const std::string& s, size_t maxLen = 220)
{
    if (s.size() <= maxLen) return s;
    return s.substr(0, maxLen) + "...";
}

bool isMyMemoryLimitError(const std::string& msg)
{
    const std::string upper = toLower(msg);
    return upper.find("query length limit") != std::string::npos
        || upper.find("max allowed query") != std::string::npos
        || upper.find("used all available free translations") != std::string::npos
        || upper.find("mymemory warning") != std::string::npos;
}

std::string friendlyMyMemoryError(const std::string& raw)
{
    const std::string clipped = truncateErr(raw);
    if (isMyMemoryLimitError(raw))
    {
        if (toLower(raw).find("used all available") != std::string::npos
            || toLower(raw).find("mymemory warning") != std::string::npos)
        {
            return withZhHint(
                clipped,
                "今日免费翻译额度已用尽，请换用谷歌/Bing/大模型");
        }
        return withZhHint(clipped, "单次文本过长，请开启自动分段或更换引擎");
    }
    const std::string low = toLower(raw);
    if (low.find("429") != std::string::npos
        || low.find("too many") != std::string::npos)
    {
        return withZhHint(clipped, "请求过于频繁或额度不足，请稍后再试或更换引擎");
    }
    if (low.find("http request failed") != std::string::npos
        || low.find("winhttp") != std::string::npos
        || low.find("timeout") != std::string::npos)
    {
        return withZhHint(clipped, "网络异常或连接超时，请检查网络或代理");
    }
    if (low.find("parse") != std::string::npos)
    {
        return withZhHint(clipped, "返回内容无法解析，请换引擎或稍后重试");
    }
    if (low.find("empty") != std::string::npos)
    {
        return withZhHint(clipped, "翻译结果为空，请换引擎或稍后重试");
    }
    if (low.find('{') != std::string::npos
        || low.find("http ") == 0
        || low.find("mymemory") != std::string::npos)
    {
        return withZhHint(clipped, "翻译失败，请稍后重试或更换引擎");
    }
    return clipped;
}

std::string normalizeProvider(std::string p)
{
    p = toLower(p);
    if (p.empty() || p == "free") return "mymemory";
    if (p == "blind" || p == "microsoft") return "bing";
    if (p == "xiaoniu" || p == "niu") return "niutrans";
    return p;
}

std::string mapLangForBing(std::string lang)
{
    lang = toLower(lang);
    if (lang == "zh-cn" || lang == "zh" || lang == "cn") return "zh-Hans";
    if (lang == "zh-tw") return "zh-Hant";
    if (lang == "auto") return "";
    return lang;
}

std::string mapLangSimple(std::string lang)
{
    lang = toLower(lang);
    if (lang == "zh-cn" || lang == "zh-hans") return "zh";
    if (lang == "zh-tw" || lang == "zh-hant") return "cht";
    if (lang == "auto") return "auto";
    return lang;
}

std::string normalizeLangPair(const std::string& source, const std::string& target)
{
    std::string src = source.empty() ? "en" : source;
    std::string dst = target.empty() ? "zh-CN" : target;
    if (dst == "zh" || dst == "zh_CN") dst = "zh-CN";
    return src + "|" + dst;
}

#ifdef _WIN32

std::wstring toWide(const std::string& s)
{
    if (s.empty()) return {};
    const int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
    std::wstring out(static_cast<size_t>(len), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, out.data(), len);
    if (!out.empty() && out.back() == L'\0') out.pop_back();
    return out;
}

std::string trimCopy(std::string s)
{
    auto notSpace = [](unsigned char c) { return !std::isspace(c); };
    s.erase(s.begin(), std::find_if(s.begin(), s.end(), notSpace));
    s.erase(std::find_if(s.rbegin(), s.rend(), notSpace).base(), s.end());
    return s;
}

std::wstring normalizeProxyList(std::string proxy)
{
    proxy = trimCopy(std::move(proxy));
    const std::string low = toLower(proxy);
    if (low.rfind("http://", 0) == 0) proxy = proxy.substr(7);
    else if (low.rfind("https://", 0) == 0) proxy = proxy.substr(8);
    const auto slash = proxy.find('/');
    if (slash != std::string::npos) proxy = proxy.substr(0, slash);
    return toWide(proxy);
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
    if (!WinHttpCrackUrl(wurl.c_str(), 0, 0, &uc)) return false;
    https = (uc.nScheme == INTERNET_SCHEME_HTTPS);
    host.assign(uc.lpszHostName, uc.dwHostNameLength);
    port = uc.nPort;
    path.assign(uc.lpszUrlPath, uc.dwUrlPathLength);
    if (uc.dwExtraInfoLength > 0 && uc.lpszExtraInfo)
        path.append(uc.lpszExtraInfo, uc.dwExtraInfoLength);
    if (path.empty()) path = L"/";
    return true;
}

struct HttpResult {
    bool ok = false;
    int status = 0;
    std::string body;
    std::string error;
};

std::string winHttpErrMessage(DWORD err, const std::wstring& host = L"")
{
    std::string hostA;
    if (!host.empty())
    {
        const int n = WideCharToMultiByte(
            CP_UTF8, 0, host.c_str(), -1, nullptr, 0, nullptr, nullptr);
        if (n > 1)
        {
            hostA.assign(static_cast<size_t>(n - 1), '\0');
            WideCharToMultiByte(
                CP_UTF8, 0, host.c_str(), -1, hostA.data(), n, nullptr, nullptr);
        }
    }
    const std::string hostSuffix = hostA.empty() ? "" : (" for " + hostA);

    switch (err)
    {
    case 12002: // ERROR_WINHTTP_TIMEOUT
        return withZhHint(
            "WinHTTP timeout (12002)" + hostSuffix,
            "连接超时；可尝试：设置→网络代理改为「直连」或填写 Clash 端口如 127.0.0.1:7890");
    case 12005: // ERROR_WINHTTP_INVALID_URL
        return withZhHint("WinHTTP invalid URL (12005)", "接口地址无效");
    case 12007: // ERROR_WINHTTP_NAME_NOT_RESOLVED
        return withZhHint(
            "WinHTTP name not resolved (12007)" + hostSuffix,
            "无法解析域名；若开了代理请改「直连」或检查代理/DNS");
    case 12029: // ERROR_WINHTTP_CANNOT_CONNECT
        return withZhHint(
            "WinHTTP cannot connect (12029)" + hostSuffix,
            "无法连接服务器；请检查代理模式（直连/系统/自定义）");
    case 12030: // ERROR_WINHTTP_CONNECTION_ERROR
        return withZhHint(
            "WinHTTP connection error (12030)" + hostSuffix,
            "网络连接中断，请检查网络或代理");
    default:
        if (err == 0)
            return withZhHint(
                "HTTP request failed" + hostSuffix,
                "网络请求失败，请检查网络或代理设置");
        return withZhHint(
            "WinHTTP error " + std::to_string(err) + hostSuffix,
            "网络请求失败；可尝试直连或填写本地代理端口");
    }
}

bool looksLikeHtml(const std::string& body)
{
    size_t i = 0;
    while (i < body.size()
        && (body[i] == ' ' || body[i] == '\n' || body[i] == '\r' || body[i] == '\t'))
        ++i;
    if (i >= body.size()) return false;
    if (body[i] == '<') return true;
    const std::string head = toLower(body.substr(i, std::min<size_t>(64, body.size() - i)));
    return head.find("<!doctype") != std::string::npos
        || head.find("<html") != std::string::npos;
}

HttpResult winHttpRequest(
    const std::string& method,
    const std::string& url,
    const std::string& body,
    const std::wstring& extraHeaders)
{
    HttpResult result;
    bool https = true;
    std::wstring host;
    INTERNET_PORT port = INTERNET_DEFAULT_HTTPS_PORT;
    std::wstring path;
    if (!parseUrl(url, https, host, port, path))
    {
        result.error = withZhHint("Invalid URL", "接口地址无效");
        return result;
    }

    DWORD accessType = WINHTTP_ACCESS_TYPE_NO_PROXY;
    LPCWSTR proxyName = WINHTTP_NO_PROXY_NAME;
    std::wstring proxyBuf;
    const std::string mode = toLower(g_proxyMode.empty() ? "auto" : g_proxyMode);
    if (mode == "direct" || mode == "none" || mode == "off")
    {
        accessType = WINHTTP_ACCESS_TYPE_NO_PROXY;
    }
    else if ((mode == "custom" || mode == "manual") && !trimCopy(g_httpProxy).empty())
    {
        accessType = WINHTTP_ACCESS_TYPE_NAMED_PROXY;
        proxyBuf = normalizeProxyList(g_httpProxy);
        proxyName = proxyBuf.c_str();
    }
    else
    {
        // Follow Windows system proxy / PAC (better than DEFAULT_PROXY for Win10+)
        accessType = WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY;
    }

    HINTERNET session = WinHttpOpen(
        L"Mozilla/5.0 LLMChatBackend/1.0",
        accessType,
        proxyName,
        WINHTTP_NO_PROXY_BYPASS,
        0);
    // AUTOMATIC_PROXY unsupported on some builds → fall back
    if (!session && accessType == WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY)
    {
        session = WinHttpOpen(
            L"Mozilla/5.0 LLMChatBackend/1.0",
            WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
            WINHTTP_NO_PROXY_NAME,
            WINHTTP_NO_PROXY_BYPASS,
            0);
    }
    if (!session)
    {
        result.error = withZhHint("WinHttpOpen failed", "无法初始化网络组件");
        return result;
    }

    // 解析 / 连接 / 发送 / 接收 超时（毫秒）
    WinHttpSetTimeouts(session, 5000, 5000, 10000, 10000);

    // Prefer TLS1.2+
    DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
#ifdef WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3
    protocols |= WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3;
#endif
    WinHttpSetOption(
        session, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols));

    HINTERNET connect = WinHttpConnect(session, host.c_str(), port, 0);
    if (!connect)
    {
        const DWORD err = GetLastError();
        WinHttpCloseHandle(session);
        result.error = winHttpErrMessage(err, host);
        return result;
    }

    DWORD flags = https ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET request = WinHttpOpenRequest(
        connect, toWide(method).c_str(), path.c_str(), nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (!request)
    {
        const DWORD err = GetLastError();
        WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
        result.error = winHttpErrMessage(err, host);
        return result;
    }

    // For HTTPS through named proxy, ensure CONNECT works
    if (https && accessType == WINHTTP_ACCESS_TYPE_NAMED_PROXY)
    {
        DWORD opt = WINHTTP_DISABLE_KEEP_ALIVE;
        // no-op optional; keep defaults
        (void)opt;
    }

    std::wstring headers =
        L"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        L"(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n"
        L"Accept: application/json,text/plain,*/*\r\n";
    if (!extraHeaders.empty()) headers += extraHeaders;

    const BOOL sent = WinHttpSendRequest(
        request,
        headers.c_str(),
        static_cast<DWORD>(-1),
        body.empty() ? WINHTTP_NO_REQUEST_DATA : (LPVOID)body.data(),
        static_cast<DWORD>(body.size()),
        static_cast<DWORD>(body.size()),
        0);

    if (!sent || !WinHttpReceiveResponse(request, nullptr))
    {
        const DWORD err = GetLastError();
        result.error = winHttpErrMessage(err, host);
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
        &status, &statusSize, WINHTTP_NO_HEADER_INDEX);
    result.status = static_cast<int>(status);

    for (;;)
    {
        DWORD available = 0;
        if (!WinHttpQueryDataAvailable(request, &available) || available == 0) break;
        std::vector<char> buffer(available);
        DWORD read = 0;
        if (!WinHttpReadData(request, buffer.data(), available, &read)) break;
        result.body.append(buffer.data(), read);
    }

    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);

    result.ok = (status >= 200 && status < 300);
    if (!result.ok)
    {
        const std::string en = "HTTP " + std::to_string(status)
            + (result.body.empty() ? "" : (": " + truncateErr(result.body, 160)));
        if (status == 429)
            result.error = withZhHint(en, "请求过于频繁或额度不足，请稍后再试或更换引擎");
        else if (status == 401 || status == 403)
            result.error = withZhHint(en, "没有访问权限，请检查 API 配置");
        else if (status == 404)
            result.error = withZhHint(en, "接口地址不正确或不存在");
        else if (status >= 500)
            result.error = withZhHint(en, "翻译服务暂时不可用，请稍后重试或更换引擎");
        else
            result.error = withZhHint(en, "翻译服务请求失败，请稍后重试或更换引擎");

        if (status == 429
            || toLower(result.body).find("mymemory warning") != std::string::npos
            || toLower(result.body).find("used all available") != std::string::npos
            || result.body.find("429001") != std::string::npos
            || toLower(result.body).find("exceeded request limits") != std::string::npos)
        {
            if (result.body.find("429001") != std::string::npos
                || toLower(result.body).find("exceeded request limits") != std::string::npos)
            {
                result.error = withZhHint(
                    truncateErr(result.body.empty() ? en : result.body),
                    "Bing 请求过于频繁，请稍后再试");
            }
            else
            {
                result.error = friendlyMyMemoryError(
                    result.body.empty() ? en : result.body);
            }
        }
    }
    return result;
}

bool looksLikeNetworkError(const std::string& err)
{
    const std::string e = toLower(err);
    return e.find("http request failed") != std::string::npos
        || e.find("winhttp") != std::string::npos
        || e.find("connect failed") != std::string::npos
        || e.find("timed out") != std::string::npos
        || e.find("timeout") != std::string::npos
        || e.find("连接超时") != std::string::npos
        || e.find("无法连接") != std::string::npos
        || e.find("无法解析") != std::string::npos
        || e.find("网络请求失败") != std::string::npos
        || e.find("网络连接中断") != std::string::npos;
}

size_t engineDefaultMax(const std::string& p)
{
    if (p == "mymemory") return kMyMemoryMaxQueryChars;
    if (p == "google") return kGoogleMaxQueryChars;
    if (p == "bing") return 3000;
    if (p == "llm") return 0;
    return 2000;
}

TranslateResult markNetworkIfNeeded(TranslateResult r)
{
    if (!r.ok)
    {
        // Prefer keeping original English; only annotate if still pure English
        const bool hasZhParen = r.error.find("（") != std::string::npos;
        if (!hasZhParen)
        {
            if (looksLikeNetworkError(r.error))
            {
                r.code = r.code.empty() ? "NETWORK_TIMEOUT" : r.code;
                r.error = withZhHint(
                    truncateErr(r.error),
                    "网络异常或连接超时，请检查网络或代理");
            }
            else
            {
                r.error = friendlyMyMemoryError(
                    r.error.empty() ? "translate failed" : r.error);
            }
        }
        else if (r.code.empty() && looksLikeNetworkError(r.error))
        {
            r.code = "NETWORK_TIMEOUT";
        }
    }
    return r;
}

HttpResult winHttpGet(const std::string& url)
{
    return winHttpRequest("GET", url, {}, L"");
}

HttpResult winHttpPost(const std::string& url, const std::string& body, const std::wstring& headers)
{
    return winHttpRequest("POST", url, body, headers);
}

TranslateResult joinChunkTranslations(
    const std::vector<std::string>& chunks,
    const std::function<TranslateResult(const std::string&)>& fn)
{
    TranslateResult result;
    std::ostringstream joined;
    for (size_t i = 0; i < chunks.size(); ++i)
    {
        const TranslateResult part = fn(chunks[i]);
        if (!part.ok) return part;
        if (i > 0
            && !chunks[i - 1].empty() && !chunks[i].empty()
            && !std::isspace(static_cast<unsigned char>(chunks[i - 1].back()))
            && !std::isspace(static_cast<unsigned char>(chunks[i].front())))
        {
            joined << ' ';
        }
        joined << part.translation;
        result.provider = part.provider;
    }
    result.translation = joined.str();
    result.ok = !result.translation.empty();
    if (!result.ok) result.error = "Empty translation";
    return result;
}

TranslateResult translateMyMemoryChunk(const std::string& text, const std::string& pair)
{
    TranslateResult result;
    result.provider = "mymemory";
    const std::string url =
        "https://api.mymemory.translated.net/get?q=" + urlEncode(text)
        + "&langpair=" + urlEncode(pair);
    const HttpResult http = winHttpGet(url);
    if (!http.ok)
    {
        const std::string raw = http.error.empty()
            ? (http.body.empty() ? "MyMemory request failed" : http.body)
            : http.error;
        result.error = friendlyMyMemoryError(raw);
        return result;
    }
    try
    {
        const json root = json::parse(http.body);
        const int status = root.value("responseStatus", 200);
        result.translation = root.at("responseData").value("translatedText", "");
        if (status != 200 || isMyMemoryLimitError(result.translation))
        {
            const std::string raw = result.translation.empty()
                ? ("MyMemory status " + std::to_string(status))
                : result.translation;
            result.error = friendlyMyMemoryError(raw);
            result.translation.clear();
            return result;
        }
        if (result.translation.empty())
        {
            result.error = withZhHint(
                "Empty translation from MyMemory",
                "翻译结果为空，请换引擎或稍后重试");
            return result;
        }
        result.ok = true;
    }
    catch (const std::exception& ex)
    {
        result.error = withZhHint(
            std::string("Parse MyMemory failed: ") + ex.what(),
            "返回内容无法解析，请换引擎或稍后重试");
    }
    return result;
}

TranslateResult translateGoogleChunk(const std::string& text, const std::string& src, const std::string& dst)
{
    TranslateResult result;
    result.provider = "google";
    const std::string sl = src.empty() || toLower(src) == "auto" ? "auto" : src;
    const std::string url =
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl="
        + urlEncode(sl) + "&tl=" + urlEncode(dst) + "&dt=t&q=" + urlEncode(text);
    const HttpResult http = winHttpGet(url);
    if (!http.ok)
    {
        const std::string base = http.error.empty()
            ? "Google translate request failed"
            : http.error;
        result.error = withZhHint(
            base,
            "谷歌翻译连接失败，国内常需系统代理，可改用 Bing/有道");
        return result;
    }
    if (looksLikeHtml(http.body) || http.body.empty())
    {
        result.error = withZhHint(
            "Google translate returned HTML/empty body",
            "谷歌翻译返回异常（可能被墙），请改用 Bing/有道或配置代理");
        return result;
    }
    try
    {
        const json root = json::parse(http.body);
        std::ostringstream out;
        if (root.is_array() && !root.empty() && root[0].is_array())
        {
            for (const auto& part : root[0])
            {
                if (part.is_array() && !part.empty() && part[0].is_string())
                    out << part[0].get<std::string>();
            }
        }
        result.translation = out.str();
        if (result.translation.empty())
        {
            result.error = withZhHint(
                "Empty translation from Google",
                "谷歌翻译无有效结果，国内常需代理，可改用 Bing/有道");
            return result;
        }
        result.ok = true;
    }
    catch (const std::exception& ex)
    {
        result.error = withZhHint(
            std::string("Parse Google failed: ") + ex.what(),
            "谷歌翻译返回无法解析，国内常需代理，可改用 Bing/有道");
    }
    return result;
}

TranslateResult translateBing(const std::string& text, const std::string& source, const std::string& target)
{
    TranslateResult result;
    result.provider = "bing";
    const HttpResult auth = winHttpGet("https://edge.microsoft.com/translate/auth");
    if (!auth.ok || auth.body.empty())
    {
        result.error = withZhHint(
            auth.error.empty() ? "Bing auth token failed" : auth.error,
            "Bing 鉴权失败，请稍后重试或更换引擎");
        return result;
    }
    if (looksLikeHtml(auth.body))
    {
        result.error = withZhHint(
            "Bing auth returned HTML",
            "Bing 鉴权返回异常，请检查网络后重试");
        return result;
    }
    const std::string token = auth.body;
    const std::string from = mapLangForBing(source.empty() ? "en" : source);
    const std::string to = mapLangForBing(target.empty() ? "zh-CN" : target);

    json body = json::array();
    body.push_back({{"Text", text}});
    const std::wstring headers =
        L"Content-Type: application/json\r\nAuthorization: Bearer "
        + toWide(token) + L"\r\n";

    // api.edge.microsofttranslator.com often fails DNS in CN;
    // api.cognitive.microsofttranslator.com works with the Edge auth token.
    const std::vector<std::string> hosts = {
        "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=",
        "https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=",
    };

    HttpResult http;
    std::string lastErr;
    for (const auto& base : hosts)
    {
        std::string url = base + urlEncode(to);
        if (!from.empty()) url += "&from=" + urlEncode(from);
        http = winHttpPost(url, body.dump(), headers);
        if (http.ok && !looksLikeHtml(http.body))
            break;
        lastErr = http.error.empty()
            ? ("HTTP " + std::to_string(http.status) + " from " + base)
            : http.error;
    }

    if (!http.ok || looksLikeHtml(http.body))
    {
        result.error = withZhHint(
            lastErr.empty() ? "Bing translate failed" : lastErr,
            "Bing 翻译请求失败，请稍后重试、检查代理，或换大模型");
        return result;
    }
    try
    {
        const json root = json::parse(http.body);
        if (root.is_array() && !root.empty()
            && root[0].contains("translations")
            && root[0]["translations"].is_array()
            && !root[0]["translations"].empty())
        {
            result.translation = root[0]["translations"][0].value("text", "");
        }
        if (result.translation.empty())
        {
            result.error = withZhHint(
                "Empty translation from Bing",
                "Bing 翻译结果为空，请稍后重试或更换引擎");
            return result;
        }
        result.ok = true;
    }
    catch (const std::exception& ex)
    {
        result.error = withZhHint(
            std::string("Parse Bing failed: ") + ex.what(),
            "Bing 翻译返回无法解析，请稍后重试或更换引擎");
    }
    return result;
}

TranslateResult translateYoudao(const std::string& text, const std::string& source, const std::string& target)
{
    TranslateResult result;
    result.provider = "youdao";
    (void)text;
    (void)source;
    (void)target;
    result.error = withZhHint(
        "Youdao free web endpoint discontinued (returns HTML SPA)",
        "有道免费网页接口已失效，请改用 Bing / 大模型，或为谷歌配置代理");
    result.code = "ERROR";
    return result;
}

TranslateResult translateBaidu(const std::string& text, const std::string& source, const std::string& target)
{
    TranslateResult result;
    result.provider = "baidu";
    (void)text;
    (void)source;
    (void)target;
    result.error = withZhHint(
        "Baidu free transapi requires signed session (errno 1022)",
        "百度免费接口已不可用（需密钥/签名），请改用 Bing / 大模型");
    result.code = "ERROR";
    return result;
}

TranslateResult translateSogou(const std::string& text, const std::string& source, const std::string& target)
{
    TranslateResult result;
    result.provider = "sogou";
    (void)text;
    (void)source;
    (void)target;
    result.error = withZhHint(
        "Sogou free translate endpoint returns HTTP 405",
        "搜狗免费接口已不可用，请改用 Bing / 大模型");
    result.code = "ERROR";
    return result;
}

TranslateResult translateNiutrans(const std::string& text, const std::string& source, const std::string& target)
{
    TranslateResult result;
    result.provider = "niutrans";
    (void)text;
    (void)source;
    (void)target;
    result.error = withZhHint(
        "Niutrans free endpoint requires apikey (error_code 13002)",
        "小牛翻译需要 API Key，当前未配置，请改用 Bing / 大模型");
    result.code = "ERROR";
    return result;
}

#endif

} // namespace

TranslateResult TranslateClient::translateFree(
    const std::string& text,
    const std::string& source,
    const std::string& target,
    const std::string& provider,
    int maxLength,
    bool autoChunk,
    const std::string& proxyMode,
    const std::string& httpProxy)
{
    TranslateResult result;
    const std::string p = normalizeProvider(provider);
    result.provider = p;

    if (text.empty())
    {
        result.error = withZhHint("text required", "请输入要翻译的文本");
        result.code = "ERROR";
        return result;
    }

#ifdef _WIN32
    ProxyScope proxyScope(proxyMode, httpProxy);

    size_t limit = engineDefaultMax(p);
    if (maxLength > 0)
        limit = static_cast<size_t>(maxLength);

    const size_t cps = utf8CodepointCount(text);
    if (limit > 0 && cps > limit)
    {
        if (!autoChunk)
        {
            result.code = "LENGTH_LIMIT";
            result.error = withZhHint(
                "Text exceeds max length (" + std::to_string(cps)
                    + " > " + std::to_string(limit) + ")",
                "文本过长，请增大最大长度或开启自动分段");
            return result;
        }
    }

    const size_t chunkSize = limit > 0 ? limit : cps;

    auto runLimited = [&](auto&& fn) -> TranslateResult {
        if (limit > 0 && autoChunk && cps > limit)
            return markNetworkIfNeeded(joinChunkTranslations(splitChunks(text, chunkSize), fn));
        return markNetworkIfNeeded(fn(text));
    };

    if (p == "mymemory")
    {
        const std::string pair = normalizeLangPair(source, target);
        return runLimited([&](const std::string& chunk) {
            return translateMyMemoryChunk(chunk, pair);
        });
    }
    if (p == "google")
    {
        const std::string src = source.empty() ? "en" : source;
        const std::string dst = target.empty() ? "zh-CN" : target;
        return runLimited([&](const std::string& chunk) {
            return translateGoogleChunk(chunk, src, dst);
        });
    }
    if (p == "bing")
    {
        return runLimited([&](const std::string& chunk) {
            return translateBing(chunk, source, target);
        });
    }
    if (p == "youdao")
        return markNetworkIfNeeded(runLimited([&](const std::string& chunk) {
            return translateYoudao(chunk, source, target);
        }));
    if (p == "baidu")
        return markNetworkIfNeeded(runLimited([&](const std::string& chunk) {
            return translateBaidu(chunk, source, target);
        }));
    if (p == "sogou")
        return markNetworkIfNeeded(runLimited([&](const std::string& chunk) {
            return translateSogou(chunk, source, target);
        }));
    if (p == "niutrans")
        return markNetworkIfNeeded(runLimited([&](const std::string& chunk) {
            return translateNiutrans(chunk, source, target);
        }));

    result.error = withZhHint(
        "Unknown translate provider: " + p,
        "未知的翻译引擎，请重新选择");
    result.code = "ERROR";
#else
    result.error = withZhHint(
        "Free translate only implemented on Windows",
        "当前环境不支持该免费翻译引擎");
    result.code = "ERROR";
#endif
    return result;
}

TranslateResult TranslateClient::translateWithLlm(
    const std::string& text,
    const std::string& apiUrl,
    const std::string& apiKey,
    const std::string& model,
    const std::string& source,
    const std::string& target,
    const std::string& proxyMode,
    const std::string& httpProxy,
    const std::string& customPrompt,
    const std::string& glossaryJson)
{
    TranslateResult result;
    result.provider = "llm";

    if (text.empty())
    {
        result.error = withZhHint("text required", "请输入要翻译的文本");
        return result;
    }

#ifdef _WIN32
    ProxyScope proxyScope(proxyMode, httpProxy);
    (void)proxyScope; // LlmClient may use its own HTTP; kept for future shared stack
#endif

    const std::string src = source.empty() ? "en" : source;
    const std::string dst = target.empty() ? "zh-CN" : target;

    std::string systemPrompt = customPrompt;
    if (systemPrompt.empty())
    {
        systemPrompt =
            "You are a precise bilingual translator. Translate the user text from "
            + src + " to " + dst
            + ". Output only the translation text with no quotes, notes, or explanations.";
    }
    else
    {
        systemPrompt +=
            "\n\nTranslate from " + src + " to " + dst
            + ". Output only the translation text with no quotes, notes, or explanations.";
    }

    if (!glossaryJson.empty() && glossaryJson != "[]")
    {
        try
        {
            const json gloss = json::parse(glossaryJson);
            if (gloss.is_array() && !gloss.empty())
            {
                std::ostringstream oss;
                oss << "\n\nGlossary (use these translations consistently):\n";
                for (const auto& item : gloss)
                {
                    if (!item.is_object())
                        continue;
                    const std::string gSrc = item.value("src", "");
                    const std::string gDst = item.value("dst", "");
                    const std::string info = item.value("info", "");
                    if (gSrc.empty() || gDst.empty())
                        continue;
                    oss << "- " << gSrc << " => " << gDst;
                    if (!info.empty())
                        oss << " (" << info << ")";
                    oss << "\n";
                }
                systemPrompt += oss.str();
            }
        }
        catch (...)
        {
            // ignore bad glossary JSON
        }
    }

    json messages = json::array();
    messages.push_back({
        {"role", "system"},
        {"content", systemPrompt},
    });
    messages.push_back({{"role", "user"}, {"content", text}});

    LlmRequest req;
    req.apiUrl = apiUrl;
    req.apiKey = apiKey;
    req.model = model;
    req.messages = messages;

    const LlmResponse llm = LlmClient::chat(req);
    if (!llm.ok)
    {
        const std::string en = truncateErr(
            llm.error.empty() ? "LLM request failed" : llm.error);
        const std::string low = toLower(llm.error);
        if (low.find("401") != std::string::npos || low.find("unauthorized") != std::string::npos)
            result.error = withZhHint(en, "大模型认证失败，请检查 API Key");
        else if (low.find("429") != std::string::npos)
            result.error = withZhHint(en, "大模型额度不足或请求过频");
        else if (low.find("404") != std::string::npos || low.find("not found") != std::string::npos)
            result.error = withZhHint(en, "模型或接口不存在，请检查 API URL 与模型名称");
        else if (looksLikeNetworkError(llm.error))
            result.error = withZhHint(en, "网络异常或连接超时，请检查网络后重试");
        else if (low.find("parse llm") != std::string::npos
            || low.find("empty llm http body") != std::string::npos
            || low.find("parse_error") != std::string::npos)
            result.error = withZhHint(en, "大模型返回内容为空或无法解析，请检查 API URL 是否为 chat/completions 且模型可用");
        else
            result.error = withZhHint(en, "大模型接口调用失败，请检查 API URL、密钥与模型");
        return result;
    }

    result.translation = llm.content;
    result.promptTokens = llm.promptTokens;
    result.completionTokens = llm.completionTokens;
    result.totalTokens = llm.totalTokens;
    result.ok = true;
    return result;
}
