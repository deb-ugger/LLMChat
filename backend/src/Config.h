#pragma once

#include <string>

struct AppConfig {
    std::string apiUrl = "https://api.openai.com/v1/chat/completions";
    std::string apiKey;
    std::string model = "gpt-4o";
    int messagePageSize = 30;
    int port = 17800;
    /** auto = system/PAC; direct = no proxy; custom = httpProxy */
    std::string proxyMode = "direct";
    /** e.g. 127.0.0.1:7890 or http://127.0.0.1:7890 */
    std::string httpProxy;
    std::string translateProvider = "bing"; // google|bing|mymemory|...|llm
    std::string translateSource = "en";
    std::string translateTarget = "zh-CN";
    int translateMaxLength = 0;      // 0 = engine default
    bool translateAutoChunk = true;  // split long text when limited
    std::string ocrLang = "eng";
    bool ocrAutoTranslate = true;
    std::string ocrTranslateProvider = "bing";
    std::string ocrTranslateSource = "en";
    std::string ocrTranslateTarget = "zh-CN";
    int ocrTranslateMaxLength = 0;
    bool ocrTranslateAutoChunk = true;
};

class ConfigStore {
public:
    explicit ConfigStore(std::string path);

    const AppConfig& get() const { return config_; }
    AppConfig& get() { return config_; }

    void load();
    void save() const;

    const std::string& path() const { return path_; }

private:
    std::string path_;
    AppConfig config_;
};
