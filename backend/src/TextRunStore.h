#pragma once
#include "AtomicFile.h"
#include <nlohmann/json.hpp>
#include <cstdint>
#include <mutex>
#include <stdexcept>
#include <unordered_map>

class TextRunStore {
    using json = nlohmann::json;
    static constexpr std::uint64_t journalSlots = 16;
    static constexpr const char* checkpointKey = "textRunCheckpoint";

    struct Run {
        json project;
        std::filesystem::path file;
        std::unordered_map<std::string, size_t> indices;
        std::uint64_t sequence = 0;
        std::uint64_t snapshotSequence = 0;
    };

    std::mutex mutex_;
    std::unordered_map<std::string, Run> runs_;

    static std::filesystem::path journalFile(std::filesystem::path file, std::uint64_t sequence) {
        file += ".checkpoint-" + std::to_string(sequence % journalSlots) + ".json";
        return file;
    }

    static void write(const std::filesystem::path& file, const std::string& data, bool backup) {
        std::string error;
        if (!atomicfile::writeText(file, data, &error, {.backup = backup, .durable = true}))
            throw std::runtime_error(error);
    }

    static void saveSnapshot(const std::string& id, Run& run) {
        run.project[checkpointKey] = {{"runId", id}, {"sequence", run.sequence}, {"slots", journalSlots}};
        write(run.file, run.project.dump(2) + "\n", true);
        run.snapshotSequence = run.sequence;
    }

public:
    void begin(const std::string& id, const std::filesystem::path& file, json project) {
        std::lock_guard lock(mutex_);
        if (runs_.contains(id) || runs_.size() >= 16) throw std::runtime_error("文本运行任务重复或数量过多");
        Run run;
        run.file = std::filesystem::weakly_canonical(file);
        for (const auto& [_, active] : runs_) {
            std::error_code error;
            if (active.file == run.file || std::filesystem::equivalent(active.file, run.file, error))
                throw std::runtime_error("该工程已有文本运行任务");
        }
        run.project = std::move(project);
        const auto& entries = run.project.at("entries");
        for (size_t i = 0; i < entries.size(); ++i) if (!run.indices.emplace(entries[i].at("id").get<std::string>(), i).second) throw std::runtime_error("工程条目编号重复");
        saveSnapshot(id, run);
        runs_.emplace(id, std::move(run));
    }

    void checkpoint(const std::string& id, const json& updates, const json& tokens, long long elapsed) {
        std::lock_guard lock(mutex_);
        const auto it = runs_.find(id);
        if (it == runs_.end()) throw std::runtime_error("文本运行任务不存在，请重新开始任务");
        if (!updates.is_array()) throw std::runtime_error("断点条目必须是数组");
        auto& run = it->second;
        auto delta = updates;
        for (auto& entry : delta) {
            if (!run.indices.contains(entry.at("id").get_ref<const std::string&>()))
                throw std::runtime_error("断点包含未知条目");
            if (entry.value("status", "") == "running") { entry["status"] = "pending"; entry.erase("error"); }
        }

        // Advance the snapshot before reusing any segment it still needs.
        if (run.sequence - run.snapshotSequence == journalSlots) saveSnapshot(id, run);
        const auto next = run.sequence + 1;
        const json record = {{"runId", id}, {"sequence", next}, {"updates", delta}, {"tokens", tokens}, {"elapsedMs", elapsed}};
        write(journalFile(run.file, next), record.dump() + "\n", false);

        for (auto& entry : delta) {
            const auto index = run.indices.at(entry.at("id").get_ref<const std::string&>());
            run.project["entries"][index] = std::move(entry);
        }
        run.project["tokens"] = tokens;
        run.project["elapsedMs"] = elapsed;
        run.sequence = next;
    }

    void finish(const std::string& id) {
        std::lock_guard lock(mutex_);
        const auto it = runs_.find(id);
        if (it == runs_.end()) return;
        const auto file = it->second.file;
        runs_.erase(it);

        // The normal save path writes a complete snapshot without the run marker.
        // A failed or interrupted save must leave the journal available for recovery.
        std::ifstream input(file, std::ios::binary);
        if (!input) return;
        const auto snapshot = json::parse(input, nullptr, false);
        if (!snapshot.is_object() || snapshot.contains(checkpointKey)) return;
        for (std::uint64_t slot = 0; slot < journalSlots; ++slot) {
            std::error_code error;
            std::filesystem::remove(journalFile(file, slot), error);
        }
    }
};
