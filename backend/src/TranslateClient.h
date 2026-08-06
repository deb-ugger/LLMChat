#pragma once

#include <string>

struct TranslateResult {
    bool ok = false;
    std::string translation;
    std::string error;
    std::string provider;
    /** LENGTH_LIMIT | NETWORK_TIMEOUT | CONFIG_ERROR | ERROR */
    std::string code;
    int promptTokens = 0;
    int completionTokens = 0;
    int totalTokens = 0;
    int cacheReadTokens = 0;
    int cacheWriteTokens = 0;
    /** True only after an outbound HTTP attempt to the vendor API. */
    bool externalCall = false;
};

class TranslateClient {
public:
    /**
     * provider: mymemory|google|bing|sogou|baidu|youdao|niutrans|free(=mymemory)
     * maxLength: 0 = use engine default; autoChunk: split+join when over limit
     * proxyMode: auto|direct|custom ; httpProxy: host:port for custom
     */
    static TranslateResult translateFree(
        const std::string& text,
        const std::string& source,
        const std::string& target,
        const std::string& provider = "mymemory",
        int maxLength = 0,
        bool autoChunk = true,
        const std::string& proxyMode = "auto",
        const std::string& httpProxy = "",
        const std::string& engineKeysJson = "{}");

    static TranslateResult translateWithLlm(
        const std::string& text,
        const std::string& apiUrl,
        const std::string& apiKey,
        const std::string& model,
        const std::string& source,
        const std::string& target,
        const std::string& proxyMode = "auto",
        const std::string& httpProxy = "",
        const std::string& customPrompt = "",
        const std::string& glossaryJson = "");

    /** JSON: {ok, entry?, error?, provider?} — Bing webpage dictionary. */
    static std::string lookupDictionaryJson(
        const std::string& word,
        const std::string& source,
        const std::string& target,
        const std::string& proxyMode = "auto",
        const std::string& httpProxy = "");
};
