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
    if (isMyMemoryLimitError(raw))
    {
        if (toLower(raw).find("used all available") != std::string::npos
            || toLower(raw).find("mymemory warning") != std::string::npos)
        {
            return "MyMemory 今日免费额度已用尽，请更换翻译引擎（谷歌/Bing/大模型）";
        }
        return "MyMemory 单次文本过长，请开启自动分段或更换引擎";
    }
    return raw;
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
        result.error = "Invalid URL";
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
        connect, toWide(method).c_str(), path.c_str(), nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (!request)
    {
        WinHttpCloseHandle(connect);
        WinHttpCloseHandle(session);
        result.error = "WinHttpOpenRequest failed";
        return result;
    }

    std::wstring headers = L"User-Agent: Mozilla/5.0\r\n";
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
        result.error = "HTTP " + std::to_string(status) + ": " + result.body.substr(0, 300);
    return result;
}

bool looksLikeNetworkError(const std::string& err)
{
    const std::string e = toLower(err);
    return e.find("http request failed") != std::string::npos
        || e.find("winhttp") != std::string::npos
        || e.find("connect failed") != std::string::npos
        || e.find("timed out") != std::string::npos
        || e.find("timeout") != std::string::npos;
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
    if (!r.ok && r.code.empty() && looksLikeNetworkError(r.error))
    {
        r.code = "NETWORK_TIMEOUT";
        if (r.error.find("网络") == std::string::npos)
            r.error = "翻译超时或网络异常，请检查网络状况后重试。(" + r.error + ")";
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
            result.error = "Empty translation from MyMemory";
            return result;
        }
        result.ok = true;
    }
    catch (const std::exception& ex)
    {
        result.error = std::string("Parse MyMemory failed: ") + ex.what();
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
        result.error = http.error.empty() ? "Google translate failed" : http.error;
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
            result.error = "Empty translation from Google";
            return result;
        }
        result.ok = true;
    }
    catch (const std::exception& ex)
    {
        result.error = std::string("Parse Google failed: ") + ex.what();
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
        result.error = auth.error.empty() ? "Bing auth token failed" : auth.error;
        return result;
    }
    const std::string token = auth.body;
    const std::string from = mapLangForBing(source.empty() ? "en" : source);
    const std::string to = mapLangForBing(target.empty() ? "zh-CN" : target);
    std::string url =
        "https://api.edge.microsofttranslator.com/translate?api-version=3.0&to="
        + urlEncode(to);
    if (!from.empty()) url += "&from=" + urlEncode(from);

    json body = json::array();
    body.push_back({{"Text", text}});
    const std::wstring headers =
        L"Content-Type: application/json\r\nAuthorization: Bearer "
        + toWide(token) + L"\r\n";
    const HttpResult http = winHttpPost(url, body.dump(), headers);
    if (!http.ok)
    {
        result.error = http.error.empty() ? "Bing translate failed" : http.error;
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
            result.error = "Empty translation from Bing";
            return result;
        }
        result.ok = true;
    }
    catch (const std::exception& ex)
    {
        result.error = std::string("Parse Bing failed: ") + ex.what();
    }
    return result;
}

TranslateResult translateYoudao(const std::string& text, const std::string& source, const std::string& target)
{
    TranslateResult result;
    result.provider = "youdao";
    std::string type = "AUTO";
    const std::string src = toLower(source);
    const std::string dst = toLower(target);
    if ((src == "en") && (dst == "zh-cn" || dst == "zh")) type = "EN2ZH_CN";
    else if ((src == "zh-cn" || src == "zh") && dst == "en") type = "ZH_CN2EN";

    const std::string url =
        "https://fanyi.youdao.com/translate?&doctype=json&type=" + urlEncode(type)
        + "&i=" + urlEncode(text);
    const HttpResult http = winHttpGet(url);
    if (!http.ok)
    {
        result.error = http.error.empty() ? "Youdao translate failed" : http.error;
        return result;
    }
    try
    {
        const json root = json::parse(http.body);
        std::ostringstream out;
        if (root.contains("translateResult") && root["translateResult"].is_array())
        {
            for (const auto& line : root["translateResult"])
            {
                if (!line.is_array()) continue;
                for (const auto& item : line)
                {
                    if (item.contains("tgt")) out << item.value("tgt", "");
                }
            }
        }
        result.translation = out.str();
        if (result.translation.empty())
        {
            result.error = "Empty translation from Youdao";
            return result;
        }
        result.ok = true;
    }
    catch (const std::exception& ex)
    {
        result.error = std::string("Parse Youdao failed: ") + ex.what();
    }
    return result;
}

TranslateResult translateBaidu(const std::string& text, const std::string& source, const std::string& target)
{
    TranslateResult result;
    result.provider = "baidu";
    const std::string from = mapLangSimple(source.empty() ? "en" : source);
    std::string to = mapLangSimple(target.empty() ? "zh-CN" : target);
    if (to == "cht") to = "zh"; // simplified fallback
    const std::string url =
        "https://fanyi.baidu.com/transapi?source=txt&from=" + urlEncode(from)
        + "&to=" + urlEncode(to) + "&query=" + urlEncode(text);
    const HttpResult http = winHttpGet(url);
    if (!http.ok)
    {
        result.error = http.error.empty() ? "Baidu translate failed" : http.error;
        return result;
    }
    try
    {
        const json root = json::parse(http.body);
        if (root.contains("data") && root["data"].is_array())
        {
            std::ostringstream out;
            for (const auto& item : root["data"])
                out << item.value("dst", "");
            result.translation = out.str();
        }
        if (result.translation.empty())
            result.translation = root.value("result", "");
        if (result.translation.empty())
        {
            result.error = "Empty translation from Baidu (接口可能需网页签名，请换 Google/Bing)";
            return result;
        }
        result.ok = true;
    }
    catch (const std::exception& ex)
    {
        result.error = std::string("Parse Baidu failed: ") + ex.what();
    }
    return result;
}

TranslateResult translateSogou(const std::string& text, const std::string& source, const std::string& target)
{
    TranslateResult result;
    result.provider = "sogou";
    const std::string from = mapLangSimple(source.empty() ? "en" : source) == "auto"
        ? "auto"
        : mapLangSimple(source.empty() ? "en" : source);
    std::string to = mapLangSimple(target.empty() ? "zh-CN" : target);
    if (to == "cht") to = "zh-CHS";
    if (to == "zh") to = "zh-CHS";

    // Public free endpoint (may change); form-encoded body
    const std::string body =
        "from=" + urlEncode(from) + "&to=" + urlEncode(to) + "&text=" + urlEncode(text);
    const HttpResult http = winHttpPost(
        "https://fanyi.sogou.com/textTranslation",
        body,
        L"Content-Type: application/x-www-form-urlencoded\r\n");
    if (!http.ok)
    {
        // Fallback: older path
        const std::string url =
            "https://fanyi.sogou.com/reventondc/translateV2";
        const HttpResult http2 = winHttpPost(
            url,
            body + "&client=pc&fr=browser_pc&needQc=1",
            L"Content-Type: application/x-www-form-urlencoded\r\n");
        if (!http2.ok)
        {
            result.error = http.error.empty() ? "Sogou translate failed" : http.error;
            return result;
        }
        try
        {
            const json root = json::parse(http2.body);
            if (root.contains("data"))
            {
                if (root["data"].contains("translate") && root["data"]["translate"].contains("dit"))
                    result.translation = root["data"]["translate"].value("dit", "");
                else
                    result.translation = root["data"].value("translation", "");
            }
        }
        catch (const std::exception& ex)
        {
            result.error = std::string("Parse Sogou failed: ") + ex.what();
            return result;
        }
    }
    else
    {
        try
        {
            const json root = json::parse(http.body);
            result.translation = root.value("translate", root.value("translation", ""));
            if (result.translation.empty() && root.contains("data"))
                result.translation = root["data"].value("translation", "");
        }
        catch (const std::exception& ex)
        {
            result.error = std::string("Parse Sogou failed: ") + ex.what();
            return result;
        }
    }

    if (result.translation.empty())
    {
        result.error = "Empty translation from Sogou (接口可能变更，请换 Google/Bing)";
        return result;
    }
    result.ok = true;
    return result;
}

TranslateResult translateNiutrans(const std::string& text, const std::string& source, const std::string& target)
{
    TranslateResult result;
    result.provider = "niutrans";
    const std::string from = mapLangSimple(source.empty() ? "en" : source);
    std::string to = mapLangSimple(target.empty() ? "zh-CN" : target);
    if (to == "cht") to = "zh";
    const std::string url =
        "https://free.niutrans.com/NiuTransServer/translation?from="
        + urlEncode(from == "auto" ? "en" : from)
        + "&to=" + urlEncode(to)
        + "&src_text=" + urlEncode(text);
    const HttpResult http = winHttpGet(url);
    if (!http.ok)
    {
        result.error = http.error.empty() ? "Niutrans translate failed" : http.error;
        return result;
    }
    try
    {
        const json root = json::parse(http.body);
        result.translation = root.value("tgt_text", root.value("translation", ""));
        if (result.translation.empty())
        {
            result.error = "Empty translation from Niutrans";
            return result;
        }
        result.ok = true;
    }
    catch (const std::exception& ex)
    {
        result.error = std::string("Parse Niutrans failed: ") + ex.what();
    }
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
    bool autoChunk)
{
    TranslateResult result;
    const std::string p = normalizeProvider(provider);
    result.provider = p;

    if (text.empty())
    {
        result.error = "text required";
        result.code = "ERROR";
        return result;
    }

#ifdef _WIN32
    size_t limit = engineDefaultMax(p);
    if (maxLength > 0)
        limit = static_cast<size_t>(maxLength);

    const size_t cps = utf8CodepointCount(text);
    if (limit > 0 && cps > limit)
    {
        if (!autoChunk)
        {
            result.code = "LENGTH_LIMIT";
            result.error =
                "文本超过翻译最大长度限制（当前 " + std::to_string(cps)
                + " 字，限制 " + std::to_string(limit)
                + " 字）。请在设置中增大「最大长度」或开启「自动拼接」。";
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

    result.error = "Unknown translate provider: " + p;
    result.code = "ERROR";
#else
    result.error = "Free translate only implemented on Windows";
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
    const std::string& target)
{
    TranslateResult result;
    result.provider = "llm";

    if (text.empty())
    {
        result.error = "text required";
        return result;
    }

    const std::string src = source.empty() ? "en" : source;
    const std::string dst = target.empty() ? "zh-CN" : target;

    json messages = json::array();
    messages.push_back({
        {"role", "system"},
        {"content",
            "You are a precise bilingual translator. Translate the user text from "
            + src + " to " + dst
            + ". Output only the translation text with no quotes, notes, or explanations."},
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
        result.error = llm.error;
        return result;
    }

    result.translation = llm.content;
    result.ok = true;
    return result;
}
