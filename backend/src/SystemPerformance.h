#pragma once

#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

class UsageStore;

class SystemPerformance {
public:
    SystemPerformance(const std::filesystem::path& logs, UsageStore& usage);
    ~SystemPerformance();

    nlohmann::json now();
    nlohmann::json history(int64_t from, int64_t to, std::string_view metric);
    nlohmann::json runs(std::string_view taskId, std::string_view source);
    bool begin(std::string taskId, std::string source, int64_t startedAt);
    bool complete(std::string taskId, std::string source, int64_t startedAt, int64_t endedAt);

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};
