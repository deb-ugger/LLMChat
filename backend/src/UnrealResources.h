#pragma once
#include "GameFileOps.h"
#include <array>
#include <bit>
#include <codecvt>
#include <locale>
#include <string_view>

namespace unreal {
using namespace gamefiles;
inline constexpr std::string_view engine = "Unreal Engine";

inline bool directory(const fs::path& path) {
    std::error_code error;
    return fs::is_directory(path, error) && !reparsePoint(path);
}
inline bool hasContent(const fs::path& path) {
    if (!directory(path)) return false;
    const auto project = path.parent_path();
    return directory(path / "Paks") || directory(path / "Localization") || directory(project / "Binaries" / "Win64")
        || fs::is_regular_file(project / (project.filename().wstring() + L".uproject"));
}
inline std::vector<fs::path> contentFolders(const fs::path& game) {
    std::vector<fs::path> result;
    if (hasContent(game / "Content")) return {game / "Content"};
    const bool packagedEngine = directory(game / "Engine");
    for (const auto& item : fs::directory_iterator(game, fs::directory_options::skip_permission_denied)) {
        const auto name = item.path().filename().wstring();
        if (name == L"Engine" || name.starts_with(L"LLMChat") || !directory(item.path())) continue;
        if (hasContent(item.path() / "Content") &&
            (fs::is_regular_file(game / (name + L".exe")) || (packagedEngine && directory(item.path() / "Binaries"))))
            result.push_back(item.path() / "Content");
    }
    return result;
}
// The shared image editor reads and writes PNG bytes at these game-relative paths.
template<class Visit> void visitImages(const fs::path& game, Visit visit) {
    for (const auto& content : contentFolders(game)) {
        for (auto it = fs::recursive_directory_iterator(content, fs::directory_options::skip_permission_denied);
             it != fs::recursive_directory_iterator(); ++it) {
            if (reparsePoint(it->path())) { it.disable_recursion_pending(); continue; }
            if (!it->is_regular_file()) continue;
            auto ext = it->path().extension().wstring();
            for (auto& c : ext) if (c >= L'A' && c <= L'Z') c += L'a' - L'A';
            if (ext == L".png") visit(it->path().lexically_relative(game));
        }
    }
}
inline std::vector<fs::path> localizationFiles(const fs::path& game) {
    std::vector<fs::path> files;
    for (const auto& content : contentFolders(game)) {
        const auto folder = content / "Localization";
        if (!directory(folder)) continue;
        const auto options = fs::directory_options::skip_permission_denied;
        for (auto it = fs::recursive_directory_iterator(folder, options); it != fs::recursive_directory_iterator(); ++it) {
            if (reparsePoint(it->path())) { it.disable_recursion_pending(); continue; }
            if (it->is_regular_file() && it->path().extension() == ".locres")
                files.push_back(it->path().lexically_relative(game));
        }
    }
    std::sort(files.begin(), files.end());
    return files;
}
inline std::vector<fs::path> binaryFolders(const fs::path& game) {
    std::vector<fs::path> folders;
    for (const auto& content : contentFolders(game)) {
        const auto binaries = content.parent_path() / "Binaries";
        if (directory(binaries) && directory(binaries / "Win64")) folders.push_back(binaries / "Win64");
    }
    return folders;
}
inline bool identified(const fs::path& path) {
    if (hasContent(path / "Content")) return true;
    return !contentFolders(path).empty();
}
inline fs::path executable(const fs::path& game) {
    auto named = game / (game.filename().wstring() + L".exe");
    if (fs::is_regular_file(named)) return named;
    std::vector<fs::path> shipping;
    for (const auto& dir : binaryFolders(game)) for (const auto& item : fs::directory_iterator(dir)) {
        if (item.is_regular_file() && !reparsePoint(item.path()) &&
            item.path().filename().wstring().ends_with(L"-Shipping.exe")) shipping.push_back(item.path());
    }
    if (shipping.size() != 1) throw std::runtime_error("无法唯一确定 UE 主程序，请从游戏目录启动");
    const auto rootLauncher = game / (shipping.front().parent_path().parent_path().parent_path().filename().wstring() + L".exe");
    return fs::is_regular_file(rootLauncher) ? rootLauncher : shipping.front();
}

// Keep the original namespace/key and hash bytes. Only localized FString spans
// are replaced, so both legacy inline and shared string-table indexes survive.
class Locres {
    static constexpr std::string_view magic{"\x0e\x14\x74\x75\x67\x4a\x03\xfc\x4a\x15\x90\x9d\xc3\x37\x7f\x1b", 16};
    static constexpr size_t maximumSize = 256 * 1024 * 1024;
    struct Span { size_t from, end; bool used = true; };
    std::string bytes_;
    std::vector<Span> values_;
    size_t position_ = 0;
    uint8_t version_ = 0;
    [[noreturn]] static void invalid() { throw std::runtime_error("UE .locres 资源结构无效或不受支持"); }
    uint64_t number(size_t size) {
        if (size > bytes_.size() - position_) invalid();
        uint64_t value = 0;
        for (size_t i = 0; i < size; ++i) value |= uint64_t(static_cast<uint8_t>(bytes_[position_++])) << (i * 8);
        return value;
    }
    int32_t integer() { return std::bit_cast<int32_t>(static_cast<uint32_t>(number(4))); }
    size_t count() {
        const auto value = number(4);
        if (value > (bytes_.size() - position_) / 4) invalid();
        return static_cast<size_t>(value);
    }
    Span stringSpan() {
        const auto from = position_;
        const auto chars = static_cast<int64_t>(integer());
        const size_t length = static_cast<size_t>(chars < 0 ? -chars * 2 : chars);
        if (length > bytes_.size() - position_) invalid();
        position_ += length;
        if (length && (bytes_[position_ - 1] != 0 || (chars < 0 && bytes_[position_ - 2] != 0))) invalid();
        return {from, position_};
    }
    void key() { if (version_ >= 2) number(4); stringSpan(); }
    static void put(std::string& output, uint64_t value, size_t size) {
        for (size_t i = 0; i < size; ++i) output.push_back(static_cast<char>(value >> (i * 8)));
    }
    std::string text(const Span& span) const {
        const size_t length = span.end - span.from - 4;
        if (length == 0) return {};
        const auto* data = bytes_.data() + span.from + 4;
        std::wstring_convert<std::codecvt_utf8_utf16<char16_t>, char16_t> converter;
        if (static_cast<uint8_t>(bytes_[span.from + 3]) < 128) {
            std::string value(data, length - 1);
            try { (void)converter.from_bytes(value); return value; }
            catch (const std::range_error&) {
#ifdef _WIN32
                std::wstring ansi(value.size(), L'\0');
                MultiByteToWideChar(1252, 0, value.data(), static_cast<int>(value.size()), ansi.data(), static_cast<int>(ansi.size()));
                return utf8path::toUtf8(ansi);
#else
                invalid();
#endif
            }
        }
        std::u16string value;
        value.reserve(length / 2 - 1);
        for (size_t i = 0; i + 2 < length; i += 2)
            value.push_back(static_cast<char16_t>(uint16_t(static_cast<uint8_t>(data[i])) | (uint16_t(static_cast<uint8_t>(data[i + 1])) << 8)));
        return converter.to_bytes(value);
    }
    static void writeText(std::string& output, const std::string& text) {
        if (text.find('\0') != std::string::npos || text.size() >= maximumSize) invalid();
        if (std::all_of(text.begin(), text.end(), [](unsigned char byte) { return byte < 128; })) {
            put(output, text.size() + 1, 4); output += text; output.push_back('\0');
        } else {
            std::wstring_convert<std::codecvt_utf8_utf16<char16_t>, char16_t> converter;
            const auto wide = converter.from_bytes(text);
            put(output, static_cast<uint32_t>(-static_cast<int32_t>(wide.size() + 1)), 4);
            for (const auto letter : wide) put(output, letter, 2);
            put(output, 0, 2);
        }
    }
public:
    explicit Locres(std::string bytes) : bytes_(std::move(bytes)) {
        if (bytes_.size() > maximumSize) invalid();
        if (bytes_.starts_with(magic)) { position_ = magic.size(); version_ = static_cast<uint8_t>(number(1)); }
        if (version_ > 3) invalid();
        const auto offset = version_ ? number(8) : UINT64_MAX;
        const auto entries = version_ >= 2 ? count() : 0;
        std::vector<int32_t> indexes;
        size_t total = 0;
        const auto namespaces = count();
        for (size_t i = 0; i < namespaces; ++i) {
            key();
            const auto keys = count();
            for (size_t j = 0; j < keys; ++j) {
                key(); number(4); ++total;
                if (version_) indexes.push_back(integer());
                else values_.push_back(stringSpan());
            }
        }
        if (version_ >= 2 && entries != total) invalid();
        if (offset != UINT64_MAX) {
            if (offset < position_ || offset > bytes_.size()) invalid();
            position_ = static_cast<size_t>(offset);
            const auto strings = count();
            for (size_t i = 0; i < strings; ++i) {
                auto value = stringSpan(); value.used = false; values_.push_back(value);
                if (version_ >= 2) number(4);
            }
        }
        for (const auto index : indexes) {
            if (index == -1) continue;
            if (index < 0 || static_cast<size_t>(index) >= values_.size()) invalid();
            values_[index].used = true;
        }
        if (position_ != bytes_.size()) invalid();
    }
    template<class Replace> std::optional<std::string> rewrite(Replace replace) const {
        std::string output;
        size_t previous = 0;
        for (const auto& span : values_) {
            if (!span.used) continue;
            auto value = text(span);
            if (!replace(value)) continue;
            output.append(bytes_, previous, span.from - previous);
            writeText(output, value);
            previous = span.end;
        }
        if (!previous) return std::nullopt;
        output.append(bytes_, previous, bytes_.size() - previous);
        return output;
    }
};
}
