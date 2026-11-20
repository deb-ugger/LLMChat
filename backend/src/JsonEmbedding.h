#pragma once
#include "Utf8Path.h"
#include "AtomicFile.h"
#include "RpgMakerText.h"
#include "RpgMessageCore.h"
#include "GameTextProject.h"
#include "GameFileOps.h"
#include "WolfArchive.h"
#include "GameResourceBackup.h"
#include "ManagedGamePatch.h"
#include "MvMzRuntime.h"
#include <nlohmann/json.hpp>
#include <filesystem>
#include <fstream>
#include <thread>
#include <mutex>
#include <atomic>
#include <regex>
#include <map>
#include <algorithm>
#include <chrono>
#include <vector>
#ifdef _WIN32
#include <windows.h>
#endif

// Non-Unity resource workflow. Engine-specific text parsers share only job/backup plumbing.
class JsonEmbedding {
    using json = nlohmann::json;
    using Path = std::filesystem::path;
    std::mutex mutex_, startMutex_; std::thread thread_; std::atomic<bool> stop_{false};
    json state_ = {{"state", "idle"}}, dictionary_; Path game_, input_, work_, tools_, sourceGame_;
    std::filesystem::file_time_type inputTime_; uintmax_t inputSize_ = 0;
    size_t matched_ = 0, blocked_ = 0, examined_ = 0;
    bool exporting_ = false; Path rpgDirectory_; json jobRequest_, issues_ = json::array(); std::string context_;
    std::map<Path, std::pair<uintmax_t, std::filesystem::file_time_type>> originals_;
    static std::string read(const Path& file) { std::ifstream in(file, std::ios::binary); if (!in) throw std::runtime_error("无法读取：" + utf8path::pathUtf8(file)); return {std::istreambuf_iterator<char>(in), {}}; }
    static void write(const Path& file, const std::string& value) {
        std::filesystem::create_directories(file.parent_path());
        std::ofstream out(file, std::ios::binary | std::ios::trunc); out.write(value.data(), static_cast<std::streamsize>(value.size())); out.flush();
        if (!out) throw std::runtime_error("无法写入输出文件：" + utf8path::pathUtf8(file));
    }
    std::vector<Path> checkedRpgFiles_;
    bool unreal_ = false;
    void remember(const Path& path) { originals_[path] = {std::filesystem::file_size(path), std::filesystem::last_write_time(path)}; }
    void detail(const std::string& value) { std::lock_guard lock(mutex_); state_["detail"] = value; state_["completed"] = 0; state_["total"] = 0; }
    void progress(size_t completed, size_t total) { std::lock_guard lock(mutex_); state_["completed"] = completed; state_["total"] = total; }
    void checkStop() { if (stop_) throw std::runtime_error("嵌入操作已中止，原游戏未修改"); }
    void runTool(const std::string& name, const std::vector<std::wstring>& args) {
        wolfarchive::runTool(tools_, work_, name, args, [&]{ return stop_.load(); });
    }
    static std::vector<std::string> controls(const std::string& value) {
        static const std::regex pattern(R"(\\[A-Za-z]+(?:\[[^\]\r\n]*\])?)");
        std::vector<std::string> result; for (auto it = std::sregex_iterator(value.begin(), value.end(), pattern); it != std::sregex_iterator(); ++it) result.push_back(it->str());
        std::sort(result.begin(), result.end()); return result;
    }
    using NameAliases = std::map<std::string, const std::string*>;
    bool replace(std::string& source, const rpgmessage::MessageLayout* messageCore = nullptr, const NameAliases* aliases = nullptr) {
        if (source.empty()) return false; ++examined_;
        if (exporting_) { dictionary_[source] = ""; return false; }
        const auto it = dictionary_.find(source);
        const std::string* translated = it == dictionary_.end() ? nullptr : &it->get_ref<const std::string&>();
        if (!translated && aliases && source.find('<') != std::string::npos) {
            const auto alias = aliases->find(rpgmessage::repairNameLineBreak(source));
            if (alias != aliases->end()) translated = alias->second;
        }
        auto target = translated ? *translated : std::string();
        if (!messageCore && (target.empty() || target == source)) return false;
        if (target.empty()) target = source;
        auto originalControls = source, targetControls = target;
        if (messageCore) {
            originalControls = rpgmessage::repairNameLineBreak(rpgmessage::repairPosition(source));
            target = rpgmessage::restoreName(originalControls, rpgmessage::repairNameLineBreak(rpgmessage::repairPosition(target)));
            targetControls = target;
            if (!std::regex_search(originalControls, rpgmessage::nameBox))
                targetControls = std::regex_replace(targetControls, rpgmessage::manualName, "");
        }
        const bool incompatible = unreal_ ? unrealControls(source) != unrealControls(target)
            : rpgDirectory_.empty() ? controls(source) != controls(target) || target[0] == '/' || target.find("\n/") != std::string::npos
            : rpgControls(originalControls) != rpgControls(targetControls);
        if (incompatible) { ++blocked_; issues_.push_back({{"file",context_},{"source",source},{"translation",target},{"reason","译文控制符与原文不一致"}}); return false; }
        if (messageCore) target = rpgmessage::alignPositionedLines(rpgmessage::alignContinuation(std::move(target), *messageCore));
        if (target == source) return false;
        source = target; ++matched_; return true;
    }
    void visit(json& node) {
        if (node.is_array()) { for (auto& item : node) visit(item); return; }
        if (!node.is_object()) return;
        if (node.contains("code")) {
            const int code = node.value("code", 0);
            if ((code == 101 || code == 102) && node.contains("stringArgs")) for (auto& arg : node["stringArgs"]) if (arg.is_string()) { auto value = arg.get<std::string>(); if (replace(value)) arg = value; }
            return; // Other commands contain identifiers, filenames and conditions.
        }
        for (auto& [key, value] : node.items()) {
            if (value.is_string() && (key == "value" || key == "Title" || key == "TitlePlus" || key == "StartUpMsg" || key == "TitleMsg")) {
                auto text = value.get<std::string>();
                static const std::regex path(R"(\.(?:png|jpg|jpeg|ogg|wav|mp3|mps|wolf|dat)$)", std::regex::icase);
                if (!std::regex_search(text, path) && replace(text)) value = text;
            } else if (value.is_structured()) visit(value);
        }
    }
    static std::string decodeText(std::string bytes) {
        if (bytes.empty()) return {};
        if (bytes.starts_with("\xef\xbb\xbf")) return bytes.substr(3);
#ifdef _WIN32
        if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, bytes.data(), static_cast<int>(bytes.size()), nullptr, 0) > 0) return bytes;
        const auto wideSize = MultiByteToWideChar(932, MB_ERR_INVALID_CHARS, bytes.data(), static_cast<int>(bytes.size()), nullptr, 0);
        if (!wideSize) throw std::runtime_error("外部脚本不是有效 CP932 文本");
        std::wstring wide(wideSize, 0); MultiByteToWideChar(932, MB_ERR_INVALID_CHARS, bytes.data(), static_cast<int>(bytes.size()), wide.data(), wideSize);
        return utf8path::toUtf8(wide);
#else
        return bytes;
#endif
    }
    bool textFile(const Path& source, const Path& output, bool save) {
        const auto text = decodeText(read(source)); std::string result; bool changed = false;
        size_t offset = 0;
        while (offset < text.size()) {
            const auto end = text.find('\n', offset); const auto stop = end == std::string::npos ? text.size() : end;
            auto line = text.substr(offset, stop - offset); const bool cr = !line.empty() && line.back() == '\r'; if (cr) line.pop_back();
            if (!line.empty() && line[0] != '/') changed = replace(line) || changed;
            result += line; if (cr) result += '\r'; if (end != std::string::npos) result += '\n';
            offset = end == std::string::npos ? text.size() : end + 1;
        }
        if (changed && save) write(output, "\xef\xbb\xbf" + result);
        return changed;
    }
    void scan(bool save) {
        matched_ = blocked_ = examined_ = 0;
        const auto dump = work_ / "dump";
        std::vector<Path> jsonFiles, textFiles;
        for (const auto& file : std::filesystem::recursive_directory_iterator(dump)) if (file.is_regular_file() && file.path().extension() == ".json") jsonFiles.push_back(file.path());
        const auto data = work_ / "Data";
        for (const auto& dir : std::filesystem::directory_iterator(data)) if (dir.is_directory() && dir.path().filename().string().starts_with("Evtext")) for (const auto& file : std::filesystem::recursive_directory_iterator(dir.path())) if (file.is_regular_file() && file.path().extension() == ".txt") textFiles.push_back(file.path());
        size_t completed = 0; const auto total = jsonFiles.size() + textFiles.size(); progress(0, total);
        for (const auto& file : jsonFiles) {
            checkStop(); auto value = json::parse(read(file)); const auto before = matched_; visit(value);
            if (save && matched_ != before) write(file, value.dump(2));
            if (++completed % 16 == 0) progress(completed, total);
        }
        for (const auto& file : textFiles) {
            checkStop(); textFile(file, work_ / "patch" / "Data" / std::filesystem::relative(file, data), save);
            if (++completed % 16 == 0) progress(completed, total);
        }
        progress(total, total);
        std::lock_guard lock(mutex_); state_["matched"] = matched_; state_["blocked"] = blocked_; state_["examined"] = examined_; state_["issues"]=issues_;
    }
    void prepareWolf() {
        const auto data = work_ / "Data";
        std::filesystem::create_directories(data);
        originals_.clear();
        std::map<Path,Path> groups;
        const auto collect = [&](const Path& source) {
            if (!std::filesystem::is_directory(source)) return;
            for (const auto& entry : std::filesystem::directory_iterator(source)) {
                const auto group = entry.is_directory() ? entry.path().filename() : entry.path().stem();
                if (!gamepatch::wolfName(utf8path::pathUtf8(group))) continue;
                if (entry.is_directory() || gameresourcebackup::imageExtension(entry.path()) == ".wolf") {
                    // A loose directory overrides the corresponding archive from this layer.
                    if (entry.is_directory() || !std::filesystem::is_directory(source / group))
                        groups[group] = entry.path();
                }
            }
        };
        const auto mainArchive = game_ / "Data.wolf";
        if (std::filesystem::is_regular_file(mainArchive)) {
            detail("读取 WOLF 封包：Data.wolf");
            remember(mainArchive);
            collect(wolfarchive::unpack(game_, mainArchive, tools_, [&]{ return stop_.load(); }));
        }
        const auto source = sourceGame_ / "Data";
        collect(source);
        if (groups.empty()) throw std::runtime_error("未找到 WOLF 的 BasicData、MapData 或 Evtext 文本资源");
        for (const auto& [group, path] : groups) {
            checkStop();
            auto input = path;
            if (std::filesystem::is_regular_file(path)) {
                detail("读取 WOLF 封包：" + utf8path::pathUtf8(path.filename()));
                input = wolfarchive::unpack(game_, path, tools_, [&]{ return stop_.load(); });
            }
            if (path.parent_path() == source) {
                const auto track = [&](const Path& file) {
                    const auto original = game_ / file.lexically_relative(sourceGame_);
                    if (std::filesystem::is_regular_file(original)) remember(original);
                };
                if (input != path) track(path);
                else for (const auto& file : std::filesystem::recursive_directory_iterator(input))
                    if (file.is_regular_file()) track(file.path());
            }
            std::filesystem::copy(input, data / group, std::filesystem::copy_options::recursive);
        }
        detail("提取事件、地图与数据库文本"); runTool("WolfTL.exe", {data.wstring(), work_.wstring(), L"--create"});
        if (!std::filesystem::is_directory(work_ / "dump")) throw std::runtime_error("没有生成可回写的文本定位数据");
    }
    static json readTranslationDictionary(const Path& path) {
        auto dictionary = json::parse(read(path));
        if (!dictionary.is_object()) throw std::runtime_error("需要原文到译文的 JSON 对象");
        size_t leaks = 0;
        for (auto it = dictionary.begin(); it != dictionary.end(); ++it) {
            if (!it->is_string()) throw std::runtime_error("JSON 不是 MTool 原文到译文格式，值必须全部是文本");
            if (translation_prompt::leaked(it.key(), it->get_ref<const std::string&>())) ++leaks;
        }
        if (leaks) throw std::runtime_error("翻译 JSON 有 " + std::to_string(leaks) + " 条译文混入了参考语境或模型提示，请重译后再生成补丁");
        return dictionary;
    }
    void inspect() {
        detail("读取翻译 JSON"); dictionary_ = readTranslationDictionary(input_);
        if (dictionary_.empty() && (rpgDirectory_.empty() || !rpgmessage::enabled(game_))) throw std::runtime_error("译文 JSON 为空");
        inputTime_ = std::filesystem::last_write_time(input_); inputSize_ = std::filesystem::file_size(input_);
        if (unreal_) {
            detail("匹配 UE 本地化资源并检查占位符"); scanUnreal(false);
        } else {
            sourceGame_ = gamepatch::source(game_,rpgDirectory_,backups(game_));
            if (rpgDirectory_.empty()) prepareWolf();
            detail("匹配译文并检查控制符"); if (rpgDirectory_.empty()) scan(false); else scanRpg(false);
        }
        std::lock_guard lock(mutex_); state_["dictionaryEntries"] = dictionary_.size(); state_["state"] = "ready"; state_["detail"] = "检查完成，可生成嵌入补丁";
    }
    void embed() {
        if (std::filesystem::file_size(input_) != inputSize_ || std::filesystem::last_write_time(input_) != inputTime_) throw std::runtime_error("翻译 JSON 已改变，请重新检查");
        if (unreal_) {
            scanUnreal(true);
            if (!matched_) throw std::runtime_error("没有可写入的有效匹配译文");
            std::lock_guard lock(mutex_);
            state_["state"] = "done"; state_["detail"] = "UE 本地化补丁已生成";
            state_["patchPath"] = utf8path::pathUtf8(work_ / "patch"); dictionary_.clear(); return;
        }
        if (!rpgDirectory_.empty()) { std::filesystem::create_directories(work_/"patch"/rpgDirectory_); scanRpg(true); if (!matched_) throw std::runtime_error("没有可写入的有效匹配译文"); std::lock_guard lock(mutex_); state_["state"] = "done"; state_["detail"] = "嵌入补丁已生成，原游戏未修改"; state_["patchPath"] = utf8path::pathUtf8(work_ / "patch"); dictionary_.clear(); return; }
        detail("准备补丁资源副本");
        std::filesystem::create_directories(work_ / "patch" / "Data");
        for (const auto& dir : std::filesystem::directory_iterator(work_ / "Data")) if (dir.is_directory()) std::filesystem::copy(dir.path(), work_ / "patch" / "Data" / dir.path().filename(), std::filesystem::copy_options::recursive | std::filesystem::copy_options::overwrite_existing);
        detail("写入匹配译文"); scan(true);
        if (!matched_) throw std::runtime_error("没有可写入的有效匹配译文");
        detail("回写 WOLF 数据文件"); runTool("WolfTL.exe", {(work_ / "Data").wstring(), work_.wstring(), L"--patch"});
        const auto patched = work_ / "patched" / "data";
        if (!std::filesystem::is_directory(patched)) throw std::runtime_error("工具未生成回写资源");
        std::filesystem::copy(patched, work_ / "patch" / "Data", std::filesystem::copy_options::recursive | std::filesystem::copy_options::overwrite_existing);
        detail("重读校验回写资源"); runTool("WolfTL.exe", {(work_ / "patch" / "Data").wstring(), (work_ / "verify").wstring(), L"--create"});
        for (const auto& file : std::filesystem::recursive_directory_iterator(work_ / "dump")) if (file.is_regular_file() && file.path().extension() == ".json") {
            checkStop(); const auto relative = std::filesystem::relative(file.path(), work_ / "dump");
            if (json::parse(read(file.path())) != json::parse(read(work_ / "verify" / "dump" / relative))) throw std::runtime_error("回写文本校验不一致：" + utf8path::pathUtf8(relative));
        }
        json manifest = {{"engine", "wolf"}, {"game", utf8path::pathUtf8(game_)}, {"json", utf8path::pathUtf8(input_)}, {"matched", matched_}, {"blocked", blocked_}, {"externalTextEncoding", "UTF-8 BOM"}, {"verification", "reopened"}};
        write(work_ / "manifest.json", manifest.dump(2));
        write(work_ / "使用说明.txt", "本目录 patch/Data 是已写入译文的资源。原游戏未修改。\n请在游戏副本中备份并移走对应 BasicData.wolf、MapData.wolf、Evtext*.wolf，再复制对应解包目录；保留其他图片、音频资源包。不要删除原件。\n外部脚本输出 UTF-8 BOM。数据已通过重读检查，仍需实测中文字体、外部脚本编码与游戏显示。\n");
        dictionary_.clear(); std::lock_guard lock(mutex_); state_["state"] = "done"; state_["detail"] = "嵌入补丁已生成，原游戏未修改"; state_["patchPath"] = utf8path::pathUtf8(work_ / "patch");
    }
    void verifyInputs() const {
        for(const auto& [path,stamp]:originals_)if(!std::filesystem::is_regular_file(path)||std::filesystem::file_size(path)!=stamp.first||std::filesystem::last_write_time(path)!=stamp.second)throw std::runtime_error("游戏资源已改变，请重新检查后生成补丁");
    }
    void apply() {
        gamepatch::verify(game_);
        verifyInputs();
        const auto snapshot=jobRequest_.value("backupMode","auto")=="auto"?scopedBackup():gameresourcebackup::Snapshot{};
        detail("验证并应用文本补丁");const auto receipt=gamepatch::install(game_,rpgDirectory_,work_/"patch",unreal_);
        std::lock_guard lock(mutex_);
        if(!snapshot.path.empty()||!receipt.empty()) state_["backupPath"]=utf8path::pathUtf8(snapshot.path.empty()?receipt:snapshot.path);
        else state_.erase("backupPath");
        state_["state"]="applied";
        state_["detail"]=std::string("文本补丁已安装")+(snapshot.path.empty()?"":" · "+snapshot.summary());
    }
    static void saveLedger(const Path& backup, const json& ledger) {
        std::string error; if (!atomicfile::writeText(backup / "manifest.json", ledger.dump(2), &error)) throw std::runtime_error(error);
    }
    static bool resourceName(const std::string& name) { return name == "BasicData" || name == "MapData" || std::regex_match(name, std::regex("Evtext[A-Za-z0-9_-]*")); }
    void backupOnly() {
        if (!rpgDirectory_.empty() && !jobRequest_.contains("backupScopes") && jobRequest_.value("backupScope","text")=="text") {
            backupRpg();
            return;
        }
        const auto backup=scopedBackup();
        std::lock_guard lock(mutex_);
        state_["state"]=state_.value("resumeAfterBackup","backedUp");
        state_.erase("resumeAfterBackup");
        state_["backupPath"]=utf8path::pathUtf8(backup.path);
        state_["detail"]=backup.summary();
    }
    void restoreWolfDirectory(const Path& backup, const Path& target, const Path& original,
                              const std::string& name, json& tree, json& manifest) {
        namespace fs = std::filesystem;
        if (tree.value("restored", false)) return;
        if (!tree.contains("files")) {
            std::map<Path, bool> files;
            auto collect = [&](const Path& root, bool fromBackup) {
                auto directories = json::array();
                if (!root.empty() && fs::exists(root)) {
                    for (const auto& entry : fs::recursive_directory_iterator(root)) {
                        const auto path = entry.path().lexically_relative(root);
                        if (gamefiles::reparsePoint(entry.path())) throw std::runtime_error("回滚目录包含链接");
                        if (entry.is_directory()) directories.push_back(gamefiles::key(path));
                        else if (entry.is_regular_file()) files[path] = fromBackup;
                        else throw std::runtime_error("回滚目录包含非普通资源");
                    }
                }
                return directories;
            };
            tree["oldDirectories"] = collect(target, false);
            tree["originalDirectories"] = collect(original, true);
            tree["hadOriginal"] = !original.empty();
            if (fs::exists(target))
                tree["retainedRoot"] = gamefiles::key(gamefiles::availableName(backup, Path("retained") / name));
            tree["files"] = json::array();
            for (const auto& [path, exists] : files)
                tree["files"].push_back({{"name", gamefiles::key(path)}, {"existed", exists}});
            gamefiles::ledger(backup, manifest, true);
        }

        const bool hadOriginal = tree.value("hadOriginal", false);
        if (hadOriginal && (original.empty() || !fs::is_directory(original)))
            throw std::runtime_error("备份原目录缺失：" + name);
        if (hadOriginal) {
            fs::create_directories(target);
            for (const auto& path : tree.at("originalDirectories"))
                fs::create_directories(gamefiles::checkedPath(target, gamefiles::relative(path)));
        }
        Path retainedName = name;
        if (tree.contains("retainedRoot")) {
            const auto savedRoot = gamefiles::relative(tree.at("retainedRoot"));
            const auto saved = gamefiles::checkedPath(backup, savedRoot);
            retainedName = savedRoot.lexically_relative("retained");
            fs::create_directories(saved);
            for (const auto& path : tree.at("oldDirectories"))
                fs::create_directories(gamefiles::checkedPath(saved, gamefiles::relative(path)));
        }
        // Existing nonempty directories cannot be swapped atomically on Windows.
        for (auto& file : tree.at("files")) {
            const auto path = gamefiles::relative(file.at("name"));
            const auto source = file.value("existed", false) ? gamefiles::checkedPath(original, path) : Path{};
            gamefiles::restoreFile(backup, gamefiles::checkedPath(target, path), source, retainedName / path, file, manifest);
        }
        const auto& old = tree.at("oldDirectories");
        for (auto it = old.rbegin(); it != old.rend(); ++it) {
            const auto path = gamefiles::relative(*it);
            const auto directory = gamefiles::checkedPath(target, path);
            if ((!hadOriginal || !fs::is_directory(gamefiles::checkedPath(original, path)))
                && fs::is_directory(directory) && fs::is_empty(directory)) fs::remove(directory);
        }
        if (!hadOriginal && fs::is_directory(target) && fs::is_empty(target)) fs::remove(target);
        tree["restored"] = true;
        gamefiles::ledger(backup, manifest, true);
    }
    void restoreBackup(const Path& backup) {
        detail("正在恢复原资源");
        auto ledger = json::parse(read(backup / "manifest.json"));
        if (ledger.value("engine", "") == "files") {
            const bool wolfText=ledger.value("wolfTextSnapshot",false);
            if(wolfText&&ledger.value("state","")=="snapshot"&&std::filesystem::is_directory(game_/"Data")) {
                std::set<std::string> originals;
                for(const auto& item:ledger.at("resources")) originals.insert(item.at("name").get<std::string>());
                for(const auto& name:gamepatch::sources(game_,{}))
                    if(!originals.contains(gamefiles::key(name))) ledger["resources"].push_back({{"name",gamefiles::key(name)},{"existed",false}});
                gamefiles::ledger(backup, ledger, true);
            }
            gamefiles::restore(game_, backup, false);
            if(wolfText) {
                json files=json::array();
                for(const auto& item:ledger.at("resources")) files.push_back({{"path",item.at("name")}});
                gamepatch::pruneEmpty(game_,{{"files",files}});
            }
            return;
        }
        if (ledger.value("engine", "") == "rpgmaker") { restoreRpg(backup, ledger); return; }
        if (ledger.value("state", "") == "rolledBack") return;
        auto resources = ledger.at("resources");
        for (auto& entry : resources) {
            if (entry.is_string()) { const auto name = entry.get<std::string>(); entry = {{"name", name}, {"hadArchive", std::filesystem::exists(backup / "Data" / (name + ".wolf"))}, {"hadDirectory", std::filesystem::is_directory(backup / "Data" / name)}}; }
            const auto name = entry.at("name").get<std::string>();
            if (!resourceName(name)) throw std::runtime_error("备份包含无效资源名称");
            if (entry.value("restored", false)) continue;
            const auto originalPack = backup / "Data" / (name + ".wolf"), currentPack = game_ / "Data" / (name + ".wolf");
            if (std::filesystem::exists(originalPack) && std::filesystem::exists(currentPack) && ledger.value("kind", "") != "snapshot") {
                const auto archive = entry.value("archiveRollback", json::object());
                if (!archive.value("restored", false)
                    && (!archive.contains("retainedPath") || !gamefiles::sameFileContents(originalPack, currentPack)))
                    throw std::runtime_error("当前存在同名资源包，回滚已停止以避免覆盖：" + name);
            }
            if (entry.value("hadArchive", false) && !std::filesystem::exists(originalPack) && !std::filesystem::exists(currentPack)) throw std::runtime_error("备份原资源缺失：" + name);
            if (entry.value("hadDirectory", false) && !std::filesystem::exists(backup / "Data" / name) && !std::filesystem::exists(game_ / "Data" / name)) throw std::runtime_error("备份原目录缺失：" + name);
        }
        ledger["resources"] = std::move(resources);
        ledger["state"] = "rollingBack";
        gamefiles::ledger(backup, ledger, true);
        auto& entries = ledger.at("resources");
        size_t completed = 0; progress(0, entries.size());
        for (auto& entry : entries) {
            if (entry.value("restored", false)) { progress(++completed, entries.size()); continue; }
            const auto name = entry.at("name").get<std::string>();
            const Path dirName = Path("Data") / name, packName = Path("Data") / (name + ".wolf");
            const auto directory = gamefiles::checkedPath(backup, dirName);
            const auto archive = gamefiles::checkedPath(backup, packName);
            const bool restoreDirectory = std::filesystem::exists(directory), restoreArchive = std::filesystem::exists(archive);
            if (restoreArchive) {
                auto& state = entry["archiveRollback"];
                if (state.is_null()) state = json::object();
                gamefiles::restoreFile(backup, gamefiles::checkedPath(game_, packName), archive, packName.filename(), state, ledger);
            }
            if (restoreDirectory || entry.contains("directoryRollback") || (!entry.value("hadDirectory", false) && restoreArchive)) {
                auto& state = entry["directoryRollback"];
                if (state.is_null()) state = json::object();
                restoreWolfDirectory(backup, gamefiles::checkedPath(game_, dirName), restoreDirectory ? directory : Path{}, name, state, ledger);
            }
            entry["restored"] = true;
            gamefiles::ledger(backup, ledger, true);
            progress(++completed, entries.size());
        }
    }
    static std::vector<std::string> rpgControls(const std::string& value) {
        static const std::regex pattern(R"((?:if|en)\([^)\r\n]+\)|\\(?:[A-Za-z]+(?:\[[^\]\r\n]*\])?|[{}.!|><^$\\])|%%|%[1-9][0-9]*(?![0-9$]))", std::regex::icase);
        std::vector<std::string> result;
        for (auto it = std::sregex_iterator(value.begin(), value.end(), pattern); it != std::sregex_iterator(); ++it)
            if (it->str() != "%%") result.push_back(it->str());
        std::sort(result.begin(), result.end()); return result;
    }
    void selectEngine() {
        rpgDirectory_.clear();
        const auto found = detect(game_);
        if (found.size() != 1 || utf8path::pathFromUtf8(found[0].at("path").get<std::string>()) != game_ || !found[0].value("supported", false))
            throw std::runtime_error("请选择支持嵌字翻译的游戏目录");
        unreal_ = found[0].at("engine").get<std::string>() == unreal::engine;
        if (found[0].at("engine").get<std::string>().starts_with("RPG Maker")) rpgDirectory_ = std::filesystem::exists(game_ / "www" / "data" / "System.json") ? Path("www") / "data" : Path("data");
    }
    static std::vector<std::string> unrealControls(const std::string& value) {
        static const std::regex tokens(R"(\{[^{}\r\n]+\}|</?[^<>\r\n]*>|%[0-9]*\$?[a-zA-Z%]|\\[rnt])");
        std::vector<std::string> result;
        for (auto it = std::sregex_iterator(value.begin(), value.end(), tokens); it != std::sregex_iterator(); ++it) result.push_back(it->str());
        std::sort(result.begin(), result.end()); return result;
    }
    void scanUnreal(bool save) {
        const auto files = unreal::localizationFiles(game_);
        if (files.empty()) throw std::runtime_error("未找到散装 .locres；请先从游戏资源包导出到对应的 Content/Localization 目录");
        gamepatch::verify(game_);
        if (save) {
            if (files != checkedRpgFiles_) throw std::runtime_error("UE 本地化资源列表已改变，请重新检查");
            verifyInputs();
        } else { originals_.clear(); checkedRpgFiles_ = files; }
        matched_ = blocked_ = examined_ = 0; issues_ = json::array();
        const auto installed = gamepatch::info(game_).value("installed",false);
        size_t completed = 0; progress(0, files.size());
        for (const auto& name : files) {
            checkStop();
            context_ = gamefiles::key(name);
            const auto live = gamefiles::checkedPath(game_, name);
            const auto original = gamefiles::checkedPath(game_, (gamepatch::root(game_) / "original").lexically_relative(game_) / name);
            const auto source = installed && std::filesystem::is_regular_file(original) ? original : live;
            if (!save) { remember(live); if (source != live) remember(source); }
            if (std::filesystem::file_size(source) > 256 * 1024 * 1024) throw std::runtime_error("UE 本地化资源超过可读取大小：" + context_);
            auto updated = unreal::Locres(read(source)).rewrite([this](std::string& value) { return replace(value); });
            if (save && updated) write(work_ / "patch" / name, *updated);
            progress(++completed, files.size());
        }
        std::lock_guard lock(mutex_);
        state_["matched"] = matched_; state_["blocked"] = blocked_; state_["issues"] = issues_;
    }
    std::vector<Path> rpgFiles(const Path& directory) {
        std::vector<Path> files;
        for (const auto& entry : std::filesystem::directory_iterator(directory)) if (entry.is_regular_file() && rpgtext::dataFile(entry.path().filename().string())) files.push_back(entry.path());
        std::sort(files.begin(), files.end()); return files;
    }
    void scanPlugins(bool save) {
        const auto source=sourceGame_/rpgDirectory_.parent_path()/"js/plugins.js";
        if(!std::filesystem::exists(source))return;
        const auto raw=read(source);const auto first=raw.find('['),last=raw.find_last_of(']');
        if(first==std::string::npos||last==std::string::npos)throw std::runtime_error("plugins.js 不是标准插件列表");
        auto plugins=json::parse(raw.substr(first,last-first+1));const auto before=matched_;
        for(auto& plugin:plugins)if(plugin.value("status",false)&&(plugin.value("name","")=="DTextPicture"||plugin.value("name","")=="TextPicture")&&plugin.contains("parameters"))rpgtext::pluginText(plugin["parameters"],[this](std::string& text){return replace(text);});
        if(save&&matched_!=before)write(work_/"patch"/rpgDirectory_.parent_path()/"js/plugins.js",raw.substr(0,first)+plugins.dump(2)+raw.substr(last+1));
        if(!save&&std::filesystem::is_regular_file(game_/rpgDirectory_.parent_path()/"js/plugins.js"))remember(game_/rpgDirectory_.parent_path()/"js/plugins.js");
    }
    void scanRpg(bool save) {
        matched_ = blocked_ = examined_ = 0; issues_=json::array(); const auto files = rpgFiles(sourceGame_ / rpgDirectory_); size_t completed = 0;
        if (!save) originals_.clear();
        else {
            if (files != checkedRpgFiles_) throw std::runtime_error("数据库文件列表已改变，请重新检查");
            verifyInputs();
        }
        if (!save) checkedRpgFiles_ = files;
        const auto layout = !exporting_ ? rpgmessage::messageLayout(game_) : rpgmessage::MessageLayout{};
        NameAliases aliases;
        if (layout.enabled) for (auto it = dictionary_.cbegin(); it != dictionary_.cend(); ++it) {
            if (it.key().find('<') == std::string::npos) continue;
            const auto normalized = rpgmessage::repairNameLineBreak(it.key());
            if (!std::regex_search(normalized, rpgmessage::nameBox)) continue;
            const auto* translation = &it->get_ref<const std::string&>();
            const auto [alias, inserted] = aliases.emplace(normalized, translation);
            if (!inserted && alias->second && *alias->second != *translation) alias->second = nullptr;
        }
        detail(exporting_ ? "提取 RPG Maker 显示文本" : "匹配 RPG Maker 显示文本"); progress(0, files.size());
        for (const auto& file : files) {
            checkStop();
            if (!save && !exporting_) {
                remember(file);
                const auto live = game_ / rpgDirectory_ / file.filename();
                if (live != file && std::filesystem::is_regular_file(live)) remember(live);
            }
            context_=file.filename().string(); auto value = json::parse(read(file)); const auto before = matched_;
            rpgtext::visit(file.filename().string(), value, [this](std::string& text) { return replace(text); },
                [this, &layout, &aliases](std::string& text) { return replace(text, layout.enabled ? &layout : nullptr, layout.enabled ? &aliases : nullptr); },
                [this, &layout](json& commands) { if (layout.enabled) matched_ += rpgmessage::repairNameFragments(commands); });
            if (save && matched_ != before) {
                const auto target = work_ / "patch" / rpgDirectory_ / file.filename(); write(target, value.dump());
                if (json::parse(read(target)) != value) throw std::runtime_error("回写校验失败：" + file.filename().string());
            }
            progress(++completed, files.size());
        }
        context_="js/plugins.js"; scanPlugins(save);
        std::lock_guard lock(mutex_); state_["matched"] = matched_; state_["blocked"] = blocked_; state_["examined"] = examined_; state_["issues"]=issues_;
    }
    void extract() {
        checkStop();
        dictionary_ = json::object(); exporting_ = true;
        try {
            if (unreal_) scanUnreal(false);
            else { sourceGame_ = gamepatch::source(game_,rpgDirectory_,backups(game_)); if (rpgDirectory_.empty()) { prepareWolf(); scan(false); } else scanRpg(false); }
        }
        catch (...) { exporting_ = false; throw; }
        exporting_ = false;
        checkStop(); gametext::resetForScan(game_);
        const auto output = work_ / "MTool.json"; write(output, dictionary_.dump(2));
        std::lock_guard lock(mutex_); state_["state"] = "exported"; state_["detail"] = "文本已导出为 MTool JSON"; state_["exportPath"] = utf8path::pathUtf8(output); state_["dictionaryEntries"] = dictionary_.size(); dictionary_.clear();
    }
    Path rpgBackup(const std::vector<Path>& files, const std::string& kind) {
        const auto backup = game_ / "LLMChat-JSON" / "backups" / ("rpg-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        json names = json::array(); size_t completed = 0; detail("备份 RPG Maker 原资源"); progress(0, files.size());
        for (const auto& file : files) {
            checkStop(); const auto name = file.filename().string();
            write(backup / "original" / name, read(game_ / rpgDirectory_ / file.filename())); names.push_back({{"name", name}}); progress(++completed, files.size());
        }
        saveLedger(backup, {{"version", 3}, {"engine", "rpgmaker"}, {"dataDirectory", utf8path::pathUtf8(rpgDirectory_)}, {"kind", kind}, {"state", kind == "snapshot" ? "snapshot" : "applying"}, {"resources", names}});
        { std::lock_guard lock(mutex_); state_["backupPath"] = utf8path::pathUtf8(backup); } return backup;
    }
    void backupRpg() {
        rpgBackup(rpgFiles(game_ / rpgDirectory_), "snapshot");
        std::lock_guard lock(mutex_); state_["state"] = state_.value("resumeAfterBackup", "backedUp"); state_.erase("resumeAfterBackup"); state_["detail"] = "备份完成，游戏资源未改变";
    }
    void restoreRpg(const Path& backup, json ledger) {
        if (ledger.value("state", "") == "rolledBack") return;
        const auto directory = ledger.at("dataDirectory").get<std::string>();
        if (directory != "data" && directory != "www/data" && directory != "www\\data") throw std::runtime_error("备份数据目录无效");
        for (const auto& item : ledger.at("resources")) {
            const auto name = item.at("name").get<std::string>();
            if (!rpgtext::dataFile(name) || (!item.value("restored", false)
                && !std::filesystem::is_regular_file(gamefiles::checkedPath(backup, Path("original") / name))))
                throw std::runtime_error("备份原资源缺失或名称无效：" + name);
        }
        ledger["state"] = "rollingBack"; gamefiles::ledger(backup, ledger, true);
        size_t completed = 0; progress(0, ledger.at("resources").size());
        for (auto& item : ledger.at("resources")) {
            if (!item.value("restored", false)) {
                const auto name = item.at("name").get<std::string>();
                const auto target = gamefiles::checkedPath(game_, utf8path::pathFromUtf8(directory) / name);
                const auto original = gamefiles::checkedPath(backup, Path("original") / name);
                gamefiles::restoreFile(backup, target, original, name, item, ledger);
            }
            progress(++completed, ledger.at("resources").size());
        }
    }
    gameresourcebackup::Snapshot scopedBackup() {
        detail("按范围备份资源");
        const auto data=rpgDirectory_.empty()?Path("Data"):rpgDirectory_;
        const auto scopes=jobRequest_.value("backupScopes",json::array({jobRequest_.value("backupScope","text")}));
        return gameresourcebackup::snapshot(game_,data,scopes,
            [&](size_t completed,size_t total){checkStop();progress(completed,total);}, unreal_);
    }
    void finishBackupMode(const std::string& action) {
        if(jobRequest_.value("backupMode","auto")!="manual" || (action!="apply"&&action!="runtime"))return;
        Path backup;{std::lock_guard lock(mutex_);if(state_.value("state","")!="applied"||!state_.contains("backupPath"))return;backup=utf8path::pathFromUtf8(state_["backupPath"].get<std::string>());}
        if(backup.parent_path().lexically_normal()!=(game_/"LLMChat-JSON"/"backups").lexically_normal())throw std::runtime_error("临时恢复目录不在当前游戏备份目录中");
        std::filesystem::remove_all(backup);
        std::lock_guard lock(mutex_);state_.erase("backupPath");state_["detail"]="已应用到游戏（手动备份模式）";
    }
    void installRuntime() {
        const auto base=rpgDirectory_.parent_path();
        if(rpgDirectory_.empty())throw std::runtime_error("本地译文加载适用于 RPG Maker MV/MZ");
            detail("准备本地翻译插件");auto dictionary=readTranslationDictionary(utf8path::pathFromUtf8(jobRequest_.at("jsonPath")));
            auto original=read(game_/base/"js/plugins.js");auto begin=original.find('['),end=original.find_last_of(']');if(begin==std::string::npos||end==std::string::npos)throw std::runtime_error("无法解析 plugins.js");
            auto plugins=json::parse(original.substr(begin,end-begin+1));if(!plugins.is_array())throw std::runtime_error("插件列表格式错误");
            plugins.erase(std::remove_if(plugins.begin(),plugins.end(),[](const json& p){return p.value("name","")=="LLMChatTranslation";}),plugins.end());
            plugins.push_back({{"name","LLMChatTranslation"},{"status",true},{"description","Local translation"},{"parameters",json::object()}});
            std::map<Path,std::string> files;auto script=std::string(mvMzRuntime);std::string font;
            const auto fontPath=jobRequest_.value("fontPath","");
            if(!fontPath.empty()){auto path=utf8path::pathFromUtf8(fontPath);auto ext=path.extension().string();if(ext!=".ttf"&&ext!=".otf")throw std::runtime_error("请选择 TTF/OTF 字体");font="LLMChat-font"+ext;files[base/"fonts"/font]=read(path);}
            script.replace(script.find("__FONT__"),8,font);
            files[base/"js/plugins/LLMChatTranslation.js"]=script;files[base/"LLMChat-translations.json"]=dictionary.dump();files[base/"js/plugins.js"]=original.substr(0,begin)+plugins.dump(2)+original.substr(end+1);
            const auto snapshot=jobRequest_.value("backupMode","auto")=="auto"?scopedBackup().path:Path();
            const auto backup=gamefiles::apply(game_,files);std::lock_guard lock(mutex_);state_["backupPath"]=utf8path::pathUtf8(snapshot.empty()?backup:snapshot);state_["state"]="applied";state_["detail"]="本地翻译插件已安装；回滚对应备份可卸载";return;
    }

public:
    static json patchInfo(const Path& game){ auto state=gamepatch::info(game);if(!state.value("managed",false)){for(auto& item:backups(game)){if(item.at("state")!="applied")continue;auto dir=utf8path::pathFromUtf8(item.at("path"));auto ledger=json::parse(read(dir/"manifest.json"));if(ledger.value("kind","")=="snapshot"||ledger.value("managedPatch",false)||ledger.value("patchAdopted",false))continue;bool text=dir.filename().string().starts_with("wolf-")||ledger.value("engine","")=="rpgmaker";if(ledger.value("engine","")=="files")for(auto& resource:ledger["resources"]){auto name=resource.at("name").get<std::string>();if((name.starts_with("data/")||name.starts_with("www/data/"))&&rpgtext::dataFile(std::filesystem::path(name).filename().string()))text=true;}if(text){state["legacy"]=true;break;}}}return state; }
    static json detect(const Path& input) {
        auto root = std::filesystem::absolute(input); const bool executable = std::filesystem::is_regular_file(root);
        if (executable) {
            root = root.parent_path();
            if (root.filename() == "Win64" && root.parent_path().filename() == "Binaries") {
                const auto project = root.parent_path().parent_path();
                if (unreal::identified(project)) root = std::filesystem::is_directory(project.parent_path() / "Engine") ? project.parent_path() : project;
            }
        }
        if (!std::filesystem::is_directory(root)) throw std::runtime_error("请选择存在的游戏目录或主程序");
        auto identify = [](const Path& path) -> json {
            std::string engine; bool supported = false;
            if (std::filesystem::is_regular_file(path / "Data.wolf") || std::filesystem::exists(path / "Data" / "BasicData.wolf") || std::filesystem::exists(path / "Data" / "BasicData" / "Game.dat")) { engine = "WOLF RPG"; supported = true; }
            else if (std::filesystem::exists(path / "www" / "data" / "System.json")) { engine = "RPG Maker MV"; supported = true; }
            else if (std::filesystem::exists(path / "data" / "System.json")) { engine = std::filesystem::exists(path / "js" / "rmmz_core.js") ? "RPG Maker MZ" : "RPG Maker MV/MZ"; supported = true; }
            else if (std::filesystem::exists(path / "UnityPlayer.dll")) engine = "Unity";
            else for (const auto& entry : std::filesystem::directory_iterator(path, std::filesystem::directory_options::skip_permission_denied)) if (entry.is_directory() && entry.path().filename().string().ends_with("_Data") && std::filesystem::exists(entry.path() / "globalgamemanagers")) { engine = "Unity"; break; }
            if (engine.empty() && unreal::identified(path))
                return {{"path",utf8path::pathUtf8(path)}, {"name",utf8path::pathUtf8(path.filename())}, {"engine",unreal::engine},
                    {"supported",true},{"textSupported",!unreal::localizationFiles(path).empty()}};
            if (engine.empty() && std::filesystem::is_directory(path / "LLMChat-JSON" / "backups")) {
                for (const auto& entry : std::filesystem::directory_iterator(path / "LLMChat-JSON" / "backups")) if (entry.is_directory() && entry.path().filename().string().starts_with("wolf-")) { engine = "WOLF RPG"; supported = true; break; }
            }
            if (engine.empty()) return nullptr;
            return {{"path", utf8path::pathUtf8(path)}, {"name", utf8path::pathUtf8(path.filename())}, {"engine", engine}, {"supported", supported}};
        };
        json result = json::array(); auto direct = identify(root); if (!direct.is_null()) { result.push_back(direct); return result; }
        if (executable) return json::array({{{"path", utf8path::pathUtf8(root)}, {"name", utf8path::pathUtf8(root.filename())}, {"engine", "未知"}, {"supported", false}}});
        for (auto it = std::filesystem::recursive_directory_iterator(root, std::filesystem::directory_options::skip_permission_denied); it != std::filesystem::recursive_directory_iterator(); ++it) if (it->is_directory()) {
            const auto name = it->path().filename().string();
            if (name.starts_with("LLMChat") || name == "MTool" || name == "node_modules" || name == ".git") { it.disable_recursion_pending(); continue; }
            auto game = identify(it->path()); if (!game.is_null()) { result.push_back(game); it.disable_recursion_pending(); }
        }
        return result;
    }
    json detectPatch(const Path& game){std::lock_guard operation(startMutex_);{std::lock_guard lock(mutex_);if(state_.value("state","")=="running")throw std::runtime_error("任务运行中，请完成或暂停后检测补丁");}auto games=detect(game);if(games.size()!=1||!games[0].value("supported",false))throw std::runtime_error("无法识别当前游戏");if(games[0].at("engine").get<std::string>()==unreal::engine)return patchInfo(game);Path data;if(games[0].at("engine").get<std::string>().starts_with("RPG Maker"))data=std::filesystem::exists(game/"www/data/System.json")?Path("www/data"):Path("data");gamepatch::source(game,data,backups(game));return patchInfo(game);}

    explicit JsonEmbedding(Path tools) : tools_(std::move(tools)) {}
    ~JsonEmbedding() { stop_ = true; if (thread_.joinable()) thread_.join(); }
    json status() { std::lock_guard lock(mutex_); return state_; }
    void cancel() { stop_ = true; }
    static json backups(const Path& game) {
        json result = json::array();
        for (bool legacy : {false, true}) {
            const auto root = legacy ? game / "LLMChat-JSON-backup" : game / "LLMChat-JSON" / "backups";
            if (!std::filesystem::is_directory(root)) continue;
            for (const auto& entry : std::filesystem::directory_iterator(root)) if (entry.is_directory() && std::filesystem::is_regular_file(entry.path() / "manifest.json")) {
                auto manifest = json::parse(read(entry.path() / "manifest.json")); const auto name = entry.path().filename().string();
                if (!std::regex_match(name, std::regex("(?:wolf|rpg|files)-[0-9]+"))) continue;
                result.push_back({{"id", (legacy ? "legacy:" : "") + name}, {"order", name.substr(name.find('-') + 1)}, {"path", utf8path::pathUtf8(entry.path())}, {"state", manifest.value("state", "applied")}, {"resources", manifest.at("resources").size()}});
            }
        }
        std::sort(result.begin(), result.end(), [](const json& a, const json& b) { return a.at("order").get<std::string>() > b.at("order").get<std::string>(); }); return result;
    }
    void start(const json& request) {
        std::lock_guard operation(startMutex_);
        const auto action = request.value("action", "inspect");
        { std::lock_guard lock(mutex_); if (state_.value("state", "") == "running") throw std::runtime_error("已有 JSON 嵌入任务正在运行"); if (action == "embed" && state_.value("state", "") != "ready") throw std::runtime_error("请先检查游戏和翻译 JSON"); if (action == "apply" && state_.value("state", "") != "done") throw std::runtime_error("请先生成嵌入补丁"); }
        if (thread_.joinable()) thread_.join(); stop_ = false; jobRequest_=request;
        if(request.value("backupMode","auto")!="auto"&&request.value("backupMode","auto")!="manual")throw std::runtime_error("无效备份方式");
        if (action == "inspect" || action == "extract" || action == "runtime" || action == "uninstall-text" || action == "cleanup-text") {
            jobRequest_ = request;
            game_ = std::filesystem::absolute(utf8path::pathFromUtf8(request.at("gamePath").get<std::string>()));
            selectEngine(); input_ = action == "inspect" ? std::filesystem::absolute(utf8path::pathFromUtf8(request.at("jsonPath").get<std::string>())) : Path();
            if(action!="uninstall-text"&&action!="cleanup-text")work_ = game_ / "LLMChat-JSON" / "work" / ((unreal_ ? "ue-" : rpgDirectory_.empty() ? "wolf-" : "rpg-") + std::to_string(std::chrono::system_clock::now().time_since_epoch().count())); if(action!="uninstall-text"&&action!="cleanup-text")std::filesystem::create_directories(work_);else work_.clear();
            std::lock_guard lock(mutex_); state_ = {{"state", "running"}, {"action", action}, {"outputPath", utf8path::pathUtf8(work_)}, {"gamePath", utf8path::pathUtf8(game_)}, {"jsonPath", utf8path::pathUtf8(input_)}};
        } else if (action == "backup") {
            const auto selectedGame = std::filesystem::absolute(utf8path::pathFromUtf8(request.at("gamePath").get<std::string>()));
            const bool sameGame = !game_.empty() && std::filesystem::equivalent(game_, selectedGame); game_ = selectedGame;
            selectEngine();
            std::lock_guard lock(mutex_); const auto previous = state_.value("state", "idle");
            const auto resume = sameGame && (previous == "ready" || previous == "done") ? previous : "backedUp";
            if (resume == "backedUp") state_ = {{"gamePath", utf8path::pathUtf8(game_)}};
            state_["state"] = "running"; state_["action"] = action; state_["resumeAfterBackup"] = resume;
        } else if (action == "rollback") {
            game_ = std::filesystem::absolute(utf8path::pathFromUtf8(request.at("gamePath").get<std::string>()));
            const auto id = request.at("backupId").get<std::string>();
            const auto list = backups(game_); Path backup; bool blocked = false;
            for (const auto& item : list) { if (item.at("id") == id) { backup = utf8path::pathFromUtf8(item.at("path").get<std::string>()); break; } if (item.at("state") != "rolledBack") blocked = true; }
            if (backup.empty() || blocked) throw std::runtime_error("请先回滚最新一份未恢复的备份");
            const auto receipt=json::parse(read(backup/"manifest.json"));if(receipt.value("managedPatch",false)&&receipt.contains("patchBefore")&&receipt["patchBefore"].value("installed",false)&&gamepatch::record(game_).is_null())throw std::runtime_error("文本补丁安装原件已清理，无法恢复这份旧补丁状态；请选择原始资源备份");
            { std::lock_guard lock(mutex_); state_ = {{"state", "running"}, {"action", action}, {"gamePath", utf8path::pathUtf8(game_)}, {"backupPath", utf8path::pathUtf8(backup)}, {"detail", "正在恢复原资源"}}; }
            thread_ = std::thread([this, backup] {
                try {
                    restoreBackup(backup);
                    gamepatch::afterRestore(game_, backup);
                    auto manifest = json::parse(read(backup / "manifest.json"));
                    manifest["state"] = "rolledBack";
                    gamefiles::ledger(backup, manifest, true);
                    std::lock_guard lock(mutex_);
                    state_["state"] = "rolledBack";
                    state_["detail"] = "原资源已恢复，替换前的资源保留在备份 retained 中";
                } catch (const std::exception& e) {
                    std::lock_guard lock(mutex_);
                    state_["state"] = "error";
                    state_["detail"] = json::parse(json(e.what()).dump(-1, ' ', false, json::error_handler_t::replace));
                }
            });
            return;
        } else if (action == "embed" || action == "apply") { std::lock_guard lock(mutex_); state_["state"] = "running"; state_["action"] = action; }
        else throw std::runtime_error("未知 JSON 嵌入操作");
        thread_ = std::thread([this, action] { try { if (action == "inspect") inspect(); else if (action == "extract") extract(); else if (action == "runtime") installRuntime(); else if (action == "embed") embed(); else if (action == "backup") backupOnly(); else if(action=="uninstall-text"){detail("卸载文本补丁");const auto receipt=gamepatch::uninstall(game_);std::lock_guard lock(mutex_);state_["backupPath"]=utf8path::pathUtf8(receipt);state_["state"]="uninstalled";state_["detail"]="文本补丁已卸载，原资源已恢复";}else if(action=="cleanup-text"){gamepatch::cleanup(game_);std::lock_guard lock(mutex_);state_["state"]="cleaned";state_["detail"]="已清理卸载后的文本补丁安装文件，用户备份保留";}else apply(); finishBackupMode(action); } catch (const std::exception& e) { std::lock_guard lock(mutex_); state_["state"] = stop_?"stopped":"error"; state_["detail"] = stop_?"操作已中止":json::parse(json(e.what()).dump(-1, ' ', false, json::error_handler_t::replace)); dictionary_.clear(); } });
    }
};
