#pragma once
#include "GameFileOps.h"
#include "GameResourceBackup.h"
#include "GameImageStateStore.h"
#include <memory>
#include <set>
#include <mutex>
#include <sstream>
#include <functional>
#include <atomic>

// MV/MZ and unpacked WOLF PNG file adapter. OCR, translation, rendering and preview UI stay in the existing image workbench.
class RpgImageProject {
    using Path=std::filesystem::path;using Json=nlohmann::json;
    std::recursive_mutex mutex_;
    std::atomic<uint64_t> readEpoch_{0};
    void checkRead(uint64_t epoch)const{if(readEpoch_.load()!=epoch)throw std::runtime_error("图片工程读取已中止");}
    std::map<Path,Json> catalogs_;
    std::map<Path,std::unique_ptr<GameImageStateStore>> stores_;
    std::set<Path> restored_;
    std::map<Path,std::map<std::string,size_t>> indexes_;
    struct ImageKey { std::string revision; std::string value; };
    std::map<Path,ImageKey> imageKeys_;
    GameImageStateStore& store(const Path& game){auto& value=stores_[game];if(!value)value=std::make_unique<GameImageStateStore>(folder(game));return *value;}
    const Json& catalog(const Path& game,std::optional<uint64_t> epoch={},const std::function<void(size_t,size_t,const std::string&)>& progress={}){
        const auto token=epoch.value_or(readEpoch_.load());checkRead(token);
        if(!catalogs_.contains(game)){if(progress)progress(0,0,"正在读取图片索引");catalogs_[game]=Json::parse(gamefiles::read(folder(game)/"project.json"));}
        if(!restored_.contains(game)){
            auto values=store(game).load([&]{checkRead(token);},[&](size_t count,const std::string& detail){if(progress)progress(count,0,detail);});
            auto& images=catalogs_.at(game).at("images");size_t count=0;
            for(auto& image:images){checkRead(token);auto saved=values.find(image.at("id").get<std::string>());if(saved!=values.end()&&saved->second.at("sourceHash")==image.at("sourceHash"))image=std::move(saved->second);else if(!image.value("ocrCompleted",false)&&!image.value("completed",false))image["selected"]=false;if(progress&&++count%512==0)progress(count,images.size(),"正在恢复图片索引");}
            restored_.insert(game);
        }
        checkRead(token);return catalogs_.at(game);
    }
    size_t imageIndex(const Path& game,const std::string& imageId){const auto& project=catalog(game);if(!indexes_.contains(game)){size_t index=0;for(auto& entry:project.at("images"))indexes_[game][entry.at("id").get<std::string>()]=index++;}auto found=indexes_[game].find(imageId);if(found==indexes_[game].end())throw std::runtime_error("未找到图片，请重新扫描");return found->second;}
    Json imageRow(const Path& game,const std::string& imageId){const auto index=imageIndex(game,imageId);return catalogs_.at(game).at("images").at(index);}
    void publish(const Path& game,const Json& rows){store(game).save(rows);for(const auto& image:rows){const auto index=imageIndex(game,image.at("id").get<std::string>());catalogs_.at(game).at("images").at(index)=image;}}
    static Path folder(const Path& game){return game/"LLMChat-JSON"/"images";}
    static Path data(const Path& game){if(std::filesystem::is_regular_file(game/"www/data/System.json"))return "www/data";if(std::filesystem::is_regular_file(game/"data/System.json"))return "data";if(std::filesystem::is_regular_file(game/"Data/BasicData/Game.dat")||std::filesystem::is_regular_file(game/"Data/BasicData.wolf")||std::filesystem::is_regular_file(game/"Data.wolf"))return "Data";throw std::runtime_error("请选择支持的 RPG Maker 或 WOLF 游戏");}
    static std::string stamp(const Path& file){return std::to_string(std::filesystem::file_size(file))+"-"+std::to_string(std::filesystem::last_write_time(file).time_since_epoch().count());}
    const std::string& imageKey(const Path& systemFile) {
        auto revision = stamp(systemFile);
        auto& cached = imageKeys_[systemFile];
        if (cached.revision != revision) {
            auto key = Json::parse(gamefiles::read(systemFile)).value("encryptionKey", "");
            cached = {std::move(revision), std::move(key)};
        }
        return cached.value;
    }
    static std::string id(const std::string& name){uint64_t value=14695981039346656037ull;for(unsigned char byte:name){value^=byte;value*=1099511628211ull;}std::ostringstream out;out<<std::hex<<value;return out.str();}
    static std::string codec(std::string bytes,const std::string& key,bool encrypt){const std::string header("RPGMV\0\0\0\0\3\1\0\0\0\0\0",16);if(key.size()!=32)throw std::runtime_error("System.json 缺少有效图片密钥");if(!encrypt){if(bytes.size()<32||bytes.substr(0,16)!=header)throw std::runtime_error("不是标准 MV/MZ 加密图片");bytes.erase(0,16);}if(bytes.size()<16)throw std::runtime_error("图片文件过短");for(size_t i=0;i<16;++i){auto hex=key.substr(i*2,2);if(hex.find_first_not_of("0123456789abcdefABCDEF")!=std::string::npos)throw std::runtime_error("图片密钥无效");bytes[i]^=static_cast<char>(std::stoi(hex,nullptr,16));}return encrypt?header+bytes:bytes;}
    static std::pair<uint32_t,uint32_t> dimensions(const std::string& bytes){if(bytes.size()<24||bytes.substr(0,8)!=std::string("\x89PNG\r\n\x1a\n",8))throw std::runtime_error("图片不是有效 PNG");auto n=[&](int at){uint32_t v=0;for(int i=0;i<4;++i)v=(v<<8)|static_cast<unsigned char>(bytes[at+i]);return v;};auto width=n(16),height=n(20);if(!width||!height)throw std::runtime_error("PNG 尺寸无效");return {width,height};}
    static void saveJson(const Path& path,const Json& value){std::string error;if(!atomicfile::writeText(path,value.dump(),&error))throw std::runtime_error(error);}
    static Json row(const Json& project,const std::string& imageId){for(auto& image:project.at("images"))if(image.at("id").get<std::string>()==imageId)return image;throw std::runtime_error("未找到图片，请重新扫描");}
    static Path originalCache(const Path& game,const Json& image){return folder(game)/"original"/(image.at("id").get<std::string>()+"-"+image.at("sourceHash").get<std::string>()+".png");}
    static void validId(const std::string& imageId){if(imageId.empty()||imageId.find_first_not_of("0123456789abcdef")!=std::string::npos)throw std::runtime_error("图片编号无效");}
    static Path installedImage(const Path& game,const std::string& imageId,bool mosaic){
        return folder(game)/(mosaic?"mosaic-installed":"installed")/(imageId+".bin");
    }
    static bool matchesInstalled(const Path& installed,const std::string& bytes){
        return std::filesystem::is_regular_file(installed)&&gamefiles::read(installed)==bytes;
    }
    static Path mosaicImage(const Path& game,const Json& image){
        const auto imageId=image.at("id").get<std::string>();
        const auto revision=image.at("sourceHash").get<std::string>();
        validId(imageId);
        if(revision.empty()||revision.find_first_not_of("0123456789-")!=std::string::npos)
            throw std::runtime_error("原图版本无效，请重新扫描");
        return folder(game)/"mosaic"/(imageId+"-"+revision+".png");
    }
    static std::string storedOriginal(const Path& game,const Json& image,const std::string& key){
        auto bytes=gamefiles::read(originalCache(game,image));
        return image.value("encrypted",false)?codec(std::move(bytes),key,true):bytes;
    }
public:
    Json currentSources(const Path& game, const Json& sources) {
        if (!sources.is_object() || sources.size() > 512) throw std::runtime_error("图片缓存校验批次无效");
        std::lock_guard lock(mutex_);
        const auto& images = catalog(game).at("images");
        Json current = Json::array();
        for (const auto& [id, hash] : sources.items()) {
            validId(id);
            const auto& image = images.at(imageIndex(game, id));
            if (!hash.is_string() || hash != image.at("sourceHash")) continue;
            const auto file = game / gamefiles::relative(image.at("file"));
            std::error_code error;
            if (!std::filesystem::is_regular_file(file, error)) continue;
            try {
                if (stamp(file) == hash.get_ref<const std::string&>()) current.push_back(id);
            } catch (const std::filesystem::filesystem_error&) {
                // A missing or changed image goes through the normal read and error path.
            }
        }
        return current;
    }
    Json info(const Path& game){data(game);return {{"exists",std::filesystem::is_regular_file(folder(game)/"project.json")},{"folder",utf8path::pathUtf8(folder(game))}};}
    Json stopReading(const Path& game){readEpoch_.fetch_add(1);std::lock_guard lock(mutex_);data(game);catalogs_.erase(game);stores_.erase(game);restored_.erase(game);indexes_.erase(game);return {{"cleared",true}};}
    Json load(const Path& game,const std::function<void(size_t,size_t,const std::string&)>& progress={}){const auto epoch=readEpoch_.load();std::lock_guard lock(mutex_);checkRead(epoch);data(game);const auto path=folder(game)/"project.json";if(!std::filesystem::is_regular_file(path))return nullptr;auto result=catalog(game,epoch,progress);checkRead(epoch);if(progress)progress(result.at("images").size(),result.at("images").size(),"图片工程读取完成");return result;}
    Json scan(const Path& game,const std::function<void(size_t,size_t,const std::string&)>& progress={}){std::lock_guard lock(mutex_);const auto scanEpoch=readEpoch_.load();checkRead(scanEpoch);if(progress)progress(0,0,"读取图片工程");auto db=data(game);auto previous=load(game);
        if(!previous.is_null()) {
            for(auto& image:previous["images"]) { image["regions"]=Json::array(); image["ocrCompleted"]=false; image["completed"]=false; image["selected"]=false; image["selectionManual"]=false; image["error"]=""; image.erase("screening"); image["renderedFile"]=""; image["renderedHash"]=""; image.erase("renderedKind"); }
            store(game).save(previous["images"]); saveJson(folder(game)/"project.json",previous); catalogs_[game]=previous;
            for(const auto& image:previous["images"]) { const auto imageId=image.at("id").get<std::string>(); validId(imageId); std::filesystem::remove(folder(game)/"rendered"/(imageId+".png")); }
        }
        Json byFile=Json::object();if(!previous.is_null())for(auto& image:previous["images"])byFile[image.at("file").get<std::string>()]=image;
        Json images=Json::array();
        std::vector<Path> files;
        size_t visited=0;
        if(progress) progress(0,0,"查找图片文件");
        const auto imageRoot=gameresourcebackup::imageRoot(game,db);
        if(!std::filesystem::is_directory(imageRoot)) throw std::runtime_error("未找到图片目录；WOLF 封包图片需先解包到 Data");
        for(const auto& entry:std::filesystem::recursive_directory_iterator(imageRoot)) {
            if(!entry.is_regular_file()) continue;
            if(gameresourcebackup::isImage(entry.path())) files.push_back(entry.path());
            if(progress&&++visited%128==0) progress(0,0,"查找图片文件 · 已找到 "+std::to_string(files.size())+" 张");
        }
        std::sort(files.begin(),files.end());
        const auto key=db==Path("Data")?std::string():imageKey(game/db/"System.json");
        size_t completed=0;if(progress)progress(0,files.size(),"读取图片信息");
        for(auto& file:files){checkRead(scanEpoch);if(progress&&(completed%16==0))progress(completed,files.size(),"读取图片信息："+utf8path::pathUtf8(file.filename()));++completed;const auto name=gamefiles::key(std::filesystem::relative(file,game));auto hash=stamp(file);if(byFile.contains(name)){
            auto old=byFile[name];
            const auto oldId=old.at("id").get<std::string>();
            if(old.at("sourceHash").get<std::string>()==hash){images.push_back(old);continue;}
            const auto translation=installedImage(game,oldId,false);
            const auto mosaic=installedImage(game,oldId,true);
            if(std::filesystem::is_regular_file(translation)||std::filesystem::is_regular_file(mosaic)){
                const auto current=gamefiles::read(file);
                if(matchesInstalled(translation,current)||matchesInstalled(mosaic,current)){images.push_back(old);continue;}
            }
        }
            std::ifstream input(file,std::ios::binary);char buffer[40];input.read(buffer,sizeof buffer);std::string bytes(buffer,static_cast<size_t>(input.gcount()));const bool encrypted=gameresourcebackup::imageExtension(file)!=".png";std::string error;uint32_t width=0,height=0;try{if(encrypted)bytes=codec(bytes,key,false);std::tie(width,height)=dimensions(bytes);}catch(const std::exception& e){error=e.what();}
            images.push_back({{"id",id(name)},{"file",name},{"container",""},{"objectId",""},{"kind",db==Path("Data")?"WOLF PNG":"RPG PNG"},{"name",utf8path::pathUtf8(file.filename())},{"width",width},{"height",height},{"sourceFile",error.empty()?name:""},{"sourceHash",hash},{"renderedFile",""},{"renderedHash",""},{"selected",false},{"ocrCompleted",false},{"completed",false},{"error",error},{"regions",Json::array()},{"encrypted",encrypted}});
        }
        checkRead(scanEpoch);if(progress)progress(completed,files.size(),"保存图片索引");
        Json project={{"version",1},{"scanRevision",5},{"root",utf8path::pathUtf8(game)},{"folder",utf8path::pathUtf8(folder(game))},{"entries",Json::array()},{"images",images},{"fonts",Json::array()},{"warnings",Json::array()},{"hashes",Json::object()}};saveJson(folder(game)/"project.json",project);catalogs_[game]=project;restored_.insert(game);indexes_.erase(game);return project;
    }
    std::string preview(const Path& game,const std::string& imageId,bool translated){std::lock_guard lock(mutex_);validId(imageId);auto image=imageRow(game,imageId);if(translated){if(image.value("renderedFile","").empty())throw std::runtime_error("尚未生成译图");return gamefiles::read(folder(game)/"rendered"/(imageId+".png"));}const auto cache=originalCache(game,image);if(std::filesystem::is_regular_file(cache))return gamefiles::read(cache);auto file=game/gamefiles::relative(image.at("file"));if(stamp(file)!=image.at("sourceHash").get<std::string>())throw std::runtime_error("原图片已改变，请重新扫描");auto bytes=gamefiles::read(file);if(image.value("encrypted",false)){bytes=codec(std::move(bytes),imageKey(game/data(game)/"System.json"),false);}dimensions(bytes);return bytes;}
    Json saveImage(const Path& game,const Json& edit){return saveMany(game,Json::array({edit})).at(0);}
    Json saveMany(const Path& game,const Json& edits){
        std::lock_guard lock(mutex_);
        Json result=Json::array();
        std::vector<Path> clearedFiles;
        for(const auto& edit:edits){
            const auto imageId=edit.at("id").get<std::string>();
            validId(imageId);
            auto image=imageRow(game,imageId);
            for(auto key:{"selected","selectionManual","screening","ocrCompleted","completed","error","regions","renderedKind","renderedTarget","noTranslationNeeded"})
                if(edit.contains(key))image[key]=edit[key];
            if(edit.value("clearRendered",false)){
                image["renderedFile"]="";
                image["renderedHash"]="";
                image.erase("renderedKind");
                image["completed"]=edit.value("noTranslationNeeded",false);
                clearedFiles.push_back(folder(game)/"rendered"/(imageId+".png"));
            }
            result.push_back(std::move(image));
        }
        publish(game,result);
        for(const auto& path:clearedFiles)std::filesystem::remove(path);
        return result;
    }
    Json render(const Path& game,const std::string& imageId,const std::string& bytes){std::lock_guard lock(mutex_);validId(imageId);auto image=imageRow(game,imageId);auto [width,height]=dimensions(bytes);if(width!=image.at("width").get<uint32_t>()||height!=image.at("height").get<uint32_t>())throw std::runtime_error("译图尺寸必须与原图一致");if(!std::filesystem::is_regular_file(originalCache(game,image)) && stamp(game/gamefiles::relative(image.at("file")))!=image.at("sourceHash").get<std::string>())throw std::runtime_error("原图片已改变，请重新扫描");auto name="rendered/"+imageId+".png";gamefiles::write(folder(game)/name,bytes);image["renderedFile"]=name;image["renderedHash"]=stamp(folder(game)/name);publish(game,Json::array({image}));return {{"path",name},{"hash",image["renderedHash"]}};}
    std::string previewMosaic(const Path& game,const std::string& imageId){
        std::lock_guard lock(mutex_);
        validId(imageId);
        return gamefiles::read(mosaicImage(game,imageRow(game,imageId)));
    }
    Json saveMosaic(const Path& game,const std::string& imageId,const std::string& revision,const std::string& bytes){
        std::lock_guard lock(mutex_);
        if(data(game)==Path("Data"))throw std::runtime_error("图片去码支持 RPG Maker MV/MZ");
        validId(imageId);
        const auto image=imageRow(game,imageId);
        if(revision!=image.at("sourceHash").get<std::string>())throw std::runtime_error("原图已变更，请重新生成去码候选");
        const auto [width,height]=dimensions(bytes);
        if(width!=image.at("width").get<uint32_t>()||height!=image.at("height").get<uint32_t>())
            throw std::runtime_error("去码图尺寸必须与原图一致");
        std::string error;
        if(!atomicfile::writeText(mosaicImage(game,image),bytes,&error))throw std::runtime_error("无法保存去码图："+error);
        return {{"saved",true}};
    }
    Json apply(const Path& game,bool automatic,const Json& scopes=Json::array({"images"}),const Json& selectedIds=nullptr,bool mosaic=false){
        std::lock_guard lock(mutex_);
        if(!std::filesystem::is_regular_file(folder(game)/"project.json")) throw std::runtime_error("尚未扫描游戏图片");
        const auto dataPath=data(game);
        if(mosaic&&dataPath==Path("Data"))throw std::runtime_error("图片去码支持 RPG Maker MV/MZ");
        const auto key=dataPath==Path("Data")?std::string():imageKey(game/dataPath/"System.json");
        const auto ids=selectedIds.is_null()?std::set<std::string>{}:selectedIds.get<std::set<std::string>>();
        if(mosaic&&ids.empty())throw std::runtime_error("请选择本组已确认的去码图");
        if(mosaic)for(const auto& imageId:ids){validId(imageId);imageIndex(game,imageId);}
        std::vector<std::pair<Path,Path>> installedFiles;
        gameresourcebackup::Snapshot snapshot;
        size_t unchanged=0;
        const auto receipt=gamefiles::applyPrepared(game,[&](const auto& stage){
            for(const auto& image:catalog(game).at("images")){
                if(!mosaic&&(!image.value("selected",false)||!image.value("completed",false)||image.value("renderedFile","").empty())) continue;
                const auto imageId=image.at("id").get<std::string>();
                if(!selectedIds.is_null()&&!ids.contains(imageId)) continue;
                const auto name=gamefiles::relative(image.at("file"));
                const auto target=game/name;
                const auto installed=installedImage(game,imageId,mosaic);
                const bool wasInstalled=std::filesystem::is_regular_file(installed);
                const auto sourceHash=image.at("sourceHash").get<std::string>();
                const bool encrypted=image.value("encrypted",false);
                const auto current=gamefiles::read(target);
                const bool otherApplied=matchesInstalled(installedImage(game,imageId,!mosaic),current);
                if(otherApplied&&current!=storedOriginal(game,image,key))
                    throw std::runtime_error("此图片已应用"+std::string(mosaic?"译图":"去码图")+"，请先恢复该图： "+image.at("name").get<std::string>());
                if(!otherApplied&&(wasInstalled?current!=gamefiles::read(installed):stamp(target)!=sourceHash))
                    throw std::runtime_error("游戏图片已改变，请检查后重新扫描："+image.at("name").get<std::string>());
                auto bytes=gamefiles::read(mosaic?mosaicImage(game,image):folder(game)/"rendered"/(imageId+".png"));
                if(encrypted) bytes=codec(std::move(bytes),key,true);
                if(bytes==current){++unchanged;continue;}
                const auto cache=originalCache(game,image);
                if(!std::filesystem::is_regular_file(cache)){
                    if(wasInstalled&&stamp(target)!=sourceHash)
                        throw std::runtime_error("缺少卸载所需的原图备份："+image.at("name").get<std::string>());
                    const auto decoded=encrypted?codec(current,key,false):std::string{};
                    const auto& original=encrypted?decoded:current;
                    dimensions(original);
                    std::string error;
                    if(!atomicfile::writeText(cache,original,&error))
                        throw std::runtime_error("无法保存原图备份："+image.at("name").get<std::string>()+" · "+error);
                }
                if(automatic&&!mosaic&&snapshot.path.empty()) snapshot=gameresourcebackup::snapshot(game,dataPath,scopes);
                stage(name,&bytes);
                installedFiles.emplace_back(name,installed);
            }
        });
        if(receipt.empty()){
            if(unchanged) return {{"files",0},{"unchanged",unchanged},{"backupPath",""}};
            throw std::runtime_error(mosaic?"没有可应用的去码图":"没有可应用的译图，请先识别、翻译或替换译图");
        }
        for(const auto& [name,installed]:installedFiles) gamefiles::copyResource(game/name,installed);
        if(!automatic&&!mosaic) std::filesystem::remove_all(receipt);
        return {{"files",installedFiles.size()},{"unchanged",unchanged},{"backupPath",utf8path::pathUtf8(mosaic?receipt:snapshot.path)},
            {"backupDetail",automatic&&!mosaic?snapshot.summary():""}};
    }

    Json uninstall(const Path& game,bool mosaic=false,const Json& selectedIds=nullptr){
        std::lock_guard lock(mutex_);
        if(!std::filesystem::is_regular_file(folder(game)/"project.json")) throw std::runtime_error("尚未扫描游戏图片");
        const auto dataPath=data(game);
        if(mosaic&&dataPath==Path("Data"))throw std::runtime_error("图片去码支持 RPG Maker MV/MZ");
        const auto key=dataPath==Path("Data")?std::string():imageKey(game/dataPath/"System.json");
        const auto ids=selectedIds.is_null()?std::set<std::string>{}:selectedIds.get<std::set<std::string>>();
        if(mosaic&&ids.empty())throw std::runtime_error("请选择本组需要恢复的图片");
        std::vector<std::pair<Path,Path>> installedFiles;
        const auto receipt=gamefiles::applyPrepared(game,[&](const auto& stage){
            for(const auto& image:catalog(game).at("images")){
                const auto imageId=image.at("id").get<std::string>();
                if(mosaic&&!ids.contains(imageId))continue;
                const auto installed=installedImage(game,imageId,mosaic);
                if(!std::filesystem::is_regular_file(installed)) continue;
                const auto name=gamefiles::relative(image.at("file"));
                const auto current=gamefiles::read(game/name);
                const auto original=storedOriginal(game,image,key);
                if(current==original) continue;
                if(matchesInstalled(installedImage(game,imageId,!mosaic),current))continue;
                if(current!=gamefiles::read(installed)) throw std::runtime_error("游戏图片已被修改，无法卸载："+image.at("name").get<std::string>());
                stage(name,&original);
                installedFiles.emplace_back(name,installed);
            }
        });
        if(receipt.empty()) throw std::runtime_error(mosaic?"本组没有已应用的去码图":"没有已应用的译图可卸载");
        for(const auto& [name,installed]:installedFiles) gamefiles::copyResource(game/name,installed);
        return {{"files",installedFiles.size()},{"backupPath",utf8path::pathUtf8(receipt)}};
    }
};
