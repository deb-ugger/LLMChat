#pragma once
#include "GameFileOps.h"
#include "RpgMakerText.h"
#include <functional>
#include <vector>

namespace gameresourcebackup {
using namespace gamefiles;
inline fs::path snapshot(const fs::path& game, const fs::path& data, const Json& selected, const std::function<void(size_t,size_t)>& progress = {}) {
    const auto scopes = selected.get<std::vector<std::string>>();
    if (scopes.empty()) throw std::runtime_error("请选择至少一项备份范围");
    std::vector<fs::path> files; const auto prefix = data.parent_path();
    for (const auto& scope : scopes) {
        if (scope == "text") {
            for (const auto& file : fs::directory_iterator(game / data)) if (file.is_regular_file() && rpgtext::dataFile(file.path().filename().string())) files.push_back(fs::relative(file.path(), game));
            if (fs::is_regular_file(game / prefix / "js/plugins.js")) files.push_back(prefix / "js/plugins.js");
        } else if (scope == "runtime") {
            for (const auto& name : {"js/plugins.js", "js/plugins/LLMChatTranslation.js", "LLMChat-translations.json", "fonts/LLMChat-font.ttf", "fonts/LLMChat-font.otf"}) files.push_back(prefix / name);
        } else if (scope == "images") {
            const auto folder = game / prefix / "img";
            if (fs::is_directory(folder)) for (const auto& file : fs::recursive_directory_iterator(folder)) if (file.is_regular_file()) {
                const auto extension = file.path().extension().string();
                if (extension == ".png" || extension == ".png_" || extension == ".rpgmvp") files.push_back(fs::relative(file.path(), game));
            }
        } else throw std::runtime_error("无效备份范围：" + scope);
    }
    std::sort(files.begin(), files.end()); files.erase(std::unique(files.begin(), files.end()), files.end());
    const auto backup = game / "LLMChat-JSON/backups" / ("files-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
    Json manifest = {{"engine","files"},{"kind","snapshot"},{"state","snapshot"},{"scopes",scopes},{"resources",Json::array()}};
    size_t completed = 0; if (progress) progress(0, files.size());
    for (const auto& entry : files) {
        const auto name = relative(key(entry));
        const bool exists = fs::is_regular_file(game / name);
        if (exists) write(backup / "original" / name, read(game / name));
        manifest["resources"].push_back({{"name",key(name)},{"existed",exists}});
        if (progress) progress(++completed, files.size());
    }
    ledger(backup, manifest); return backup;
}
}
