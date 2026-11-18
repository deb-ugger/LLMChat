#pragma once

#include <iterator>
#include <regex>
#include <string>
#include <string_view>

namespace translation_prompt {
inline constexpr char leakError[] = "译文混入了参考语境或模型提示，请重译此条";

inline bool leaked(const std::string& source, const std::string& output) {
    if (output.empty() || source == output) return false;
    static const std::regex marker(
        R"marker(<[ \t]*/?[ \t]*reference[_ -]context[ \t]*>|"reference_context"[ \t]*:)marker",
        std::regex::icase);
    const auto markerCount = [&](const std::string& value) {
        return std::distance(std::sregex_iterator(value.begin(), value.end(), marker), std::sregex_iterator());
    };
    if (const auto count = markerCount(output); count && count > markerCount(source)) return true;

    for (const std::string_view phrase : {"原文语境（仅参考）", "原文语境(仅参考)",
             "以下仅为参考上下文，不要翻译或输出此部分", "以下仅为参考上下文,不要翻译或输出此部分", "只输出最后一条用户消息的译文",
             "Use reference_context as read-only reference"}) {
        if (output.find(phrase) != std::string::npos && source.find(phrase) == std::string::npos) return true;
    }
    return false;
}
}
