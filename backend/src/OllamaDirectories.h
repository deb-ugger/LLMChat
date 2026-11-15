#pragma once
#include "Utf8Path.h"
#include <algorithm>
#include <cstdlib>
#include <optional>
#include <vector>

namespace ollamadirectories {
namespace fs = std::filesystem;

inline std::optional<fs::path> resolve(const fs::path& input) {
    if (input.empty()) return std::nullopt;
    for (const auto& root : {input, input / "models", input / ".ollama" / "models"}) {
        std::error_code error;
        const bool manifests = fs::is_directory(root / "manifests", error);
        error.clear();
        const bool blobs = fs::is_directory(root / "blobs", error);
        if (!manifests && !blobs) continue;
        auto canonical = fs::canonical(root, error);
        if (!error) return canonical;
    }
    return std::nullopt;
}

inline std::vector<fs::path> discover() {
    std::vector<fs::path> candidates;
#ifdef _WIN32
    const auto environment = [](const wchar_t* name) {
        const auto size = GetEnvironmentVariableW(name, nullptr, 0);
        if (!size) return fs::path{};
        std::wstring value(size, L'\0');
        const auto written = GetEnvironmentVariableW(name, value.data(), size);
        if (!written || written >= size) return fs::path{};
        value.resize(written);
        return fs::path(value);
    };
    candidates.push_back(environment(L"OLLAMA_MODELS"));
    for (const auto* name : {L"USERPROFILE", L"LOCALAPPDATA", L"ProgramFiles"}) {
        const auto base = environment(name);
        if (!base.empty()) {
            candidates.push_back(base / ".ollama" / "models");
            candidates.push_back(base / "Ollama" / "models");
        }
    }
    const auto drives = GetLogicalDrives();
    for (int index = 0; index < 26; ++index) {
        if (!(drives & (1UL << index))) continue;
        const std::wstring drive = {wchar_t(L'A' + index), L':', L'\\'};
        if (GetDriveTypeW(drive.c_str()) != DRIVE_FIXED) continue;
        candidates.push_back(fs::path(drive) / "Ollama" / "models");
        candidates.push_back(fs::path(drive) / ".ollama" / "models");
        candidates.push_back(fs::path(drive) / "Models" / "Ollama");
    }
#else
    if (const auto* models = std::getenv("OLLAMA_MODELS")) candidates.emplace_back(models);
    if (const auto* home = std::getenv("HOME")) candidates.push_back(fs::path(home) / ".ollama" / "models");
#endif
    std::vector<fs::path> result;
    for (const auto& candidate : candidates) {
        const auto root = resolve(candidate);
        if (!root) continue;
        const auto same = [&](const fs::path& existing) {
            std::error_code error;
            return fs::equivalent(existing, *root, error);
        };
        if (std::none_of(result.begin(), result.end(), same)) result.push_back(*root);
    }
    return result;
}
} // namespace ollamadirectories
