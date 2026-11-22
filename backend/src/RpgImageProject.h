#pragma once
#include "GameFileOps.h"
#include "WolfArchive.h"
#include "GameResourceBackup.h"
#include "GameImageStateStore.h"
#include "RpgImageComposition.h"
#include <memory>
#include <chrono>
#include <set>
#include <mutex>
#include <sstream>
#include <functional>
#include <atomic>
#include <unordered_map>

namespace gameimageexport { class PackageGenerator; }
namespace gameimageexport::selection { class SnapshotBuilder; }

// MV/MZ and WOLF image adapter. OCR, translation, rendering and preview UI stay in the existing image workbench.
class RpgImageProject {
    friend class gameimageexport::PackageGenerator;
    friend class gameimageexport::selection::SnapshotBuilder;
    using Path=std::filesystem::path;using Json=nlohmann::json;
    Path wolfTools_;
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
    static Path data(const Path& game){if(std::filesystem::is_regular_file(game/"www/data/System.json"))return "www/data";if(std::filesystem::is_regular_file(game/"data/System.json"))return "data";if(std::filesystem::is_regular_file(game/"Data/BasicData/Game.dat")||std::filesystem::is_regular_file(game/"Data/BasicData.wolf")||std::filesystem::is_regular_file(game/"Data.wolf"))return "Data";if(unreal::identified(game))return {};throw std::runtime_error("请选择支持图片翻译的游戏目录");}
    static std::string stamp(const Path& file){return std::to_string(std::filesystem::file_size(file))+"-"+std::to_string(std::filesystem::last_write_time(file).time_since_epoch().count());}
    static uint64_t nameHash(const std::string& value) {
        uint64_t hash = 14695981039346656037ull;
        for (unsigned char byte : value) { hash ^= byte; hash *= 1099511628211ull; }
        return hash;
    }
    static std::string packedStamp(const std::string& revision, const std::string& fileStamp) {
        return std::to_string(nameHash(revision+"-"+fileStamp));
    }
    static std::string sourceStamp(const Path& file,const Json& image) {
        const auto stampValue = stamp(file);
        return image.contains("archiveRevision") ? packedStamp(image.at("archiveRevision").get_ref<const std::string&>(),stampValue) : stampValue;
    }
    const std::string& imageKey(const Path& systemFile) {
        auto revision = stamp(systemFile);
        auto& cached = imageKeys_[systemFile];
        if (cached.revision != revision) {
            auto key = Json::parse(gamefiles::read(systemFile)).value("encryptionKey", "");
            cached = {std::move(revision), std::move(key)};
        }
        return cached.value;
    }
    static std::string id(const std::string& name){std::ostringstream out;out<<std::hex<<nameHash(name);return out.str();}
    static std::string codec(std::string bytes,const std::string& key,bool encrypt){const std::string header("RPGMV\0\0\0\0\3\1\0\0\0\0\0",16);if(key.size()!=32)throw std::runtime_error("System.json 缺少有效图片密钥");if(!encrypt){if(bytes.size()<32||bytes.substr(0,16)!=header)throw std::runtime_error("不是标准 MV/MZ 加密图片");bytes.erase(0,16);}if(bytes.size()<16)throw std::runtime_error("图片文件过短");for(size_t i=0;i<16;++i){auto hex=key.substr(i*2,2);if(hex.find_first_not_of("0123456789abcdefABCDEF")!=std::string::npos)throw std::runtime_error("图片密钥无效");bytes[i]^=static_cast<char>(std::stoi(hex,nullptr,16));}return encrypt?header+bytes:bytes;}
    static std::pair<uint32_t,uint32_t> dimensions(const std::string& bytes){if(bytes.size()<24||bytes.substr(0,8)!=std::string("\x89PNG\r\n\x1a\n",8))throw std::runtime_error("图片不是有效 PNG");auto n=[&](int at){uint32_t v=0;for(int i=0;i<4;++i)v=(v<<8)|static_cast<unsigned char>(bytes[at+i]);return v;};auto width=n(16),height=n(20);if(!width||!height)throw std::runtime_error("PNG 尺寸无效");return {width,height};}
    static void saveJson(const Path& path,const Json& value){std::string error;if(!atomicfile::writeText(path,value.dump(),&error))throw std::runtime_error(error);}
    static Json row(const Json& project,const std::string& imageId){for(auto& image:project.at("images"))if(image.at("id").get<std::string>()==imageId)return image;throw std::runtime_error("未找到图片，请重新扫描");}
    static Path originalCache(const Path& game,const Json& image){return folder(game)/"original"/(image.at("id").get<std::string>()+"-"+image.at("sourceHash").get<std::string>()+".png");}
    static void validId(const std::string& imageId){if(imageId.empty()||imageId.find_first_not_of("0123456789abcdef")!=std::string::npos)throw std::runtime_error("图片编号无效");}
    static Path installedImage(const Path& game,const std::string& imageId,bool mosaic){
        return folder(game)/(mosaic?"mosaic-installed":"installed")/(imageId+".bin");
    }
    static Path composedImage(const Path& game,const std::string& imageId){
        return folder(game)/"composed-installed"/(imageId+".bin");
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
    static std::string imageBytes(const Json& image,std::string bytes,const std::string& key,bool encrypt){
        return image.value("encrypted",false)?codec(std::move(bytes),key,encrypt):bytes;
    }
    struct AppliedLayers {
        std::optional<std::string> translation;
        std::optional<std::string> mosaic;
        std::optional<std::string>& layer(bool isMosaic){return isMosaic?mosaic:translation;}
        bool composed() const{return translation&&mosaic;}
    };
    struct ImageInstallation {
        std::string original;
        std::string originalFile;
        bool cached=false;
        AppliedLayers layers;
    };
    static ImageInstallation readInstallation(const Path& game,const Json& image,const Path& target,
            const std::string& current,const std::string& key){
        const auto imageId=image.at("id").get<std::string>();
        const auto cache=originalCache(game,image);
        ImageInstallation result;
        result.cached=std::filesystem::is_regular_file(cache);
        if(!result.cached){
            if(sourceStamp(target,image)!=image.at("sourceHash").get<std::string>())
                throw std::runtime_error("游戏图片已改变或缺少原图备份："+image.at("name").get<std::string>());
            result.original=imageBytes(image,current,key,false);
            dimensions(result.original);
            result.originalFile=current;
            return result;
        }
        result.original=gamefiles::read(cache);
        result.originalFile=imageBytes(image,result.original,key,true);
        const auto readLayer=[&](bool isMosaic)->std::optional<std::string>{
            const auto path=installedImage(game,imageId,isMosaic);
            if(!std::filesystem::is_regular_file(path))return std::nullopt;
            auto bytes=gamefiles::read(path);
            if(bytes==result.originalFile)return std::nullopt;
            return bytes;
        };
        auto translation=readLayer(false);
        auto mosaic=readLayer(true);
        if(translation&&mosaic&&matchesInstalled(composedImage(game,imageId),current)){
            result.layers={std::move(translation),std::move(mosaic)};
        }else if(current!=result.originalFile){
            if(translation&&*translation==current)result.layers.translation=std::move(translation);
            else if(mosaic&&*mosaic==current)result.layers.mosaic=std::move(mosaic);
            else throw std::runtime_error("游戏图片已被其他操作修改："+image.at("name").get<std::string>());
        }
        return result;
    }
    template<class Stage>
    static void stageInstallation(const Stage& stage,const Path& game,const Json& image,const Path& name,
            const ImageInstallation& installation,const std::string& current,const std::string& key){
        const auto imageId=image.at("id").get<std::string>();
        const auto& layers=installation.layers;
        std::string composed;
        const std::string* next=&installation.originalFile;
        if(layers.composed()){
            composed=imageBytes(image,rpgimagecompose::combine(installation.original,
                imageBytes(image,*layers.mosaic,key,false),imageBytes(image,*layers.translation,key,false)),key,true);
            next=&composed;
        }else if(layers.translation)next=&*layers.translation;
        else if(layers.mosaic)next=&*layers.mosaic;
        const auto stageMetadata=[&](const Path& path,const std::string* bytes){
            if(bytes?!matchesInstalled(path,*bytes):std::filesystem::is_regular_file(path))
                stage(path.lexically_relative(game),bytes);
        };
        if(!installation.cached)stageMetadata(originalCache(game,image),&installation.original);
        stageMetadata(installedImage(game,imageId,false),layers.translation?&*layers.translation:nullptr);
        stageMetadata(installedImage(game,imageId,true),layers.mosaic?&*layers.mosaic:nullptr);
        stageMetadata(composedImage(game,imageId),layers.composed()?next:nullptr);
        if (image.contains("archive") && !layers.translation && !layers.mosaic) {
            if (std::filesystem::is_regular_file(game/name)) stage(name,nullptr);
        } else if(*next!=current)stage(name,next);
    }
    static Path originalSource(const Path& game, const Json& image) {
        if (!image.contains("archive")) return game / gamefiles::relative(image.at("file"));
        const auto archive = game / gamefiles::relative(image.at("archive"));
        if (wolfarchive::revision(archive) != image.at("archiveRevision").get<std::string>())
            throw std::runtime_error("WOLF 封包已改变，请重新扫描：" + utf8path::pathUtf8(archive.filename()));
        return game / gamefiles::relative(image.at("sourceFile"));
    }
public:
    explicit RpgImageProject(Path wolfTools = {}) : wolfTools_(std::move(wolfTools)) {}
    Json currentSources(const Path& game, const Json& sources) {
        if (!sources.is_object() || sources.size() > 512) throw std::runtime_error("图片缓存校验批次无效");
        std::lock_guard lock(mutex_);
        const auto& images = catalog(game).at("images");
        Json current = Json::array();
        for (const auto& [id, hash] : sources.items()) {
            validId(id);
            const auto& image = images.at(imageIndex(game, id));
            if (!hash.is_string() || hash != image.at("sourceHash")) continue;
            Path file;
            try { file = originalSource(game,image); } catch (const std::exception&) { continue; }
            std::error_code error;
            if (!std::filesystem::is_regular_file(file, error)) continue;
            try {
                if (sourceStamp(file,image) == hash.get_ref<const std::string&>()) current.push_back(id);
            } catch (const std::filesystem::filesystem_error&) {
                // A missing or changed image goes through the normal read and error path.
            }
        }
        return current;
    }
    Json info(const Path& game){data(game);return {{"exists",std::filesystem::is_regular_file(folder(game)/"project.json")},{"folder",utf8path::pathUtf8(folder(game))}};}
    Json stopReading(const Path& game){readEpoch_.fetch_add(1);std::lock_guard lock(mutex_);data(game);catalogs_.erase(game);stores_.erase(game);restored_.erase(game);indexes_.erase(game);return {{"cleared",true}};}
    Json load(const Path& game,const std::function<void(size_t,size_t,const std::string&)>& progress={}){const auto epoch=readEpoch_.load();std::lock_guard lock(mutex_);checkRead(epoch);data(game);const auto path=folder(game)/"project.json";if(!std::filesystem::is_regular_file(path))return nullptr;auto result=catalog(game,epoch,progress);checkRead(epoch);if(progress)progress(result.at("images").size(),result.at("images").size(),"图片工程读取完成");return result;}
    Json scan(const Path& game,const std::function<void(size_t,size_t,const std::string&)>& progress={}){std::lock_guard lock(mutex_);using Clock = std::chrono::steady_clock; const auto started=Clock::now(); const auto scanEpoch=readEpoch_.load();checkRead(scanEpoch);if(progress)progress(0,0,"读取图片工程");auto db=data(game);auto previous=load(game); const auto loaded=Clock::now();
        struct Source { Path file; Path archive; std::string revision; std::string fileStamp; };
        std::map<Path, Source> files;
        std::vector<Path> archives;
        const bool wolf = db == Path("Data");
        const auto imageRoot = gameresourcebackup::imageRoot(game, db);
        if (progress) progress(0,0,"查找图片文件");
        if (db.empty()) {
            unreal::visitImages(game, [&](const Path& relative) {
                checkRead(scanEpoch);
                files.emplace(relative, Source{game / relative,{},{},{}});
                if (progress && files.size() % 128 == 0) progress(0,0,"查找 UE 图片 · 已找到 "+std::to_string(files.size())+" 张");
            });
        } else if (std::filesystem::is_directory(imageRoot)) {
            size_t visited=0;
            for (const auto& entry : std::filesystem::recursive_directory_iterator(imageRoot)) {
                checkRead(scanEpoch);
                if (!entry.is_regular_file()) continue;
                const auto& path = entry.path();
                const auto ext = gameresourcebackup::imageExtension(path);
                if (wolf && ext == ".wolf") archives.push_back(path);
                else if (wolf ? ext == ".png" : gameresourcebackup::isImage(path))
                    files.emplace(path.lexically_relative(game),Source{path,{},{},{}});
                if (progress && ++visited % 128 == 0) progress(0,0,"查找图片文件 · 已找到 "+std::to_string(files.size())+" 张");
            }
        } else if (!wolf || !std::filesystem::is_regular_file(game / "Data.wolf"))
            throw std::runtime_error("未找到图片目录");
        std::sort(archives.begin(), archives.end());
        if (wolf && std::filesystem::is_regular_file(game / "Data.wolf")) archives.push_back(game / "Data.wolf");
        for (const auto& archive : archives) {
            if (progress) progress(0,0,"读取 WOLF 封包：" + utf8path::pathUtf8(archive.filename()));
            const auto root = wolfarchive::unpack(game, archive, wolfTools_, [&]{ return readEpoch_.load() != scanEpoch; });
            auto logical = archive.lexically_relative(game);
            logical.replace_extension();
            const auto version = root.parent_path().filename().string();
            const auto png = Json::parse(gamefiles::read(root.parent_path() / "png.json"));
            for (const auto& entry : png) {
                checkRead(scanEpoch);
                const auto relative = gamefiles::relative(entry.at(0));
                files.try_emplace(logical / relative, Source{root / relative, archive, version, entry.at(1)});
            }
        }
        if(!previous.is_null()) {
            for(auto& image:previous["images"]) { image["regions"]=Json::array(); image["ocrCompleted"]=false; image["completed"]=false; image["selected"]=false; image["selectionManual"]=false; image["error"]=""; image.erase("screening"); image["renderedFile"]=""; image["renderedHash"]=""; image.erase("renderedKind"); }
            store(game).save(previous["images"]); saveJson(folder(game)/"project.json",previous); catalogs_[game]=previous;
            for(const auto& image:previous["images"]) { const auto imageId=image.at("id").get<std::string>(); validId(imageId); std::filesystem::remove(folder(game)/"rendered"/(imageId+".png")); }
        }
        std::unordered_map<std::string,size_t> byFile;
        if (!previous.is_null()) {
            const auto& oldImages=previous.at("images");
            byFile.reserve(oldImages.size());
            for (size_t i=0;i<oldImages.size();++i) byFile.emplace(oldImages[i].at("file").get<std::string>(),i);
        }
        const auto listed=Clock::now(); size_t reused=0;
        Json images=Json::array();
        const auto key=(db.empty() || wolf)?std::string():imageKey(game/db/"System.json");
        size_t completed=0;if(progress)progress(0,files.size(),"读取图片信息");
        for(const auto& [logical,source]:files){const auto& file=source.file;checkRead(scanEpoch);if(progress&&(completed%16==0))progress(completed,files.size(),"读取图片信息："+utf8path::pathUtf8(file.filename()));++completed;const auto name=gamefiles::key(logical);auto hash=source.archive.empty()?stamp(file):packedStamp(source.revision,source.fileStamp);if(auto found=byFile.find(name);found!=byFile.end()){
            auto& old=previous["images"][found->second];
            const auto oldId=old.at("id").get<std::string>();
            if(old.at("sourceHash").get<std::string>()==hash && old.value("archiveRevision","")==source.revision){++reused; images.push_back(std::move(old));continue;}
            const auto translation=installedImage(game,oldId,false);
            const auto mosaic=installedImage(game,oldId,true);
            const auto combined=composedImage(game,oldId);
            const auto original=originalCache(game,old);
            if(std::filesystem::is_regular_file(translation)||std::filesystem::is_regular_file(mosaic)||
               std::filesystem::is_regular_file(combined)||std::filesystem::is_regular_file(original)){
                const auto current=gamefiles::read(file);
                if(matchesInstalled(translation,current)||matchesInstalled(mosaic,current)||matchesInstalled(combined,current)||
                   (std::filesystem::is_regular_file(original)&&current==imageBytes(old,gamefiles::read(original),key,true))){
                    ++reused; images.push_back(std::move(old));
                    continue;
                }
            }
        }
            std::ifstream input(file,std::ios::binary);char buffer[40];input.read(buffer,sizeof buffer);std::string bytes(buffer,static_cast<size_t>(input.gcount()));const bool encrypted=gameresourcebackup::imageExtension(file)!=".png";std::string error;uint32_t width=0,height=0;try{if(encrypted)bytes=codec(bytes,key,false);std::tie(width,height)=dimensions(bytes);}catch(const std::exception& e){error=e.what();}
            images.push_back({{"id",id(name)},{"file",name},{"container",""},{"objectId",""},{"kind",db.empty()?"UE PNG":wolf?"WOLF PNG":"RPG PNG"},{"name",utf8path::pathUtf8(file.filename())},{"width",width},{"height",height},{"sourceFile",error.empty()?gamefiles::key(file.lexically_relative(game)):""},{"sourceHash",hash},{"renderedFile",""},{"renderedHash",""},{"selected",false},{"ocrCompleted",false},{"completed",false},{"error",error},{"regions",Json::array()},{"encrypted",encrypted}});
            if (!source.archive.empty()) {
                images.back()["archive"] = gamefiles::key(source.archive.lexically_relative(game));
                images.back()["archiveRevision"] = source.revision;
            }
        }
        checkRead(scanEpoch);if(progress)progress(completed,files.size(),"保存图片索引");
        const auto finished=Clock::now();
        auto ms=[](auto start,auto end){return std::chrono::duration_cast<std::chrono::milliseconds>(end-start).count();};
        Json timing={{"parsed",images.size()-reused},{"reused",reused},{"loadMs",ms(started,loaded)},
                     {"listMs",ms(loaded,listed)},{"parseMs",ms(listed,finished)}};
        Json project={{"imageScanTiming",timing},{"version",1},{"scanRevision",5},{"root",utf8path::pathUtf8(game)},{"folder",utf8path::pathUtf8(folder(game))},{"entries",Json::array()},{"images",std::move(images)},{"fonts",Json::array()},{"warnings",Json::array()},{"hashes",Json::object()}};saveJson(folder(game)/"project.json",project);catalogs_[game]=project;restored_.insert(game);indexes_.erase(game);return project;
    }
    std::string preview(const Path& game,const std::string& imageId,bool translated){std::lock_guard lock(mutex_);validId(imageId);auto image=imageRow(game,imageId);if(translated){if(image.value("renderedFile","").empty())throw std::runtime_error("尚未生成译图");return gamefiles::read(folder(game)/"rendered"/(imageId+".png"));}const auto cache=originalCache(game,image);if(std::filesystem::is_regular_file(cache))return gamefiles::read(cache);auto file=originalSource(game,image);if(sourceStamp(file,image)!=image.at("sourceHash").get<std::string>())throw std::runtime_error("原图片已改变，请重新扫描");auto bytes=gamefiles::read(file);if(image.value("encrypted",false)){bytes=codec(std::move(bytes),imageKey(game/data(game)/"System.json"),false);}dimensions(bytes);return bytes;}
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
    Json render(const Path& game,const std::string& imageId,const std::string& bytes){std::lock_guard lock(mutex_);validId(imageId);auto image=imageRow(game,imageId);auto [width,height]=dimensions(bytes);if(width!=image.at("width").get<uint32_t>()||height!=image.at("height").get<uint32_t>())throw std::runtime_error("译图尺寸必须与原图一致");if(!std::filesystem::is_regular_file(originalCache(game,image)) && sourceStamp(originalSource(game,image),image)!=image.at("sourceHash").get<std::string>())throw std::runtime_error("原图片已改变，请重新扫描");auto name="rendered/"+imageId+".png";gamefiles::write(folder(game)/name,bytes);image["renderedFile"]=name;image["renderedHash"]=stamp(folder(game)/name);publish(game,Json::array({image}));return {{"path",name},{"hash",image["renderedHash"]}};}
    std::string previewMosaic(const Path& game,const std::string& imageId){
        std::lock_guard lock(mutex_);
        validId(imageId);
        return gamefiles::read(mosaicImage(game,imageRow(game,imageId)));
    }
    Json saveMosaic(const Path& game,const std::string& imageId,const std::string& revision,const std::string& bytes){
        std::lock_guard lock(mutex_);
        data(game);
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
    Json mosaicStatus(const Path& game) {
        std::lock_guard lock(mutex_);
        const auto project = catalog(game);
        Json candidates = Json::object();
        for (const auto& image : project.at("images")) {
            if (!image.value("sourceHash", "").empty() && std::filesystem::is_regular_file(mosaicImage(game, image)))
                candidates[image.at("id").get<std::string>()] = image.at("sourceHash");
        }
        return {{"candidates", candidates}};
    }

    Json prepareMosaic(const Path& game, const Json& selectedIds, const std::string& patchId) {
        std::lock_guard lock(mutex_);
        data(game);
        validId(patchId);
        if (patchId.size() != 32) throw std::runtime_error("去码补丁标识无效");
        const auto ids = selectedIds.get<std::set<std::string>>();
        if (ids.empty()) throw std::runtime_error("没有已确认的去码图");
        const auto patch = folder(game) / "mosaic-patches" / patchId;
        if (std::filesystem::exists(patch)) throw std::runtime_error("去码补丁目录已存在");
        Json sources = Json::object();
        for (const auto& imageId : ids) {
            validId(imageId);
            const auto image = imageRow(game, imageId);
            const auto bytes = gamefiles::read(mosaicImage(game, image));
            const auto [width, height] = dimensions(bytes);
            if (width != image.at("width").get<uint32_t>() || height != image.at("height").get<uint32_t>())
                throw std::runtime_error("去码图尺寸与扫描原图不符");
            gamefiles::write(patch / (imageId + ".png"), bytes);
            sources[imageId] = image.at("sourceHash");
        }
        saveJson(patch / "manifest.json", {{"version", 1}, {"sources", sources}});
        return {{"patchId", patchId}, {"path", utf8path::pathUtf8(patch)}, {"ids", ids}};
    }

    Json apply(const Path& game,bool automatic,const Json& scopes=Json::array({"images"}),const Json& selectedIds=nullptr,bool mosaic=false,
        const std::string& preparedMosaic = {}){
        std::lock_guard lock(mutex_);
        if(!std::filesystem::is_regular_file(folder(game)/"project.json")) throw std::runtime_error("尚未扫描游戏图片");
        const auto dataPath=data(game);
        const auto key=(dataPath.empty() || dataPath==Path("Data"))?std::string():imageKey(game/dataPath/"System.json");
        const auto ids=selectedIds.is_null()?std::set<std::string>{}:selectedIds.get<std::set<std::string>>();
        if(mosaic&&ids.empty())throw std::runtime_error("请选择本组已确认的去码图");
        if(mosaic)for(const auto& imageId:ids){validId(imageId);imageIndex(game,imageId);}
        Path mosaicPatch;
        Json stagedSources;
        if (mosaic && !preparedMosaic.empty()) {
            validId(preparedMosaic);
            if (preparedMosaic.size() != 32) throw std::runtime_error("去码补丁标识无效");
            mosaicPatch = folder(game) / "mosaic-patches" / preparedMosaic;
            const auto manifest = Json::parse(gamefiles::read(mosaicPatch / "manifest.json"));
            if (manifest.value("version", 0) != 1) throw std::runtime_error("去码补丁版本不支持");
            stagedSources = manifest.at("sources");
            if (stagedSources.size() != ids.size()) throw std::runtime_error("去码补丁范围已改变，请重新生成");
        }
        gameresourcebackup::Snapshot snapshot;
        size_t updated=0,unchanged=0,composed=0;
        const auto receipt=gamefiles::applyPrepared(game,[&](const auto& stage){
            for(const auto& image:catalog(game).at("images")){
                if(!mosaic&&(!image.value("selected",false)||!image.value("completed",false)||image.value("renderedFile","").empty())) continue;
                const auto imageId=image.at("id").get<std::string>();
                if(!selectedIds.is_null()&&!ids.contains(imageId)) continue;
                validId(imageId);
                const auto name=gamefiles::relative(image.at("file"));
                const auto target=game/name;
                const auto source = image.contains("archive") ? originalSource(game,image) : target;
                const auto existing = std::filesystem::exists(target) ? target : source;
                const auto current=gamefiles::read(existing);
                auto installation=readInstallation(game,image,existing,current,key);
                if (!mosaicPatch.empty() && (!stagedSources.contains(imageId) || stagedSources.at(imageId) != image.at("sourceHash")))
                    throw std::runtime_error("去码补丁的原图版本已变更，请重新生成");
                const auto patchFile = !mosaicPatch.empty() ? mosaicPatch / (imageId + ".png")
                    : mosaic ? mosaicImage(game, image) : folder(game) / "rendered" / (imageId + ".png");
                auto bytes = imageBytes(image, gamefiles::read(patchFile), key, true);
                auto& layer=installation.layers.layer(mosaic);
                if(bytes==(layer?*layer:installation.originalFile)){++unchanged;continue;}
                if(bytes==installation.originalFile)layer.reset();
                else layer=std::move(bytes);
                if(automatic&&!mosaic&&snapshot.path.empty()) snapshot=gameresourcebackup::snapshot(game,dataPath,scopes,{},dataPath.empty());
                stageInstallation(stage,game,image,name,installation,current,key);
                ++updated;
                if(installation.layers.composed())++composed;
            }
        });
        if(receipt.empty()){
            if(unchanged) return {{"files",0},{"unchanged",unchanged},{"backupPath",""}};
            throw std::runtime_error(mosaic?"没有可应用的去码图":"没有可应用的译图，请先识别、翻译或替换译图");
        }
        if(!automatic&&!mosaic) std::filesystem::remove_all(receipt);
        return {{"files",updated},{"unchanged",unchanged},{"composed",composed},{"backupPath",utf8path::pathUtf8(mosaic?receipt:snapshot.path)},
            {"backupDetail",automatic&&!mosaic?snapshot.summary():""}};
    }

    Json uninstall(const Path& game,bool mosaic=false,const Json& selectedIds=nullptr){
        std::lock_guard lock(mutex_);
        if(!std::filesystem::is_regular_file(folder(game)/"project.json")) throw std::runtime_error("尚未扫描游戏图片");
        const auto dataPath=data(game);
        const auto key=(dataPath.empty() || dataPath==Path("Data"))?std::string():imageKey(game/dataPath/"System.json");
        const auto ids=selectedIds.is_null()?std::set<std::string>{}:selectedIds.get<std::set<std::string>>();
        if(mosaic&&ids.empty())throw std::runtime_error("请选择本组需要恢复的图片");
        size_t updated=0,retained=0;
        const auto receipt=gamefiles::applyPrepared(game,[&](const auto& stage){
            for(const auto& image:catalog(game).at("images")){
                const auto imageId=image.at("id").get<std::string>();
                if(mosaic&&!ids.contains(imageId))continue;
                validId(imageId);
                const auto installed=installedImage(game,imageId,mosaic);
                if(!std::filesystem::is_regular_file(installed)) continue;
                const auto name=gamefiles::relative(image.at("file"));
                const auto current=gamefiles::read(game/name);
                auto installation=readInstallation(game,image,game/name,current,key);
                auto& layer=installation.layers.layer(mosaic);
                if(!layer)continue;
                layer.reset();
                stageInstallation(stage,game,image,name,installation,current,key);
                ++updated;
                if(installation.layers.layer(!mosaic))++retained;
            }
        });
        if(receipt.empty()) throw std::runtime_error(mosaic?"本组没有已应用的去码图":"没有已应用的译图可卸载");
        return {{"files",updated},{"retained",retained},{"backupPath",utf8path::pathUtf8(receipt)}};
    }
};
