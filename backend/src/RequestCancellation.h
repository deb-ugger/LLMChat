#pragma once

#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace request_cancel {
using Clock = std::chrono::steady_clock;
struct State {
    std::atomic<bool> cancelled{false};
    Clock::time_point deadline = Clock::now() + std::chrono::seconds(120);
    bool stopped() const { return cancelled.load() || Clock::now() >= deadline; }
};

// One state per in-flight translation. Early cancellation markers are bounded
// and short-lived so a cancel that overtakes its POST still prevents the work.
class Registry {
    std::mutex mutex_;
    std::unordered_map<std::string, std::shared_ptr<State>> active_;
    std::unordered_map<std::string, Clock::time_point> early_;
    void prune() {
        const auto now = Clock::now();
        for (auto it = early_.begin(); it != early_.end();)
            if (it->second <= now) it = early_.erase(it); else ++it;
    }
public:
    std::shared_ptr<State> begin(const std::string& id) {
        std::lock_guard lock(mutex_);
        prune();
        if (active_.size() >= 12 || active_.count(id)) return {};
        auto state = std::make_shared<State>();
        state->cancelled = early_.erase(id) != 0;
        active_.emplace(id, state);
        return state;
    }
    void cancel(const std::string& id) {
        std::lock_guard lock(mutex_);
        prune();
        const auto it = active_.find(id);
        if (it != active_.end()) it->second->cancelled = true;
        else if (early_.size() < 256)
            early_[id] = Clock::now() + std::chrono::seconds(120);
    }
    void finish(const std::string& id) {
        std::lock_guard lock(mutex_);
        active_.erase(id);
    }
};

inline thread_local std::shared_ptr<State> current;
inline bool stopped() { return current && current->stopped(); }
class Scope {
    Registry& registry_;
    std::string id_;
    std::shared_ptr<State> previous_;
public:
    Scope(Registry& registry, std::string id, std::shared_ptr<State> state)
        : registry_(registry), id_(std::move(id)), previous_(std::move(current)) {
        current = std::move(state);
    }
    ~Scope() { current = std::move(previous_); registry_.finish(id_); }
    Scope(const Scope&) = delete;
    Scope& operator=(const Scope&) = delete;
};
}
