#include "SystemPerformance.h"
#include "AtomicFile.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <thread>
#include <tuple>
#include <utility>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <pdh.h>
#include <pdhmsg.h>
#endif

namespace {

using Json = nlohmann::json;
using Steady = std::chrono::steady_clock;
using namespace std::chrono_literals;

constexpr auto keepSamples = 30min;
constexpr auto stopAfter = 60s;
constexpr auto keepRuns = 7 * 24h;
constexpr size_t maxRuns = 200;
constexpr size_t maxPoints = 2000;
constexpr size_t maxArchivePoints = 360;

enum Metric { Cpu, AvailableMemory, UsedMemory, DiskRead, DiskWrite, NetworkReceive, NetworkSend, Gpu, MetricCount };
using Value = std::optional<double>;
struct Point {
    int64_t time = 0;
    std::array<Value, MetricCount> values{};
};

int64_t epochMilliseconds() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}

template<class Get>
void appendMetrics(Json& result, std::string_view metric, Get get) {
    const auto add = [&](const char* name, Metric id) {
        if (metric.empty() || metric == name) result[name] = get(id);
    };
    const auto pair = [&](const char* name, const char* firstName, Metric firstId, const char* secondName, Metric secondId) {
        if (!metric.empty() && metric != name) return;
        auto first = get(firstId);
        auto second = get(secondId);
        result[name] = first.is_null() && second.is_null() ? Json(nullptr)
            : Json{{firstName, std::move(first)}, {secondName, std::move(second)}};
    };
    add("cpu", Cpu);
    pair("memory", "availableBytes", AvailableMemory, "usedBytes", UsedMemory);
    pair("disk", "readBytesPerSec", DiskRead, "writeBytesPerSec", DiskWrite);
    pair("network", "receiveBytesPerSec", NetworkReceive, "sendBytesPerSec", NetworkSend);
    add("gpu", Gpu);
}

Json pointJson(const Point* point, const char* timeKey, std::string_view metric = {}) {
    Json result{{timeKey, point ? Json(point->time) : Json(nullptr)}};
    appendMetrics(result, metric, [&](Metric id) -> Json {
        return point && point->values[id] ? Json(*point->values[id]) : Json(nullptr);
    });
    return result;
}

#ifdef _WIN32
Value counterValue(const PDH_FMT_COUNTERVALUE& value) {
    if (value.CStatus != PDH_CSTATUS_VALID_DATA && value.CStatus != PDH_CSTATUS_NEW_DATA) return {};
    return std::isfinite(value.doubleValue) && value.doubleValue >= 0 ? Value(value.doubleValue) : Value{};
}

class Sampler {
public:
    Sampler() {
        if (PdhOpenQueryW(nullptr, 0, &query_) != ERROR_SUCCESS) return;
        add(Cpu, LR"(\Processor(_Total)\% Processor Time)");
        add(AvailableMemory, LR"(\Memory\Available Bytes)");
        add(DiskRead, LR"(\PhysicalDisk(_Total)\Disk Read Bytes/sec)");
        add(DiskWrite, LR"(\PhysicalDisk(_Total)\Disk Write Bytes/sec)");
        add(NetworkReceive, LR"(\Network Interface(*)\Bytes Received/sec)");
        add(NetworkSend, LR"(\Network Interface(*)\Bytes Sent/sec)");
        add(Gpu, LR"(\GPU Engine(*)\Utilization Percentage)");
    }

    ~Sampler() { if (query_) PdhCloseQuery(query_); }

    Point read() {
        Point point{epochMilliseconds()};
        if (!query_ || PdhCollectQueryData(query_) != ERROR_SUCCESS) return point;
        auto& values = point.values;
        for (auto metric : {Cpu, AvailableMemory, DiskRead, DiskWrite}) values[metric] = readCounter(metric);
        MEMORYSTATUSEX memory{};
        memory.dwLength = sizeof(memory);
        if (values[AvailableMemory] && GlobalMemoryStatusEx(&memory)) {
            const auto total = static_cast<double>(memory.ullTotalPhys);
            if (*values[AvailableMemory] <= total) values[UsedMemory] = total - *values[AvailableMemory];
        }

        for (auto metric : {NetworkReceive, NetworkSend}) {
            visit(metric, [&](std::wstring_view, double value) {
                values[metric] = values[metric].value_or(0) + value;
            });
        }

        std::map<std::wstring, double> engines;
        visit(Gpu, [&](std::wstring_view instance, double value) {
            // GPU Engine instances are split by process. Sum only instances of the same physical engine.
            const auto adapter = instance.find(L"_luid_");
            const auto engine = adapter == instance.npos ? instance : instance.substr(adapter);
            engines[std::wstring(engine)] += value;
        });
        for (const auto& [name, value] : engines) values[Gpu] = std::max(values[Gpu].value_or(0), std::min(100.0, value));
        return point;
    }

private:
    PDH_HQUERY query_ = nullptr;
    std::array<PDH_HCOUNTER, MetricCount> counters_{};
    std::vector<std::max_align_t> buffer_;

    void add(Metric id, const wchar_t* path) {
        PDH_HCOUNTER counter = nullptr;
        if (PdhAddEnglishCounterW(query_, path, 0, &counter) == ERROR_SUCCESS) counters_[id] = counter;
    }
    Value readCounter(Metric id) const {
        PDH_FMT_COUNTERVALUE value{};
        return counters_[id] && PdhGetFormattedCounterValue(counters_[id], PDH_FMT_DOUBLE | PDH_FMT_NOCAP100,
            nullptr, &value) == ERROR_SUCCESS ? counterValue(value) : Value{};
    }
    template<class Visitor>
    void visit(Metric id, Visitor visitor) {
        if (!counters_[id]) return;
        DWORD bytes = 0, count = 0;
        constexpr auto format = PDH_FMT_DOUBLE | PDH_FMT_NOCAP100;
        if (PdhGetFormattedCounterArrayW(counters_[id], format, &bytes, &count, nullptr) != PDH_MORE_DATA) return;
        buffer_.resize((bytes + sizeof(std::max_align_t) - 1) / sizeof(std::max_align_t));
        auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buffer_.data());
        if (PdhGetFormattedCounterArrayW(counters_[id], format, &bytes, &count, items) != ERROR_SUCCESS) return;
        for (DWORD i = 0; i < count; ++i) {
            if (const auto value = counterValue(items[i].FmtValue)) visitor(items[i].szName, *value);
        }
    }
};
#else
class Sampler {
public:
    Point read() { return Point{epochMilliseconds()}; }
};
#endif

struct Run {
    std::string taskId;
    std::string source;
    int64_t startedAt;
    int64_t endedAt;
};

struct Totals {
    double sum = 0;
    double peak = 0;
    size_t samples = 0;
    void add(double value) {
        sum += value;
        peak = std::max(peak, value);
        ++samples;
    }
    Json json() const {
        return {{"mean", samples ? Json(sum / samples) : Json(nullptr)},
            {"peak", samples ? Json(peak) : Json(nullptr)}, {"samples", samples}};
    }
};

Json summarize(const Run& run, const std::deque<Point>& history) {
    std::array<Totals, MetricCount> totals;
    std::array<Totals, 5> system;
    std::vector<const Point*> selected;
    Json first, last;
    for (const auto& point : history) {
        if (point.time < run.startedAt || point.time > run.endedAt) continue;
        if (first.is_null()) first = point.time;
        last = point.time;
        selected.push_back(&point);
        for (size_t i = 0; i < totals.size(); ++i) if (point.values[i]) totals[i].add(*point.values[i]);
        const auto& v = point.values;
        if (v[Cpu]) system[0].add(*v[Cpu]);
        if (v[AvailableMemory] && v[UsedMemory] && *v[AvailableMemory] + *v[UsedMemory] > 0)
            system[1].add(*v[UsedMemory] / (*v[AvailableMemory] + *v[UsedMemory]) * 100);
        if (v[DiskRead] || v[DiskWrite]) system[2].add(v[DiskRead].value_or(0) + v[DiskWrite].value_or(0));
        if (v[NetworkReceive] || v[NetworkSend]) system[3].add(v[NetworkReceive].value_or(0) + v[NetworkSend].value_or(0));
        if (v[Gpu]) system[4].add(*v[Gpu]);
    }
    auto timeline = Json::array();
    const auto stride = std::max(size_t{1}, (selected.size() + maxArchivePoints - 1) / maxArchivePoints);
    for (size_t i = 0; i < selected.size(); i += stride) timeline.push_back(pointJson(selected[i], "t"));
    if (!selected.empty() && (selected.size() - 1) % stride) timeline.push_back(pointJson(selected.back(), "t"));
    Json metrics = Json::object();
    appendMetrics(metrics, {}, [&](Metric metric) { return totals[metric].json(); });
    return {{"taskId", run.taskId}, {"source", run.source}, {"startedAt", run.startedAt}, {"endedAt", run.endedAt},
        {"firstSampledAt", first}, {"lastSampledAt", last}, {"metrics", std::move(metrics)},
        {"summary", {{"cpu", system[0].json()}, {"memory", system[1].json()}, {"disk", system[2].json()},
            {"network", system[3].json()}, {"gpu", system[4].json()}}},
        {"sampleCount", selected.size()}, {"points", std::move(timeline)}};
}

void writeRuns(const std::filesystem::path& file, const std::deque<Json>& incoming) {
    const auto cutoff = epochMilliseconds() - std::chrono::duration_cast<std::chrono::milliseconds>(keepRuns).count();
    // A retried notification cannot replace the samples captured for that completed run.
    std::map<std::tuple<int64_t, std::string, std::string>, Json> rows;
    const auto retain = [&](Json row) {
        if (!row.is_object() || !row.contains("endedAt") || !row["endedAt"].is_number_integer() ||
            !row.contains("source") || !row["source"].is_string() || !row.contains("taskId") || !row["taskId"].is_string()) return;
        const auto endedAt = row["endedAt"].get<int64_t>();
        if (endedAt < cutoff) return;
        const auto key = std::tuple{endedAt, row["source"].get<std::string>(), row["taskId"].get<std::string>()};
        rows.try_emplace(key, std::move(row));
        if (rows.size() > maxRuns) rows.erase(rows.begin());
    };
    {
        std::ifstream input(file);
        std::string line;
        while (std::getline(input, line)) retain(Json::parse(line, nullptr, false));
    }
    for (const auto& row : incoming) retain(row);
    std::string output;
    for (const auto& [key, row] : rows) output += row.dump() + "\n";
    std::string error;
    if (!atomicfile::writeText(file, output, &error, {.backup = false}))
        std::cerr << "System performance archive: " << error << '\n';
}

} // namespace

class SystemPerformance::Impl {
public:
    explicit Impl(const std::filesystem::path& logs) : file_(logs / "system-performance.jsonl") {}
    ~Impl() {
        {
            std::lock_guard lock(mutex_);
            stopping_ = true;
        }
        wake_.notify_one();
        if (worker_.joinable()) worker_.join();
    }

    Json now() {
        std::lock_guard lock(mutex_);
        touch();
        if (samples_.empty() || samples_.back().time < epochMilliseconds() -
            std::chrono::duration_cast<std::chrono::milliseconds>(stopAfter).count()) return pointJson(nullptr, "sampledAt");
        return pointJson(&samples_.back(), "sampledAt");
    }

    Json history(int64_t from, int64_t to, std::string_view metric) {
        std::vector<Point> matching;
        {
            std::lock_guard lock(mutex_);
            touch();
            trimSamples(epochMilliseconds());
            for (const auto& point : samples_) if (point.time >= from && point.time <= to) matching.push_back(point);
        }
        const auto stride = std::max(size_t{1}, (matching.size() + maxPoints - 1) / maxPoints);
        auto output = Json::array();
        for (size_t i = 0; i < matching.size(); i += stride) output.push_back(pointJson(&matching[i], "t", metric));
        return {{"points", std::move(output)}};
    }

    Json runs(std::string_view taskId, std::string_view source) {
        std::lock_guard lock(archiveMutex_);
        std::ifstream input(file_);
        auto matches = Json::array();
        const auto marker = Json(taskId).dump();
        std::string line;
        while (std::getline(input, line)) {
            if (line.find(marker) == std::string::npos) continue;
            auto row = Json::parse(line, nullptr, false);
            if (row.is_object() && row.value("taskId", std::string{}) == taskId &&
                row.value("source", std::string{}) == source) matches.push_back(std::move(row));
        }
        return {{"runs", std::move(matches)}};
    }

    bool begin(Run run) {
        std::lock_guard lock(mutex_);
        const SegmentKey key{run.startedAt, run.taskId, run.source};
        if (std::find(completed_.begin(), completed_.end(), key) != completed_.end()) return true;
        if (active_.size() >= maxRuns && !active_.contains(key)) return false;
        active_.insert(key);
        touch();
        return true;
    }

    bool complete(Run run) {
        std::lock_guard lock(mutex_);
        const SegmentKey key{run.startedAt, run.taskId, run.source};
        if (std::find(completed_.begin(), completed_.end(), key) != completed_.end()) return true;
        if (pending_.size() >= maxRuns) return false;
        trimSamples(epochMilliseconds());
        pending_.push_back(summarize(run, samples_));
        active_.erase(key);
        completed_.push_back(key);
        if (completed_.size() > maxRuns) completed_.pop_front();
        start();
        wake_.notify_one();
        return true;
    }

private:
    const std::filesystem::path file_;
    const std::chrono::seconds interval_ = std::thread::hardware_concurrency() <= 2 ? 5s : 2s;
    using SegmentKey = std::tuple<int64_t, std::string, std::string>;
    std::set<SegmentKey> active_;
    std::deque<SegmentKey> completed_;
    std::mutex mutex_;
    std::mutex archiveMutex_;
    std::condition_variable wake_;
    std::thread worker_;
    bool running_ = false;
    bool stopping_ = false;
    Steady::time_point readUntil_ = Steady::time_point::min();
    Steady::time_point nextSample_ = Steady::time_point::min();
    std::deque<Point> samples_;
    std::deque<Json> pending_;

    void trimSamples(int64_t now) {
        const auto recentCutoff = now - std::chrono::duration_cast<std::chrono::milliseconds>(keepSamples).count();
        const auto cutoff = active_.empty() ? recentCutoff : std::min(recentCutoff, std::get<0>(*active_.begin()));
        while (!samples_.empty() && samples_.front().time < cutoff)
            samples_.pop_front();
    }

    void touch() {
        const auto now = Steady::now();
        if (now >= readUntil_) nextSample_ = now;
        readUntil_ = now + stopAfter;
        start();
        wake_.notify_one();
    }

    void start() {
        if (running_) return;
        // A worker sets running_ to false as its last action under mutex_.
        if (worker_.joinable()) worker_.join();
        worker_ = std::thread([this] { work(); });
        running_ = true;
    }

    void work() {
        std::unique_ptr<Sampler> sampler;
        std::unique_lock lock(mutex_);
        for (;;) {
            if (!pending_.empty()) {
                std::deque<Json> batch;
                batch.swap(pending_);
                lock.unlock();
                try {
                    std::lock_guard archiveLock(archiveMutex_);
                    writeRuns(file_, batch);
                }
                catch (const std::exception& error) { std::cerr << "System performance archive: " << error.what() << '\n'; }
                lock.lock();
                continue;
            }
            const auto now = Steady::now();
            if (stopping_ || (active_.empty() && now >= readUntil_)) break;
            if (now < nextSample_) {
                wake_.wait_until(lock, active_.empty() ? std::min(nextSample_, readUntil_) : nextSample_);
                continue;
            }
            nextSample_ = now + interval_;
            lock.unlock();
            Point point{epochMilliseconds()};
            try {
                if (!sampler) sampler = std::make_unique<Sampler>();
                point = sampler->read();
            } catch (const std::exception& error) { std::cerr << "System performance sample: " << error.what() << '\n'; }
            lock.lock();
            samples_.push_back(point);
            trimSamples(point.time);
        }
        running_ = false;
    }
};

SystemPerformance::SystemPerformance(const std::filesystem::path& logs) : impl_(std::make_unique<Impl>(logs)) {}
SystemPerformance::~SystemPerformance() = default;
Json SystemPerformance::now() { return impl_->now(); }
Json SystemPerformance::history(int64_t from, int64_t to, std::string_view metric) { return impl_->history(from, to, metric); }
Json SystemPerformance::runs(std::string_view taskId, std::string_view source) { return impl_->runs(taskId, source); }
bool SystemPerformance::begin(std::string taskId, std::string source, int64_t startedAt) {
    return impl_->begin({std::move(taskId), std::move(source), startedAt, startedAt});
}
bool SystemPerformance::complete(std::string taskId, std::string source, int64_t startedAt, int64_t endedAt) {
    return impl_->complete({std::move(taskId), std::move(source), startedAt, endedAt});
}
