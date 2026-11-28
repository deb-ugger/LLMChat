#pragma once
#include <nlohmann/json.hpp>
#include <map>
#include <tuple>
#include <regex>
#include <limits>
#include <stdexcept>
#include <string>

namespace rpgscenes {
using Json = nlohmann::json;
using Key = std::tuple<std::string, int, int, int, std::string>;
inline int index(const Json& value, const char* field) {
    if (!value.contains(field) || !value[field].is_number_integer()) throw std::runtime_error("场景位置需要整数索引");
    const auto number = value[field].get<int64_t>();
    if (number < 0 || number > std::numeric_limits<int>::max()) throw std::runtime_error("场景位置索引无效");
    return static_cast<int>(number);
}
inline Key key(const Json& value) {
    const auto file = value.at("file").get<std::string>(), slot = value.at("slot").get<std::string>();
    static const std::regex files(R"((Map[0-9]+|CommonEvents|Troops)\.json)");
    static const std::regex slots(R"(message|choice/[0-9]+|branch|legacy-picture|plugin/(text|Text|message|Message|label|Label|caption|Caption))");
    if (!std::regex_match(file, files) || !std::regex_match(slot, slots)) throw std::runtime_error("场景译文的文件或文本位置无效");
    return {file, index(value, "event"), index(value, "page"), index(value, "command"), slot};
}
inline Json records(const Json& values) {
    if (!values.is_array()) throw std::runtime_error("场景译文必须是数组");
    std::map<std::pair<Key, std::string>, Json> seen;
    for (const auto& value : values) {
        const auto location = key(value);
        if (!value.contains("source") || !value["source"].is_string() || value["source"].get_ref<const std::string&>().empty() ||
            !value.contains("translation") || !value["translation"].is_string() ||
            !value.contains("target") || !value["target"].is_string() || value["target"].get_ref<const std::string&>().empty())
            throw std::runtime_error("场景译文缺少原文、译文或目标语言");
        if (!seen.emplace(std::pair{location, value["target"].get<std::string>()}, value).second)
            throw std::runtime_error("同一场景位置出现了重复译文");
    }
    return values;
}
inline Json merge(const Json& previous, const Json& updates) {
    std::map<std::pair<Key, std::string>, Json> values;
    for (const auto& value : records(previous)) values[{key(value), value["target"].get<std::string>()}] = value;
    for (const auto& value : records(updates)) values[{key(value), value["target"].get<std::string>()}] = value;
    Json result = Json::array();
    for (const auto& [id, value] : values) result.push_back(value);
    return result;
}
struct Scene {
    std::string source, translation;
    bool usable = false;
};
class Dictionary {
    std::map<Key, Scene> values_;
public:
    void clear() { values_.clear(); }
    bool empty() const { return values_.empty(); }
    void load(const Json& values) {
        clear();
        for (const auto& value : records(values)) {
            const auto review = value.value("semanticReview", Json::object());
            const auto state = review.is_object() ? review.value("state", "") : "";
            const auto translated = value["translation"].get<std::string>();
            const bool reviewed = state != "uncertain" && state != "failed";
            if (!values_.emplace(key(value), Scene{value["source"].get<std::string>(), translated,
                !translated.empty() && value.value("error", "").empty() && value.value("contextKnown", false) && reviewed}).second)
                throw std::runtime_error("同一场景位置存在多份译文，请重新保存当前目标语言的文本工程");
        }
    }
    const Scene* find(const std::string& file, int event, size_t page, size_t command, const std::string& slot) const {
        if (page > std::numeric_limits<int>::max() || command > std::numeric_limits<int>::max()) return nullptr;
        const auto found = values_.find({file, event, static_cast<int>(page), static_cast<int>(command), slot});
        return found == values_.end() ? nullptr : &found->second;
    }
};
}
