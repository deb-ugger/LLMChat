#pragma once
#include "GameFileOps.h"
#include <mutex>
#include <sstream>
#include <functional>
#include <atomic>

// MV/MZ file adapter. OCR, translation, rendering and preview UI stay in the existing image workbench.
class RpgImageProject {
    using Path=std::filesystem::path;using Json=nlohmann::json;
    std::recursive_mutex mutex_;
    std::atomic<uint64_t> readEpoch_{0};
    void checkRead(uint64_t epoch)const{if(readEpoch_.load()!=epoch)throw std::runtime_error("图片工程读取已中止");}
    std::map<Path,Json> catalogs_;
    std::map<Path,std::map<std::string,Json>> states_;
    std::map<std::string,Json>& states(const Path& game,std::optional<uint64_t> epoch={}){if(!states_.contains(game)){std::map<std::string,Json> values;auto dir=folder(game)/"state";if(std::filesystem::is_directory(dir))for(auto& file:std::filesystem::directory_iterator(dir))if(file.is_regular_file()&&file.path().extension()==".json"){if(epoch)checkRead(*epoch);auto value=Json::parse(gamefiles::read(file.path()));if(epoch)checkRead(*epoch);if(!value.contains("selectionManual")&&!value.contains("screening"))value["selectionManual"]=true;const auto imageId=value.at("id").get<std::string>();values[imageId]=std::move(value);}states_.emplace(game,std::move(values));}return states_.at(game);}
    std::map<Path,std::map<std::string,size_t>> indexes_;
    const Json& catalog(const Path& game){if(!catalogs_.contains(game))catalogs_[game]=Json::parse(gamefiles::read(folder(game)/"project.json"));return catalogs_.at(game);}
    Json imageRow(const Path& game,const std::string& imageId){const auto& project=catalog(game);if(!indexes_.contains(game)){size_t index=0;for(auto& entry:project.at("images"))indexes_[game][entry.at("id").get<std::string>()]=index++;}auto found=indexes_[game].find(imageId);if(found==indexes_[game].end())throw std::runtime_error("未找到图片，请重新扫描");auto image=project.at("images").at(found->second);const auto& values=states(game);auto saved=values.find(imageId);if(saved!=values.end()&&saved->second.at("sourceHash")==image.at("sourceHash"))return saved->second;return image;}
    static Path folder(const Path& game){return game/"LLMChat-JSON"/"images";}
    static Path data(const Path& game){if(std::filesystem::is_regular_file(game/"www/data/System.json"))return "www/data";if(std::filesystem::is_regular_file(game/"data/System.json"))return "data";throw std::runtime_error("请选择 RPG Maker MV/MZ 游戏");}
    static std::string stamp(const Path& file){return std::to_string(std::filesystem::file_size(file))+"-"+std::to_string(std::filesystem::last_write_time(file).time_since_epoch().count());}
    static std::string id(const std::string& name){uint64_t value=14695981039346656037ull;for(unsigned char byte:name){value^=byte;value*=1099511628211ull;}std::ostringstream out;out<<std::hex<<value;return out.str();}
    static std::string codec(std::string bytes,const std::string& key,bool encrypt){const std::string header("RPGMV\0\0\0\0\3\1\0\0\0\0\0",16);if(key.size()!=32)throw std::runtime_error("System.json 缺少有效图片密钥");if(!encrypt){if(bytes.size()<32||bytes.substr(0,16)!=header)throw std::runtime_error("不是标准 MV/MZ 加密图片");bytes.erase(0,16);}if(bytes.size()<16)throw std::runtime_error("图片文件过短");for(size_t i=0;i<16;++i){auto hex=key.substr(i*2,2);if(hex.find_first_not_of("0123456789abcdefABCDEF")!=std::string::npos)throw std::runtime_error("图片密钥无效");bytes[i]^=static_cast<char>(std::stoi(hex,nullptr,16));}return encrypt?header+bytes:bytes;}
    static std::pair<uint32_t,uint32_t> dimensions(const std::string& bytes){if(bytes.size()<24||bytes.substr(0,8)!=std::string("\x89PNG\r\n\x1a\n",8))throw std::runtime_error("图片不是有效 PNG");auto n=[&](int at){uint32_t v=0;for(int i=0;i<4;++i)v=(v<<8)|static_cast<unsigned char>(bytes[at+i]);return v;};auto width=n(16),height=n(20);if(!width||!height)throw std::runtime_error("PNG 尺寸无效");return {width,height};}
    static void saveJson(const Path& path,const Json& value){std::string error;if(!atomicfile::writeText(path,value.dump(),&error))throw std::runtime_error(error);}
    static Json row(const Json& project,const std::string& imageId){for(auto& image:project.at("images"))if(image.at("id").get<std::string>()==imageId)return image;throw std::runtime_error("未找到图片，请重新扫描");}
    static Path originalCache(const Path& game,const Json& image){return folder(game)/"original"/(image.at("id").get<std::string>()+"-"+image.at("sourceHash").get<std::string>()+".png");}
    static void validId(const std::string& imageId){if(imageId.empty()||imageId.find_first_not_of("0123456789abcdef")!=std::string::npos)throw std::runtime_error("图片编号无效");}
public:
    Json stopReading(const Path& game){readEpoch_.fetch_add(1);std::lock_guard lock(mutex_);data(game);catalogs_.erase(game);states_.erase(game);indexes_.erase(game);return {{"cleared",true}};}
    Json load(const Path& game){const auto epoch=readEpoch_.load();std::lock_guard lock(mutex_);checkRead(epoch);data(game);const auto path=folder(game)/"project.json";if(!std::filesystem::is_regular_file(path))return nullptr;auto project=catalog(game);checkRead(epoch);const auto& values=states(game,epoch);for(auto& image:project["images"]){checkRead(epoch);auto saved=values.find(image.at("id").get<std::string>());if(saved!=values.end()&&saved->second.at("sourceHash")==image.at("sourceHash"))image=saved->second;else if(!image.value("ocrCompleted",false)&&!image.value("completed",false))image["selected"]=false;}return project;}
    Json scan(const Path& game,const std::function<void(size_t,size_t,const std::string&)>& progress={}){std::lock_guard lock(mutex_);if(progress)progress(0,0,"读取图片工程");auto db=data(game);auto previous=load(game);Json byFile=Json::object();if(!previous.is_null())for(auto& image:previous["images"])byFile[image.at("file").get<std::string>()]=image;
        Json images=Json::array();std::vector<Path> files;size_t visited=0;if(progress)progress(0,0,"查找图片文件");for(auto& e:std::filesystem::recursive_directory_iterator(game/db.parent_path()/"img"))if(e.is_regular_file()){auto ext=e.path().extension().string();if(ext==".png"||ext==".png_"||ext==".rpgmvp")files.push_back(e.path());if(progress&&++visited%128==0)progress(0,0,"查找图片文件 · 已找到 "+std::to_string(files.size())+" 张");}std::sort(files.begin(),files.end());const auto key=Json::parse(gamefiles::read(game/db/"System.json")).value("encryptionKey","");
        size_t completed=0;if(progress)progress(0,files.size(),"读取图片信息");
        for(auto& file:files){if(progress&&(completed%16==0))progress(completed,files.size(),"读取图片信息："+utf8path::pathUtf8(file.filename()));++completed;const auto name=gamefiles::key(std::filesystem::relative(file,game));auto hash=stamp(file);if(byFile.contains(name)){auto old=byFile[name];const auto installed=folder(game)/"installed"/(old.at("id").get<std::string>()+".bin");if(old.at("sourceHash").get<std::string>()==hash||(std::filesystem::is_regular_file(installed)&&gamefiles::read(installed)==gamefiles::read(file))){images.push_back(old);continue;}}
            std::ifstream input(file,std::ios::binary);char buffer[40];input.read(buffer,sizeof buffer);std::string bytes(buffer,static_cast<size_t>(input.gcount()));const bool encrypted=file.extension()!=".png";std::string error;uint32_t width=0,height=0;try{if(encrypted)bytes=codec(bytes,key,false);std::tie(width,height)=dimensions(bytes);}catch(const std::exception& e){error=e.what();}
            images.push_back({{"id",id(name)},{"file",name},{"container",""},{"objectId",""},{"kind","RPG PNG"},{"name",utf8path::pathUtf8(file.filename())},{"width",width},{"height",height},{"sourceFile",error.empty()?name:""},{"sourceHash",hash},{"renderedFile",""},{"renderedHash",""},{"selected",false},{"ocrCompleted",false},{"completed",false},{"error",error},{"regions",Json::array()},{"encrypted",encrypted}});
        }
        if(progress)progress(completed,files.size(),"保存图片索引");
        Json project={{"version",1},{"scanRevision",5},{"root",utf8path::pathUtf8(game)},{"folder",utf8path::pathUtf8(folder(game))},{"entries",Json::array()},{"images",images},{"fonts",Json::array()},{"warnings",Json::array()},{"hashes",Json::object()}};saveJson(folder(game)/"project.json",project);catalogs_[game]=project;indexes_.erase(game);return project;
    }
    std::string preview(const Path& game,const std::string& imageId,bool translated,bool retain=true){std::lock_guard lock(mutex_);validId(imageId);auto image=imageRow(game,imageId);if(translated){if(image.value("renderedFile","").empty())throw std::runtime_error("尚未生成译图");return gamefiles::read(folder(game)/"rendered"/(imageId+".png"));}const auto cache=originalCache(game,image);if(std::filesystem::is_regular_file(cache))return gamefiles::read(cache);auto file=game/gamefiles::relative(image.at("file"));if(stamp(file)!=image.at("sourceHash").get<std::string>())throw std::runtime_error("原图片已改变，请重新扫描");auto bytes=gamefiles::read(file);if(image.value("encrypted",false)){auto key=Json::parse(gamefiles::read(game/data(game)/"System.json")).value("encryptionKey","");bytes=codec(bytes,key,false);}dimensions(bytes);if(retain)gamefiles::write(cache,bytes);return bytes;}
    Json saveImage(const Path& game,const Json& edit){std::lock_guard lock(mutex_);const auto imageId=edit.at("id").get<std::string>();validId(imageId);auto image=imageRow(game,imageId);for(auto key:{"selected","selectionManual","screening","ocrCompleted","completed","error","regions","renderedKind"})if(edit.contains(key))image[key]=edit[key];saveJson(folder(game)/"state"/(imageId+".json"),image);states(game)[imageId]=image;return image;}
    Json saveMany(const Path& game,const Json& edits){std::lock_guard lock(mutex_);Json result=Json::array();for(auto& edit:edits)result.push_back(saveImage(game,edit));return result;}
    Json render(const Path& game,const std::string& imageId,const std::string& bytes){std::lock_guard lock(mutex_);validId(imageId);auto image=imageRow(game,imageId);auto [width,height]=dimensions(bytes);if(width!=image.at("width").get<uint32_t>()||height!=image.at("height").get<uint32_t>())throw std::runtime_error("译图尺寸必须与原图一致");if(!std::filesystem::is_regular_file(originalCache(game,image)))preview(game,imageId,false);auto name="rendered/"+imageId+".png";gamefiles::write(folder(game)/name,bytes);image["renderedFile"]=name;image["renderedHash"]=stamp(folder(game)/name);saveJson(folder(game)/"state"/(imageId+".json"),image);states(game)[imageId]=image;return {{"path",name},{"hash",image["renderedHash"]}};}
    Json apply(const Path& game,bool automatic){std::lock_guard lock(mutex_);auto project=load(game);std::map<Path,std::string> files;const auto key=Json::parse(gamefiles::read(game/data(game)/"System.json")).value("encryptionKey","");
        for(auto& image:project["images"]){if(!image.value("selected",false)||!image.value("completed",false)||image.value("renderedFile","").empty())continue;const auto imageId=image.at("id").get<std::string>();auto target=game/gamefiles::relative(image.at("file"));auto current=gamefiles::read(target);const auto installed=folder(game)/"installed"/(imageId+".bin");if(std::filesystem::is_regular_file(installed)?current!=gamefiles::read(installed):stamp(target)!=image.at("sourceHash").get<std::string>())throw std::runtime_error("游戏图片已改变，请检查后重新扫描："+image.at("name").get<std::string>());if(!std::filesystem::is_regular_file(originalCache(game,image)))preview(game,imageId,false);auto bytes=gamefiles::read(folder(game)/"rendered"/(imageId+".png"));if(image.value("encrypted",false))bytes=codec(bytes,key,true);if(bytes!=current)files[gamefiles::relative(image.at("file"))]=bytes;}
        if(files.empty())throw std::runtime_error("没有可应用的新译图，请先识别、翻译或替换译图");const auto backup=gamefiles::apply(game,files);for(auto& image:project["images"]){auto name=gamefiles::relative(image.at("file"));if(files.contains(name))gamefiles::write(folder(game)/"installed"/(image.at("id").get<std::string>()+".bin"),files[name]);}if(!automatic)std::filesystem::remove_all(backup);return {{"files",files.size()},{"backupPath",automatic?utf8path::pathUtf8(backup):""}};
    }
    Json uninstall(const Path& game){
        std::lock_guard lock(mutex_);auto project=load(game);
        if(project.is_null())throw std::runtime_error("尚未扫描游戏图片");
        std::map<Path,std::string> files;
        const auto key=Json::parse(gamefiles::read(game/data(game)/"System.json")).value("encryptionKey","");
        for(auto& image:project["images"]){
            const auto imageId=image.at("id").get<std::string>();
            const auto installed=folder(game)/"installed"/(imageId+".bin");
            if(!std::filesystem::is_regular_file(installed))continue;
            auto name=gamefiles::relative(image.at("file"));auto current=gamefiles::read(game/name);
            auto original=gamefiles::read(originalCache(game,image));
            if(image.value("encrypted",false))original=codec(original,key,true);
            if(current==original)continue;
            if(current!=gamefiles::read(installed))throw std::runtime_error("游戏图片已被修改，无法卸载："+image.at("name").get<std::string>());
            files[name]=std::move(original);
        }
        if(files.empty())throw std::runtime_error("没有已应用的译图可卸载");
        const auto backup=gamefiles::apply(game,files);
        // Keep the restored bytes as the last known installation state for safe reapplication.
        for(auto& image:project["images"]){auto name=gamefiles::relative(image.at("file"));if(files.contains(name))gamefiles::write(folder(game)/"installed"/(image.at("id").get<std::string>()+".bin"),files.at(name));}
        return {{"files",files.size()},{"backupPath",utf8path::pathUtf8(backup)}};
    }

};
