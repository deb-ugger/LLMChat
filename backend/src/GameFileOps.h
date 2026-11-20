#pragma once
#include "Utf8Path.h"
#include "AtomicFile.h"
#include <nlohmann/json.hpp>
#include <filesystem>
#include <array>
#include <fstream>
#include <chrono>
#include <optional>
#include <map>
#include <set>
#include <algorithm>
#include <vector>
namespace gamefiles {
namespace fs=std::filesystem; using Json=nlohmann::json;
inline std::string key(const fs::path& path){auto value=utf8path::pathUtf8(path);std::replace(value.begin(),value.end(),static_cast<char>(92),'/');return value;}
inline std::string read(const fs::path& p){std::ifstream f(p,std::ios::binary);if(!f)throw std::runtime_error("无法读取："+utf8path::pathUtf8(p));return {std::istreambuf_iterator<char>(f),{}};}
inline void write(const fs::path& p,const std::string& s){fs::create_directories(p.parent_path());std::ofstream f(p,std::ios::binary);f.write(s.data(),s.size());if(!f)throw std::runtime_error("无法写入："+utf8path::pathUtf8(p));}
inline void copyResource(const fs::path& from,const fs::path& to){fs::create_directories(to.parent_path());fs::copy_file(from,to,fs::copy_options::overwrite_existing);}
inline fs::path relative(const std::string& s){auto p=utf8path::pathFromUtf8(s);if(p.empty()||p.is_absolute()||p.has_root_name())throw std::runtime_error("无效资源路径");for(auto& part:p)if(part=="..")throw std::runtime_error("无效资源路径");return p;}
inline bool reparsePoint(const fs::path& path) {
#ifdef _WIN32
    const auto attributes = GetFileAttributesW(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_REPARSE_POINT);
#else
    std::error_code error; return fs::is_symlink(fs::symlink_status(path, error));
#endif
}
inline fs::path checkedPath(const fs::path& root, const fs::path& name) {
    auto result = root;
    for (const auto& part : relative(key(name))) {
        if (part == "." || part.wstring().find(L':') != std::wstring::npos) throw std::runtime_error("无效资源路径");
        result /= part;
        if (reparsePoint(result)) throw std::runtime_error("资源路径包含链接，未修改文件");
    }
    return result;
}
inline void ledger(const fs::path& p, const Json& j, bool durable = false) {
    std::string error;
    if (!atomicfile::writeText(p / "manifest.json", j.dump(2), &error, {.durable = durable}))
        throw std::runtime_error(error);
}

inline fs::path availableName(const fs::path& root, const fs::path& name) {
    auto candidate = name;
    for (int number = 2; fs::exists(checkedPath(root, candidate)); ++number)
        candidate = utf8path::pathFromUtf8(key(name) + "-" + std::to_string(number));
    return candidate;
}

inline void copyVerified(const fs::path& source, const fs::path& destination) {
    const auto expected = fs::file_size(source);
    std::ifstream input(source, std::ios::binary);
    if (!input) throw std::runtime_error("无法读取资源：" + key(source));
    fs::create_directories(destination.parent_path());
    std::ofstream output(destination, std::ios::binary | std::ios::trunc);
    if (!output) throw std::runtime_error("无法写入资源：" + key(destination));

    std::array<char, 64 * 1024> buffer;
    while (input.read(buffer.data(), buffer.size()) || input.gcount() != 0) {
        output.write(buffer.data(), input.gcount());
        if (!output) throw std::runtime_error("写入资源失败：" + key(destination));
    }
    if (!input.eof() || input.bad()) throw std::runtime_error("读取资源失败：" + key(source));
    output.close();
    if (!output || fs::file_size(destination) != expected || fs::file_size(source) != expected)
        throw std::runtime_error("资源副本长度校验失败：" + key(destination));
    if (const auto error = atomicfile::syncPath(destination))
        throw std::runtime_error("无法同步资源副本：" + key(destination) + "：" + error.message());
}

inline bool sameFileContents(const fs::path& first, const fs::path& second) {
    if (!fs::is_regular_file(first) || !fs::is_regular_file(second)) return false;
    const auto size = fs::file_size(first);
    if (size != fs::file_size(second)) return false;
    std::ifstream a(first, std::ios::binary), b(second, std::ios::binary);
    if (!a || !b) return false;
    std::array<char, 64 * 1024> left, right;
    for (uintmax_t remaining = size; remaining != 0;) {
        const auto count = static_cast<std::streamsize>(std::min<uintmax_t>(remaining, left.size()));
        if (!a.read(left.data(), count) || !b.read(right.data(), count)
            || !std::equal(left.data(), left.data() + count, right.data())) return false;
        remaining -= count;
    }
    return true;
}

inline void replaceResource(const fs::path& temporary, const fs::path& target) {
#ifdef _WIN32
    if (!MoveFileExW(temporary.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        throw fs::filesystem_error("无法替换资源", temporary, target,
            std::error_code(static_cast<int>(GetLastError()), std::system_category()));
#else
    fs::rename(temporary, target);
#endif
}

inline void restoreFile(const fs::path& backup, const fs::path& target, const fs::path& original,
                        const fs::path& retainedName, Json& item, Json& manifest) {
    if (item.value("restored", false)) return;
    struct TemporaryFile {
        fs::path path;
        ~TemporaryFile() { if (!path.empty()) { std::error_code ignored; fs::remove(path, ignored); } }
    } temporary;

    if (!original.empty()) {
        if (!item.contains("restoreTemp")) {
            const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
            const auto name = fs::path(".llmchat-rollback-" + std::to_string(stamp) + ".tmp");
            item["restoreTemp"] = key(availableName(target.parent_path(), name));
            ledger(backup, manifest, true);
        }
        const auto name = relative(item.at("restoreTemp"));
        if (name != name.filename() || !key(name).starts_with(".llmchat-rollback-"))
            throw std::runtime_error("回滚临时文件名无效");
        const auto stage = checkedPath(target.parent_path(), name);
        if (fs::exists(stage) && !fs::is_regular_file(stage))
            throw std::runtime_error("回滚临时文件不是普通文件：" + key(stage));
        temporary.path = stage;
        copyVerified(original, temporary.path);
    }

    const bool targetExists = fs::exists(target);
    if (targetExists && !fs::is_regular_file(target)) throw std::runtime_error("回滚目标不是普通文件：" + key(target));
    if (!item.contains("retainedPath")) {
        item["retainedPath"] = targetExists
            ? Json(key(availableName(backup, fs::path("retained") / retainedName))) : Json(nullptr);
        ledger(backup, manifest, true);
    }
    if (item.at("retainedPath").is_string()) {
        const auto retained = relative(item.at("retainedPath"));
        if (*retained.begin() != "retained") throw std::runtime_error("保留资源路径无效");
        const auto saved = checkedPath(backup, retained);
        if (!item.value("retainedSaved", false)) {
            copyVerified(target, saved);
            item["retainedSaved"] = true;
            ledger(backup, manifest, true);
        }
    }

    // Repeating the replacement after an interrupted ledger write keeps the first retained copy.
    if (!original.empty()) replaceResource(temporary.path, target);
    else if (targetExists) fs::remove(target);
    item.erase("restoreTemp");
    item["restored"] = true;
    ledger(backup, manifest, true);
}

inline void restore(const fs::path& game, const fs::path& backup, bool finalize = true) {
    auto manifest = Json::parse(read(backup / "manifest.json"));
    if (manifest.value("state", "") == "rolledBack") return;
    for (const auto& item : manifest.at("resources")) {
        const auto name = relative(item.at("name"));
        if (!item.value("restored", false) && item.value("existed", false)
            && !fs::exists(checkedPath(backup, fs::path("original") / name)))
            throw std::runtime_error("缺少备份原件：" + key(name));
    }
    manifest["state"] = "rollingBack";
    ledger(backup, manifest, true);
    for (auto& item : manifest.at("resources")) {
        if (item.value("restored", false)) continue;
        const auto name = relative(item.at("name"));
        const auto original = item.value("existed", false) ? checkedPath(backup, fs::path("original") / name) : fs::path{};
        restoreFile(backup, checkedPath(game, name), original, name, item, manifest);
    }
    for (const auto& dir : manifest.value("createdDirectories", Json::array())) {
        const auto path = checkedPath(game, relative(dir.get<std::string>()));
        if (fs::is_directory(path) && fs::is_empty(path)) fs::remove(path);
    }
    if (finalize) {
        manifest["state"] = "rolledBack";
        ledger(backup, manifest, true);
    }
}
template<class Prepare>
inline fs::path applyPrepared(const fs::path& game, Prepare prepare, const fs::path& backupRoot = {}, Json journal = Json::object()) {
    fs::path backup;
    bool created=false;
    journal.update(Json{{"engine","files"},{"state","applying"},{"resources",Json::array()}});
    std::vector<std::pair<fs::path,bool>> staged;
    std::set<fs::path> newDirectories;
    try {
        prepare([&](const fs::path& name,const std::string* bytes,const fs::path* source = nullptr) {
            relative(key(name));
            if(backup.empty()) {
                const auto root = backupRoot.empty() ? game/"LLMChat-JSON"/"backups" : backupRoot;
                backup=root/("files-"+std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
                fs::create_directories(backup.parent_path());
                if(!fs::create_directory(backup)) throw std::runtime_error("备份目录已存在");
                created=true;
            }
            const bool existed=fs::exists(game/name);
            for(auto dir=name.parent_path();!dir.empty()&&!fs::exists(game/dir);dir=dir.parent_path())
                newDirectories.insert(dir);
            if(existed) copyResource(game/name,backup/"original"/name);
            if(bytes) write(backup/"staging"/name,*bytes);
            else if(source) copyResource(*source, backup/"staging"/name);
            journal["resources"].push_back({{"name",key(name)},{"existed",existed}});
            staged.emplace_back(name,bytes||source);
        });
    } catch(...) {
        if(created) {
            std::error_code ignored;
            fs::remove_all(backup,ignored);
        }
        throw;
    }
    if(staged.empty()) return {};
    for(auto dir=newDirectories.rbegin();dir!=newDirectories.rend();++dir)
        journal["createdDirectories"].push_back(key(*dir));
    ledger(backup,journal);
    size_t applied=0;
    try {
        for(const auto& [name,hasBytes]:staged) {
            const auto target=game/name;
            fs::create_directories(target.parent_path());
            if(!hasBytes) { fs::remove(target); ++applied; continue; }
#ifdef _WIN32
            if(!MoveFileExW((backup/"staging"/name).c_str(),target.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH))
                throw std::runtime_error("无法替换资源："+utf8path::pathUtf8(name));
#else
            fs::rename(backup/"staging"/name,target);
#endif
            ++applied;
        }
        journal["state"]="applied";
        ledger(backup,journal);
    } catch(const std::exception& error) {
        for(size_t i=applied;i<staged.size();++i) journal["resources"][i]["restored"]=true;
        ledger(backup,journal);
        restore(game,backup);
        throw std::runtime_error(std::string(error.what())+"；原资源已恢复");
    }
    return backup;
}
inline fs::path applyChanges(const fs::path& game,const std::map<fs::path,std::optional<std::string>>& files) {
    return applyPrepared(game,[&](const auto& stage) {
        for(const auto& [name,bytes]:files) stage(name,bytes ? &*bytes : nullptr);
    });
}
inline fs::path apply(const fs::path& game,const std::map<fs::path,std::string>& files) {
    return applyPrepared(game,[&](const auto& stage) {
        for(const auto& [name,bytes]:files) stage(name,&bytes);
    });
}

}
