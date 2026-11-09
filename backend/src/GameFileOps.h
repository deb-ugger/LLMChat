#pragma once
#include "Utf8Path.h"
#include "AtomicFile.h"
#include <nlohmann/json.hpp>
#include <filesystem>
#include <fstream>
#include <chrono>
namespace gamefiles {
namespace fs=std::filesystem; using Json=nlohmann::json;
inline std::string read(const fs::path& p){std::ifstream f(p,std::ios::binary);if(!f)throw std::runtime_error("无法读取："+utf8path::pathUtf8(p));return {std::istreambuf_iterator<char>(f),{}};}
inline void write(const fs::path& p,const std::string& s){fs::create_directories(p.parent_path());std::ofstream f(p,std::ios::binary);f.write(s.data(),s.size());if(!f)throw std::runtime_error("无法写入："+utf8path::pathUtf8(p));}
inline fs::path relative(const std::string& s){auto p=utf8path::pathFromUtf8(s);if(p.empty()||p.is_absolute()||p.has_root_name())throw std::runtime_error("无效资源路径");for(auto& part:p)if(part=="..")throw std::runtime_error("无效资源路径");return p;}
inline void ledger(const fs::path& p,const Json& j){std::string error;if(!atomicfile::writeText(p/"manifest.json",j.dump(2),&error))throw std::runtime_error(error);}
inline void restore(const fs::path& game,const fs::path& backup){auto j=Json::parse(read(backup/"manifest.json"));if(j.value("state","")=="rolledBack")return;
 for(auto& item:j["resources"]){auto name=relative(item.at("name"));if(item.value("existed",false)&&!fs::exists(backup/"original"/name))throw std::runtime_error("缺少备份原件");}
 j["state"]="rollingBack";ledger(backup,j);
 for(auto& item:j["resources"]){if(item.value("restored",false))continue;auto name=relative(item.at("name"));auto target=game/name;
 if(fs::exists(target)){auto saved=backup/"retained"/name;int n=2;while(fs::exists(saved))saved=backup/"retained"/(name.generic_string()+"-"+std::to_string(n++));fs::create_directories(saved.parent_path());fs::rename(target,saved);}
 if(item.value("existed",false))write(target,read(backup/"original"/name));item["restored"]=true;ledger(backup,j);}
 j["state"]="rolledBack";ledger(backup,j);
}
inline fs::path apply(const fs::path& game,const std::map<fs::path,std::string>& files){auto backup=game/"LLMChat-JSON"/"backups"/("files-"+std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));Json j={{"engine","files"},{"state","applying"},{"resources",Json::array()}};
 for(auto& [name,data]:files){relative(name.generic_string());const bool exists=fs::exists(game/name);if(exists)write(backup/"original"/name,read(game/name));write(backup/"staging"/name,data);j["resources"].push_back({{"name",name.generic_string()},{"existed",exists}});}ledger(backup,j);
 try{for(auto& [name,data]:files){auto target=game/name;fs::create_directories(target.parent_path());
#ifdef _WIN32
 if(!MoveFileExW((backup/"staging"/name).c_str(),target.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH))throw std::runtime_error("无法替换资源："+utf8path::pathUtf8(name));
#else
 fs::rename(backup/"staging"/name,target);
#endif
 }}catch(...){restore(game,backup);throw;}j["state"]="applied";ledger(backup,j);return backup;
}
}
