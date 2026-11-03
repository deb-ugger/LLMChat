#pragma once
#include <nlohmann/json.hpp>
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <chrono>
#include <memory>
#include <vector>
#include <stdexcept>
#include <algorithm>

// Text requests are owned and scheduled by the service, independently of polling.
class TextTaskQueue {
    using json = nlohmann::json;
    struct Job { std::string id; std::function<json()> work; json result; bool running = false, done = false, cancelled = false; std::chrono::steady_clock::time_point created = std::chrono::steady_clock::now(); };
    std::mutex mutex_; std::condition_variable ready_;
    std::unordered_map<std::string, std::shared_ptr<Job>> jobs_;
    std::deque<std::shared_ptr<Job>> pending_;
    std::vector<std::thread> workers_;
    std::function<void(const std::string&)> cancel_; bool closing_ = false;
    void worker() {
        for (;;) {
            std::shared_ptr<Job> job;
            { std::unique_lock lock(mutex_); ready_.wait(lock, [&] { return closing_ || !pending_.empty(); }); if (closing_) return; job = pending_.front(); pending_.pop_front(); if (job->cancelled) continue; job->running = true; }
            json result;
            try { result = job->work(); } catch (const std::exception& e) { result = {{"status", 500}, {"body", {{"error", e.what()}}}}; }
            { std::lock_guard lock(mutex_); job->result = std::move(result); job->work = {}; job->done = true; }
            ready_.notify_all();
        }
    }
public:
    explicit TextTaskQueue(std::function<void(const std::string&)> cancel) : cancel_(std::move(cancel)) {
        for (int i = 0; i < 4; ++i) workers_.emplace_back([this] { worker(); });
    }
    ~TextTaskQueue() {
        { std::lock_guard lock(mutex_); closing_ = true; for (auto& [id, job] : jobs_) if (!job->done) cancel_(id); }
        ready_.notify_all(); for (auto& thread : workers_) thread.join();
    }
    bool submit(const std::string& id, std::function<json()> work) {
        std::lock_guard lock(mutex_);
        const auto now = std::chrono::steady_clock::now();
        for (auto it = jobs_.begin(); it != jobs_.end();) if (it->second->done && now - it->second->created > std::chrono::minutes(5)) it = jobs_.erase(it); else ++it;
        if (closing_ || jobs_.size() >= 128 || jobs_.contains(id)) return false;
        auto job = std::make_shared<Job>(); job->id = id; job->work = std::move(work); jobs_[id] = job; pending_.push_back(job); ready_.notify_all(); return true;
    }
    json status(const std::string& id) {
        std::unique_lock lock(mutex_); const auto it = jobs_.find(id); if (it == jobs_.end()) throw std::runtime_error("文本请求不存在或已过期");
        const auto job = it->second;
        ready_.wait_for(lock, std::chrono::milliseconds(500), [&] { return job->done || job->cancelled || closing_; });
        if (job->cancelled || closing_) return {{"done", true}, {"response", {{"status", 499}, {"body", {{"error", "文本请求已取消"}}}}}};
        return job->done ? json{{"done", true}, {"response", job->result}} : json{{"done", false}, {"state", job->running ? "running" : "queued"}};
    }
    bool remove(const std::string& id) {
        std::lock_guard lock(mutex_); const auto it = jobs_.find(id); if (it == jobs_.end()) return false;
        if (!it->second->done) { it->second->cancelled = true; cancel_(id); if (!it->second->running) { const auto job = it->second; std::erase(pending_, job); job->work = {}; } }
        jobs_.erase(it);
        ready_.notify_all();
        return true;
    }
};
