#pragma once
#include "GameFileOps.h"
#include "ManagedGamePatch.h"
#include <functional>
#include <vector>

namespace gameresourcebackup {
using namespace gamefiles;
inline fs::path imageRoot(const fs::path& game, const fs::path& data) {
    return data == "Data" ? game / data : game / data.parent_path() / "img";
}
inline std::string imageExtension(const fs::path& path) {
    auto extension = path.extension().string();
    for (auto& c : extension) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
    return extension;
}
inline bool isImage(const fs::path& path) {
    const auto extension = imageExtension(path);
    return extension == ".png" || extension == ".png_" || extension == ".rpgmvp";
}
inline std::vector<fs::path> imageSources(const fs::path& game, const fs::path& data, bool firstOnly = false) {
    std::vector<fs::path> files;
    const auto folder = imageRoot(game, data);
    if (!fs::is_directory(folder)) return files;
    for (const auto& file : fs::recursive_directory_iterator(folder)) {
        if (!file.is_regular_file() || !isImage(file.path())) continue;
        files.push_back(fs::relative(file.path(), game));
        if (firstOnly) break;
    }
    return files;
}

inline std::vector<fs::path> wolfTextSources(const fs::path& game) {
    return fs::is_directory(game / "Data") ? gamepatch::sources(game, {}) : std::vector<fs::path>{};
}

inline const char* wolfCategory(const fs::path& name) {
    if (name == "Data.wolf") return "dataWolf";
    if (isImage(name)) return "looseImages";
    return imageExtension(name) == ".wolf" ? "textArchives" : "looseText";
}

inline Json wolfAvailability(const fs::path& game) {
    Json available = {{"dataWolfPresent", fs::is_regular_file(game / "Data.wolf")},
        {"looseText", false}, {"textArchives", false}, {"looseImages", !imageSources(game, "Data", true).empty()}, {"textIncludesImages", false}};
    for (const auto& name : wolfTextSources(game)) {
        available[isImage(name) ? "textIncludesImages" : wolfCategory(name)] = true;
    }
    return available;
}

inline Json emptyWolfCoverage(const fs::path& game) {
    Json coverage = Json::object();
    for (const auto* key : {"looseText", "dataWolf", "looseImages", "installationOriginals", "textArchives"})
        coverage[key] = {{"included", false}, {"count", 0}};
    coverage["dataWolf"]["present"] = fs::is_regular_file(game / "Data.wolf");
    return coverage;
}

struct Snapshot {
    fs::path path;
    Json counts = Json::object();
    Json wolfCoverage;
    std::string summary() const {
        std::string message = "备份完成";
        if (!wolfCoverage.is_null()) {
            for (const auto& [category, label] : {std::pair{"looseText", "散装文本"}, {"textArchives", "文本分包"}, {"looseImages", "散装图片"}}) {
                const auto count = wolfCoverage.at(category).at("count").get<size_t>();
                if (count) message += std::string(" · ") + label + " " + std::to_string(count) + " 个";
            }
            const auto& archive = wolfCoverage.at("dataWolf");
            if (archive.at("present").get<bool>() && !archive.at("included").get<bool>()) message += " · 未包含 Data.wolf";
            return message;
        }
        for (const auto& [scope, label] : {std::pair{"text","文本资源"}, {"runtime","插件与字体"}, {"images","图片资源"}})
            if (counts.contains(scope)) message += std::string(" · ") + label + " " + std::to_string(counts.at(scope).get<size_t>()) + " 个";
        return message;
    }
};
inline Snapshot snapshot(const fs::path& game, const fs::path& data, const Json& selected, const std::function<void(size_t,size_t)>& progress = {}, bool isUnreal = false) {
    const auto scopes = selected.get<std::vector<std::string>>();
    if (scopes.empty()) throw std::runtime_error("请选择至少一项备份范围");
    Snapshot result;
    std::set<fs::path> files;
    const auto prefix = data.parent_path();
    const bool wolf = !isUnreal && data == "Data";
    if (wolf) result.wolfCoverage = emptyWolfCoverage(game);
    for (const auto& scope : scopes) {
        std::vector<fs::path> candidates;
        if (scope == "text") {
            candidates = wolf ? wolfTextSources(game) : gamepatch::sources(game, data, isUnreal);
        } else if (scope == "runtime" && !wolf) {
            for (const auto& name : {"js/plugins.js", "js/plugins/LLMChatTranslation.js", "LLMChat-translations.json", "fonts/LLMChat-font.ttf", "fonts/LLMChat-font.otf"}) candidates.push_back(prefix / name);
        } else if (scope == "images") {
            candidates = imageSources(game, data);
        } else throw std::runtime_error("无效备份范围：" + scope);
        result.counts[scope] = std::count_if(candidates.begin(), candidates.end(), [&](const auto& name) {
            return fs::is_regular_file(game / name);
        });
        files.insert(candidates.begin(), candidates.end());
    }
    if (files.empty()) throw std::runtime_error("所选范围没有可备份的资源");
    const auto backup = game / "LLMChat-JSON/backups" / ("files-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
    Json manifest = {{"engine","files"},{"kind","snapshot"},{"state","snapshot"},{"scopes",scopes},{"counts",result.counts},
        {"wolfTextSnapshot",wolf && result.counts.value("text", size_t{0}) > 0},{"resources",Json::array()}};
    size_t completed = 0; if (progress) progress(0, files.size());
    for (const auto& entry : files) {
        const auto name = relative(key(entry));
        const bool exists = fs::is_regular_file(game / name);
        if (exists) copyResource(game / name, backup / "original" / name);
        Json resource = {{"name", key(name)}, {"existed", exists}};
        if (wolf) {
            const auto* category = wolfCategory(name);
            resource["category"] = category;
            if (exists) {
                auto& coverage = result.wolfCoverage.at(category);
                coverage["included"] = true;
                coverage["count"] = coverage.at("count").get<size_t>() + 1;
            }
        }
        manifest["resources"].push_back(std::move(resource));
        if (progress) progress(++completed, files.size());
    }
    if (wolf) manifest["backupCoverage"] = result.wolfCoverage;
    ledger(backup, manifest);
    result.path = backup;
    return result;
}
}
