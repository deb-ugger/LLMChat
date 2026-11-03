#pragma once
#include "AtomicFile.h"
#include <nlohmann/json.hpp>
#include <mutex>
#include <unordered_map>

// Keep the project once; checkpoints send only changed entries and small totals.
class TextRunStore {
    using json = nlohmann::json;
    struct Run { json project; std::filesystem::path file; std::unordered_map<std::string, size_t> indices; };
    std::mutex mutex_; std::unordered_map<std::string, Run> runs_;
    static void save(const Run& run) { std::string error; if (!atomicfile::writeText(run.file, run.project.dump(2) + "\n", &error)) throw std::runtime_error(error); }
public:
    void begin(const std::string& id, const std::filesystem::path& file, json project) {
        std::lock_guard lock(mutex_);
        if (runs_.contains(id) || runs_.size() >= 16) throw std::runtime_error("文本运行任务重复或数量过多");
        Run run; run.file = file; run.project = std::move(project);
        const auto& entries = run.project.at("entries");
        for (size_t i = 0; i < entries.size(); ++i) if (!run.indices.emplace(entries[i].at("id").get<std::string>(), i).second) throw std::runtime_error("工程条目编号重复");
        save(run); runs_.emplace(id, std::move(run));
    }
    void checkpoint(const std::string& id, const json& updates, const json& tokens, long long elapsed) {
        std::lock_guard lock(mutex_); auto it = runs_.find(id); if (it == runs_.end()) throw std::runtime_error("文本运行任务不存在，请重新开始任务");
        auto& run = it->second;
        for (const auto& entry : updates) if (!run.indices.contains(entry.at("id").get<std::string>())) throw std::runtime_error("断点包含未知条目");
        for (auto entry : updates) {
            const auto index = run.indices.at(entry.at("id").get<std::string>());
            if (entry.value("status", "") == "running") { entry["status"] = "pending"; entry.erase("error"); }
            run.project["entries"][index] = std::move(entry);
        }
        run.project["tokens"] = tokens; run.project["elapsedMs"] = elapsed;
        save(run);
    }
    void finish(const std::string& id) { std::lock_guard lock(mutex_); runs_.erase(id); }
};
