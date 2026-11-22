#pragma once

#include "UnityAutoTranslator.h"
#include <map>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <set>
#include <thread>

class UnityInstallJobs {
    using json = nlohmann::json;
    struct Job {
        std::string detail = "准备安装";
        bool done = false;
        json result;
        std::jthread worker;
    };

    std::mutex mutex_;
    std::set<std::string> writers_;
    std::map<unsigned, Job> jobs_;
    unsigned nextId_ = 0;
    unsigned active_ = 0;

    static json conflict() {
        return {{"ok", false}, {"code", "UNITY_INSTALL_CONFLICT"}, {"error", "这个游戏正在进行安装或文件写入，请等当前操作结束"}};
    }

public:
    ~UnityInstallJobs() {
        {
            std::lock_guard lock(mutex_);
            for (auto& [id, job] : jobs_) job.worker.request_stop();
        }
        for (auto& [id, job] : jobs_) if (job.worker.joinable()) job.worker.join();
    }

    template<class Run>
    bool write(const std::string& path, Run run) {
        {
            std::lock_guard lock(mutex_);
            if (!writers_.insert(path).second) return false;
        }
        struct Release {
            UnityInstallJobs& jobs;
            const std::string& path;
            ~Release() { std::lock_guard lock(jobs.mutex_); jobs.writers_.erase(path); }
        } release{*this, path};
        run();
        return true;
    }

    template<class Run>
    std::pair<int, json> start(const std::string& path, Run run) {
        std::lock_guard lock(mutex_);
        if (writers_.contains(path)) return {409, conflict()};
        if (active_ >= 2) {
            return {429, {{"ok", false}, {"code", "UNITY_INSTALL_BUSY"}, {"error", "安装任务已满，请稍后重试"}}};
        }
        if (jobs_.size() >= 32) {
            for (auto it = jobs_.begin(); it != jobs_.end(); ++it) {
                if (it->second.done) { jobs_.erase(it); break; }
            }
        }
        const auto id = ++nextId_;
        auto& job = jobs_.try_emplace(id).first->second;
        try {
            writers_.insert(path);
            job.worker = std::jthread([this, &job, path, run = std::move(run)](std::stop_token stop) {
                json result;
                try {
                    const UnityInstallControl control{stop, [this, &job](std::string detail) {
                        std::lock_guard lock(mutex_);
                        job.detail = std::move(detail);
                    }};
                    const auto value = run(control);
                    result = {{"ok", value.ok}, {"error", value.error}, {"gameDir", value.gameDir},
                        {"package", value.package}, {"version", value.version}, {"configPath", value.configPath},
                        {"installMethod", value.installMethod}, {"steps", value.steps}};
                } catch (const std::exception& e) {
                    result = {{"ok", false}, {"error", e.what()}, {"steps", json::array()}};
                }
                std::lock_guard lock(mutex_);
                if (stop.stop_requested() && !result.value("ok", false)) {
                    result["code"] = "UNITY_INSTALL_CANCELLED";
                    result["error"] = "安装已取消，已写入的文件可能保留";
                }
                job.result = std::move(result);
                job.done = true;
                writers_.erase(path);
                --active_;
            });
        } catch (...) {
            writers_.erase(path);
            jobs_.erase(id);
            throw;
        }
        ++active_;
        return {202, {{"taskId", id}}};
    }

    std::optional<json> status(unsigned id, bool cancel = false) {
        std::lock_guard lock(mutex_);
        const auto found = jobs_.find(id);
        if (found == jobs_.end()) return std::nullopt;
        auto& job = found->second;
        if (job.done) return json{{"state", "done"}, {"result", job.result}};
        if (cancel) job.worker.request_stop();
        if (job.worker.get_stop_token().stop_requested())
            return json{{"state", "stopping"}, {"detail", "正在取消，等待安装进程和文件写入结束"}};
        return json{{"state", "running"}, {"detail", job.detail}};
    }
};
