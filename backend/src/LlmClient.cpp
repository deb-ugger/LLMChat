#include "LlmClient.h"
#include "CancellableWinHttp.h"
#include "RequestCancellation.h"

#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#pragma comment(lib, "winhttp.lib")
#endif

#include <cctype>
#include <algorithm>
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

LlmResponse winHttpPost(const std::string& url, const std::string& bearer, const std::string& body,
                        const std::string& proxyMode, std::string proxy, bool requireComplete, json* nativeJson = nullptr, bool readOnly = false)
{
    LlmResponse result;
    if (request_cancel::stopped()) { result.error = "翻译已取消"; return result; }

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
        WINHTTP_FLAG_ASYNC);
    if (!session)
    {
        result.error = "WinHttpOpen failed";
        return result;
    }

    if (readOnly) WinHttpSetTimeouts(session, 1000, 1000, 2000, 2000);
    else WinHttpSetTimeouts(session, 5000, 10000, 30000, 300000);
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
        readOnly ? L"GET" : L"POST",
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

    CancellableWinHttp operation(request);
    if (proxyMode == "direct" || proxyMode == "custom") {
        if (proxy.rfind("http://", 0) == 0) proxy.erase(0, 7);
        else if (proxy.rfind("https://", 0) == 0) proxy.erase(0, 8);
        const auto wideProxy = toWide(proxy);
        WINHTTP_PROXY_INFO info{};
        info.dwAccessType = proxyMode == "direct" ? WINHTTP_ACCESS_TYPE_NO_PROXY : WINHTTP_ACCESS_TYPE_NAMED_PROXY;
        info.lpszProxy = proxyMode == "direct" ? nullptr : const_cast<wchar_t*>(wideProxy.c_str());
        if ((proxyMode == "custom" && proxy.empty()) || !WinHttpSetOption(request, WINHTTP_OPTION_PROXY, &info, sizeof(info))) {
            result.error = "网络代理配置无效";
            operation.close(); WinHttpCloseHandle(connect); WinHttpCloseHandle(session);
            return result;
        }
    }
    std::wstring headers = L"Content-Type: application/json\r\n";
    if (!bearer.empty())
    {
        headers += L"Authorization: Bearer " + toWide(bearer) + L"\r\n";
    }

    result.externalCall = true;
    const bool sent = operation.send(headers.c_str(), body.empty() ? nullptr : (LPVOID)body.data(), static_cast<DWORD>(body.size()));

    if (!sent || !operation.receive())
    {
        const auto error = GetLastError();
        const bool loopback = host == L"127.0.0.1" || host == L"localhost" || host == L"::1" || host == L"[::1]";
        if (error == ERROR_WINHTTP_CANNOT_CONNECT && loopback)
        {
            const auto address = host == L"::1" ? "[::1]" : toUtf8(host);
            result.error = "无法连接本地模型服务 " + std::string(address) + ":" + std::to_string(port) +
                "。请启动所选模型的服务（Ollama 可在「设置 → 通用 → 本地大模型」开启），再继续。";
            result.errorCode = "LLM_LOCAL_CONNECTION_FAILED";
        }
        else
        {
            result.error = std::string(sent ? "HTTP receive failed" : "HTTP send failed") +
                " (WinHTTP " + std::to_string(error) + ")";
        }
        operation.close();
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
        if (!operation.available(available))
        {
            break;
        }
        if (available == 0)
        {
            break;
        }
        std::vector<char> buffer(available);
        DWORD read = 0;
        if (!operation.read(buffer.data(), available, read))
        {
            break;
        }
        responseBody.append(buffer.data(), read);
    }

    operation.close();
    WinHttpCloseHandle(connect);
    WinHttpCloseHandle(session);

    if (status < 200 || status >= 300)
    {
        if (responseBody.find("token repeat limit reached") != std::string::npos) {
            result.errorCode = "LLM_MODEL_REPETITION";
            result.error = "模型重复生成，服务已中止本次输出；需简化输入或拆分条目后重试";
        } else result.error = "LLM HTTP " + std::to_string(status) + ": " + responseBody.substr(0, 500);
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

    if (nativeJson) {
        *nativeJson = json::parse(responseBody, nullptr, false);
        result.ok = nativeJson->is_object() && !nativeJson->contains("error");
        if (!result.ok) result.error = nativeJson->is_object() ? nativeJson->value("error", "Ollama 返回无效响应") : "Ollama 返回无效 JSON";
        return result;
    }
    auto parsed = LlmClient::parseChatResponse(responseBody, requireComplete);
    parsed.statusCode = result.statusCode;
    parsed.externalCall = result.externalCall;
    return parsed;
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

LlmResponse LlmClient::parseChatResponse(const std::string& responseBody, bool requireComplete)
{
    LlmResponse result;
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
        const auto& choice = root["choices"][0];
        const auto reason = choice.find("finish_reason");
        const std::string finishReason = reason != choice.end() && reason->is_string()
            ? reason->get<std::string>() : "";
        if (requireComplete && (finishReason == "length" || finishReason == "max_tokens")) {
            result.errorCode = "LLM_OUTPUT_TRUNCATED";
            result.error = "模型输出达到长度上限，译文不完整。请减少本批文本或提高服务端输出上限后重试";
            return result;
        }
        if (finishReason == "content_filter") {
            result.errorCode = "LLM_CONTENT_FILTERED";
            result.error = "模型服务拦截了本次内容，未返回完整译文";
            return result;
        }
        if (finishReason == "tool_calls" || finishReason == "function_call") {
            result.errorCode = "LLM_NO_FINAL_ANSWER";
            result.error = "模型返回了工具调用，未返回最终译文。请使用文本翻译模式";
            return result;
        }
        // Some local servers put a leading thinking block in the content field.
        // Keep only the completed final answer, never reasoning_content.
        auto first = content.find_first_not_of(" \t\r\n");
        while (first != std::string::npos && content.compare(first, 7, "<think>") == 0) {
            const auto close = content.find("</think>", first + 7);
            if (close == std::string::npos) {
                result.errorCode = "LLM_NO_FINAL_ANSWER";
                result.error = "模型只返回了未完成的思考内容，未生成最终译文";
                return result;
            }
            content.erase(0, close + 8);
            first = content.find_first_not_of(" \t\r\n");
        }
        if (first == std::string::npos) {
            result.errorCode = "LLM_NO_FINAL_ANSWER";
            result.error = "模型未返回最终译文。请检查模型输出上限与思考模式设置";
            return result;
        }
        result.content = content;
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

LlmResponse LlmClient::parseOllamaTestResponse(const std::string& responseBody)
{
    LlmResponse result;
    try {
        const auto root = json::parse(responseBody);
        if (root.contains("error")) { result.error = root.at("error").get<std::string>(); return result; }
        result.content = root.value("message", json::object()).value("content", "");
        result.promptTokens = root.value("prompt_eval_count", 0);
        result.completionTokens = root.value("eval_count", 0);
        result.totalTokens = result.promptTokens + result.completionTokens;
        result.ok = root.value("done", false) && result.content.find_first_not_of(" \r\n\t") != std::string::npos;
        if (!result.ok) result.error = "模型未生成可见输出，请检查模型是否支持当前测试输入";
    } catch (const std::exception& error) { result.error = std::string("Ollama 测试响应无效：") + error.what(); }
    return result;
}

LlmResponse LlmClient::testOllama(const std::string& apiUrl, const std::string& model)
{
#ifdef _WIN32
    auto base = apiUrl;
    while (!base.empty() && base.back() == '/') base.pop_back();
    for (const auto* suffix : {"/v1/chat/completions", "/api/chat", "/v1"}) {
        if (base.ends_with(suffix)) { base.resize(base.size() - std::char_traits<char>::length(suffix)); break; }
    }
    json metadata;
    auto response = winHttpPost(base + "/api/show", "", json{{"model",model}}.dump(), "direct", "", false, &metadata);
    if (!response.ok) return response;
    const auto capabilities = metadata.value("capabilities", json::array());
    const bool vision = std::find(capabilities.begin(), capabilities.end(), "vision") != capabilities.end();
    if (std::find(capabilities.begin(), capabilities.end(), "embedding") != capabilities.end() &&
        std::find(capabilities.begin(), capabilities.end(), "completion") == capabilities.end()) {
        response.ok = false; response.error = "该模型用于嵌入，不支持翻译生成测试"; return response;
    }
    json message = {{"role","user"},{"content",vision ? "Read the text in this image. Output only the text." : "将日语「こんにちは」翻译成简体中文，只输出译文。"}};
    if (vision) message["images"] = json::array({
        "iVBORw0KGgoAAAANSUhEUgAAAGAAAAAwCAYAAADuFn/PAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAIXSURBVHhe7ZfhjcMgDEYZj4EyDrtklWzCye3dqYdtMJDeB5Wf5D9VIMn3wKQhO1BC+YPzv7gAMC4AjAsA4wLAuAAwLgCMCwDjAsC4ADBvEXClmEMISsWcrnKEznkU42PKzeFXypHdl+rIZ3ktmFsFsLAaFQ0m2JwtARuFT9wk4MwHe2FjNQLtErBZ+MQNAibC/6lKqHYB2nOsGz4xKeDKKZYvXAtKCynkcMgx2QRo864dPjEn4DyElzYcsh3j2gK0RbB++MSEAPnFlYXMEL+UhMF1AfIz7BI+MS5AOvDY6qwhtQ0enC5g//CJcQFCG7F8Vr7CwhXaELvmWwD7fcPwiWEBUgsROkgVyxws6JhyKn97qd5FgGZYAAtGWL1NDLuI36dVA88B5AMF9J5FWDYXQPeUD+NynlUZFmDp3y0sc+gCXoQLInc5kIcFSC/du+p4uHwX8Ws6rittLsi4ANT/ACH8B9LzCDtqNcYFKH+ErLtAaj/SimUCKpLZtY/iUldiQoDchqiEHP8ghq+MY6FWBMi7yr4oEMwJUHaBHpQc0KOk9LsFaHKVtrUAkwKISqjm0ttErwB1UTTHYbhBADEhoRFMv4Dx1ojgJgFPWFiNsvRmNqdFgLYLKjsNxa0CflFW4LP6+vGYAP2zVDtrULxHgGPGBYBxAWBcABgXAMYFgHEBYFwAGBcAxgWAcQFgXAAYFwDGBYD5AtJA624j99OOAAAAAElFTkSuQmCC"
    });
    const json body = {{"model",model},{"messages",json::array({message})},{"stream",false},{"think",false},{"keep_alive",0},
        {"options",{{"num_predict",16},{"num_ctx",2048},{"temperature",0}}}};
    json output;
    response = winHttpPost(base + "/api/chat", "", body.dump(), "direct", "", false, &output);
    if (!response.ok) return response;
    auto parsed = parseOllamaTestResponse(output.dump());
    parsed.statusCode = response.statusCode; parsed.externalCall = response.externalCall;
    return parsed;
#else
    LlmResponse response; response.error = "当前平台不支持 Ollama 生成测试"; return response;
#endif
}

LlmResponse LlmClient::chat(const LlmRequest& request)
{
    LlmResponse early;
    if (request.apiUrl.empty())
    {
        early.error = "请先填写 API URL";
        return early;
    }

    json body = request.options;
    body["model"] = request.model;
    body["messages"] = request.messages;
    body["stream"] = false;

#ifdef _WIN32
    const std::string suffix = "/v1/chat/completions";
    if (request.nativeOllama && request.apiUrl.ends_with(suffix)) {
        const auto baseUrl = request.apiUrl.substr(0, request.apiUrl.size() - suffix.size());
        json nativeBody = {{"model", request.model}, {"messages", request.messages}, {"stream", false}};
        for (auto& message : nativeBody["messages"]) if (message.contains("content") && message["content"].is_array()) {
            std::string text; json images = json::array();
            for (const auto& part : message["content"]) {
                if (part.value("type", "") == "text") text += part.value("text", "");
                if (part.value("type", "") == "image_url") {
                    const auto url = part.at("image_url").at("url").get<std::string>();
                    const auto comma = url.find(',');
                    if (!url.starts_with("data:image/") || comma == std::string::npos) { early.error = "Ollama 图片输入须为内嵌图片数据"; return early; }
                    images.push_back(url.substr(comma + 1));
                }
            }
            message["content"] = text; if (!images.empty()) message["images"] = images;
        }
        json options = request.options;
        if (request.ollamaContextLength >= 1024 && request.ollamaContextLength <= 1048576) options["num_ctx"] = request.ollamaContextLength;
        if (options.contains("keep_alive")) { nativeBody["keep_alive"] = options["keep_alive"]; options.erase("keep_alive"); }
        if (options.contains("format")) { nativeBody["format"] = options["format"]; options.erase("format"); }
        if (options.contains("max_tokens")) { options["num_predict"] = options["max_tokens"]; options.erase("max_tokens"); }
        if (options.value("reasoning_effort", "") == "none") nativeBody["think"] = false;
        options.erase("reasoning_effort"); nativeBody["options"] = options;
        json output;
        auto result = winHttpPost(baseUrl + "/api/chat", request.apiKey,
            nativeBody.dump(), request.proxyMode, request.httpProxy, false, &output);
        if (!result.ok) {
            auto message = result.error;
            std::transform(message.begin(), message.end(), message.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            if (message.find("exceed_context_size_error") != std::string::npos ||
                message.find("exceeds the available context size") != std::string::npos ||
                message.find("input length exceeds maximum context length") != std::string::npos ||
                message.find("input exceeds the context length") != std::string::npos ||
                message.find("prompt is too long for the context") != std::string::npos) {
                result.errorCode = "OLLAMA_CONTEXT_LIMIT";
                result.error = "Ollama 拒绝了请求，输入超过上下文容量。请提高「设置 → 通用 → 本地大模型 → Ollama」中的上下文长度，或缩短输入。服务响应：" + result.error;
            }
            return result;
        }
        const auto message = output.value("message", json::object());
        const auto doneReason = output.value("done_reason", "");
        const bool explicitContextStop = doneReason == "context_length";
        const json compatible = {{"choices", json::array({json{{"message", message}, {"finish_reason", explicitContextStop ? "length" : doneReason}}})},
            {"usage", {{"prompt_tokens", output.value("prompt_eval_count", 0)}, {"completion_tokens", output.value("eval_count", 0)}}}};
        auto parsed = parseChatResponse(compatible.dump(), request.requireComplete);
        parsed.statusCode = result.statusCode; parsed.externalCall = result.externalCall;
        if (parsed.errorCode == "LLM_OUTPUT_TRUNCATED") {
            int context = 0;
            json running;
            const auto status = winHttpPost(baseUrl + "/api/ps", request.apiKey, "", request.proxyMode, request.httpProxy, false, &running, true);
            const auto normalizeModel = [](std::string name) { if (name.ends_with(":latest")) name.resize(name.size() - 7); return name; };
            const auto models = status.ok ? running.find("models") : running.end();
            if (models != running.end() && models->is_array()) {
                for (const auto& model : *models) {
                    if (!model.is_object()) continue;
                    const auto name = model.find("name"), length = model.find("context_length");
                    if (name != model.end() && name->is_string() && normalizeModel(name->get<std::string>()) == normalizeModel(request.model) &&
                        length != model.end() && length->is_number_integer()) { context = length->get<int>(); break; }
                }
            }
            const int limit = options.value("num_predict", 0);
            const bool reachedOutputLimit = limit > 0 && parsed.completionTokens >= limit;
            const bool reachedContext = context > 0 && parsed.promptTokens > 0 && parsed.completionTokens > 0 &&
                static_cast<long long>(parsed.promptTokens) + parsed.completionTokens == context;
            if (explicitContextStop || (reachedContext && !reachedOutputLimit)) {
                parsed.errorCode = "OLLAMA_CONTEXT_LIMIT";
                parsed.error = "Ollama 上下文已用满";
            } else if (reachedContext && reachedOutputLimit) {
                parsed.error = "Ollama 同时达到上下文容量与本次输出上限";
            } else if (reachedOutputLimit) {
                parsed.error = "Ollama 达到本次请求的输出上限 " + std::to_string(limit) + " token";
            } else {
                parsed.error = "Ollama 因长度限制停止，无法确认触发的是上下文还是输出上限";
            }
            parsed.error += "（输入 " + std::to_string(parsed.promptTokens) + "，输出 " + std::to_string(parsed.completionTokens) + " token";
            if (context > 0) parsed.error += "，运行上下文 " + std::to_string(context) + " token";
            parsed.error += "）。";
            if (parsed.errorCode == "OLLAMA_CONTEXT_LIMIT" || reachedContext) parsed.error += "请提高「设置 → 通用 → 本地大模型 → Ollama」中的上下文长度，或缩短输入。";
        }
        const double duration = output.value("eval_duration", 0.0);
        if (duration > 0 && parsed.completionTokens > 0) parsed.generationTokensPerSecond = parsed.completionTokens * 1e9 / duration;
        return parsed;
    }
    return winHttpPost(request.apiUrl, request.apiKey, body.dump(), request.proxyMode, request.httpProxy, request.requireComplete);
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
