#pragma once

#include <nlohmann/json.hpp>
#include <algorithm>
#include <charconv>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iterator>
#include <regex>
#include <string>

namespace rpgmessage {
struct MessageLayout { bool enabled = false; int width = 0; int fontSize = 0; };
inline int pluginInteger(const nlohmann::json& params, const char* key) {
    if (!params.is_object() || !params.contains(key) || !params[key].is_string()) return 0;
    const auto& value = params[key].get_ref<const std::string&>();
    int result = 0;
    const auto parsed = std::from_chars(value.data(), value.data() + value.size(), result);
    return parsed.ec == std::errc() && parsed.ptr == value.data() + value.size() && result > 0 ? result : 0;
}

inline MessageLayout messageLayout(const std::filesystem::path& game) {
    for (const auto& root : {game / "www", game}) {
        const auto js = root / "js";
        if (!std::filesystem::is_regular_file(js / "plugins" / "YEP_MessageCore.js")) continue;
        std::ifstream input(js / "plugins.js", std::ios::binary);
        const std::string contents((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
        const auto first = contents.find('['), last = contents.rfind(']');
        if (first == std::string::npos || last <= first) return {};
        const auto plugins = nlohmann::json::parse(contents.substr(first, last - first + 1), nullptr, false);
        MessageLayout result;
        int screenWidth = 0;
        bool usesScreenWidth = false;
        if (plugins.is_array()) for (const auto& plugin : plugins) {
            if (!plugin.is_object() || !plugin.contains("name") || !plugin.contains("status") || plugin["status"] != true) continue;
            const auto params = plugin.value("parameters", nlohmann::json::object());
            if (plugin["name"] == "Community_Basic") screenWidth = pluginInteger(params, "screenWidth");
            if (plugin["name"] == "YEP_MessageCore") {
                result.enabled = true;
                result.fontSize = pluginInteger(params, "Font Size");
                result.width = pluginInteger(params, "Default Width");
                usesScreenWidth = params.is_object() && params.contains("Default Width") && params["Default Width"] == "Graphics.boxWidth";
            }
        }
        if (usesScreenWidth) result.width = screenWidth;
        return result;
    }
    return {};
}
inline bool enabled(const std::filesystem::path& game) { return messageLayout(game).enabled; }

inline std::string repairPosition(const std::string& text) {
    if (text.find('[') == std::string::npos) return text;
    static const std::regex missingSlash(R"((^|\n)([ \t]*)(p[xy]\[[0-9]{1,5}\])(?=[\xE3-\xEF]|\\))", std::regex::icase);
    static const std::regex strayDash(R"((^|\n)([ \t]*\\p[xy]\[)([0-9])-([0-9]{2}\]))", std::regex::icase);
    static const std::regex unclosed(R"((^|\n)([ \t]*\\p[xy]\[[0-9]{1,4})(?=[\xE3-\xEF]))", std::regex::icase);
    const auto positioned = std::regex_replace(text, missingSlash, "$1$2\\$3");
    return std::regex_replace(std::regex_replace(positioned, strayDash, "$1$2$3$4"), unclosed, "$1$2]");
}

inline const std::regex nameBox(R"((\\(?:nc|nr|n[1-5]?))<([^<>\r\n]*)>)", std::regex::icase);
inline const std::regex manualName(R"(\\nc<[^<>\\\r\n]+>[ \t\r\n]*$)", std::regex::icase);

inline std::string repairNameLineBreak(const std::string& text) {
    if (text.find('<') == std::string::npos || text.find('\\') == std::string::npos) return text;
    static const std::regex splitClosingBracket(
        R"((^|[^\\])(\\(?:nc|nr|n[1-5]?)<[^<>\\\r\n \t][^<>\\\r\n]*?)[ \t]*\r?\n[ \t]*>)",
        std::regex::icase);
    static const std::regex missingClosingBracket(
        R"((^|[^\\])(\\(?:nc|nr|n[1-5]?)<[^<>\\\r\n \t][^<>\\\r\n]{0,47}?)[ \t]*(?=\r?\n|$))",
        std::regex::icase);
    static const std::regex positionedName(
        R"((^|\n)([ \t]*)\\px\[[0-9]+\][ \t]*(\\(?:nc|nr|n[1-5]?)<[^<>\\\r\n]+>)[ \t]*(?=\r?\n|$))",
        std::regex::icase);
    auto repaired = std::regex_replace(text, splitClosingBracket, "$1$2>");
    const auto closed = std::regex_replace(repaired, missingClosingBracket, "$1$2>");
    auto result = std::regex_replace(closed, positionedName, "$1$2$3");
    if (closed == repaired) return result;
    static const std::regex terminalName(R"((^|[^\\])(\\(?:nc|nr|n[1-5]?)<[^<>\\\r\n]+>)[ \t\r\n]*$)", std::regex::icase);
    std::smatch name;
    if (!std::regex_search(result, name, terminalName)) return result;
    const auto offset = static_cast<size_t>(name.position(2));
    const auto previousBreak = result.rfind('\n', offset);
    const auto lineStart = previousBreak == std::string::npos ? 0 : previousBreak + 1;
    if (result.find_first_not_of(" \t\r", lineStart) >= offset) return result;
    const auto firstBreak = result.find('\n');
    const auto lineBreaks = std::count(result.begin(), result.end(), '\n');
    if (lineBreaks >= 3 && firstBreak != std::string::npos && result.find_first_not_of(" \t\r") >= firstBreak) {
        const auto tag = name[2].str();
        result.erase(offset, name.length(2));
        result.insert(0, tag);
    } else if (lineBreaks < 3) {
        result.insert(offset, result.find("\r\n") == std::string::npos ? "\n" : "\r\n");
    }
    return result;
}

inline std::string restoreName(const std::string& source, std::string target) {
    std::smatch original, translated;
    if (!std::regex_search(source, original, nameBox) || original[2].length() == 0 ||
        std::regex_search(original.suffix().str(), nameBox)) return target;
    if (!std::regex_search(target, translated, nameBox)) return target + original.str();
    if (translated[2].length() == 0) target.replace(translated.position(), translated.length(), original.str());
    return target;
}

inline std::string alignContinuation(std::string text, const MessageLayout& layout = {}) {
    if (text.find('\n') == std::string::npos || text.find('\\') == std::string::npos) return text;
    static const std::regex pair(R"((^|\n)(\\px\[([0-9]{1,5})\])([^\r\n]+)(\r?\n)((?:吗|嗎|呢|吧|呀|か|ね|よ)(?:[!?]|！|？|。)+)(?=\r?\n|$))", std::regex::icase);
    std::string output;
    size_t consumed = 0;
    for (auto it = std::sregex_iterator(text.begin(), text.end(), pair); it != std::sregex_iterator(); ++it) {
        const auto& match = *it;
        const auto joined = match[4].str() + match[6].str();
        // One em per code point leaves room for the full-width characters. Keep the break if metrics are unavailable.
        const auto glyphs = std::count_if(joined.begin(), joined.end(), [](unsigned char ch) { return (ch & 0xc0) != 0x80; });
        constexpr int horizontalPadding = 36;
        const bool fits = layout.width > 0 && layout.fontSize > 0 && joined.find('\\') == std::string::npos &&
            static_cast<long long>(glyphs) * layout.fontSize + std::stoi(match[3].str()) + horizontalPadding <= layout.width;
        output += text.substr(consumed, match.position() - consumed) + match[1].str() + match[2].str();
        output += fits ? joined : match[4].str() + match[5].str() + match[2].str() + match[6].str();
        consumed = match.position() + match.length();
    }
    return consumed ? output + text.substr(consumed) : text;
}

inline std::string alignPositionedLines(const std::string& text) {
    if (text.find('\n') == std::string::npos || text.find('\\') == std::string::npos) return text;
    static const std::regex control(R"(\\(?:([A-Za-z]+)(?:\[[^\]\r\n]*\]|<[^<>\r\n]*>)?|[{}.!|><^$\\]))");
    static const std::regex position(R"(\\px\[[0-9]+\])", std::regex::icase);
    static const std::regex visibleControl(R"(\\(?:[vnpi]\[[0-9]+\]|g|\\))", std::regex::icase);
    std::string output, anchor;
    output.reserve(text.size());
    for (size_t start = 0; start < text.size();) {
        const auto end = text.find('\n', start);
        auto line = text.substr(start, end == std::string::npos ? end : end - start);
        const auto first = line.find_first_not_of(" \t\r");
        if (first != std::string::npos) {
            auto cursor = line.cbegin() + first;
            std::smatch match;
            std::string explicitPosition;
            bool invalidPosition = false, hasVisibleControl = false;
            while (std::regex_search(cursor, line.cend(), match, control, std::regex_constants::match_continuous)) {
                const auto token = match.str();
                if (std::regex_match(token, position)) {
                    if (explicitPosition.empty()) explicitPosition = token;
                } else if (match[1] == "px" || match[1] == "PX" || match[1] == "Px" || match[1] == "pX") {
                    invalidPosition = true;
                } else {
                    hasVisibleControl = hasVisibleControl || std::regex_match(token, visibleControl);
                }
                cursor = match[0].second;
            }
            const bool hasBody = hasVisibleControl ||
                line.find_first_not_of(" \t\r", static_cast<size_t>(cursor - line.cbegin())) != std::string::npos;
            if (hasBody && !explicitPosition.empty()) anchor = explicitPosition;
            else if (hasBody && !invalidPosition && !anchor.empty()) line.insert(first, anchor);
        }
        output += line;
        if (end == std::string::npos) break;
        output += '\n';
        start = end + 1;
    }
    return output;
}

inline const std::regex nameWithoutSlash(R"(^[ \t\r\n]*(nc<[^<>\s\\][^<>\\\r\n]*>)[ \t\r\n]*$)", std::regex::icase);
inline const std::regex nameWithoutCommand(R"(^[ \t]*(<[^<>\s\\][^<>\\\r\n]*>)[ \t]*$)");
inline const std::regex danglingNameCommand(R"((^|[^\\])(\\nc)[ \t]*$)", std::regex::icase);

using ReportLinkedName = std::function<void(const std::string&, const std::string&)>;
inline size_t repairNameFragments(nlohmann::json& commands, const ReportLinkedName& report = {}) {
    size_t repaired = 0;
    for (size_t i = 0; i < commands.size();) {
        auto& current = commands[i];
        if (current.value("code", 0) != 401) { ++i; continue; }
        const auto text = current.at("parameters").at(0).get<std::string>();
        std::smatch name;
        if (text.find('<') == std::string::npos) { ++i; continue; }
        if (std::regex_match(text, name, nameWithoutSlash)) {
            current["parameters"][0] = "\\" + name[1].str();
            ++repaired;
        } else if (i >= 3 && commands[i - 1].value("code", 0) == 101 &&
                   commands[i - 2].value("code", 0) == 401 &&
                   (i + 1 == commands.size() || commands[i + 1].value("code", 0) == 101 ||
                    commands[i + 1].value("code", 0) == 0) &&
                   std::regex_match(text, name, nameWithoutCommand)) {
            const auto indent = current.value("indent", 0);
            const auto& header = commands[i - 1];
            size_t first = i - 2;
            while (first > 0 && commands[first - 1].value("code", 0) == 401 &&
                   commands[first - 1].value("indent", 0) == indent) --first;
            if (first > 0 && header.value("indent", 0) == indent && commands[i - 2].value("indent", 0) == indent &&
                commands[first - 1].value("code", 0) == 101 && commands[first - 1].value("indent", 0) == indent &&
                commands[first - 1].at("parameters") == header.at("parameters")) {
                auto& previous = commands[i - 2]["parameters"][0];
                auto previousText = previous.get<std::string>();
                std::smatch prefix;
                if (std::regex_search(previousText, prefix, danglingNameCommand)) {
                    if (report) {
                        std::string dialogue;
                        for (size_t line = first; line < i - 1; ++line) {
                            if (line != first) dialogue += '\n';
                            dialogue += commands[line].at("parameters").at(0).get_ref<const std::string&>();
                        }
                        report(dialogue, text);
                    }
                    previousText.resize(prefix.position(2) + prefix.length(2));
                    previous = previousText + name[1].str();
                    commands.erase(commands.begin() + (i - 1), commands.begin() + (i + 1));
                    ++repaired;
                    --i;
                    continue;
                }
            }
        }
        ++i;
    }
    return repaired;
}
}
