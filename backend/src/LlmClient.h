#pragma once

#include <string>
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
};

class LlmClient {
public:
    static LlmResponse chat(const LlmRequest& request);
};
