#pragma once
#include <nlohmann/json.hpp>
#include <functional>
#include <optional>
#include <regex>
#include <string>

// MV/MZ database fields and event commands that are displayed to players.
// Script, plugin parameters, notes, asset paths and editor-only names stay intact.
namespace rpgtext {
using Json = nlohmann::json;
using Edit = std::function<bool(std::string&)>;
using EditCommands = std::function<void(Json&)>;
using SceneEdit = std::function<std::optional<bool>(int, size_t, size_t, const std::string&, std::string&)>;
inline bool dataFile(const std::string& name) {
    static const std::regex names(R"((Actors|Classes|Skills|Items|Weapons|Armors|Enemies|Troops|States|CommonEvents|System|Map[0-9]+)\.json)");
    return std::regex_match(name, names);
}
inline void text(Json& value, const Edit& edit) {
    if (!value.is_string()) return;
    auto string = value.get<std::string>(); if (edit(string)) value = string;
}
inline void strings(Json& value, const Edit& edit) {
    if (value.is_string()) text(value, edit);
    else if (value.is_structured()) for (auto& item : value) strings(item, edit);
}
inline void field(Json& value, const char* key, const Edit& edit) {
    if (value.contains(key)) text(value[key], edit);
}
inline void pluginText(Json& args, const Edit& edit) {
    for (const auto key : {"text", "Text", "message", "Message", "label", "Label", "caption", "Caption"}) field(args, key, edit);
}
inline void notes(Json& row, const Edit& edit) {
    if (!row.contains("note") || !row["note"].is_string()) return;
    auto value=row["note"].get<std::string>();
    static const std::regex tag(R"((<Help Description>)([\s\S]*?)(</Help Description>))",std::regex::icase);
    std::string result;size_t offset=0;bool changed=false;
    for(auto it=std::sregex_iterator(value.begin(),value.end(),tag);it!=std::sregex_iterator();++it){result+=value.substr(offset,it->position()-offset);auto body=(*it)[2].str();changed=edit(body)||changed;result+=(*it)[1].str()+body+(*it)[3].str();offset=it->position()+it->length();}
    if(changed)row["note"]=result+value.substr(offset);
}
inline std::string messageBlock(const Json& list, size_t& index) {
    const auto& first = list[index];
    const auto code = first.value("code", 0), indent = first.value("indent", 0);
    auto message = first.at("parameters").at(0).get<std::string>();
    while (index + 1 < list.size() && list[index + 1].value("code", 0) == code && list[index + 1].value("indent", 0) == indent)
        message += "\n" + list[++index].at("parameters").at(0).get<std::string>();
    return message;
}
using DialoguePage = std::function<void(int, size_t, const Json&)>;
inline void visitDialoguePages(const std::string& file, const Json& data, const DialoguePage& accept) {
    const auto pages = [&](const Json& object) {
        if (!object.is_object() || !object.contains("pages")) return;
        for (size_t page = 0; page < object["pages"].size(); ++page) {
            const auto& node = object["pages"][page];
            if (node.contains("list") && node["list"].is_array()) accept(object.value("id", 0), page, node["list"]);
        }
    };
    if (file.starts_with("Map") && data.contains("events")) {
        for (const auto& event : data["events"]) pages(event);
    } else if (file == "CommonEvents.json" && data.is_array()) {
        for (const auto& event : data)
            if (event.is_object() && event.contains("list") && event["list"].is_array()) accept(event.value("id", 0), 0, event["list"]);
    } else if (file == "Troops.json" && data.is_array()) {
        for (const auto& troop : data) pages(troop);
    }
}
inline void commands(Json& list, const Edit& edit, const Edit& messageEdit, const EditCommands& editCommands,
                     const SceneEdit& sceneEdit = {}, int event = 0, size_t page = 0) {
    if (!list.is_array()) return;
    Json result = Json::array();
    for (size_t i = 0; i < list.size(); ++i) {
        auto command = list[i]; const auto code = command.value("code", 0);
        if (code == 401 || code == 405) {
            auto original = command;
            const auto first = i;
            auto message = messageBlock(list, i);
            const auto scoped = sceneEdit ? sceneEdit(event, page, first, "message", message) : std::nullopt;
            const bool changed = scoped.has_value() ? *scoped : code == 401 && messageEdit ? messageEdit(message) : edit(message);
            if (!changed) { for (auto j = first; j <= i; ++j) result.push_back(list[j]); continue; }
            size_t offset = 0, line = 0;
            do { const auto end = message.find('\n', offset); if (code == 401 && line && line % 4 == 0 && first && list[first - 1].value("code", 0) == 101) result.push_back(list[first - 1]); original["parameters"][0] = message.substr(offset, end == std::string::npos ? end : end - offset); result.push_back(original); ++line; if (end == std::string::npos) break; offset = end + 1; } while (offset <= message.size());
            continue;
        }
        if (command.contains("parameters")) {
            auto& args = command["parameters"];
            const auto scopedText = [&](Json& value, const std::string& slot) {
                if (!value.is_string()) return;
                auto candidate = value.get<std::string>();
                const auto handled = sceneEdit ? sceneEdit(event, page, i, slot, candidate) : std::nullopt;
                if (handled.has_value() ? *handled : edit(candidate)) value = candidate;
            };
            if (code == 102 && !args.empty() && args[0].is_array()) {
                for (size_t option = 0; option < args[0].size(); ++option) scopedText(args[0][option], "choice/" + std::to_string(option));
            }
            else if (code == 402 && args.size() > 1) scopedText(args[1], "branch");
            else if ((code == 320 || code == 324 || code == 325) && args.size() > 1) text(args[1], edit);
            else if (code == 101 && args.size() > 4) text(args[4], edit); // MZ speaker name
            else if (code == 357 && args.size() > 3 && args[0] == "DTextPicture" && args[1] == "dText" && args[3].is_object()) {
                for (const auto* field : {"text", "Text", "message", "Message", "label", "Label", "caption", "Caption"})
                    if (args[3].contains(field)) scopedText(args[3][field], std::string("plugin/") + field);
            }
            else if (code == 356 && !args.empty() && args[0].is_string()) {
                auto value = args[0].get<std::string>();
                if (value.starts_with("D_TEXT ")) { const auto end = value.find_last_of(' '); if (end > 7) { auto body = value.substr(7, end - 7); const auto handled = sceneEdit ? sceneEdit(event, page, i, "legacy-picture", body) : std::nullopt; if (handled.has_value() ? *handled : edit(body)) args[0] = "D_TEXT " + body + value.substr(end); } }
            }
        }
        result.push_back(std::move(command));
    }
    if (editCommands) editCommands(result);
    list = std::move(result);
}
inline void pages(Json& value, const Edit& edit, const Edit& messageEdit, const EditCommands& editCommands, const SceneEdit& sceneEdit = {}) {
    if (value.contains("pages")) for (size_t index = 0; index < value["pages"].size(); ++index) {
        auto& page = value["pages"][index];
        if (page.contains("list")) commands(page["list"], edit, messageEdit, editCommands, sceneEdit, value.value("id", 0), index);
    }
}
inline void visit(const std::string& file, Json& value, const Edit& edit, const Edit& messageEdit = {}, const EditCommands& editCommands = {}, const SceneEdit& sceneEdit = {}) {
    if (file == "System.json") {
        field(value, "gameTitle", edit); field(value, "currencyUnit", edit);
        for (const auto key : {"terms", "armorTypes", "elements", "equipTypes", "skillTypes", "weaponTypes"}) if (value.contains(key)) strings(value[key], edit);
    } else if (file.starts_with("Map")) {
        field(value, "displayName", edit);
        if (value.contains("events")) for (auto& event : value["events"]) if (event.is_object()) pages(event, edit, messageEdit, editCommands, sceneEdit);
    } else if (value.is_array()) for (auto& row : value) {
        if (!row.is_object()) continue;
        if (file == "CommonEvents.json") { if (row.contains("list")) commands(row["list"], edit, messageEdit, editCommands, sceneEdit, row.value("id", 0), 0); }
        else if (file == "Troops.json") pages(row, edit, messageEdit, editCommands, sceneEdit);
        else {
            notes(row,edit);
            field(row, "name", edit);
            if (file == "Actors.json") { field(row, "nickname", edit); field(row, "profile", edit); }
            else if (file == "States.json") for (const auto key : {"message1", "message2", "message3", "message4"}) field(row, key, edit);
            else field(row, "description", edit);
        }
    }
}
}
