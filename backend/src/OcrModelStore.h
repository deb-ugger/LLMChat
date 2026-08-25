#pragma once

#include "Config.h"

#include <filesystem>
#include <cstdint>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>

class OcrModelStore {
public:
    explicit OcrModelStore(std::filesystem::path dataDir);

    nlohmann::json status() const;
    nlohmann::json ensureMode(const std::string& mode, const AppConfig& config);
    nlohmann::json removeMode(const std::string& mode);
    std::filesystem::path modelFile(const std::string& fileName) const;
    bool isAllowedModelFile(const std::string& fileName) const;

private:
    std::filesystem::path root_;
    mutable std::mutex mutex_;
    bool downloadActive_ = false;
    std::string downloadMode_;
    std::string downloadModel_;
    std::uintmax_t downloadBytes_ = 0;
    std::uintmax_t downloadTotalBytes_ = 0;
};
