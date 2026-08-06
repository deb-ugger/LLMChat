#pragma once

#include <string>
#include <vector>
#include <nlohmann/json.hpp>

struct LlmRequest {
    std::string apiUrl;
    std::string apiKey;
    std::string model;
    nlohmann::json messages;
};

struct LlmResponse {
    bool ok = false;
    std::string content;
    std::string error;
    int statusCode = 0;
    int promptTokens = 0;
    int completionTokens = 0;
    int totalTokens = 0;
    /** Prompt-cache hit / read tokens (vendor-specific; 0 if unsupported). */
    int cacheReadTokens = 0;
    /** Prompt-cache write / creation tokens (vendor-specific; 0 if unsupported). */
    int cacheWriteTokens = 0;
    /** True only after an outbound HTTP attempt to the vendor API. */
    bool externalCall = false;
};

struct LlmListModelsRequest {
    /** Usually .../v1/chat/completions; will be rewritten to .../v1/models */
    std::string apiUrl;
    std::string apiKey;
    std::string proxyMode;
    std::string httpProxy;
};

struct LlmListModelsResponse {
    bool ok = false;
    std::string error;
    int statusCode = 0;
    std::vector<std::string> modelIds;
    bool externalCall = false;
};

class LlmClient {
public:
    static LlmResponse chat(const LlmRequest& request);
    /** GET OpenAI-compatible /v1/models and return model ids. */
    static LlmListModelsResponse listModels(const LlmListModelsRequest& request);
    /** Derive .../models URL from a chat/completions (or similar) URL. */
    static std::string modelsUrlFromChatUrl(const std::string& apiUrl);
};
