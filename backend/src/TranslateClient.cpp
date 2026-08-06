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
#include <random>
#include <chrono>
#include <mutex>
#include <regex>

#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#include <wincrypt.h>
#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "advapi32.lib")
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

void replaceAllInPlace(std::string& str, const std::string& from, const std::string& to)
{
    if (from.empty()) return;
    size_t pos = 0;
    while ((pos = str.find(from, pos)) != std::string::npos)
    {
        str.replace(pos, from.size(), to);
        pos += to.size();
    }
}

/**
 * MT engines (esp. Google) often drop "+" in "C++" / "#" in "C#".
 * Protect with stable ASCII placeholders, then restore after translate.
 * Encoding itself is fine ( '+' → "%2B" ); this is an engine quirk.
 */
std::string protectCodeTokens(std::string s)
{
    // Longer tokens first
    replaceAllInPlace(s, "C++", "@@CPP@@");
    replaceAllInPlace(s, "c++", "@@cpp@@");
    replaceAllInPlace(s, "C#", "@@CSHARP@@");
    replaceAllInPlace(s, "c#", "@@csharp@@");
    replaceAllInPlace(s, "F#", "@@FSHARP@@");
    replaceAllInPlace(s, "f#", "@@fsharp@@");
    return s;
}

std::string restoreCodeTokens(std::string s)
{
    replaceAllInPlace(s, "@@CPP@@", "C++");
    replaceAllInPlace(s, "@@cpp@@", "c++");
    replaceAllInPlace(s, "@@CSHARP@@", "C#");
    replaceAllInPlace(s, "@@csharp@@", "c#");
    replaceAllInPlace(s, "@@FSHARP@@", "F#");
    replaceAllInPlace(s, "@@fsharp@@", "f#");
    // Engines sometimes insert spaces inside placeholders
    replaceAllInPlace(s, "@@ CPP @@", "C++");
    replaceAllInPlace(s, "@@ cpp @@", "c++");
    replaceAllInPlace(s, "@@ CSHARP @@", "C#");
    replaceAllInPlace(s, "@@ csharp @@", "c#");
    return s;
}

TranslateResult restoreCodeTokensResult(TranslateResult r)
{
    if (r.ok) r.translation = restoreCodeTokens(std::move(r.translation));
    return r;
}

#ifdef _WIN32
std::string md5Hex(const std::string& data)
{
    HCRYPTPROV prov = 0;
    HCRYPTHASH hash = 0;
    std::string out;
    if (!CryptAcquireContextW(&prov, nullptr, nullptr, PROV_RSA_FULL, CRYPT_VERIFYCONTEXT))
    {
        return out;
    }
    if (!CryptCreateHash(prov, CALG_MD5, 0, 0, &hash))
    {
        CryptReleaseContext(prov, 0);
        return out;
    }
    if (!CryptHashData(hash, reinterpret_cast<const BYTE*>(data.data()),
            static_cast<DWORD>(data.size()), 0))
    {
        CryptDestroyHash(hash);
        CryptReleaseContext(prov, 0);
        return out;
    }
    BYTE digest[16];
    DWORD len = 16;
    if (CryptGetHashParam(hash, HP_HASHVAL, digest, &len, 0))
    {
        std::ostringstream oss;
        oss << std::hex << std::setfill('0');
        for (DWORD i = 0; i < len; ++i)
            oss << std::setw(2) << static_cast<int>(digest[i]);
        out = oss.str();
    }
    CryptDestroyHash(hash);
    CryptReleaseContext(prov, 0);
    return out;
}

std::string randomSalt()
{
    const auto t = std::chrono::steady_clock::now().time_since_epoch().count();
    std::mt19937 rng(static_cast<unsigned>(t ^ (t >> 32)));
    return std::to_string(rng());
}

json parseEngineKeys(const std::string& raw)
{
    if (raw.empty()) return json::object();
    try
    {
        auto j = json::parse(raw);
        if (j.is_object()) return j;
    }
    catch (...)
    {
    }
    return json::object();
}

std::string engineField(const json& keys, const std::string& provider, const std::string& field)
{
    if (!keys.contains(provider) || !keys[provider].is_object()) return {};
    const auto& o = keys[provider];
    if (o.contains(field) && o[field].is_string())
        return o[field].get<std::string>();
    return {};
}

std::string mapBaiduLang(const std::string& code)
{
    const std::string c = toLower(code);
    if (c.empty() || c == "auto") return "auto";
    if (c.rfind("zh-tw", 0) == 0 || c == "cht") return "cht";
    if (c.rfind("zh", 0) == 0) return "zh";
    if (c.rfind("en", 0) == 0) return "en";
    if (c.rfind("ja", 0) == 0 || c == "jp") return "jp";
    if (c.rfind("ko", 0) == 0 || c == "kor") return "kor";
    return c.size() >= 2 ? c.substr(0, 2) : c;
}

std::string mapYoudaoLang(const std::string& code)
{
    const std::string c = toLower(code);
    if (c.empty() || c == "auto") return "auto";
    if (c.rfind("zh-tw", 0) == 0) return "zh-CHT";
    if (c.rfind("zh", 0) == 0) return "zh-CHS";
    if (c.rfind("en", 0) == 0) return "en";
    if (c.rfind("ja", 0) == 0) return "ja";
    if (c.rfind("ko", 0) == 0) return "ko";
    return c.size() >= 2 ? c.substr(0, 2) : c;
}

std::string mapNiuLang(const std::string& code)
{
    const std::string c = toLower(code);
    if (c.empty() || c == "auto") return "auto";
    if (c.rfind("zh", 0) == 0) return "zh";
    if (c.rfind("en", 0) == 0) return "en";
    if (c.rfind("ja", 0) == 0) return "ja";
    if (c.rfind("ko", 0) == 0) return "ko";
    return c.size() >= 2 ? c.substr(0, 2) : c;
}
#endif

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

bool looksLikeHtml(const std::string& body);

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

/** Full upstream body for diagnostics — never truncate or strip HTML. */
std::string safeErrDetail(const std::string& body, size_t /*maxLen*/ = 160)
{
    return body;
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
    // Keep full upstream body for diagnosis (no truncation / no HTML stripping)
    const std::string full = raw.empty() ? "translate failed" : raw;
    if (isMyMemoryLimitError(raw))
    {
        if (toLower(raw).find("used all available") != std::string::npos
            || toLower(raw).find("mymemory warning") != std::string::npos)
        {
            return withZhHint(
                full,
                "今日免费翻译额度已用尽，请换用谷歌/Bing/大模型");
        }
        return withZhHint(full, "单次文本过长，请开启自动分段或更换引擎");
    }
    const std::string low = toLower(raw);
    if (low.find("429") != std::string::npos
        || low.find("too many") != std::string::npos)
    {
        return withZhHint(full, "请求过于频繁或额度不足，请稍后再试或更换引擎");
    }
    if (low.find("http request failed") != std::string::npos
        || low.find("winhttp") != std::string::npos
        || low.find("timeout") != std::string::npos)
    {
        return withZhHint(full, "网络异常或连接超时，请检查网络或代理");
    }
    if (low.find("parse") != std::string::npos)
    {
        return withZhHint(full, "返回内容无法解析，请换引擎或稍后重试");
    }
    if (low.find("empty") != std::string::npos)
    {
        return withZhHint(full, "翻译结果为空，请换引擎或稍后重试");
    }
    if (low.find('{') != std::string::npos
        || low.find("http ") == 0
        || low.find("mymemory") != std::string::npos)
    {
        return withZhHint(full, "翻译失败，请稍后重试或更换引擎");
    }
    return full;
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

std::string fromWide(const std::wstring& w)
{
    if (w.empty()) return {};
    const int n = WideCharToMultiByte(
        CP_UTF8, 0, w.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (n <= 1) return {};
    std::string out(static_cast<size_t>(n - 1), '\0');
    WideCharToMultiByte(
        CP_UTF8, 0, w.c_str(), -1, out.data(), n, nullptr, nullptr);
    return out;
}

void mergeCookiePair(std::string& jar, const std::string& pair)
{
    const auto eq = pair.find('=');
    if (eq == std::string::npos || eq == 0) return;
    const std::string name = pair.substr(0, eq);
    std::string next;
    std::size_t i = 0;
    while (i < jar.size())
    {
        while (i < jar.size() && (jar[i] == ' ' || jar[i] == ';')) ++i;
        const auto start = i;
        while (i < jar.size() && jar[i] != ';') ++i;
        const std::string item = jar.substr(start, i - start);
        if (item.rfind(name + "=", 0) != 0)
        {
            if (!next.empty()) next += "; ";
            next += item;
        }
    }
    if (!next.empty()) next += "; ";
    next += pair;
    jar = std::move(next);
}

void collectSetCookies(HINTERNET request, std::string& jar)
{
    DWORD size = 0;
    WinHttpQueryHeaders(
        request,
        WINHTTP_QUERY_RAW_HEADERS_CRLF,
        WINHTTP_HEADER_NAME_BY_INDEX,
        WINHTTP_NO_OUTPUT_BUFFER,
        &size,
        WINHTTP_NO_HEADER_INDEX);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0) return;
    std::wstring raw(size / sizeof(wchar_t), L'\0');
    if (!WinHttpQueryHeaders(
            request,
            WINHTTP_QUERY_RAW_HEADERS_CRLF,
            WINHTTP_HEADER_NAME_BY_INDEX,
            raw.data(),
            &size,
            WINHTTP_NO_HEADER_INDEX))
    {
        return;
    }
    std::wstringstream ss(raw);
    std::wstring line;
    while (std::getline(ss, line))
    {
        if (!line.empty() && line.back() == L'\r') line.pop_back();
        if (line.size() < 12) continue;
        if (_wcsnicmp(line.c_str(), L"Set-Cookie:", 11) != 0) continue;
        std::wstring v = line.substr(11);
        while (!v.empty() && iswspace(v.front())) v.erase(v.begin());
        const auto semi = v.find(L';');
        const std::wstring pairW =
            semi == std::wstring::npos ? v : v.substr(0, semi);
        mergeCookiePair(jar, fromWide(pairW));
    }
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
    /** Cookie request header value collected from Set-Cookie (name=value; …). */
    std::string cookies;
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

/** Google free endpoint blocked by CAPTCHA / unusual-traffic page. */
bool isGoogleCaptchaOrBlockPage(const std::string& body)
{
    if (body.empty()) return false;
    const size_t n = std::min(body.size(), size_t(8000));
    const std::string low = toLower(body.substr(0, n));
    return low.find("recaptcha") != std::string::npos
        || low.find("captcha-form") != std::string::npos
        || low.find("unusual traffic") != std::string::npos
        || low.find("detected unusual traffic") != std::string::npos
        || low.find("g-recaptcha") != std::string::npos
        || (looksLikeHtml(body)
            && low.find("translate.googleapis.com") != std::string::npos
            && low.find("continue") != std::string::npos);
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

    collectSetCookies(request, result.cookies);

    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);

    result.ok = (status >= 200 && status < 300);
    if (!result.ok)
    {
        const std::string detail = safeErrDetail(result.body, 160);
        const std::string en = "HTTP " + std::to_string(status)
            + (detail.empty() ? "" : (": " + detail));
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
                const std::string bingDetail = safeErrDetail(result.body);
                result.error = withZhHint(
                    bingDetail.empty() ? en : bingDetail,
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
                    r.error,
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
        if (part.externalCall)
            result.externalCall = true;
        if (!part.ok)
            return part;
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
    result.externalCall = true;
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
    result.externalCall = true;
    const HttpResult http = winHttpGet(url);

    auto markCaptcha = [&](const std::string& /*raw*/) {
        result.ok = false;
        result.translation.clear();
        result.code = "GOOGLE_CAPTCHA";
        // CAPTCHA HTML 本身无助于排障，给出明确说明即可
        result.error = withZhHint(
            "Google CAPTCHA / unusual traffic from your network",
            "谷歌翻译触发人机验证（请求过频或 IP 被风控），请稍后再试，或改用 Bing/有道");
    };

    if (!http.ok)
    {
        if (isGoogleCaptchaOrBlockPage(http.body) || isGoogleCaptchaOrBlockPage(http.error))
        {
            markCaptcha(http.body.empty() ? http.error : http.body);
            return result;
        }
        const std::string base = http.error.empty()
            ? "Google translate request failed"
            : http.error;
        result.error = withZhHint(
            base,
            "谷歌翻译连接失败，国内常需系统代理，可改用 Bing/有道");
        return result;
    }
    if (http.body.empty())
    {
        result.error = withZhHint(
            "Google translate empty body",
            "谷歌翻译返回为空，请改用 Bing/有道或配置代理");
        return result;
    }
    if (isGoogleCaptchaOrBlockPage(http.body) || looksLikeHtml(http.body))
    {
        markCaptcha(http.body);
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
        if (looksLikeHtml(result.translation) || isGoogleCaptchaOrBlockPage(result.translation))
        {
            markCaptcha(result.translation);
            return result;
        }
        result.ok = true;
    }
    catch (const std::exception& ex)
    {
        if (isGoogleCaptchaOrBlockPage(http.body))
        {
            markCaptcha(http.body);
            return result;
        }
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

    struct BingCred {
        std::string host;
        std::string ig;
        std::string key;
        std::string token;
        std::string cookies;
        std::chrono::steady_clock::time_point expires{};
    };
    static std::mutex mu;
    static BingCred cache;

    auto parseCreds = [](const std::string& html, BingCred& out) -> bool {
        std::smatch m;
        if (!std::regex_search(html, m, std::regex(R"regex(IG:"([^"]+)")regex")))
            return false;
        out.ig = m[1].str();
        if (!std::regex_search(
                html,
                m,
                std::regex(
                    R"regex(params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)")regex")))
        {
            return false;
        }
        out.key = m[1].str();
        out.token = m[2].str();
        return !out.ig.empty() && !out.key.empty() && !out.token.empty();
    };

    auto ensureCreds = [&](BingCred& cred) -> std::string {
        const auto now = std::chrono::steady_clock::now();
        {
            std::lock_guard<std::mutex> lock(mu);
            if (!cache.host.empty()
                && !cache.ig.empty()
                && !cache.token.empty()
                && now < cache.expires)
            {
                cred = cache;
                return {};
            }
        }

        const std::vector<std::string> hosts = {
            "https://cn.bing.com",
            "https://www.bing.com",
        };
        std::string lastErr;
        for (const auto& host : hosts)
        {
            const HttpResult page = winHttpGet(host + "/translator");
            if (!page.ok || page.body.empty())
            {
                lastErr = page.error.empty()
                    ? ("HTTP " + std::to_string(page.status) + " from " + host + "/translator")
                    : page.error;
                continue;
            }
            BingCred next;
            next.host = host;
            next.cookies = page.cookies;
            if (!parseCreds(page.body, next))
            {
                lastErr = "Cannot parse Bing translator tokens from " + host;
                continue;
            }
            next.expires = now + std::chrono::minutes(25);
            {
                std::lock_guard<std::mutex> lock(mu);
                cache = next;
            }
            cred = std::move(next);
            return {};
        }
        return lastErr.empty()
            ? "Bing translator page unavailable"
            : lastErr;
    };

    BingCred cred;
    // Credential bootstrap hits Bing over the network.
    result.externalCall = true;
    const std::string credErr = ensureCreds(cred);
    if (!credErr.empty())
    {
        result.error = withZhHint(
            credErr,
            "Bing 鉴权失败（旧 Edge 接口已失效）。请检查网络后重试，或换有道/大模型");
        return result;
    }

    const std::string from = mapLangForBing(source.empty() ? "en" : source);
    const std::string to = mapLangForBing(target.empty() ? "zh-CN" : target);
    const std::string fromLang = from.empty() ? "auto-detect" : from;

    const std::string form =
        "fromLang=" + urlEncode(fromLang)
        + "&to=" + urlEncode(to)
        + "&text=" + urlEncode(text)
        + "&token=" + urlEncode(cred.token)
        + "&key=" + urlEncode(cred.key)
        + "&tryFetchingGenderDebiasedTranslations=true";

    const std::string url =
        cred.host + "/ttranslatev3?isVertical=1&IG=" + urlEncode(cred.ig)
        + "&IID=translator.5026";

    std::wstring headers =
        L"Content-Type: application/x-www-form-urlencoded\r\n"
        L"Origin: " + toWide(cred.host) + L"\r\n"
        L"Referer: " + toWide(cred.host + "/translator") + L"\r\n";
    if (!cred.cookies.empty())
        headers += L"Cookie: " + toWide(cred.cookies) + L"\r\n";

    HttpResult http = winHttpPost(url, form, headers);
    // Token expired / challenge → refresh once
    if ((!http.ok || http.body.empty() || looksLikeHtml(http.body))
        && (http.status == 401 || http.status == 403 || http.status == 404
            || http.body.find("\"statusCode\":") != std::string::npos))
    {
        {
            std::lock_guard<std::mutex> lock(mu);
            cache = {};
        }
        const std::string retryErr = ensureCreds(cred);
        if (retryErr.empty())
        {
            const std::string form2 =
                "fromLang=" + urlEncode(fromLang)
                + "&to=" + urlEncode(to)
                + "&text=" + urlEncode(text)
                + "&token=" + urlEncode(cred.token)
                + "&key=" + urlEncode(cred.key)
                + "&tryFetchingGenderDebiasedTranslations=true";
            const std::string url2 =
                cred.host + "/ttranslatev3?isVertical=1&IG=" + urlEncode(cred.ig)
                + "&IID=translator.5026";
            std::wstring headers2 =
                L"Content-Type: application/x-www-form-urlencoded\r\n"
                L"Origin: " + toWide(cred.host) + L"\r\n"
                L"Referer: " + toWide(cred.host + "/translator") + L"\r\n";
            if (!cred.cookies.empty())
                headers2 += L"Cookie: " + toWide(cred.cookies) + L"\r\n";
            http = winHttpPost(url2, form2, headers2);
        }
    }

    if (!http.ok || looksLikeHtml(http.body))
    {
        const std::string raw = http.error.empty()
            ? ("HTTP " + std::to_string(http.status) + " from Bing webpage API")
            : http.error;
        result.error = withZhHint(
            raw,
            "Bing 翻译请求失败，请稍后重试、检查代理，或换有道/大模型");
        return result;
    }

    try
    {
        const json root = json::parse(http.body);
        // Webpage API: [{ translations: [{ text }] }]
        // or { statusCode, … }
        if (root.is_object() && root.contains("statusCode"))
        {
            result.error = withZhHint(
                "Bing status " + root.value("statusCode", json(0)).dump(),
                "Bing 拒绝了请求（可能触发风控），请稍后再试");
            return result;
        }
        if (root.is_array() && !root.empty())
        {
            const json& first = root[0];
            if (first.contains("translations")
                && first["translations"].is_array()
                && !first["translations"].empty())
            {
                result.translation =
                    first["translations"][0].value("text", "");
            }
        }
        if (result.translation.empty())
        {
            result.error = withZhHint(
                "Empty translation from Bing",
                "Bing 翻译结果为空，请稍后重试或更换引擎");
            return result;
        }
        if (looksLikeHtml(result.translation))
        {
            result.translation.clear();
            result.error = withZhHint(
                "Bing translation looked like HTML",
                "Bing 翻译返回异常，请稍后重试或更换引擎");
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

/** Prefer Youdao (rich CN gloss + phonetics + examples); fall back to Bing. */
json lookupYoudaoDictionaryJson(const std::string& word)
{
    json out = json::object();
    out["ok"] = false;
    const std::string url =
        "https://dict.youdao.com/jsonapi?q=" + urlEncode(word);
    const HttpResult http = winHttpGet(url);
    if (!http.ok || http.body.empty())
    {
        out["error"] = withZhHint(
            http.error.empty()
                ? ("HTTP " + std::to_string(http.status) + " from Youdao")
                : http.error,
            "有道词典请求失败");
        return out;
    }

    auto stripHtml = [](std::string s) {
        std::string r;
        r.reserve(s.size());
        bool inTag = false;
        for (char c : s)
        {
            if (c == '<')
            {
                inTag = true;
                continue;
            }
            if (c == '>')
            {
                inTag = false;
                continue;
            }
            if (!inTag) r.push_back(c);
        }
        return r;
    };

    auto mapPos = [](std::string tag) {
        for (char& c : tag)
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        while (!tag.empty() && (tag.back() == '.' || tag.back() == ' '))
            tag.pop_back();
        if (tag == "n" || tag == "noun") return std::string("noun");
        if (tag == "v" || tag == "verb" || tag == "vi" || tag == "vt")
            return std::string("verb");
        if (tag == "adj" || tag == "a" || tag == "adjective")
            return std::string("adjective");
        if (tag == "adv" || tag == "ad" || tag == "adverb")
            return std::string("adverb");
        if (tag == "prep" || tag == "preposition") return std::string("preposition");
        if (tag == "conj" || tag == "conjunction") return std::string("conjunction");
        if (tag == "pron" || tag == "pronoun") return std::string("pronoun");
        if (tag == "int" || tag == "interjection") return std::string("interjection");
        if (tag == "num" || tag == "number") return std::string("number");
        if (tag == "art" || tag == "article") return std::string("article");
        return tag.empty() ? std::string("unknown") : tag;
    };

    auto splitZhDefs = [](std::string line) {
        // Drop leading "n. " / "v. " etc.
        static const std::regex posRe(
            R"regex(^\s*([a-zA-Z]+\.?)\s+)regex");
        std::smatch m;
        if (std::regex_search(line, m, posRe))
            line = line.substr(m[0].length());
        std::vector<std::string> parts;
        std::string cur;
        for (size_t i = 0; i < line.size(); ++i)
        {
            const unsigned char c = static_cast<unsigned char>(line[i]);
            const unsigned char c2 =
                i + 1 < line.size() ? static_cast<unsigned char>(line[i + 1]) : 0;
            // UTF-8 fullwidth semicolon U+FF1B = EF BC 9B
            if (c == 0xEF && c2 == 0xBC
                && i + 2 < line.size()
                && static_cast<unsigned char>(line[i + 2]) == 0x9B)
            {
                const auto t = trimCopy(cur);
                if (!t.empty()) parts.push_back(t);
                cur.clear();
                i += 2;
                continue;
            }
            if (c == ';')
            {
                const auto t = trimCopy(cur);
                if (!t.empty()) parts.push_back(t);
                cur.clear();
                continue;
            }
            cur.push_back(line[i]);
        }
        const auto t = trimCopy(cur);
        if (!t.empty()) parts.push_back(t);
        if (parts.empty() && !line.empty()) parts.push_back(trimCopy(line));
        return parts;
    };

    try
    {
        const json root = json::parse(http.body);
        json entry;
        entry["word"] = word;
        entry["phonetics"] = json::array();
        entry["meanings"] = json::array();
        entry["examples"] = json::array();

        const json* ecWord = nullptr;
        if (root.contains("ec") && root["ec"].contains("word")
            && root["ec"]["word"].is_array() && !root["ec"]["word"].empty())
        {
            ecWord = &root["ec"]["word"][0];
        }
        if (ecWord && ecWord->is_object())
        {
            const auto& w = *ecWord;
            if (w.contains("return-phrase"))
            {
                if (w["return-phrase"].is_string())
                    entry["word"] = w["return-phrase"].get<std::string>();
                else if (w["return-phrase"].is_object()
                    && w["return-phrase"].contains("l")
                    && w["return-phrase"]["l"].contains("i"))
                {
                    entry["word"] = w["return-phrase"]["l"]["i"].get<std::string>();
                }
            }
            const std::string usphone = w.value("usphone", "");
            const std::string ukphone = w.value("ukphone", "");
            const std::string usspeech = w.value("usspeech", "");
            const std::string ukspeech = w.value("ukspeech", "");
            if (!usphone.empty() || !usspeech.empty())
            {
                json p;
                if (!usphone.empty()) p["text"] = usphone;
                if (!usspeech.empty())
                    p["audio"] =
                        "https://dict.youdao.com/dictvoice?audio=" + usspeech;
                entry["phonetics"].push_back(p);
            }
            if (!ukphone.empty() || !ukspeech.empty())
            {
                json p;
                if (!ukphone.empty()) p["text"] = ukphone;
                if (!ukspeech.empty())
                    p["audio"] =
                        "https://dict.youdao.com/dictvoice?audio=" + ukspeech;
                entry["phonetics"].push_back(p);
            }

            std::map<std::string, json> byPos;
            if (w.contains("trs") && w["trs"].is_array())
            {
                for (const auto& block : w["trs"])
                {
                    if (!block.contains("tr") || !block["tr"].is_array()) continue;
                    for (const auto& tr : block["tr"])
                    {
                        if (!tr.contains("l") || !tr["l"].contains("i")) continue;
                        const auto& ii = tr["l"]["i"];
                        std::vector<std::string> lines;
                        if (ii.is_array())
                        {
                            for (const auto& x : ii)
                                if (x.is_string()) lines.push_back(x.get<std::string>());
                        }
                        else if (ii.is_string())
                        {
                            lines.push_back(ii.get<std::string>());
                        }
                        for (const auto& line0 : lines)
                        {
                            std::string line = trimCopy(line0);
                            if (line.empty()) continue;
                            std::string posTag = "unknown";
                            static const std::regex posRe(
                                R"regex(^\s*([a-zA-Z]+\.?)\s+)regex");
                            std::smatch m;
                            if (std::regex_search(line, m, posRe))
                                posTag = mapPos(m[1].str());
                            const auto defs = splitZhDefs(line);
                            if (!byPos.count(posTag))
                            {
                                byPos[posTag] = {
                                    {"partOfSpeech", posTag},
                                    {"definitions", json::array()},
                                    {"synonyms", json::array()},
                                };
                            }
                            for (const auto& def : defs)
                            {
                                if (byPos[posTag]["definitions"].size() >= 8) break;
                                byPos[posTag]["definitions"].push_back(
                                    {{"definition", def}});
                            }
                        }
                    }
                }
            }
            for (auto& kv : byPos)
            {
                if (!kv.second["definitions"].empty())
                    entry["meanings"].push_back(kv.second);
            }
        }

        // English definitions + inline examples
        if (root.contains("ee") && root["ee"].contains("word"))
        {
            const json& eeWord = root["ee"]["word"];
            const json* eeTrs = nullptr;
            if (eeWord.is_object() && eeWord.contains("trs"))
                eeTrs = &eeWord["trs"];
            else if (eeWord.is_array() && !eeWord.empty()
                && eeWord[0].contains("trs"))
                eeTrs = &eeWord[0]["trs"];
            if (eeTrs && eeTrs->is_array())
            {
                for (const auto& block : *eeTrs)
                {
                    const std::string pos = mapPos(block.value("pos", ""));
                    json meaning = {
                        {"partOfSpeech", pos.empty() ? "english" : pos},
                        {"definitions", json::array()},
                        {"synonyms", json::array()},
                    };
                    if (!block.contains("tr") || !block["tr"].is_array()) continue;
                    for (const auto& tr : block["tr"])
                    {
                        std::string def;
                        if (tr.contains("l") && tr["l"].contains("i"))
                        {
                            if (tr["l"]["i"].is_string())
                                def = tr["l"]["i"].get<std::string>();
                            else if (tr["l"]["i"].is_array() && !tr["l"]["i"].empty())
                                def = tr["l"]["i"][0].get<std::string>();
                        }
                        std::string exam;
                        try
                        {
                            exam = tr.at("exam").at("i").at("f").at("l")[0].at("i")
                                       .get<std::string>();
                        }
                        catch (...)
                        {
                        }
                        if (def.empty()) continue;
                        json item = {{"definition", "[英] " + def}};
                        if (!exam.empty()) item["example"] = exam;
                        meaning["definitions"].push_back(item);
                        if (meaning["definitions"].size() >= 6) break;
                    }
                    if (!meaning["definitions"].empty())
                        entry["meanings"].push_back(meaning);
                }
            }
        }

        // Bilingual example sentences
        if (root.contains("blng_sents_part")
            && root["blng_sents_part"].contains("sentence-pair")
            && root["blng_sents_part"]["sentence-pair"].is_array())
        {
            int n = 0;
            for (const auto& sp : root["blng_sents_part"]["sentence-pair"])
            {
                if (n >= 5) break;
                std::string en = sp.value("sentence", "");
                if (en.empty())
                    en = stripHtml(sp.value("sentence-eng", ""));
                else
                    en = stripHtml(en);
                const std::string zh =
                    stripHtml(sp.value("sentence-translation", ""));
                if (en.empty()) continue;
                json ex = {{"en", en}};
                if (!zh.empty()) ex["zh"] = zh;
                const std::string src = sp.value("source", "");
                if (!src.empty()) ex["source"] = src;
                entry["examples"].push_back(ex);
                ++n;
            }
        }

        // Synonyms from phrs / syno if present
        if (root.contains("syno") && root["syno"].contains("synos")
            && root["syno"]["synos"].is_array() && !entry["meanings"].empty())
        {
            json syns = json::array();
            for (const auto& s : root["syno"]["synos"])
            {
                if (!s.contains("syno") || !s["syno"].is_array()) continue;
                for (const auto& item : s["syno"])
                {
                    std::string w;
                    if (item.is_string()) w = item.get<std::string>();
                    else if (item.is_object())
                        w = item.value("word", item.value("name", ""));
                    if (w.empty()) continue;
                    syns.push_back(w);
                    if (syns.size() >= 12) break;
                }
                if (syns.size() >= 12) break;
            }
            if (!syns.empty())
                entry["meanings"][0]["synonyms"] = syns;
        }

        if (entry["meanings"].empty() && entry["examples"].empty())
        {
            out["error"] = withZhHint(
                "Youdao returned no meanings",
                "有道未返回该词义项");
            return out;
        }
        out["ok"] = true;
        out["entry"] = entry;
        out["provider"] = "youdao";
    }
    catch (const std::exception& ex)
    {
        out["error"] = withZhHint(
            std::string("Parse Youdao failed: ") + ex.what(),
            "有道词典返回无法解析");
    }
    return out;
}

json lookupBingDictionaryJson(
    const std::string& word,
    const std::string& source,
    const std::string& target)
{
    json out = json::object();
    out["ok"] = false;

    // Reuse translateBing credential fetch by duplicating the light path
    struct BingCred {
        std::string host;
        std::string ig;
        std::string key;
        std::string token;
        std::string cookies;
    };

    auto parseCreds = [](const std::string& html, BingCred& outCred) -> bool {
        std::smatch m;
        if (!std::regex_search(html, m, std::regex(R"regex(IG:"([^"]+)")regex")))
            return false;
        outCred.ig = m[1].str();
        if (!std::regex_search(
                html,
                m,
                std::regex(
                    R"regex(params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)")regex")))
        {
            return false;
        }
        outCred.key = m[1].str();
        outCred.token = m[2].str();
        return true;
    };

    BingCred cred;
    std::string lastErr;
    for (const auto& host : {std::string("https://cn.bing.com"), std::string("https://www.bing.com")})
    {
        const HttpResult page = winHttpGet(host + "/translator");
        if (!page.ok)
        {
            lastErr = page.error.empty()
                ? ("HTTP " + std::to_string(page.status))
                : page.error;
            continue;
        }
        cred.host = host;
        cred.cookies = page.cookies;
        if (parseCreds(page.body, cred)) break;
        lastErr = "Cannot parse Bing tokens";
        cred = {};
    }
    if (cred.host.empty())
    {
        out["error"] = withZhHint(
            lastErr.empty() ? "Bing dictionary auth failed" : lastErr,
            "无法打开必应翻译页获取词典凭证，请检查网络后重试");
        return out;
    }

    const std::string from = mapLangForBing(source.empty() ? "en" : source);
    const std::string to = mapLangForBing(target.empty() ? "zh-CN" : target);
    const std::string form =
        "text=" + urlEncode(word)
        + "&from=" + urlEncode(from.empty() ? "en" : from)
        + "&to=" + urlEncode(to.empty() ? "zh-Hans" : to)
        + "&token=" + urlEncode(cred.token)
        + "&key=" + urlEncode(cred.key);
    const std::string url =
        cred.host + "/tlookupv3?isVertical=1&IG=" + urlEncode(cred.ig)
        + "&IID=translator.5026";
    std::wstring headers =
        L"Content-Type: application/x-www-form-urlencoded\r\n"
        L"Origin: " + toWide(cred.host) + L"\r\n"
        L"Referer: " + toWide(cred.host + "/translator") + L"\r\n";
    if (!cred.cookies.empty())
        headers += L"Cookie: " + toWide(cred.cookies) + L"\r\n";

    const HttpResult http = winHttpPost(url, form, headers);
    if (!http.ok)
    {
        out["error"] = withZhHint(
            http.error.empty()
                ? ("HTTP " + std::to_string(http.status) + " from Bing dictionary")
                : http.error,
            "必应词典请求失败，请稍后重试");
        return out;
    }

    try
    {
        const json root = json::parse(http.body);
        if (!root.is_array() || root.empty())
        {
            out["error"] = withZhHint(
                "Empty Bing dictionary response",
                "未找到该词的词典义项");
            return out;
        }
        const json& row = root[0];
        json entry;
        entry["word"] = row.value("displaySource", row.value("normalizedSource", word));
        entry["phonetics"] = json::array();
        entry["meanings"] = json::array();

        auto mapPos = [](std::string tag) {
            for (char& c : tag) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            if (tag == "adj") return std::string("adjective");
            if (tag == "adv") return std::string("adverb");
            if (tag == "noun" || tag == "verb" || tag == "pronoun"
                || tag == "preposition" || tag == "conjunction"
                || tag == "interjection" || tag == "article")
                return tag;
            return tag.empty() ? std::string("unknown") : tag;
        };

        std::map<std::string, json> byPos;
        if (row.contains("translations") && row["translations"].is_array())
        {
            for (const auto& tr : row["translations"])
            {
                const std::string pos = mapPos(tr.value("posTag", ""));
                if (!byPos.count(pos))
                {
                    byPos[pos] = {
                        {"partOfSpeech", pos},
                        {"definitions", json::array()},
                        {"synonyms", json::array()},
                    };
                }
                const std::string def = tr.value(
                    "displayTarget",
                    tr.value("normalizedTarget", ""));
                if (!def.empty())
                {
                    byPos[pos]["definitions"].push_back({{"definition", def}});
                }
                if (tr.contains("backTranslations") && tr["backTranslations"].is_array())
                {
                    for (const auto& bt : tr["backTranslations"])
                    {
                        const std::string syn = bt.value(
                            "displayText",
                            bt.value("normalizedText", ""));
                        if (syn.empty()) continue;
                        auto& arr = byPos[pos]["synonyms"];
                        bool exists = false;
                        for (const auto& x : arr)
                        {
                            if (x.get<std::string>() == syn)
                            {
                                exists = true;
                                break;
                            }
                        }
                        if (!exists && arr.size() < 12) arr.push_back(syn);
                    }
                }
            }
        }
        for (auto& kv : byPos)
        {
            if (!kv.second["definitions"].empty())
                entry["meanings"].push_back(kv.second);
        }
        if (entry["meanings"].empty())
        {
            out["error"] = withZhHint(
                "No meanings in Bing dictionary",
                "未找到该词的词典义项");
            return out;
        }
        out["ok"] = true;
        out["entry"] = entry;
        out["provider"] = "bing";
    }
    catch (const std::exception& ex)
    {
        out["error"] = withZhHint(
            std::string("Parse Bing dictionary failed: ") + ex.what(),
            "词典返回无法解析，请稍后重试");
    }
    return out;
}

TranslateResult translateYoudao(
    const std::string& text,
    const std::string& source,
    const std::string& target,
    const std::string& appKey,
    const std::string& appSecret)
{
    TranslateResult result;
    result.provider = "youdao";
    if (appKey.empty() || appSecret.empty())
    {
        result.error = withZhHint(
            "Youdao requires appId and secret",
            "有道翻译需要填写 App Key 与 App Secret（在设置→翻译引擎中配置）");
        result.code = "CONFIG_ERROR";
        return result;
    }
    const std::string salt = randomSalt();
    const std::string sign = md5Hex(appKey + text + salt + appSecret);
    if (sign.empty())
    {
        result.error = withZhHint("MD5 failed", "无法计算有道签名");
        result.code = "CONFIG_ERROR";
        return result;
    }
    const std::string body =
        "q=" + urlEncode(text)
        + "&from=" + urlEncode(mapYoudaoLang(source))
        + "&to=" + urlEncode(mapYoudaoLang(target))
        + "&appKey=" + urlEncode(appKey)
        + "&salt=" + urlEncode(salt)
        + "&sign=" + urlEncode(sign);
    result.externalCall = true;
    const HttpResult http = winHttpPost(
        "https://openapi.youdao.com/api",
        body,
        L"Content-Type: application/x-www-form-urlencoded\r\n");
    if (!http.ok)
    {
        result.error = http.error.empty()
            ? withZhHint("Youdao HTTP failed", "有道翻译请求失败")
            : http.error;
        result.code = "ERROR";
        return result;
    }
    try
    {
        const json j = json::parse(http.body);
        const std::string err = j.value("errorCode", "");
        if (err != "0")
        {
            result.error = withZhHint(
                "Youdao errorCode=" + err,
                "有道翻译失败（错误码 " + err + "），请检查 App Key / Secret");
            result.code = "ERROR";
            return result;
        }
        if (!j.contains("translation") || !j["translation"].is_array() || j["translation"].empty())
        {
            result.error = withZhHint("Youdao empty translation", "有道翻译结果为空");
            result.code = "ERROR";
            return result;
        }
        result.translation = j["translation"][0].get<std::string>();
        result.ok = !result.translation.empty();
        if (!result.ok)
        {
            result.error = withZhHint("Youdao empty translation", "有道翻译结果为空");
            result.code = "ERROR";
        }
    }
    catch (const std::exception& ex)
    {
        result.error = withZhHint(
            std::string("Parse Youdao failed: ") + ex.what(),
            "有道翻译返回无法解析");
        result.code = "ERROR";
    }
    return result;
}

TranslateResult translateBaidu(
    const std::string& text,
    const std::string& source,
    const std::string& target,
    const std::string& appId,
    const std::string& secret)
{
    TranslateResult result;
    result.provider = "baidu";
    if (appId.empty() || secret.empty())
    {
        result.error = withZhHint(
            "Baidu requires appId and secret",
            "百度翻译需要填写 App ID 与密钥（在设置→翻译引擎中配置）");
        result.code = "CONFIG_ERROR";
        return result;
    }
    const std::string salt = randomSalt();
    const std::string sign = md5Hex(appId + text + salt + secret);
    if (sign.empty())
    {
        result.error = withZhHint("MD5 failed", "无法计算百度签名");
        result.code = "CONFIG_ERROR";
        return result;
    }
    const std::string url =
        "https://fanyi-api.baidu.com/api/trans/vip/translate"
        "?q=" + urlEncode(text)
        + "&from=" + urlEncode(mapBaiduLang(source))
        + "&to=" + urlEncode(mapBaiduLang(target))
        + "&appid=" + urlEncode(appId)
        + "&salt=" + urlEncode(salt)
        + "&sign=" + urlEncode(sign);
    result.externalCall = true;
    const HttpResult http = winHttpGet(url);
    if (!http.ok)
    {
        result.error = http.error.empty()
            ? withZhHint("Baidu HTTP failed", "百度翻译请求失败")
            : http.error;
        result.code = "ERROR";
        return result;
    }
    try
    {
        const json j = json::parse(http.body);
        if (j.contains("error_code"))
        {
            const std::string code = j["error_code"].is_string()
                ? j["error_code"].get<std::string>()
                : std::to_string(j["error_code"].get<int>());
            result.error = withZhHint(
                "Baidu error_code=" + code,
                "百度翻译失败（错误码 " + code + "），请检查 App ID / 密钥");
            result.code = "ERROR";
            return result;
        }
        if (!j.contains("trans_result") || !j["trans_result"].is_array()
            || j["trans_result"].empty())
        {
            result.error = withZhHint("Baidu empty result", "百度翻译结果为空");
            result.code = "ERROR";
            return result;
        }
        std::string joined;
        for (const auto& row : j["trans_result"])
        {
            if (!joined.empty()) joined += "\n";
            joined += row.value("dst", "");
        }
        result.translation = joined;
        result.ok = !result.translation.empty();
        if (!result.ok)
        {
            result.error = withZhHint("Baidu empty result", "百度翻译结果为空");
            result.code = "ERROR";
        }
    }
    catch (const std::exception& ex)
    {
        result.error = withZhHint(
            std::string("Parse Baidu failed: ") + ex.what(),
            "百度翻译返回无法解析");
        result.code = "ERROR";
    }
    return result;
}

TranslateResult translateSogou(
    const std::string& text,
    const std::string& source,
    const std::string& target,
    const std::string& pid,
    const std::string& key)
{
    TranslateResult result;
    result.provider = "sogou";
    if (pid.empty() || key.empty())
    {
        result.error = withZhHint(
            "Sogou requires pid and key",
            "搜狗翻译需要填写 PID 与 Key（在设置→翻译引擎中配置）");
        result.code = "CONFIG_ERROR";
        return result;
    }
    const std::string salt = randomSalt();
    const std::string sign = md5Hex(pid + text + salt + key);
    if (sign.empty())
    {
        result.error = withZhHint("MD5 failed", "无法计算搜狗签名");
        result.code = "CONFIG_ERROR";
        return result;
    }
    // Sogou open platform text translate (pid/key signature)
    const std::string body =
        "from=" + urlEncode(mapBaiduLang(source))
        + "&to=" + urlEncode(mapBaiduLang(target))
        + "&pid=" + urlEncode(pid)
        + "&q=" + urlEncode(text)
        + "&salt=" + urlEncode(salt)
        + "&sign=" + urlEncode(sign);
    result.externalCall = true;
    const HttpResult http = winHttpPost(
        "https://fanyi.sogou.com/reventondc/api/sogouTranslate",
        body,
        L"Content-Type: application/x-www-form-urlencoded\r\n");
    if (!http.ok)
    {
        result.error = http.error.empty()
            ? withZhHint("Sogou HTTP failed", "搜狗翻译请求失败")
            : http.error;
        result.code = "ERROR";
        return result;
    }
    try
    {
        const json j = json::parse(http.body);
        if (j.contains("errorCode") && j["errorCode"].get<std::string>() != "0")
        {
            const std::string code = j["errorCode"].get<std::string>();
            result.error = withZhHint(
                "Sogou errorCode=" + code,
                "搜狗翻译失败（错误码 " + code + "），请检查 PID / Key");
            result.code = "ERROR";
            return result;
        }
        result.translation = j.value("translation", "");
        if (result.translation.empty() && j.contains("trans_result"))
        {
            if (j["trans_result"].is_object())
                result.translation = j["trans_result"].value("translation", "");
        }
        result.ok = !result.translation.empty();
        if (!result.ok)
        {
            result.error = withZhHint("Sogou empty result", "搜狗翻译结果为空或接口不可用");
            result.code = "ERROR";
        }
    }
    catch (const std::exception& ex)
    {
        result.error = withZhHint(
            std::string("Parse Sogou failed: ") + ex.what(),
            "搜狗翻译返回无法解析");
        result.code = "ERROR";
    }
    return result;
}

TranslateResult translateNiutrans(
    const std::string& text,
    const std::string& source,
    const std::string& target,
    const std::string& apiKey)
{
    TranslateResult result;
    result.provider = "niutrans";
    if (apiKey.empty())
    {
        result.error = withZhHint(
            "Niutrans requires apikey",
            "小牛翻译需要填写 API Key（在设置→翻译引擎中配置）");
        result.code = "CONFIG_ERROR";
        return result;
    }
    const std::string url =
        "https://api.niutrans.com/NiuTransServer/translation"
        "?from=" + urlEncode(mapNiuLang(source))
        + "&to=" + urlEncode(mapNiuLang(target))
        + "&src_text=" + urlEncode(text)
        + "&apikey=" + urlEncode(apiKey);
    result.externalCall = true;
    const HttpResult http = winHttpGet(url);
    if (!http.ok)
    {
        result.error = http.error.empty()
            ? withZhHint("Niutrans HTTP failed", "小牛翻译请求失败")
            : http.error;
        result.code = "ERROR";
        return result;
    }
    try
    {
        const json j = json::parse(http.body);
        if (j.contains("error_code") || j.contains("errorCode"))
        {
            const std::string code = j.contains("error_code")
                ? (j["error_code"].is_string()
                      ? j["error_code"].get<std::string>()
                      : std::to_string(j["error_code"].get<int>()))
                : (j["errorCode"].is_string()
                      ? j["errorCode"].get<std::string>()
                      : std::to_string(j["errorCode"].get<int>()));
            result.error = withZhHint(
                "Niutrans error=" + code,
                "小牛翻译失败（错误码 " + code + "），请检查 API Key");
            result.code = "ERROR";
            return result;
        }
        result.translation = j.value("tgt_text", j.value("translation", ""));
        result.ok = !result.translation.empty();
        if (!result.ok)
        {
            result.error = withZhHint("Niutrans empty result", "小牛翻译结果为空");
            result.code = "ERROR";
        }
    }
    catch (const std::exception& ex)
    {
        result.error = withZhHint(
            std::string("Parse Niutrans failed: ") + ex.what(),
            "小牛翻译返回无法解析");
        result.code = "ERROR";
    }
    return result;
}

#endif

} // namespace

std::string TranslateClient::lookupDictionaryJson(
    const std::string& word,
    const std::string& source,
    const std::string& target,
    const std::string& proxyMode,
    const std::string& httpProxy)
{
#ifdef _WIN32
    ProxyScope scope(proxyMode, httpProxy);
    std::string q = word;
    while (!q.empty() && std::isspace(static_cast<unsigned char>(q.front())))
        q.erase(q.begin());
    while (!q.empty() && std::isspace(static_cast<unsigned char>(q.back())))
        q.pop_back();
    if (q.empty())
    {
        json err = {{"ok", false}, {"error", "请输入要查询的单词"}};
        return err.dump();
    }
    // Prefer Youdao (phonetics / bilingual examples / EN defs). Bing gloss is fallback.
    json youdao = lookupYoudaoDictionaryJson(q);
    if (youdao.value("ok", false)) return youdao.dump();
    json bing = lookupBingDictionaryJson(q, source, target);
    if (bing.value("ok", false)) return bing.dump();
    json err = {
        {"ok", false},
        {"error",
         youdao.value(
             "error",
             bing.value(
                 "error",
                 std::string("词典查询失败，请检查网络后重试")))},
    };
    return err.dump();
#else
    (void)source;
    (void)target;
    (void)proxyMode;
    (void)httpProxy;
    json err = {
        {"ok", false},
        {"error", "当前环境不支持词典查询"},
    };
    return err.dump();
#endif
}

TranslateResult TranslateClient::translateFree(
    const std::string& text,
    const std::string& source,
    const std::string& target,
    const std::string& provider,
    int maxLength,
    bool autoChunk,
    const std::string& proxyMode,
    const std::string& httpProxy,
    const std::string& engineKeysJson)
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
    const json engineKeys = parseEngineKeys(engineKeysJson);

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

    // Protect C++/C#/F# tokens: Google (and some others) drop "+" / "#" in output.
    auto runLimited = [&](auto&& fn) -> TranslateResult {
        auto wrapped = [&](const std::string& chunk) {
            return restoreCodeTokensResult(fn(protectCodeTokens(chunk)));
        };
        if (limit > 0 && autoChunk && cps > limit)
            return markNetworkIfNeeded(joinChunkTranslations(splitChunks(text, chunkSize), wrapped));
        return markNetworkIfNeeded(wrapped(text));
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
        TranslateResult google = runLimited([&](const std::string& chunk) {
            return translateGoogleChunk(chunk, src, dst);
        });
        if (google.ok) return google;

        // Free Google endpoint often hits CAPTCHA; fall back to Bing automatically.
        const bool captcha = google.code == "GOOGLE_CAPTCHA"
            || isGoogleCaptchaOrBlockPage(google.error);
        if (captcha || looksLikeHtml(google.error))
        {
            TranslateResult bing = runLimited([&](const std::string& chunk) {
                return translateBing(chunk, source, target);
            });
            if (bing.ok)
            {
                bing.provider = "bing";
                return bing;
            }
            google.error = withZhHint(
                "Google CAPTCHA and Bing fallback failed. Google: "
                    + (google.error.empty() ? "captcha" : google.error)
                    + " | Bing: "
                    + (bing.error.empty() ? "failed" : bing.error),
                "谷歌翻译已触发人机验证，且 Bing 备用也失败。请稍后再试、换网络/代理，或改用有道/大模型");
            google.code = "GOOGLE_CAPTCHA";
        }
        return google;
    }
    if (p == "bing")
    {
        return runLimited([&](const std::string& chunk) {
            return translateBing(chunk, source, target);
        });
    }
    if (p == "youdao")
    {
        const std::string appId = engineField(engineKeys, "youdao", "appId");
        const std::string secret = engineField(engineKeys, "youdao", "secret");
        return markNetworkIfNeeded(runLimited([&](const std::string& chunk) {
            return translateYoudao(chunk, source, target, appId, secret);
        }));
    }
    if (p == "baidu")
    {
        const std::string appId = engineField(engineKeys, "baidu", "appId");
        const std::string secret = engineField(engineKeys, "baidu", "secret");
        return markNetworkIfNeeded(runLimited([&](const std::string& chunk) {
            return translateBaidu(chunk, source, target, appId, secret);
        }));
    }
    if (p == "sogou")
    {
        const std::string appId = engineField(engineKeys, "sogou", "appId");
        const std::string secret = engineField(engineKeys, "sogou", "secret");
        return markNetworkIfNeeded(runLimited([&](const std::string& chunk) {
            return translateSogou(chunk, source, target, appId, secret);
        }));
    }
    if (p == "niutrans")
    {
        const std::string apiKey = engineField(engineKeys, "niutrans", "apiKey");
        return markNetworkIfNeeded(runLimited([&](const std::string& chunk) {
            return translateNiutrans(chunk, source, target, apiKey);
        }));
    }

    result.error = withZhHint(
        "Unknown translate provider: " + p,
        "未知的翻译引擎，请重新选择");
    result.code = "ERROR";
#else
    (void)engineKeysJson;
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
        result.code = "CONFIG_ERROR";
        return result;
    }
    if (apiUrl.empty())
    {
        result.error = withZhHint("apiUrl required", "请先填写 API URL");
        result.code = "CONFIG_ERROR";
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
    result.externalCall = llm.externalCall;
    if (!llm.ok)
    {
        const std::string en =
            llm.error.empty() ? "LLM request failed" : llm.error;
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
        else if (!llm.externalCall)
            result.error = en;
        else
            result.error = withZhHint(en, "大模型接口调用失败，请检查 API URL、密钥与模型");
        result.code = llm.externalCall ? "ERROR" : "CONFIG_ERROR";
        return result;
    }

    result.translation = llm.content;
    result.promptTokens = llm.promptTokens;
    result.completionTokens = llm.completionTokens;
    result.totalTokens = llm.totalTokens;
    result.cacheReadTokens = llm.cacheReadTokens;
    result.cacheWriteTokens = llm.cacheWriteTokens;
    result.ok = true;
    return result;
}
