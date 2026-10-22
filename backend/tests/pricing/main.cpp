#include "PricingStore.h"

#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <random>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

void expect(bool ok, const std::string& message)
{
    if (!ok) throw std::runtime_error(message);
}

json rates(double input)
{
    return {{"input", input}, {"output", input * 2},
            {"cacheRead", input / 10}, {"cacheWrite", input / 5}};
}

json rule(const std::string& model, double input)
{
    return {{"model", model}, {"vendor", "DeepSeek"}, {"rates", rates(input)},
            {"idleRates", rates(input / 2)},
            {"peakWindows", json::array({{{"from", "09:00"}, {"to", "18:00"}}})}};
}

void check(PricingStore& store, const std::string& model, const std::string& date,
           const std::string& time, double input, const std::string& band)
{
    const auto actual = store.ratesFor(model, date, "CNY", time);
    expect(actual && actual->input == input && actual->output == input * 2
               && actual->cacheRead == input / 10 && actual->cacheWrite == input / 5,
           "rates: " + model + " " + date + " " + time);
    expect(store.bandFor(model, date, time) == band,
           "band: " + model + " " + date + " " + time);
}

void run(const fs::path& directory)
{
    PricingStore store((directory / "pricing.json").string());
    auto table = PricingStore::defaultTable();
    auto before = rule("interval", 10);
    before["to"] = "2026-08-31";
    auto after = rule("interval", 20);
    after["from"] = "2026-09-01";
    auto overnight = rule("overnight", 30);
    overnight["peakWindows"] = json::array({{{"from", "22:00"}, {"to", "06:00"}}});
    auto flat = rule("flat", 40);
    flat["peakWindows"] = json::array();
    auto weekdays = rule("weekdays", 50);
    weekdays["peakWeekdays"] = json::array({1, 2, 3, 4, 5});
    auto priority = rule("priority", 60);
    priority["subRules"] = json::array({
        {{"band", "peak"}, {"peakWeekdays", json::array({1})}, {"rates", rates(70)}},
        {{"band", "idle"}, {"rates", rates(80)}},
        {{"band", "peak"}, {"rates", rates(90)}},
    });
    auto flatPriority = priority;
    flatPriority["model"] = "flat-priority";
    flatPriority["peakWindows"] = json::array();
    auto peakOnly = rule("peak-only", 60);
    peakOnly["subRules"] = json::array({{{"band", "peak"}, {"rates", rates(70)}}});
    auto usd = rule("usd", 12);
    usd["vendor"] = "OpenAI";
    table["rules"] = json::array({before, after, overnight, flat, weekdays, priority, flatPriority, peakOnly, usd});
    expect(store.put(table).empty(), "save pricing fixture");

    check(store, "interval", "2026-08-31", "08:59", 5, "idle");
    check(store, "interval", "2026-08-31", "09:00:00", 10, "peak");
    check(store, " interval ", "2026-08-31", "17:59:59", 10, "peak");
    check(store, "interval", "2026-08-31", "18:00", 5, "idle");
    check(store, "interval", "2026-09-01", "09:00", 20, "peak");
    check(store, "interval", "2026-08-31", "", 10, "peak");
    check(store, "overnight", "2026-08-31", "22:00", 30, "peak");
    check(store, "overnight", "2026-08-31", "05:59", 30, "peak");
    check(store, "overnight", "2026-08-31", "06:00", 15, "idle");
    check(store, "flat", "2026-08-31", "12:00", 20, "flat");
    check(store, "weekdays", "2026-08-31", "12:00", 50, "peak");
    check(store, "weekdays", "2026-08-30", "12:00", 25, "idle");
    check(store, "priority", "2026-08-31", "12:00", 70, "peak");
    check(store, "priority", "2026-09-01", "12:00", 90, "peak");
    check(store, "priority", "2026-09-01", "19:00", 80, "idle");
    check(store, "flat-priority", "2026-08-31", "12:00", 70, "flat");
    check(store, "flat-priority", "2026-09-01", "12:00", 80, "flat");
    check(store, "peak-only", "2026-08-31", "19:00", 70, "peak");
    const auto usdRates = store.ratesFor("usd", "2026-08-31", " usd ", "12:00");
    expect(usdRates && usdRates->input == 12, "vendor currency and currency normalization");
    expect(!store.ratesFor("interval", "2026-08-31", "USD", "12:00"), "no currency conversion");
    expect(!store.ratesFor("interval", "", "CNY", "12:00"), "missing date");
    expect(!store.ratesFor("missing", "2026-08-31", "CNY"), "missing model");
    expect(store.bandFor("missing", "2026-08-31") == "flat", "missing model band");
    expect(store.bandFor(" ", "2026-08-31").empty(), "empty model band");
    json event = {{"channel", "llm"}, {"model", "interval"}, {"date", "2026-08-31"},
                  {"time", "12:00"}, {"promptTokens", 1000}, {"completionTokens", 100},
                  {"totalTokens", 1100}, {"cacheReadTokens", 200}, {"cacheWriteTokens", 50}};
    expect(std::abs(store.costFor(event, "CNY") - 0.0103) < 1e-12, "token cost formula");
    const auto saved = store.get();
    PricingStore reloaded((directory / "pricing.json").string());
    expect(reloaded.get() == saved, "reload preserves configured prices and intervals");
    check(reloaded, "interval", "2026-09-01", "09:00", 20, "peak");
    auto overlapping = table;
    overlapping["rules"].push_back(before);
    expect(!store.put(overlapping).empty(), "overlapping intervals rejected before indexing");
    expect(store.get() == saved, "rejected intervals leave active table unchanged");

    auto legacy = rule("legacy", 100);
    legacy.erase("rates"); legacy.erase("peakWindows");
    legacy["cny"] = rates(100); legacy["idleRates"] = rates(50);
    table["rules"] = json::array({legacy});
    table["dayParts"] = {{"idleFrom", "00:30"}, {"idleTo", "08:30"}};
    expect(store.put(table).empty(), "normalize legacy pricing at input");
    check(store, "legacy", "2026-08-31", "00:30", 50, "idle");
    check(store, "legacy", "2026-08-31", "08:30", 100, "peak");
    legacy["peakWindows"] = json::array();
    table["rules"] = json::array({legacy});
    expect(store.put(table).empty(), "explicit empty windows override legacy dayParts");
    check(store, "legacy", "2026-08-31", "12:00", 50, "flat");

    table = PricingStore::defaultTable();
    for (int i = 0; i < 150; ++i)
        table["rules"].push_back(rule("model-" + std::to_string(i), i + 1));
    expect(store.put(table).empty(), "save model catalog");
    const auto start = std::chrono::steady_clock::now();
    for (int i = 0; i < 1500; ++i)
        check(store, "model-" + std::to_string(i % 150), "2026-08-31", "12:00", i % 150 + 1, "peak");
    const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    std::cout << "Pricing boundaries, sub-rule priority, currency, legacy migration and reload passed.\n"
              << "1500 rate/band pairs over 150 models: " << ms << " ms\n";
}

int main()
{
    const auto directory = fs::temp_directory_path()
        / ("llmchat-pricing-" + std::to_string(std::random_device{}()));
    try
    {
        expect(fs::create_directory(directory), "create isolated pricing fixture directory");
        run(directory);
    }
    catch (const std::exception& error)
    {
        std::cerr << error.what() << '\n';
        return 1;
    }
    fs::remove_all(directory);
}
