#pragma once
#include "GameFileOps.h"
#include "RpgMakerText.h"
#include <set>

// Installation originals are separate from user-created backup snapshots.
namespace gamepatch {
using namespace gamefiles;
inline fs::path root(const fs::path& game){return game/"LLMChat-JSON"/"patches"/"text";}
inline bool wolfName(const std::string& n){return n=="BasicData"||n=="MapData"||std::regex_match(n,std::regex("Evtext[A-Za-z0-9_-]*"));}
inline std::vector<fs::path> sources(const fs::path& game,const fs::path& data){
 std::vector<fs::path> files;
 if(!data.empty()){for(auto& e:fs::directory_iterator(game/data))if(e.is_regular_file()&&rpgtext::dataFile(e.path().filename().string()))files.push_back(fs::relative(e.path(),game));auto plugin=data.parent_path()/"js/plugins.js";if(fs::is_regular_file(game/plugin))files.push_back(plugin);}
 else for(auto& e:fs::directory_iterator(game/"Data")){auto name=e.is_directory()?e.path().filename().string():e.path().stem().string();if(!wolfName(name))continue;if(e.is_directory()){for(auto& f:fs::recursive_directory_iterator(e.path()))if(f.is_regular_file())files.push_back(fs::relative(f.path(),game));}else if(e.path().extension()==".wolf")files.push_back(fs::relative(e.path(),game));}
 return files;
}
inline Json record(const fs::path& game){auto path=root(game)/"manifest.json";return fs::is_regular_file(path)?Json::parse(read(path)):Json();}
inline bool same(const fs::path& a,const fs::path& b){return fs::is_regular_file(a)&&fs::is_regular_file(b)&&fs::file_size(a)==fs::file_size(b)&&read(a)==read(b);}
inline Json info(const fs::path& game){auto j=record(game);if(j.is_null())return {{"installed",false},{"managed",false},{"conflicts",Json::array()}};Json conflicts=Json::array();if(j.value("installed",false))for(auto& item:j["files"]){auto name=relative(item.at("path"));if(item.value("present",false)?!same(game/name,root(game)/"installed"/name):fs::exists(game/name))conflicts.push_back(key(name));}return {{"installed",j.value("installed",false)},{"managed",true},{"legacy",j.value("legacy",false)},{"conflicts",conflicts},{"resources",j["files"].size()}};}
inline void saveInstalled(const fs::path& game,Json j,const std::set<fs::path>& names){
 j["files"]=Json::array();for(auto& name:names){bool present=fs::is_regular_file(game/name);j["files"].push_back({{"path",key(name)},{"present",present}});if(present)write(root(game)/"installed"/name,read(game/name));}j["installed"]=true;ledger(root(game),j);
}
inline void capture(const fs::path& game,const fs::path& data){
 fs::remove_all(root(game)/"original");Json names=Json::array();for(auto& name:sources(game,data)){write(root(game)/"original"/name,read(game/name));names.push_back(key(name));}ledger(root(game),{{"version",1},{"installed",false},{"originals",names},{"files",Json::array()}});
}
// Adopt old text applications only when their original files are still available.
inline fs::path source(const fs::path& game,const fs::path& data,const Json& backups){
 auto j=record(game);if(!j.is_null())return j.value("installed",false)?root(game)/"original":game;
 std::vector<fs::path> layers;
 for(auto& b:backups){if(b.at("state")!="applied")continue;auto dir=utf8path::pathFromUtf8(b.at("path"));auto m=Json::parse(read(dir/"manifest.json"));if(m.value("kind","")=="snapshot"||m.value("managedPatch",false)||m.value("patchAdopted",false))continue;bool text=m.value("engine","")=="rpgmaker"||dir.filename().string().starts_with("wolf-");if(m.value("engine","")=="files")for(auto& item:m["resources"]){auto n=item.at("name").get<std::string>();if(n.starts_with(key(data)+"/")&&rpgtext::dataFile(fs::path(n).filename().string()))text=true;}if(text)layers.push_back(dir);}
 if(layers.empty())return game;
 try {capture(game,data);std::set<fs::path> installed;for(auto& name:sources(game,data))installed.insert(name);
 for(auto& dir:layers){auto m=Json::parse(read(dir/"manifest.json"));
  if(m.value("engine","")=="rpgmaker"){auto base=relative(m.at("dataDirectory"));for(auto& item:m["resources"]){auto n=item.at("name").get<std::string>();if(!rpgtext::dataFile(n))throw std::runtime_error("旧补丁的文本资源名称无效");write(root(game)/"original"/base/n,read(dir/"original"/n));}}
  else if(m.value("engine","")=="files"){for(auto& item:m["resources"]){auto name=relative(item.at("name"));if(item.value("existed",false))write(root(game)/"original"/name,read(dir/"original"/name));else fs::remove(root(game)/"original"/name);}}
  else {for(auto& item:m["resources"]){const auto n=item.is_string()?item.get<std::string>():item.at("name").get<std::string>();if(!wolfName(n))throw std::runtime_error("旧补丁资源名称无效");auto pack=dir/"Data"/(n+".wolf"),folder=dir/"Data"/n;if(fs::is_regular_file(pack)){write(root(game)/"original"/"Data"/(n+".wolf"),read(pack));if(!fs::is_directory(folder))fs::remove_all(root(game)/"original"/"Data"/n);}if(fs::is_directory(folder)){fs::create_directories(root(game)/"original"/"Data"/n);fs::copy(folder,root(game)/"original"/"Data"/n,fs::copy_options::recursive|fs::copy_options::overwrite_existing);}}}
 }
 j=record(game);j["originals"]=Json::array();for(auto& e:fs::recursive_directory_iterator(root(game)/"original"))if(e.is_regular_file()){auto n=fs::relative(e.path(),root(game)/"original");j["originals"].push_back(key(n));installed.insert(n);}j["legacy"]=true;saveInstalled(game,j,installed);for(auto& dir:layers){auto m=Json::parse(read(dir/"manifest.json"));m["patchAdopted"]=true;ledger(dir,m);}return root(game)/"original";}catch(...){fs::remove_all(root(game));throw;}
}
inline void verify(const fs::path& game){auto state=info(game);if(!state["conflicts"].empty())throw std::runtime_error("补丁资源已被其他操作修改，请先处理冲突："+state["conflicts"].dump());}
inline fs::path install(const fs::path& game,const fs::path& data,const fs::path& patch){
 verify(game);auto j=record(game);if(j.is_null()||!j.value("installed",false)){capture(game,data);j=record(game);}
 if(!j.contains("workDirs"))j["workDirs"]=Json::array();const auto work=key(patch.parent_path());if(std::find(j["workDirs"].begin(),j["workDirs"].end(),work)==j["workDirs"].end())j["workDirs"].push_back(work);
 std::map<fs::path,std::optional<std::string>> desired;std::set<fs::path> names;
 for(auto& n:j["originals"]){auto name=relative(n);desired[name]=read(root(game)/"original"/name);names.insert(name);}
 for(auto& item:j["files"]){auto name=relative(item.at("path"));if(!desired.contains(name))desired[name]=std::nullopt;names.insert(name);}
 for(auto& e:fs::recursive_directory_iterator(patch))if(e.is_regular_file()){auto name=fs::relative(e.path(),patch);desired[name]=read(e.path());names.insert(name);if(data.empty()&&name.begin()!=name.end()&&*name.begin()=="Data"){auto it=name.begin();++it;if(it!=name.end()){auto group=*it;if(wolfName(group.string())){auto archive=fs::path("Data")/(group.string()+".wolf");desired[archive]=std::nullopt;names.insert(archive);}}}}
 std::map<fs::path,std::optional<std::string>> changes;for(auto& [name,bytes]:desired)if(bytes?(!fs::is_regular_file(game/name)||read(game/name)!=*bytes):fs::exists(game/name))changes[name]=bytes;
 fs::path receipt;if(!changes.empty())receipt=applyChanges(game,changes);if(!receipt.empty()){auto m=Json::parse(read(receipt/"manifest.json"));m["managedPatch"]=true;m["patchBefore"]=j;ledger(receipt,m);}saveInstalled(game,j,names);return receipt;
}
inline void pruneEmpty(const fs::path& game,const Json& j){for(auto& item:j["files"]){auto name=relative(item.at("path"));if(key(name).starts_with("Data/")){auto dir=(game/name).parent_path();while(dir!=game/"Data"&&fs::is_directory(dir)&&fs::is_empty(dir)){fs::remove(dir);dir=dir.parent_path();}}}}
inline fs::path uninstall(const fs::path& game){verify(game);auto j=record(game);if(j.is_null()||!j.value("installed",false))throw std::runtime_error("没有已安装的文本补丁");std::map<fs::path,std::optional<std::string>> changes;std::set<std::string> originals;for(auto& n:j["originals"])originals.insert(n.get<std::string>());for(auto& item:j["files"]){auto name=relative(item.at("path"));changes[name]=originals.contains(key(name))?std::optional<std::string>(read(root(game)/"original"/name)):std::nullopt;}auto receipt=applyChanges(game,changes);auto m=Json::parse(read(receipt/"manifest.json"));m["managedPatch"]=true;m["patchBefore"]=j;ledger(receipt,m);pruneEmpty(game,j);j["installed"]=false;ledger(root(game),j);return receipt;}
inline void afterRestore(const fs::path& game,const fs::path& backup){auto current=record(game);if(current.is_null())return;pruneEmpty(game,current);auto receipt=Json::parse(read(backup/"manifest.json"));if(receipt.value("managedPatch",false)&&receipt.contains("patchBefore")){auto previous=receipt["patchBefore"];if(previous.value("installed",false)){std::set<fs::path> names;for(auto& item:previous["files"])names.insert(relative(item.at("path")));saveInstalled(game,previous,names);}else ledger(root(game),previous);return;}bool original=true;std::set<std::string> names;for(auto& item:current["originals"])names.insert(item.get<std::string>());for(auto& item:current["files"]){auto name=relative(item.at("path"));if(names.contains(key(name))?!same(game/name,root(game)/"original"/name):fs::exists(game/name)){original=false;break;}}if(original){current["installed"]=false;ledger(root(game),current);}}
inline void cleanup(const fs::path& game){auto j=record(game);if(!j.is_null()&&j.value("installed",false))throw std::runtime_error("请先卸载文本补丁，再清理安装文件");if(!j.is_null()&&j.contains("workDirs"))for(auto& value:j["workDirs"]){auto dir=utf8path::pathFromUtf8(value.get<std::string>());if(dir.parent_path().lexically_normal()!=(game/"LLMChat-JSON"/"work").lexically_normal()||!std::regex_match(dir.filename().string(),std::regex("(?:wolf|rpg)-[0-9]+")))throw std::runtime_error("补丁工作目录无效");fs::remove_all(dir);}fs::remove_all(root(game));}
}
