#include "SystemPerformance.h"
#include "AtomicFile.h"
#include "UsageStore.h"

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
#include <wbemidl.h>
#include <wrl/client.h>
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

enum Metric { Cpu, AvailableMemory, UsedMemory, DiskRead, DiskWrite, NetworkReceive, NetworkSend, Gpu, DiskPercent, MetricCount };
using Value = std::optional<double>;

struct TemperatureReading {
    Value cpu, gpu;
    const char* source = nullptr;
};

struct Point {
    int64_t time = 0;
    std::array<Value, MetricCount> values{};
    TemperatureReading temperature;
    std::optional<ModelActivity> activity;
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
    const auto value = [](const Value& measure) { return measure ? Json(*measure) : Json(nullptr); };
    const auto temperature = point ? point->temperature : TemperatureReading{};
    const auto activity = point ? point->activity : std::optional<ModelActivity>{};
    result["diskPercent"] = point ? value(point->values[DiskPercent]) : Json(nullptr);
    result["cpuTempC"] = value(temperature.cpu);
    result["gpuTempC"] = value(temperature.gpu);
    result["tempSource"] = temperature.source ? Json(temperature.source) : Json(nullptr);
    result["tokensPerSecond"] = activity ? Json(activity->tokensPerSecond) : Json(nullptr);
    result["modelCount"] = activity ? Json(activity->modelCount) : Json(nullptr);
    result["modelInstanceCount"] = activity ? Json(activity->modelInstanceCount) : Json(nullptr);
    return result;
}

#ifdef _WIN32
Value counterValue(const PDH_FMT_COUNTERVALUE& value) {
    if (value.CStatus != PDH_CSTATUS_VALID_DATA && value.CStatus != PDH_CSTATUS_NEW_DATA) return {};
    return std::isfinite(value.doubleValue) && value.doubleValue >= 0 ? Value(value.doubleValue) : Value{};
}

struct Variant {
    VARIANT value{};
    ~Variant() { VariantClear(&value); }
};

Value numeric(const VARIANT& value) {
    switch (value.vt) {
    case VT_R4: return value.fltVal;
    case VT_R8: return value.dblVal;
    case VT_I4: return value.lVal;
    case VT_UI4: return value.ulVal;
    default: return {};
    }
}

class Temperatures {
    using Bstr = std::unique_ptr<OLECHAR, decltype(&SysFreeString)>;
    struct Source {
        Microsoft::WRL::ComPtr<IWbemServices> services;
        Steady::time_point retryAt = Steady::time_point::min();
    };

public:
    Temperatures() {
        initialized_ = SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED));
        if (initialized_)
            CoCreateInstance(CLSID_WbemLocator, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(locator_.GetAddressOf()));
    }

    ~Temperatures() {
        lhm_.services.Reset();
        acpi_.services.Reset();
        locator_.Reset();
        if (initialized_) CoUninitialize();
    }

    TemperatureReading read() {
        TemperatureReading result;
        query(lhm_, LR"(ROOT\LibreHardwareMonitor)",
            L"SELECT Identifier, Name, Value FROM Sensor WHERE SensorType = 'Temperature'", [&](IWbemClassObject& row) {
                Variant id, name, value;
                if (FAILED(row.Get(L"Identifier", 0, &id.value, nullptr, nullptr)) || id.value.vt != VT_BSTR ||
                    !id.value.bstrVal || FAILED(row.Get(L"Value", 0, &value.value, nullptr, nullptr))) return;
                const auto celsius = numeric(value.value);
                if (!celsius || !std::isfinite(*celsius)) return;
                const std::wstring_view identifier(id.value.bstrVal);
                if (identifier.starts_with(L"/intelcpu/") || identifier.starts_with(L"/amdcpu/")) {
                    if (SUCCEEDED(row.Get(L"Name", 0, &name.value, nullptr, nullptr)) && name.value.vt == VT_BSTR &&
                        name.value.bstrVal && std::wstring_view(name.value.bstrVal).find(L"TjMax") != std::wstring_view::npos) return;
                    hottest(result.cpu, *celsius);
                } else if (identifier.starts_with(L"/gpu-") || identifier.starts_with(L"/nvidiagpu/") ||
                    identifier.starts_with(L"/atigpu/") || identifier.starts_with(L"/intelgpu/")) {
                    hottest(result.gpu, *celsius);
                }
            });
        if (result.cpu || result.gpu) {
            result.source = "lhm";
            return result;
        }
        query(acpi_, LR"(ROOT\WMI)",
            L"SELECT CurrentTemperature FROM MSAcpi_ThermalZoneTemperature WHERE Active = TRUE", [&](IWbemClassObject& row) {
                Variant value;
                if (FAILED(row.Get(L"CurrentTemperature", 0, &value.value, nullptr, nullptr))) return;
                // ACPI reports a thermal zone, not a CPU die or GPU sensor. Use the hottest valid zone as the CPU-side fallback.
                if (const auto kelvin10 = numeric(value.value); kelvin10 && *kelvin10 > 0)
                    hottest(result.cpu, *kelvin10 / 10.0 - 273.15);
            });
        if (result.cpu) result.source = "acpi";
        return result;
    }

private:
    bool initialized_ = false;
    Microsoft::WRL::ComPtr<IWbemLocator> locator_;
    Source lhm_, acpi_;

    static Bstr bstr(const wchar_t* value) { return Bstr(SysAllocString(value), SysFreeString); }

    static void hottest(Value& value, double candidate) {
        if (!value || candidate > *value) value = candidate;
    }

    template<class ReadRow>
    void query(Source& source, const wchar_t* nameSpace, const wchar_t* wql, ReadRow readRow) {
        if (!locator_ || Steady::now() < source.retryAt) return;
        if (!source.services) {
            if (FAILED(locator_->ConnectServer(bstr(nameSpace).get(), nullptr, nullptr, nullptr, WBEM_FLAG_CONNECT_USE_MAX_WAIT,
                nullptr, nullptr, source.services.GetAddressOf())) ||
                FAILED(CoSetProxyBlanket(source.services.Get(), RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, nullptr,
                    RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, nullptr, EOAC_NONE))) {
                source.services.Reset();
                source.retryAt = Steady::now() + 30s;
                return;
            }
        }
        Microsoft::WRL::ComPtr<IEnumWbemClassObject> rows;
        if (FAILED(source.services->ExecQuery(bstr(L"WQL").get(), bstr(wql).get(),
            WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY, nullptr, rows.GetAddressOf()))) {
            source.services.Reset();
            source.retryAt = Steady::now() + 30s;
            return;
        }
        const auto deadline = Steady::now() + 150ms;
        while (Steady::now() < deadline) {
            Microsoft::WRL::ComPtr<IWbemClassObject> row;
            ULONG count = 0;
            const auto wait = std::chrono::ceil<std::chrono::milliseconds>(deadline - Steady::now()).count();
            if (wait <= 0) return;
            const auto status = rows->Next(static_cast<LONG>(wait), 1, row.GetAddressOf(), &count);
            if (FAILED(status)) {
                source.services.Reset();
                source.retryAt = Steady::now() + 30s;
                return;
            }
            if (!count) return;
            readRow(*row.Get());
        }
    }
};

class Sampler {
public:
    Sampler() {
        if (PdhOpenQueryW(nullptr, 0, &query_) != ERROR_SUCCESS) return;
        add(Cpu, LR"(\Processor(_Total)\% Processor Time)");
        add(AvailableMemory, LR"(\Memory\Available Bytes)");
        add(DiskRead, LR"(\PhysicalDisk(_Total)\Disk Read Bytes/sec)");
        add(DiskWrite, LR"(\PhysicalDisk(_Total)\Disk Write Bytes/sec)");
        add(DiskPercent, LR"(\PhysicalDisk(_Total)\% Disk Time)");
        add(NetworkReceive, LR"(\Network Interface(*)\Bytes Received/sec)");
        add(NetworkSend, LR"(\Network Interface(*)\Bytes Sent/sec)");
        add(Gpu, LR"(\GPU Engine(*)\Utilization Percentage)");
    }

    ~Sampler() { if (query_) PdhCloseQuery(query_); }

    Point read() {
        Point point{epochMilliseconds()};
        point.temperature = temperatures_.read();
        if (!query_ || PdhCollectQueryData(query_) != ERROR_SUCCESS) return point;
        auto& values = point.values;
        for (auto metric : {Cpu, AvailableMemory, DiskRead, DiskWrite}) values[metric] = readCounter(metric);
        // _Total Disk Time can exceed 100% across physical disks. Present a bounded busy percentage.
        if (const auto percent = readCounter(DiskPercent)) values[DiskPercent] = std::min(100.0, *percent);
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
    Temperatures temperatures_;
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
    Impl(const std::filesystem::path& logs, UsageStore& usage)
        : file_(logs / "system-performance.jsonl"), usage_(usage) {}
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
            std::chrono::duration_cast<std::chrono::milliseconds>(stopAfter).count()) {
            auto result = pointJson(nullptr, "sampledAt");
            const auto activity = usage_.recentModelActivity();
            result["tokensPerSecond"] = activity.tokensPerSecond;
            result["modelCount"] = activity.modelCount;
            result["modelInstanceCount"] = activity.modelInstanceCount;
            return result;
        }
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
    UsageStore& usage_;
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
                point.activity = usage_.recentModelActivity();
            } catch (const std::exception& error) { std::cerr << "System performance sample: " << error.what() << '\n'; }
            lock.lock();
            samples_.push_back(point);
            trimSamples(point.time);
        }
        running_ = false;
    }
};

SystemPerformance::SystemPerformance(const std::filesystem::path& logs, UsageStore& usage)
    : impl_(std::make_unique<Impl>(logs, usage)) {}
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
