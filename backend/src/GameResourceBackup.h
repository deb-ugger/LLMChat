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
struct Snapshot {
    fs::path path;
    Json counts = Json::object();
    std::string summary() const {
        std::string message = "备份完成";
        for (const auto& [scope, label] : {std::pair{"text","文本资源"}, {"runtime","插件与字体"}, {"images","图片资源"}})
            if (counts.contains(scope)) message += std::string(" · ") + label + " " + std::to_string(counts.at(scope).get<size_t>()) + " 个";
        return message;
    }
};
inline Snapshot snapshot(const fs::path& game, const fs::path& data, const Json& selected, const std::function<void(size_t,size_t)>& progress = {}) {
    const auto scopes = selected.get<std::vector<std::string>>();
    if (scopes.empty()) throw std::runtime_error("请选择至少一项备份范围");
    Snapshot result;
    std::set<fs::path> files;
    const auto prefix = data.parent_path();
    const bool wolf = data == "Data";
    for (const auto& scope : scopes) {
        std::vector<fs::path> candidates;
        if (scope == "text") {
            if (!wolf || fs::is_directory(game / data)) candidates = gamepatch::sources(game, wolf ? fs::path{} : data);
        } else if (scope == "runtime" && !wolf) {
            for (const auto& name : {"js/plugins.js", "js/plugins/LLMChatTranslation.js", "LLMChat-translations.json", "fonts/LLMChat-font.ttf", "fonts/LLMChat-font.otf"}) candidates.push_back(prefix / name);
        } else if (scope == "images") {
            const auto folder = imageRoot(game, data);
            if (fs::is_directory(folder)) for (const auto& file : fs::recursive_directory_iterator(folder))
                if (file.is_regular_file() && isImage(file.path())) candidates.push_back(fs::relative(file.path(), game));
        } else throw std::runtime_error("无效备份范围：" + scope);
        result.counts[scope] = std::count_if(candidates.begin(), candidates.end(), [&](const auto& name) {
            return fs::is_regular_file(game / name);
        });
        files.insert(candidates.begin(), candidates.end());
    }
    if (files.empty()) throw std::runtime_error("所选范围没有可备份的资源");
    const auto backup = game / "LLMChat-JSON/backups" / ("files-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
    Json manifest = {{"engine","files"},{"kind","snapshot"},{"state","snapshot"},{"scopes",scopes},{"counts",result.counts},
        {"wolfTextSnapshot",wolf && result.counts.contains("text")},{"resources",Json::array()}};
    size_t completed = 0; if (progress) progress(0, files.size());
    for (const auto& entry : files) {
        const auto name = relative(key(entry));
        const bool exists = fs::is_regular_file(game / name);
        if (exists) copyResource(game / name, backup / "original" / name);
        manifest["resources"].push_back({{"name",key(name)},{"existed",exists}});
        if (progress) progress(++completed, files.size());
    }
    ledger(backup, manifest);
    result.path = backup;
    return result;
}
}
