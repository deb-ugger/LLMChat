#pragma once
#include <nlohmann/json.hpp>
#include <functional>
#include <regex>
#include <string>

// MV/MZ database fields and event commands that are displayed to players.
// Script, plugin parameters, notes, asset paths and editor-only names stay intact.
namespace rpgtext {
using Json = nlohmann::json;
using Edit = std::function<bool(std::string&)>;
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
inline void commands(Json& list, const Edit& edit) {
    if (!list.is_array()) return;
    Json result = Json::array();
    for (size_t i = 0; i < list.size(); ++i) {
        auto command = list[i]; const auto code = command.value("code", 0);
        if (code == 401 || code == 405) {
            auto original = command; std::string message = command.at("parameters").at(0).get<std::string>();
            const auto first = i;
            while (i + 1 < list.size() && list[i + 1].value("code", 0) == code && list[i + 1].value("indent", 0) == command.value("indent", 0)) message += "\n" + list[++i].at("parameters").at(0).get<std::string>();
            if (!edit(message)) { for (auto j = first; j <= i; ++j) result.push_back(list[j]); continue; }
            size_t offset = 0, line = 0;
            do { const auto end = message.find('\n', offset); if (code == 401 && line && line % 4 == 0 && first && list[first - 1].value("code", 0) == 101) result.push_back(list[first - 1]); original["parameters"][0] = message.substr(offset, end == std::string::npos ? end : end - offset); result.push_back(original); ++line; if (end == std::string::npos) break; offset = end + 1; } while (offset <= message.size());
            continue;
        }
        if (command.contains("parameters")) {
            auto& args = command["parameters"];
            if (code == 102 && !args.empty()) strings(args[0], edit);
            else if ((code == 402 || code == 320 || code == 324 || code == 325) && args.size() > 1) text(args[1], edit);
            else if (code == 101 && args.size() > 4) text(args[4], edit); // MZ speaker name
            else if (code == 357 && args.size() > 3 && args[0] == "DTextPicture" && args[1] == "dText" && args[3].is_object()) pluginText(args[3], edit);
            else if (code == 356 && !args.empty() && args[0].is_string()) {
                auto value = args[0].get<std::string>();
                if (value.starts_with("D_TEXT ")) { const auto end = value.find_last_of(' '); if (end > 7) { auto body = value.substr(7, end - 7); if (edit(body)) args[0] = "D_TEXT " + body + value.substr(end); } }
            }
        }
        result.push_back(std::move(command));
    }
    list = std::move(result);
}
inline void pages(Json& value, const Edit& edit) {
    if (value.contains("pages")) for (auto& page : value["pages"]) if (page.contains("list")) commands(page["list"], edit);
}
inline void visit(const std::string& file, Json& value, const Edit& edit) {
    if (file == "System.json") {
        field(value, "gameTitle", edit); field(value, "currencyUnit", edit);
        for (const auto key : {"terms", "armorTypes", "elements", "equipTypes", "skillTypes", "weaponTypes"}) if (value.contains(key)) strings(value[key], edit);
    } else if (file.starts_with("Map")) {
        field(value, "displayName", edit);
        if (value.contains("events")) for (auto& event : value["events"]) if (event.is_object()) pages(event, edit);
    } else if (value.is_array()) for (auto& row : value) {
        if (!row.is_object()) continue;
        if (file == "CommonEvents.json") { if (row.contains("list")) commands(row["list"], edit); }
        else if (file == "Troops.json") pages(row, edit);
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
