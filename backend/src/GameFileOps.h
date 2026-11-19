#pragma once
#include "Utf8Path.h"
#include "AtomicFile.h"
#include <nlohmann/json.hpp>
#include <filesystem>
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
inline void ledger(const fs::path& p,const Json& j){std::string error;if(!atomicfile::writeText(p/"manifest.json",j.dump(2),&error))throw std::runtime_error(error);}
inline void restore(const fs::path& game,const fs::path& backup){auto j=Json::parse(read(backup/"manifest.json"));if(j.value("state","")=="rolledBack")return;
 for(auto& item:j["resources"]){auto name=relative(item.at("name"));if(item.value("existed",false)&&!fs::exists(backup/"original"/name))throw std::runtime_error("缺少备份原件");}
 j["state"]="rollingBack";ledger(backup,j);
 for(auto& item:j["resources"]){if(item.value("restored",false))continue;auto name=relative(item.at("name"));auto target=game/name;
 if(fs::exists(target)){auto saved=backup/"retained"/name;int n=2;while(fs::exists(saved))saved=backup/"retained"/utf8path::pathFromUtf8(key(name)+"-"+std::to_string(n++));fs::create_directories(saved.parent_path());fs::rename(target,saved);}
 if(item.value("existed",false))copyResource(backup/"original"/name,target);item["restored"]=true;ledger(backup,j);}
 for(const auto& dir:j.value("createdDirectories",Json::array())) {
     const auto path=game/relative(dir.get<std::string>());
     if(fs::is_directory(path)&&fs::is_empty(path)) fs::remove(path);
 }
 j["state"]="rolledBack";ledger(backup,j);
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
