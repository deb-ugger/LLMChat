#pragma once
#include "AtomicFile.h"
#include "Utf8Path.h"
#include <nlohmann/json.hpp>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <set>

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
inline Json load(const Json& request) {
    std::lock_guard lock(mutex);
    const auto base = storage(request), path = source(base, request.value("sourcePath", ""));
    if (path.empty()) return {{"entries", Json::array()}, {"sourcePath", ""}, {"translationPath", ""}, {"options", Json::object()}};
    const auto originals = dictionary(path);
    const auto saved = fs::is_regular_file(base / "text-project.json") ? read(base / "text-project.json") : Json::object();
    Json previous = Json::object(), rows = Json::array();
    if (saved.contains("entries")) for (const auto& row : saved.at("entries")) previous[row.at("source").get<std::string>()] = row;
    size_t index = 0;
    for (auto it = originals.begin(); it != originals.end(); ++it) {
        Json row = {{"id", std::to_string(++index)}, {"source", it.key()}, {"translation", ""}, {"selected", true}, {"error", ""}, {"file", "MTool.json"}, {"container", ""}, {"objectId", std::to_string(index)}, {"locator", it.key()}, {"kind", "游戏文本"}};
        if (previous.contains(it.key())) for (const auto& key : {"translation", "selected", "error"}) row[key] = previous[it.key()].at(key);
        if (previous.contains(it.key()) && previous[it.key()].contains("screeningDraft")) row["screeningDraft"] = previous[it.key()]["screeningDraft"];
        rows.push_back(std::move(row));
    }
    return {{"entries", rows}, {"sourcePath", utf8path::pathUtf8(path)}, {"translationPath", utf8path::pathUtf8(base / "text-translation.json")}, {"options", saved.value("options", Json::object())}};
}
inline Json save(const Json& request) {
    std::lock_guard lock(mutex);
    const auto base = storage(request), path = source(base, request.at("sourcePath").get<std::string>());
    if (path.empty()) throw std::runtime_error("请先扫描游戏文本");
    const auto originals = dictionary(path);
    const auto& rows = request.at("entries");
    if (!rows.is_array() || rows.size() != originals.size()) throw std::runtime_error("工程条目与扫描文本数量不一致，请重新读取");
    Json translated = Json::object(); std::set<std::string> seen;
    for (const auto& row : rows) {
        const auto text = row.at("source").get<std::string>();
        if (!originals.contains(text) || !seen.insert(text).second) throw std::runtime_error("工程包含重复或不属于当前扫描的原文：" + text.substr(0, 120));
        const auto value = row.at("translation").get<std::string>();
        if (row.at("selected").get<bool>() && row.at("error").get<std::string>().empty() && !value.empty() && value != text) translated[text] = value;
    }
    // The source export and game resources are never overwritten by editing.
    write(base / "text-project.json", {{"sourcePath", utf8path::pathUtf8(path)}, {"entries", rows}, {"options", request.value("options", Json::object())}});
    write(base / "text-translation.json", translated);
    return {{"ok", true}, {"translationPath", utf8path::pathUtf8(base / "text-translation.json")}};
}
}
