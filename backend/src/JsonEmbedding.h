#pragma once
#include "Utf8Path.h"
#include "AtomicFile.h"
#include "RpgMakerText.h"
#include "GameFileOps.h"
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
    json state_ = {{"state", "idle"}}, dictionary_; Path game_, input_, work_, tools_;
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
    void remember(const Path& path) { originals_[path] = {std::filesystem::file_size(path), std::filesystem::last_write_time(path)}; }
    void detail(const std::string& value) { std::lock_guard lock(mutex_); state_["detail"] = value; state_["completed"] = 0; state_["total"] = 0; }
    void progress(size_t completed, size_t total) { std::lock_guard lock(mutex_); state_["completed"] = completed; state_["total"] = total; }
    void checkStop() { if (stop_) throw std::runtime_error("嵌入操作已中止，原游戏未修改"); }
    void runTool(const std::string& name, const std::vector<std::wstring>& args) {
        checkStop(); const auto executable = tools_ / name;
        if (!std::filesystem::exists(executable)) throw std::runtime_error("缺少 WOLF 工具 " + name + "，请先准备 resources/wolf");
#ifdef _WIN32
        std::wstring command = L"\"" + executable.wstring() + L"\"";
        for (const auto& arg : args) command += L" \"" + arg + L"\"";
        SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
        HANDLE log = CreateFileW((work_ / "tools.log").c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (log == INVALID_HANDLE_VALUE) throw std::runtime_error("无法创建工具日志");
        STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES; startup.hStdOutput = log; startup.hStdError = log; startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        PROCESS_INFORMATION process{};
        const bool ok = CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, work_.c_str(), &startup, &process);
        CloseHandle(log); if (!ok) throw std::runtime_error("无法启动工具：" + name);
        CloseHandle(process.hThread);
        while (WaitForSingleObject(process.hProcess, 100) == WAIT_TIMEOUT) if (stop_) { TerminateProcess(process.hProcess, 2); WaitForSingleObject(process.hProcess, INFINITE); CloseHandle(process.hProcess); checkStop(); }
        DWORD code; GetExitCodeProcess(process.hProcess, &code); CloseHandle(process.hProcess);
        if (code != 0) throw std::runtime_error(name + " 处理失败，请查看输出目录 tools.log");
#else
        throw std::runtime_error("WOLF 嵌入目前仅支持 Windows");
#endif
    }
    static std::vector<std::string> controls(const std::string& value) {
        static const std::regex pattern(R"(\\[A-Za-z]+(?:\[[^\]\r\n]*\])?)");
        std::vector<std::string> result; for (auto it = std::sregex_iterator(value.begin(), value.end(), pattern); it != std::sregex_iterator(); ++it) result.push_back(it->str());
        std::sort(result.begin(), result.end()); return result;
    }
    bool replace(std::string& source) {
        if (source.empty()) return false; ++examined_;
        if (exporting_) { dictionary_[source] = ""; return false; }
        const auto it = dictionary_.find(source); if (it == dictionary_.end()) return false;
        const auto target = it->get<std::string>(); if (target.empty() || target == source) return false;
        if ((rpgDirectory_.empty() ? controls(source) != controls(target) : rpgControls(source) != rpgControls(target)) || (rpgDirectory_.empty() && (target[0] == '/' || target.find("\n/") != std::string::npos))) { ++blocked_; issues_.push_back({{"file",context_},{"source",source},{"translation",target},{"reason","译文控制符与原文不一致"}}); return false; }
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
        const auto source = game_ / "Data", data = work_ / "Data"; std::filesystem::create_directories(data);
        originals_.clear();
        if (!std::filesystem::is_directory(source)) throw std::runtime_error("游戏目录缺少 Data 文件夹");
        bool found = false;
        for (const auto& entry : std::filesystem::directory_iterator(source)) {
            const auto stem = entry.path().stem().string();
            if (stem != "BasicData" && stem != "MapData" && !stem.starts_with("Evtext")) continue;
            if (entry.is_directory()) { for (const auto& file : std::filesystem::recursive_directory_iterator(entry.path())) if (file.is_regular_file()) remember(file.path()); std::filesystem::copy(entry.path(), data / entry.path().filename(), std::filesystem::copy_options::recursive); found = true; }
            else if (entry.path().extension() == ".wolf") {
                found = true; remember(entry.path()); const auto copy = data / entry.path().filename(); std::filesystem::copy_file(entry.path(), copy);
                detail("解包：" + utf8path::pathUtf8(entry.path().filename()));
                runTool("DxaDecode.exe", {L"-K:WLFRPrO!p(;s5((8P@((UFWlu$#5(=", copy.wstring()});
                const auto folder = data / entry.path().stem();
                if (!std::filesystem::is_directory(folder) || std::filesystem::is_empty(folder)) throw std::runtime_error("解包结果为空：" + utf8path::pathUtf8(entry.path().filename()));
            }
        }
        if (!found) throw std::runtime_error("目前支持 WOLF 的 BasicData、MapData、Evtext 资源包或解包目录");
        detail("提取事件、地图与数据库文本"); runTool("WolfTL.exe", {data.wstring(), work_.wstring(), L"--create"});
        if (!std::filesystem::is_directory(work_ / "dump")) throw std::runtime_error("没有生成可回写的文本定位数据");
    }
    void inspect() {
        detail("读取翻译 JSON"); dictionary_ = json::parse(read(input_));
        if (!dictionary_.is_object() || dictionary_.empty()) throw std::runtime_error("需要原文到译文的非空 JSON 对象");
        for (const auto& value : dictionary_) if (!value.is_string()) throw std::runtime_error("JSON 不是 MTool 原文到译文格式，值必须全部是文本");
        inputTime_ = std::filesystem::last_write_time(input_); inputSize_ = std::filesystem::file_size(input_);
        if (rpgDirectory_.empty()) prepareWolf(); else prepareRpg();
        detail("匹配译文并检查控制符"); if (rpgDirectory_.empty()) scan(false); else scanRpg(false);
        std::lock_guard lock(mutex_); state_["dictionaryEntries"] = dictionary_.size(); state_["state"] = "ready"; state_["detail"] = "检查完成，可生成嵌入补丁";
    }
    void embed() {
        if (std::filesystem::file_size(input_) != inputSize_ || std::filesystem::last_write_time(input_) != inputTime_) throw std::runtime_error("翻译 JSON 已改变，请重新检查");
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
    void apply() {
        for (const auto& [path, stamp] : originals_) if (!std::filesystem::is_regular_file(path) || std::filesystem::file_size(path) != stamp.first || std::filesystem::last_write_time(path) != stamp.second) throw std::runtime_error("游戏资源已改变，请重新检查后生成补丁");
        if (!rpgDirectory_.empty()) { applyRpg(); return; }
        const auto backup = game_ / "LLMChat-JSON" / "backups" / ("wolf-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        const auto staging = game_ / "LLMChat-JSON" / "staging" / work_.filename();
        struct StagingCleanup { Path path; ~StagingCleanup() { std::error_code error; std::filesystem::remove_all(path, error); } } cleanup{staging};
        std::filesystem::create_directories(backup / "Data"); std::filesystem::create_directories(staging);
        struct Item { Path name; bool directory = false, archive = false, installed = false; };
        std::vector<Item> items; json files = json::array();
        for (const auto& entry : std::filesystem::directory_iterator(work_ / "patch" / "Data")) if (entry.is_directory()) {
            const auto name = entry.path().filename(); const auto text = name.string();
            if (text != "BasicData" && text != "MapData" && !text.starts_with("Evtext")) throw std::runtime_error("补丁包含不支持的资源目录");
            detail("准备应用：" + text); checkStop();
            std::filesystem::copy(entry.path(), staging / name, std::filesystem::copy_options::recursive);
            items.push_back({name});
            files.push_back({{"name", text}, {"hadArchive", std::filesystem::exists(game_ / "Data" / (text + ".wolf"))}, {"hadDirectory", std::filesystem::exists(game_ / "Data" / name)}});
        }
        json ledger = {{"version", 2}, {"game", utf8path::pathUtf8(game_)}, {"state", "applying"}, {"resources", files}};
        saveLedger(backup, ledger);
        write(backup / "恢复说明.txt", "先关闭游戏，在 JSON 嵌入页读取游戏目录的备份并回滚。软件会把替换后的目录保留至本备份 retained，再恢复原资源。\n手动恢复时也请先移开当前同名目录保留改动，再将本目录 Data 中的原件移回游戏 Data；不要覆盖后来更新的同名资源。\n");
        { std::lock_guard lock(mutex_); state_["backupPath"] = utf8path::pathUtf8(backup); }
        try {
            size_t completed = 0; progress(0, items.size());
            for (auto& item : items) {
                checkStop(); const auto target = game_ / "Data" / item.name; auto archive = target; archive += ".wolf";
                if (std::filesystem::exists(archive)) { std::filesystem::rename(archive, backup / "Data" / archive.filename()); item.archive = true; }
                if (std::filesystem::exists(target)) { std::filesystem::rename(target, backup / "Data" / item.name); item.directory = true; }
                std::filesystem::rename(staging / item.name, target); item.installed = true;
                progress(++completed, items.size());
            }
        } catch (const std::exception& error) {
            std::string failure = error.what();
            try {
                restoreBackup(backup);
            } catch (...) { throw std::runtime_error("应用失败，自动恢复未完成。请从备份目录恢复：" + utf8path::pathUtf8(backup)); }
            throw std::runtime_error("应用失败，原资源已恢复：" + failure);
        }
        std::filesystem::remove_all(staging);
        ledger["state"] = "applied"; saveLedger(backup, ledger);
        std::lock_guard lock(mutex_); state_["state"] = "applied"; state_["detail"] = "已应用到游戏，原资源已保留备份。请运行 GamePro.exe 验证。";
    }
    static void saveLedger(const Path& backup, const json& ledger) {
        std::string error; if (!atomicfile::writeText(backup / "manifest.json", ledger.dump(2), &error)) throw std::runtime_error(error);
    }
    static bool resourceName(const std::string& name) { return name == "BasicData" || name == "MapData" || std::regex_match(name, std::regex("Evtext[A-Za-z0-9_-]*")); }
    void backupOnly() {
        if (!rpgDirectory_.empty()) { if(!jobRequest_.contains("backupScopes")&&jobRequest_.value("backupScope","text")=="text")backupRpg();else backupAssets(); return; }
        const auto backup = game_ / "LLMChat-JSON" / "backups" / ("wolf-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        std::filesystem::create_directories(backup / "Data"); std::map<std::string, json> resources; std::vector<Path> files;
        for (const auto& entry : std::filesystem::directory_iterator(game_ / "Data")) {
            const auto name = entry.is_directory() ? entry.path().filename().string() : entry.path().stem().string();
            if (!resourceName(name)) continue;
            auto& item = resources[name]; if (item.is_null()) item = {{"name", name}, {"hadArchive", false}, {"hadDirectory", false}};
            if (entry.is_directory()) { item["hadDirectory"] = true; for (const auto& file : std::filesystem::recursive_directory_iterator(entry.path())) if (file.is_regular_file()) files.push_back(file.path()); }
            else if (entry.path().extension() == ".wolf") { item["hadArchive"] = true; files.push_back(entry.path()); }
        }
        if (files.empty()) throw std::runtime_error("没有找到可备份的 WOLF 文字资源");
        detail("备份原资源"); size_t completed = 0; progress(0, files.size());
        for (const auto& file : files) { checkStop(); const auto target = backup / "Data" / std::filesystem::relative(file, game_ / "Data"); std::filesystem::create_directories(target.parent_path()); std::filesystem::copy_file(file, target); progress(++completed, files.size()); }
        json entries = json::array(); for (const auto& [name, item] : resources) entries.push_back(item);
        saveLedger(backup, {{"version", 2}, {"kind", "snapshot"}, {"state", "snapshot"}, {"resources", entries}});
        std::lock_guard lock(mutex_); state_["state"] = state_.value("resumeAfterBackup", "backedUp"); state_.erase("resumeAfterBackup"); state_["backupPath"] = utf8path::pathUtf8(backup); state_["detail"] = "备份完成，游戏资源未改变";
    }
    void restoreBackup(const Path& backup) {
        detail("正在恢复原资源");
        auto ledger = json::parse(read(backup / "manifest.json"));
        if (ledger.value("engine", "") == "files") { gamefiles::restore(game_, backup); return; }
        if (ledger.value("engine", "") == "rpgmaker") { restoreRpg(backup, ledger); return; }
        if (ledger.value("state", "") == "rolledBack") return;
        auto resources = ledger.at("resources");
        for (auto& entry : resources) {
            if (entry.is_string()) { const auto name = entry.get<std::string>(); entry = {{"name", name}, {"hadArchive", std::filesystem::exists(backup / "Data" / (name + ".wolf"))}, {"hadDirectory", std::filesystem::is_directory(backup / "Data" / name)}}; }
            const auto name = entry.at("name").get<std::string>();
            if (!resourceName(name)) throw std::runtime_error("备份包含无效资源名称");
            if (entry.value("restored", false)) continue;
            const auto originalPack = backup / "Data" / (name + ".wolf"), currentPack = game_ / "Data" / (name + ".wolf");
            if (std::filesystem::exists(originalPack) && std::filesystem::exists(currentPack) && ledger.value("kind", "") != "snapshot") throw std::runtime_error("当前存在同名资源包，回滚已停止以避免覆盖：" + name);
            if (entry.value("hadArchive", false) && !std::filesystem::exists(originalPack) && !std::filesystem::exists(currentPack)) throw std::runtime_error("备份原资源缺失：" + name);
            if (entry.value("hadDirectory", false) && !std::filesystem::exists(backup / "Data" / name) && !std::filesystem::exists(game_ / "Data" / name)) throw std::runtime_error("备份原目录缺失：" + name);
        }
        ledger["resources"] = resources; ledger["state"] = "rollingBack"; saveLedger(backup, ledger);
        size_t completed = 0; progress(0, resources.size());
        for (auto& entry : ledger["resources"]) {
            if (entry.value("restored", false)) { progress(++completed, resources.size()); continue; }
            const auto name = entry.at("name").get<std::string>(); const auto target = game_ / "Data" / name;
            const auto directory = backup / "Data" / name, archive = backup / "Data" / (name + ".wolf");
            const bool restoreDirectory = std::filesystem::exists(directory), restoreArchive = std::filesystem::exists(archive);
            if (std::filesystem::exists(target) && (restoreDirectory || (!entry.value("hadDirectory", false) && restoreArchive))) {
                auto retained = backup / "retained" / name; int number = 2;
                while (std::filesystem::exists(retained)) retained = backup / "retained" / (name + "-" + std::to_string(number++));
                std::filesystem::create_directories(retained.parent_path()); std::filesystem::rename(target, retained);
            }
            if (restoreDirectory) std::filesystem::rename(directory, target);
            if (restoreArchive) {
                const auto current = game_ / "Data" / (name + ".wolf");
                if (std::filesystem::exists(current)) { auto retained = backup / "retained" / (name + ".wolf"); int number = 2; while (std::filesystem::exists(retained)) retained = backup / "retained" / (name + "-" + std::to_string(number++) + ".wolf"); std::filesystem::create_directories(retained.parent_path()); std::filesystem::rename(current, retained); }
                std::filesystem::rename(archive, current);
            }
            entry["restored"] = true; saveLedger(backup, ledger);
            progress(++completed, resources.size());
        }
        ledger["state"] = "rolledBack"; saveLedger(backup, ledger);
    }
    static std::vector<std::string> rpgControls(const std::string& value) {
        static const std::regex pattern(R"(\\(?:[A-Za-z]+(?:\[[^\]\r\n]*\])?|[{}.!|><^$\\])|%[1-9][0-9]*)");
        std::vector<std::string> result;
        for (auto it = std::sregex_iterator(value.begin(), value.end(), pattern); it != std::sregex_iterator(); ++it) result.push_back(it->str());
        std::sort(result.begin(), result.end()); return result;
    }
    void selectEngine() {
        rpgDirectory_.clear();
        const auto found = detect(game_);
        if (found.size() != 1 || utf8path::pathFromUtf8(found[0].at("path").get<std::string>()) != game_ || !found[0].value("supported", false)) throw std::runtime_error("请选择支持提取与回写的 WOLF 或 RPG Maker MV/MZ 游戏");
        if (found[0].at("engine").get<std::string>().starts_with("RPG Maker")) rpgDirectory_ = std::filesystem::exists(game_ / "www" / "data" / "System.json") ? Path("www") / "data" : Path("data");
    }
    std::vector<Path> rpgFiles(const Path& directory) {
        std::vector<Path> files;
        for (const auto& entry : std::filesystem::directory_iterator(directory)) if (entry.is_regular_file() && rpgtext::dataFile(entry.path().filename().string())) files.push_back(entry.path());
        std::sort(files.begin(), files.end()); return files;
    }
    void prepareRpg() {
        originals_.clear(); const auto files = rpgFiles(game_ / rpgDirectory_); size_t completed = 0;
        detail("读取 RPG Maker 地图、事件与数据库"); progress(0, files.size());
        for (const auto& file : files) { checkStop(); remember(file); write(work_ / "source" / file.filename(), read(file)); progress(++completed, files.size()); }
    }
    void scanPlugins(bool save) {
        const auto source=game_/rpgDirectory_.parent_path()/"js/plugins.js";
        if(!std::filesystem::exists(source))return;
        const auto raw=read(source);const auto first=raw.find('['),last=raw.find_last_of(']');
        if(first==std::string::npos||last==std::string::npos)throw std::runtime_error("plugins.js 不是标准插件列表");
        auto plugins=json::parse(raw.substr(first,last-first+1));const auto before=matched_;
        for(auto& plugin:plugins)if(plugin.value("status",false)&&(plugin.value("name","")=="DTextPicture"||plugin.value("name","")=="TextPicture")&&plugin.contains("parameters"))rpgtext::pluginText(plugin["parameters"],[this](std::string& text){return replace(text);});
        if(save&&matched_!=before)write(work_/"patch"/rpgDirectory_.parent_path()/"js/plugins.js",raw.substr(0,first)+plugins.dump(2)+raw.substr(last+1));
        if(!save)remember(source);
    }
    void scanRpg(bool save) {
        matched_ = blocked_ = examined_ = 0; issues_=json::array(); const auto files = rpgFiles(work_ / "source"); size_t completed = 0;
        detail(exporting_ ? "提取 RPG Maker 显示文本" : "匹配 RPG Maker 显示文本"); progress(0, files.size());
        for (const auto& file : files) {
            checkStop(); context_=file.filename().string(); auto value = json::parse(read(file)); const auto before = matched_;
            rpgtext::visit(file.filename().string(), value, [this](std::string& text) { return replace(text); });
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
        dictionary_ = json::object(); exporting_ = true;
        try { if (rpgDirectory_.empty()) { prepareWolf(); scan(false); } else { prepareRpg(); scanRpg(false); } }
        catch (...) { exporting_ = false; throw; }
        exporting_ = false;
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
            if (!rpgtext::dataFile(name) || !std::filesystem::is_regular_file(backup / "original" / name)) throw std::runtime_error("备份原资源缺失或名称无效：" + name);
        }
        ledger["state"] = "rollingBack"; saveLedger(backup, ledger); size_t completed = 0; progress(0, ledger["resources"].size());
        for (auto& item : ledger["resources"]) {
            if (!item.value("restored", false)) {
                const auto name = item.at("name").get<std::string>(); const auto target = game_ / utf8path::pathFromUtf8(directory) / name;
                const auto staging = backup / "restore" / name; write(staging, read(backup / "original" / name));
                if (std::filesystem::exists(target)) {
                    auto retained = backup / "retained" / name; int number = 2;
                    while (std::filesystem::exists(retained)) retained = backup / "retained" / (name + "-" + std::to_string(number++));
                    std::filesystem::create_directories(retained.parent_path()); std::filesystem::rename(target, retained);
                }
                std::filesystem::create_directories(target.parent_path()); std::filesystem::rename(staging, target); item["restored"] = true; saveLedger(backup, ledger);
            }
            progress(++completed, ledger["resources"].size());
        }
        ledger["state"] = "rolledBack"; saveLedger(backup, ledger);
    }
    void applyRpg() {
        const auto files = rpgFiles(work_ / "patch" / rpgDirectory_);
        const auto pluginPath=rpgDirectory_.parent_path()/"js/plugins.js";
        if(std::filesystem::exists(work_/"patch"/pluginPath)){std::map<Path,std::string> output;for(auto& file:files)output[rpgDirectory_/file.filename()]=read(file);output[pluginPath]=read(work_/"patch"/pluginPath);const auto backup=gamefiles::apply(game_,output);std::lock_guard lock(mutex_);state_["state"]="applied";state_["backupPath"]=utf8path::pathUtf8(backup);state_["detail"]="译文及插件文本已应用，原资源已备份";return;}
        if (files.empty()) throw std::runtime_error("补丁中没有可应用的资源");
        const auto backup = rpgBackup(files, "patch"); auto ledger = json::parse(read(backup / "manifest.json"));
        try {
            detail("应用 RPG Maker 译文"); size_t completed = 0; progress(0, files.size());
            for (const auto& file : files) {
                checkStop(); const auto staging = backup / "install" / file.filename(); write(staging, read(file));
                const auto target = game_ / rpgDirectory_ / file.filename();
#ifdef _WIN32
                if (!MoveFileExW(staging.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) throw std::runtime_error("无法替换游戏资源：" + file.filename().string());
#else
                std::filesystem::rename(staging, target);
#endif
                progress(++completed, files.size());
            }
        } catch (const std::exception& error) {
            const auto reason = std::string(error.what());
            try { restoreRpg(backup, ledger); } catch (...) { throw std::runtime_error("应用失败，自动恢复未完成，请从备份恢复：" + utf8path::pathUtf8(backup)); }
            throw std::runtime_error("应用失败，原资源已恢复：" + reason);
        }
        ledger["state"] = "applied"; saveLedger(backup, ledger);
        std::lock_guard lock(mutex_); state_["state"] = "applied"; state_["detail"] = "译文已应用，原资源已备份";
    }
    void backupAssets() {
        const auto scopes=jobRequest_.contains("backupScopes")?jobRequest_.at("backupScopes").get<std::vector<std::string>>():std::vector<std::string>{jobRequest_.value("backupScope","text")};
        if(scopes.empty())throw std::runtime_error("请选择至少一项备份范围");
        std::vector<Path> files;const auto prefix=rpgDirectory_.parent_path();
        for(const auto& scope:scopes) {
            if(scope=="text") { for(auto& file:rpgFiles(game_/rpgDirectory_))files.push_back(std::filesystem::relative(file,game_));if(std::filesystem::exists(game_/prefix/"js/plugins.js"))files.push_back(prefix/"js/plugins.js"); }
            else if(scope=="runtime") {const std::vector<Path> names={prefix/"js/plugins.js",prefix/"js/plugins/LLMChatTranslation.js",prefix/"LLMChat-translations.json",prefix/"fonts/LLMChat-font.ttf",prefix/"fonts/LLMChat-font.otf"};files.insert(files.end(),names.begin(),names.end());}
            else if(scope=="images"){const auto root=game_/prefix/"img";for(auto& entry:std::filesystem::recursive_directory_iterator(root))if(entry.is_regular_file()){auto ext=entry.path().extension().string();if(ext==".png"||ext==".png_"||ext==".rpgmvp")files.push_back(std::filesystem::relative(entry.path(),game_));}}
            else throw std::runtime_error("无效备份范围");
        }
        std::sort(files.begin(),files.end());files.erase(std::unique(files.begin(),files.end()),files.end());
        const auto backup=game_/"LLMChat-JSON"/"backups"/("files-"+std::to_string(std::chrono::system_clock::now().time_since_epoch().count()));
        json ledger={{"engine","files"},{"kind","snapshot"},{"state","snapshot"},{"resources",json::array()}};detail("备份所选资源");progress(0,files.size());size_t completed=0;
        for(auto& name:files){checkStop();const bool exists=std::filesystem::is_regular_file(game_/name);if(exists)write(backup/"original"/name,read(game_/name));ledger["resources"].push_back({{"name",name.generic_string()},{"existed",exists}});progress(++completed,files.size());}saveLedger(backup,ledger);
        std::lock_guard lock(mutex_);state_["state"]=state_.value("resumeAfterBackup","backedUp");state_.erase("resumeAfterBackup");state_["backupPath"]=utf8path::pathUtf8(backup);state_["detail"]="备份完成，游戏资源未改变";
    }
    void finishBackupMode(const std::string& action) {
        if(jobRequest_.value("backupMode","auto")!="manual" || (action!="apply"&&action!="runtime"&&action!="images-apply"))return;
        Path backup;{std::lock_guard lock(mutex_);if(state_.value("state","")!="applied"||!state_.contains("backupPath"))return;backup=utf8path::pathFromUtf8(state_["backupPath"].get<std::string>());}
        if(backup.parent_path().lexically_normal()!=(game_/"LLMChat-JSON"/"backups").lexically_normal())throw std::runtime_error("临时恢复目录不在当前游戏备份目录中");
        std::filesystem::remove_all(backup);
        std::lock_guard lock(mutex_);state_.erase("backupPath");state_["detail"]="已应用到游戏（手动备份模式）";
    }
    static std::string pngCodec(std::string bytes, const std::string& key, bool encrypt) {
        const std::string header = std::string("RPGMV\0\0\0\0\3\1\0\0\0\0\0",16);
        if (key.size()!=32) throw std::runtime_error("System.json 中缺少有效的图片加密密钥");
        if (!encrypt) { if(bytes.size()<32 || bytes.substr(0,16)!=header)throw std::runtime_error("不是标准 MV/MZ 加密图片");bytes.erase(0,16); }
        if(bytes.size()<16)throw std::runtime_error("图片文件过短");
        for(size_t i=0;i<16;++i){auto part=key.substr(i*2,2);if(part.find_first_not_of("0123456789abcdefABCDEF")!=std::string::npos)throw std::runtime_error("无效的图片密钥");bytes[i]^=static_cast<char>(std::stoi(part,nullptr,16));}
        return encrypt?header+bytes:bytes;
    }
    void assetJob(const std::string& action) {
        if(rpgDirectory_.empty())throw std::runtime_error("此功能适用于 RPG Maker MV/MZ");
        const auto base=rpgDirectory_.parent_path();
        if(action=="runtime") {
            detail("准备本地翻译插件");auto dictionary=json::parse(read(utf8path::pathFromUtf8(jobRequest_.at("jsonPath"))));
            if(!dictionary.is_object())throw std::runtime_error("翻译 JSON 必须为原文到译文对象");for(auto& value:dictionary)if(!value.is_string())throw std::runtime_error("译文必须为字符串");
            auto original=read(game_/base/"js/plugins.js");auto begin=original.find('['),end=original.find_last_of(']');if(begin==std::string::npos||end==std::string::npos)throw std::runtime_error("无法解析 plugins.js");
            auto plugins=json::parse(original.substr(begin,end-begin+1));if(!plugins.is_array())throw std::runtime_error("插件列表格式错误");
            plugins.erase(std::remove_if(plugins.begin(),plugins.end(),[](const json& p){return p.value("name","")=="LLMChatTranslation";}),plugins.end());
            plugins.push_back({{"name","LLMChatTranslation"},{"status",true},{"description","Local translation"},{"parameters",json::object()}});
            std::map<Path,std::string> files;auto script=std::string(mvMzRuntime);std::string font;
            const auto fontPath=jobRequest_.value("fontPath","");
            if(!fontPath.empty()){auto path=utf8path::pathFromUtf8(fontPath);auto ext=path.extension().string();if(ext!=".ttf"&&ext!=".otf")throw std::runtime_error("请选择 TTF/OTF 字体");font="LLMChat-font"+ext;files[base/"fonts"/font]=read(path);}
            script.replace(script.find("__FONT__"),8,font);
            files[base/"js/plugins/LLMChatTranslation.js"]=script;files[base/"LLMChat-translations.json"]=dictionary.dump();files[base/"js/plugins.js"]=original.substr(0,begin)+plugins.dump(2)+original.substr(end+1);
            const auto backup=gamefiles::apply(game_,files);std::lock_guard lock(mutex_);state_["backupPath"]=utf8path::pathUtf8(backup);state_["state"]="applied";state_["detail"]="本地翻译插件已安装；回滚对应备份可卸载";return;
        }
        auto system=json::parse(read(game_/rpgDirectory_/"System.json"));const auto key=system.value("encryptionKey","");
        if(action=="images-export") {
            detail("解密并导出图片");json entries=json::array();std::vector<Path> files;const auto root=game_/base/"img";
            for(auto& file:std::filesystem::recursive_directory_iterator(root))if(file.is_regular_file()){auto ext=file.path().extension().string();if(ext==".png"||ext==".rpgmvp"||ext==".png_")files.push_back(file.path());}
            progress(0,files.size());size_t n=0;
            for(auto& file:files){checkStop();auto relative=std::filesystem::relative(file,root);const bool encrypted=file.extension()!=".png";auto bytes=read(file);if(encrypted)bytes=pngCodec(bytes,key,false);if(bytes.substr(0,8)!=std::string("\x89PNG\r\n\x1a\n",8))throw std::runtime_error("图片解密失败："+utf8path::pathUtf8(relative));auto name=std::to_string(n)+"-"+utf8path::pathUtf8(relative.stem())+".png";write(work_/"images"/utf8path::pathFromUtf8(name),bytes);entries.push_back({{"source",utf8path::pathUtf8(base/"img"/relative)},{"image",name},{"encrypted",encrypted}});progress(++n,files.size());}
            write(work_/"images.json",entries.dump(2));std::lock_guard lock(mutex_);state_["state"]="exported";state_["imagesPath"]=utf8path::pathUtf8(work_/"images");state_["imageManifest"]=utf8path::pathUtf8(work_/"images.json");state_["detail"]="图片已解密导出";return;
        }
        auto manifestPath=utf8path::pathFromUtf8(jobRequest_.at("imageManifest"));auto entries=json::parse(read(manifestPath));const auto edited=utf8path::pathFromUtf8(jobRequest_.at("editedDirectory"));std::map<Path,std::string> files;size_t n=0;detail("检查图片并重新加密");progress(0,entries.size());
        for(auto& entry:entries){checkStop();auto name=gamefiles::relative(entry.at("image"));if(!std::filesystem::exists(edited/name)){progress(++n,entries.size());continue;}auto bytes=read(edited/name);auto source=gamefiles::relative(entry.at("source"));auto generic=source.generic_string();if(!(generic.starts_with("img/")||generic.starts_with("www/img/")))throw std::runtime_error("图片资源路径无效");auto before=read(game_/source);if(entry.at("encrypted").get<bool>())before=pngCodec(before,key,false);if(bytes==before){progress(++n,entries.size());continue;}
            if(bytes.size()<24||bytes.substr(0,8)!=std::string("\x89PNG\r\n\x1a\n",8)||bytes.substr(16,8)!=before.substr(16,8))throw std::runtime_error("译图必须是尺寸不变的 PNG："+utf8path::pathUtf8(name));files[source]=entry.at("encrypted").get<bool>()?pngCodec(bytes,key,true):bytes;progress(++n,entries.size());}
        if(files.empty())throw std::runtime_error("未找到有改动的译图，请选择保留导出文件名的译图目录");auto backup=gamefiles::apply(game_,files);std::lock_guard lock(mutex_);state_["backupPath"]=utf8path::pathUtf8(backup);state_["state"]="applied";state_["detail"]="译图已应用，原图片已备份";
    }
public:
    static json detect(const Path& input) {
        auto root = std::filesystem::absolute(input); const bool executable = std::filesystem::is_regular_file(root); if (executable) root = root.parent_path();
        if (!std::filesystem::is_directory(root)) throw std::runtime_error("请选择存在的游戏目录或主程序");
        auto identify = [](const Path& path) -> json {
            std::string engine; bool supported = false;
            if (std::filesystem::exists(path / "Data" / "BasicData.wolf") || std::filesystem::exists(path / "Data" / "BasicData" / "Game.dat")) { engine = "WOLF RPG"; supported = true; }
            else if (std::filesystem::exists(path / "www" / "data" / "System.json")) { engine = "RPG Maker MV"; supported = true; }
            else if (std::filesystem::exists(path / "data" / "System.json")) { engine = std::filesystem::exists(path / "js" / "rmmz_core.js") ? "RPG Maker MZ" : "RPG Maker MV/MZ"; supported = true; }
            else if (std::filesystem::exists(path / "UnityPlayer.dll")) engine = "Unity";
            else for (const auto& entry : std::filesystem::directory_iterator(path, std::filesystem::directory_options::skip_permission_denied)) if (entry.is_directory() && entry.path().filename().string().ends_with("_Data") && std::filesystem::exists(entry.path() / "globalgamemanagers")) { engine = "Unity"; break; }
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
        if (action == "inspect" || action == "extract" || action == "runtime" || action == "images-export" || action == "images-apply") {
            jobRequest_ = request;
            game_ = std::filesystem::absolute(utf8path::pathFromUtf8(request.at("gamePath").get<std::string>()));
            selectEngine(); input_ = action == "inspect" ? std::filesystem::absolute(utf8path::pathFromUtf8(request.at("jsonPath").get<std::string>())) : Path();
            work_ = game_ / "LLMChat-JSON" / "work" / ((rpgDirectory_.empty() ? "wolf-" : "rpg-") + std::to_string(std::chrono::system_clock::now().time_since_epoch().count())); std::filesystem::create_directories(work_);
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
            { std::lock_guard lock(mutex_); state_ = {{"state", "running"}, {"action", action}, {"gamePath", utf8path::pathUtf8(game_)}, {"backupPath", utf8path::pathUtf8(backup)}, {"detail", "正在恢复原资源"}}; }
            thread_ = std::thread([this, backup] { try { restoreBackup(backup); std::lock_guard lock(mutex_); state_["state"] = "rolledBack"; state_["detail"] = "原资源已恢复；替换后的目录保留在备份 retained 中"; } catch (const std::exception& e) { std::lock_guard lock(mutex_); state_["state"] = "error"; state_["detail"] = json::parse(json(e.what()).dump(-1, ' ', false, json::error_handler_t::replace)); } });
            return;
        } else if (action == "embed" || action == "apply") { std::lock_guard lock(mutex_); state_["state"] = "running"; state_["action"] = action; }
        else throw std::runtime_error("未知 JSON 嵌入操作");
        thread_ = std::thread([this, action] { try { if (action == "inspect") inspect(); else if (action == "extract") extract(); else if (action == "runtime" || action == "images-export" || action == "images-apply") assetJob(action); else if (action == "embed") embed(); else if (action == "backup") backupOnly(); else apply(); finishBackupMode(action); } catch (const std::exception& e) { std::lock_guard lock(mutex_); state_["state"] = "error"; state_["detail"] = json::parse(json(e.what()).dump(-1, ' ', false, json::error_handler_t::replace)); dictionary_.clear(); } });
    }
};
