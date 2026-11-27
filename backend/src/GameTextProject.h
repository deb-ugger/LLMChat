#pragma once
#include "AtomicFile.h"
#include "TranslationPromptLeak.h"
#include "RpgMessageCore.h"
#include "RpgMakerText.h"
#include "Utf8Path.h"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <charconv>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <map>
#include <set>
#include <vector>

namespace gametext {
using Json = nlohmann::json;
namespace fs = std::filesystem;
inline std::mutex mutex;
inline Json read(const fs::path& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) throw std::runtime_error("无法读取游戏文本文件：" + utf8path::pathUtf8(path));
    return Json::parse(stream);
}
inline fs::path storage(const Json& request) {
    const auto game = fs::canonical(utf8path::pathFromUtf8(request.at("gamePath").get<std::string>()));
    if (!fs::is_directory(game)) throw std::runtime_error("游戏目录不存在");
    return game / "LLMChat-JSON";
}
inline fs::path source(const fs::path& base, const std::string& requested) {
    fs::path path;
    if (!requested.empty()) path = utf8path::pathFromUtf8(requested);
    else if (fs::is_directory(base / "work")) {
        for (const auto& work : fs::directory_iterator(base / "work")) {
            const auto candidate = work.path() / "MTool.json";
            if (work.is_directory() && fs::is_regular_file(candidate) && (path.empty() || fs::last_write_time(candidate) > fs::last_write_time(path))) path = candidate;
        }
    }
    if (path.empty()) return {};
    path = fs::canonical(path);
    const auto relative = path.lexically_relative(fs::weakly_canonical(base / "work"));
    if (relative.empty() || *relative.begin() == ".." || relative.is_absolute() || path.filename() != "MTool.json") throw std::runtime_error("文本来源必须是当前游戏扫描生成的 MTool.json");
    return path;
}
inline Json dictionary(const fs::path& path) {
    const auto data = read(path);
    if (!data.is_object()) throw std::runtime_error("扫描文本必须为 MTool 原文到译文 JSON");
    for (const auto& value : data) if (!value.is_string()) throw std::runtime_error("扫描文本含非文本条目");
    return data;
}
inline void write(const fs::path& path, const Json& value) {
    std::string error;
    if (!atomicfile::writeText(path, value.dump(2), &error)) throw std::runtime_error(error);
}
inline std::map<uint64_t, fs::path> checkpoints(const fs::path& base) {
    std::map<uint64_t, fs::path> batches;
    const auto directory = base / "text-checkpoints";
    if (!fs::is_directory(directory)) return batches;
    for (const auto& entry : fs::directory_iterator(directory)) {
        if (entry.path().extension() != ".json" || !entry.is_regular_file()) continue;
        const auto stem = entry.path().stem().string();
        uint64_t number = 0;
        const auto [end, error] = std::from_chars(stem.data(), stem.data() + stem.size(), number);
        if (error == std::errc{} && end == stem.data() + stem.size() && number) batches.emplace(number, entry.path());
    }
    return batches;
}
// Retain the newest batch number so sequence numbers survive compaction and restarts.
inline void compactCheckpoints(const std::map<uint64_t, fs::path>& batches) {
    if (batches.empty()) return;
    for (auto it = batches.begin(); it != std::prev(batches.end()); ++it) {
        std::error_code ignored;
        fs::remove(it->second, ignored);
    }
}
inline Json checkpoint(const Json& request) {
    std::lock_guard lock(mutex);
    const auto base = storage(request), path = source(base, request.at("sourcePath").get<std::string>());
    if (path.empty()) throw std::runtime_error("请先扫描游戏文本");
    const auto& entries = request.at("entries");
    if (!entries.is_array()) throw std::runtime_error("增量译文格式无效");
    const auto batches = checkpoints(base);
    const auto sequence = batches.empty() ? 1 : batches.rbegin()->first + 1;
    Json batch = {{"sourcePath", utf8path::pathUtf8(path)}, {"entries", entries}};
    for (const auto* key : {"options", "workflow"}) if (request.contains(key)) batch[key] = request.at(key);
    write(base / "text-checkpoints" / (std::to_string(sequence) + ".json"), batch);
    return {{"ok", true}};
}
inline Json workflow(const Json& request) {
    std::lock_guard lock(mutex);
    const auto base = storage(request), file = base / "workflow.json";
    auto value = fs::is_regular_file(file) ? read(file) : Json::object();
    const auto imageFile = base / "images/project.json";
    const auto imageRevision = fs::is_regular_file(imageFile) ? std::to_string(fs::last_write_time(imageFile).time_since_epoch().count()) : "";
    auto sourcePath = request.value("sourcePath", "");
    if (sourcePath.empty()) sourcePath = value.value("sourcePath", "");
    if (sourcePath != value.value("sourcePath", "")) value["textSkipped"] = false;
    if (imageRevision != value.value("imageRevision", "")) value["imagesSkipped"] = false;
    value["sourcePath"] = sourcePath; value["imageRevision"] = imageRevision;
    for (const auto key : {"textSkipped", "imagesSkipped"}) {
        if (request.contains(key)) value[key] = request.at(key).get<bool>();
        else if (!value.contains(key)) value[key] = false;
    }
    if (request.contains("textSkipped") || request.contains("imagesSkipped")) write(file, value);
    return value;
}
inline void resetForScan(const fs::path& game) {
    std::lock_guard lock(mutex);
    const auto base = game / "LLMChat-JSON", file = base / "text-project.json";
    const auto batches = checkpoints(base);
    if (fs::is_regular_file(file) || !batches.empty()) {
        auto value = fs::is_regular_file(file) ? read(file) : Json{{"entries", Json::array()}};
        for (auto& entry : value["entries"]) { entry["translation"] = ""; entry["error"] = ""; entry.erase("layoutDraft"); entry.erase("screeningDraft"); entry.erase("importPartial"); entry.erase("translationResult"); }
        if (!batches.empty()) value["checkpointSequence"] = batches.rbegin()->first;
        value["workflow"] = Json{{"screened", false}}; write(file, value);
    }
    write(base / "text-translation.json", Json::object());
    write(base / "workflow.json", Json{{"textSkipped", false}, {"imagesSkipped", false}});
    compactCheckpoints(batches);
}
inline void flagPromptLeak(Json& row, const std::string& source) {
    const auto translation = row.at("translation").get<std::string>();
    if (translation_prompt::leaked(source, translation)) row["error"] = translation_prompt::leakError;
    const auto draft = row.find("layoutDraft");
    if (draft != row.end() && draft->is_string() && translation_prompt::leaked(source, draft->get_ref<const std::string&>())) {
        row.erase(draft);
        if (translation.empty()) row["error"] = translation_prompt::leakError;
    }
}

inline std::set<std::string> linkedDialogueNames(const fs::path& directory) {
    std::set<std::string> linked;
    if (!fs::is_directory(directory)) return linked;
    static const std::regex danglingJson(R"json(\\\\nc[ \t]*")json", std::regex::icase);
    for (const auto& file : fs::directory_iterator(directory)) {
        const auto name = utf8path::pathUtf8(file.path().filename());
        if (!file.is_regular_file() || !(name.starts_with("Map") || name == "CommonEvents.json" || name == "Troops.json") ||
            !rpgtext::dataFile(name)) continue;
        std::ifstream stream(file.path(), std::ios::binary);
        const std::string raw((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
        if (raw.find("\\\\nc") == std::string::npos && raw.find("\\\\NC") == std::string::npos) continue;
        if (!std::regex_search(raw, danglingJson)) continue;
        auto map = Json::parse(raw, nullptr, false);
        if (map.is_discarded()) continue;
        rpgtext::visit(name, map, [](std::string&) { return false; }, {}, [&](Json& commands) {
            rpgmessage::repairNameFragments(commands, [&](const std::string& dialogue, const std::string& fragment) {
                linked.insert(dialogue);
                linked.insert(fragment);
            });
        });
    }
    return linked;
}

struct DialogueContexts {
    Json pages = Json::array();
    std::map<std::string, std::pair<size_t, size_t>> positions;
    std::set<std::string> repeated;
    std::set<std::string> mapNames;
};
inline DialogueContexts collectDialogueContexts(const fs::path& directory, const Json& originals) {
    DialogueContexts result;
    if (!fs::is_directory(directory)) return result;
    std::vector<fs::path> files;
    for (const auto& file : fs::directory_iterator(directory)) {
        const auto name = utf8path::pathUtf8(file.path().filename());
        if (file.is_regular_file() && rpgtext::dataFile(name) &&
            (name.starts_with("Map") || name == "CommonEvents.json" || name == "Troops.json")) files.push_back(file.path());
    }
    std::sort(files.begin(), files.end());
    for (const auto& file : files) {
        auto data = read(file);
        const auto name = utf8path::pathUtf8(file.filename());
        if (name.starts_with("Map")) {
            const auto title = data.value("displayName", "");
            if (originals.contains(title)) result.mapNames.insert(title);
        }
        rpgtext::visitDialoguePages(name, data, [&](int event, size_t page, const Json& commands) {
            Json lines = Json::array(), indexes = Json::array(), speakers = Json::object();
            const auto flush = [&] {
                if (lines.empty()) return;
                result.pages.push_back({{"file", name}, {"event", event}, {"page", page},
                                        {"commands", indexes}, {"lines", lines}});
                if (!speakers.empty()) result.pages.back()["speakers"] = std::move(speakers);
                lines.clear();
                indexes.clear();
                speakers = Json::object();
            };
            const auto append = [&](size_t command, const std::string& text, const std::string& speaker = {}) {
                if (text.empty()) return;
                if (originals.contains(text) && !result.positions.try_emplace(text, result.pages.size(), lines.size()).second)
                    result.repeated.insert(text);
                if (!speaker.empty()) speakers[std::to_string(lines.size())] = speaker;
                lines.push_back(text);
                indexes.push_back(command);
            };
            for (size_t i = 0; i < commands.size(); ++i) {
                const auto& item = commands[i];
                const auto code = item.value("code", 0);
                // Choices, conditions, loops, battle outcomes and jumps split narrative paths.
                if (code == 111 || code == 112 || code == 113 || code == 115 || code == 117 ||
                    code == 118 || code == 119 || code == 201 || code == 301 ||
                    (code >= 402 && code <= 404) || (code >= 411 && code <= 413) ||
                    (code >= 601 && code <= 604)) flush();
                if (code == 401 || code == 405) {
                    const auto command = i;
                    const auto message = rpgtext::messageBlock(commands, i);
                    std::string speaker;
                    if (code == 401 && command > 0 && commands[command - 1].value("code", 0) == 101) {
                        const auto parameters = commands[command - 1].value("parameters", Json::array());
                        if (parameters.is_array() && parameters.size() > 4 && parameters[4].is_string()) speaker = parameters[4].get<std::string>();
                    }
                    append(command, message, speaker);
                } else if (code == 102 && item.contains("parameters") && !item["parameters"].empty() && item["parameters"][0].is_array()) {
                    for (const auto& choice : item["parameters"][0])
                        if (choice.is_string()) append(i, choice.get_ref<const std::string&>());
                }
            }
            flush();
        });
    }
    for (const auto& text : result.repeated) result.positions.erase(text);
    return result;
}

inline Json load(const Json& request) {
    std::lock_guard lock(mutex);
    const auto base = storage(request), path = source(base, request.value("sourcePath", ""));
    if (path.empty()) return {{"entries", Json::array()}, {"sourcePath", ""}, {"translationPath", ""}, {"options", Json::object()}};
    const auto originals = dictionary(path);
    auto contextData = path.parent_path() / "source";
    if (!fs::is_directory(contextData)) {
        const auto game = base.parent_path();
        const fs::path data = fs::is_regular_file(game / "www/data/System.json") ? "www/data" : "data";
        const auto patch = base / "patches/text";
        const auto ledger = patch / "manifest.json";
        contextData = fs::is_regular_file(ledger) && read(ledger).value("installed", false)
            ? patch / "original" / data : game / data;
    }
    const auto dialogue = collectDialogueContexts(contextData, originals);
    std::map<std::string, std::string> systemMessages;
    std::map<std::string, std::string> textKinds, textContexts;
    const auto addKind = [&](const std::string& text, const std::string& kind) {
        if (!originals.contains(text)) return;
        const auto [entry, inserted] = textKinds.try_emplace(text, kind);
        if (!inserted && entry->second != kind) entry->second.clear();
    };
    for (const auto& title : dialogue.mapNames) addKind(title, "place");
    for (const auto& [name, kind] : {std::pair{"Actors.json", "character"}, {"Skills.json", "skill"},
                                   {"Items.json", "item"}, {"Weapons.json", "item"}, {"Armors.json", "item"}}) {
        const auto file = contextData / name;
        if (!fs::is_regular_file(file)) continue;
        for (const auto& record : read(file)) if (record.is_object()) addKind(record.value("name", ""), kind);
    }
    const auto systemFile = contextData / "System.json";
    if (fs::is_regular_file(systemFile)) {
        const auto system = read(systemFile);
        const auto terms = system.value("terms", Json::object());
        const auto messages = terms.value("messages", Json::object());
        for (const auto& [key, value] : messages.items())
            if (value.is_string()) systemMessages.try_emplace(value.get_ref<const std::string&>(), key);
        for (const auto* field : {"basic", "params", "commands"}) {
            if (!terms.contains(field) || !terms[field].is_array()) continue;
            const auto& labels = terms[field];
            for (size_t index = 0; index < labels.size(); ++index) {
                if (!labels[index].is_string()) continue;
                const auto& label = labels[index].get_ref<const std::string&>();
                if (label.empty()) continue;
                addKind(label, "interface");
                if (std::string_view(field) == "commands" && index == 16)
                    textContexts[label] = "装备菜单命令：自动选择属性最优的装备。";
            }
        }
    }
    const auto layout = rpgmessage::messageLayout(base.parent_path());
    const bool messageCore = layout.enabled;
    const auto linkedNames = messageCore ? linkedDialogueNames(contextData) : std::set<std::string>{};
    auto saved = fs::is_regular_file(base / "text-project.json") ? read(base / "text-project.json") : Json::object();
    Json previous = Json::object(), rows = Json::array();
    if (saved.contains("entries")) for (const auto& row : saved.at("entries")) previous[row.at("source").get<std::string>()] = row;
    bool sameSource = previous.size() == originals.size();
    for (auto it = originals.begin(); it != originals.end(); ++it) if (!previous.contains(it.key())) { sameSource = false; break; }
    const auto batches = checkpoints(base);
    const auto sourcePath = utf8path::pathUtf8(path);
    for (auto it = batches.upper_bound(saved.value("checkpointSequence", uint64_t{0})); it != batches.end(); ++it) {
        auto batch = read(it->second);
        if (batch.at("sourcePath") != sourcePath) continue;
        for (auto& row : batch.at("entries")) {
            const auto key = row.at("source").get<std::string>();
            if (originals.contains(key)) previous[key] = std::move(row);
        }
        if (batch.contains("options")) saved["options"] = std::move(batch["options"]);
        if (batch.contains("workflow")) {
            saved["workflow"] = std::move(batch["workflow"]);
            sameSource = true;
        }
    }
    size_t index = 0, positionRepairs = 0;
    for (auto it = originals.begin(); it != originals.end(); ++it) {
        Json row = {{"id", std::to_string(++index)}, {"source", it.key()}, {"translation", ""}, {"selected", true}, {"error", ""}, {"file", "MTool.json"}, {"container", ""}, {"objectId", std::to_string(index)}, {"locator", it.key()}, {"kind", "游戏文本"}};
        if (const auto position = dialogue.positions.find(it.key()); position != dialogue.positions.end())
            row["dialoguePosition"] = {{"page", position->second.first}, {"line", position->second.second}};
        else if (const auto message = systemMessages.find(it.key()); message != systemMessages.end() && !dialogue.repeated.contains(it.key()))
            row["rpgSystemMessage"] = message->second;
        else if (const auto kind = textKinds.find(it.key()); kind != textKinds.end() && !kind->second.empty() && !dialogue.repeated.contains(it.key())) {
            row["rpgTextKind"] = kind->second;
            if (const auto context = textContexts.find(it.key()); context != textContexts.end()) row["rpgTextContext"] = context->second;
        }
        if (previous.contains(it.key())) for (const auto& key : {"translation", "selected", "error"}) row[key] = previous[it.key()].at(key);
        if (previous.contains(it.key())) for (const auto* key : {"screeningDraft", "layoutDraft", "translationTarget", "layoutDraftTarget", "importPartial", "translationResult"}) if (previous[it.key()].contains(key)) row[key] = previous[it.key()][key];
        flagPromptLeak(row, it.key());
        if (messageCore) {
            Json repairs = Json::array();
            const auto& source = it.key();
            const auto position = rpgmessage::repairPosition(source);
            const auto namedSource = rpgmessage::repairNameLineBreak(position);
            const auto sourceContinuation = rpgmessage::alignContinuation(namedSource, layout);
            const auto& input = row["translation"].get_ref<const std::string&>();
            const auto& baseText = !input.empty() && row["error"] == "" ? input : source;
            const auto targetPosition = rpgmessage::repairPosition(baseText);
            const auto namedTarget = rpgmessage::repairNameLineBreak(targetPosition);
            const auto continuation = rpgmessage::alignContinuation(
                rpgmessage::restoreName(namedSource, namedTarget), layout);
            const auto corrected = rpgmessage::alignPositionedLines(continuation);
            if (position != source) repairs.push_back("position");
            if (sourceContinuation != namedSource) repairs.push_back("continuation");
            if (corrected != continuation || rpgmessage::alignPositionedLines(sourceContinuation) != sourceContinuation)
                repairs.push_back("alignment");
            if (namedSource != position || namedTarget != targetPosition || linkedNames.contains(source) ||
                std::regex_match(source, rpgmessage::nameWithoutSlash)) repairs.push_back("name");
            if (!repairs.empty()) {
                if (corrected != baseText && row["error"] == "") row["dialogueRepairPreview"] = {{"input", input}, {"text", corrected}};
                ++positionRepairs;
                row["dialogueRepairs"] = std::move(repairs);
            }
        }
        rows.push_back(std::move(row));
    }
    return {{"entries", rows}, {"dialoguePages", dialogue.pages}, {"sourcePath", utf8path::pathUtf8(path)}, {"translationPath", utf8path::pathUtf8(base / "text-translation.json")}, {"options", saved.value("options", Json::object())}, {"workflow", sameSource ? saved.value("workflow", Json()) : Json{{"screened", false}}}, {"messageCore", messageCore}, {"positionRepairs", positionRepairs}};
}
inline Json save(const Json& request) {
    std::lock_guard lock(mutex);
    const auto base = storage(request), path = source(base, request.at("sourcePath").get<std::string>());
    if (path.empty()) throw std::runtime_error("请先扫描游戏文本");
    const auto originals = dictionary(path);
    auto rows = request.at("entries");
    if (!rows.is_array() || rows.size() != originals.size()) throw std::runtime_error("工程条目与扫描文本数量不一致，请重新读取");
    Json translated = Json::object(); std::set<std::string> seen;
    const auto target = request.value("options", Json::object()).value("target", "");
    std::set<std::string> retained;
    const auto workflow = request.value("workflow", Json::object());
    if (workflow.is_object() && workflow.value("version", 0) == 2) {
        for (const auto& id : workflow.value("skippedIds", Json::array()))
            if (id.is_string()) retained.insert(id.get<std::string>());
    }
    for (auto& row : rows) {
        row.erase("dialoguePosition");
        row.erase("rpgSystemMessage");
        row.erase("rpgTextKind");
        row.erase("rpgTextContext");
        row.erase("dialogueRepairPreview");
        row.erase("dialogueRepairs");
        const auto text = row.at("source").get<std::string>();
        if (!originals.contains(text) || !seen.insert(text).second) throw std::runtime_error("工程包含重复或不属于当前扫描的原文：" + text.substr(0, 120));
        flagPromptLeak(row, text);
        const auto value = row.at("translation").get<std::string>();
        const auto savedTarget = row.value("translationTarget", "");
        if ((row.at("selected").get<bool>() || retained.contains(row.at("id").get<std::string>())) &&
            row.at("error").get<std::string>().empty() && !value.empty() && value != text &&
            (target.empty() || savedTarget.empty() || target == savedTarget)) translated[text] = value;
    }
    // The source export and game resources are never overwritten by editing.
    const auto batches = checkpoints(base);
    const auto sequence = batches.empty() ? uint64_t{0} : batches.rbegin()->first;
    write(base / "text-project.json", {{"sourcePath", utf8path::pathUtf8(path)}, {"entries", rows}, {"options", request.value("options", Json::object())}, {"workflow", request.value("workflow", Json())}, {"checkpointSequence", sequence}});
    write(base / "text-translation.json", translated);
    compactCheckpoints(batches);
    return {{"ok", true}, {"translationPath", utf8path::pathUtf8(base / "text-translation.json")}};
}
}
