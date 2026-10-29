#pragma once

#include "Utf8Path.h"
#include <filesystem>
#include <string>

namespace runtime_assets {

inline std::filesystem::path resolve(const std::filesystem::path& root, const std::string& relative)
{
    namespace fs = std::filesystem;
    const fs::path rel = utf8path::pathFromUtf8(relative);
    if (rel.empty() || rel.is_absolute() || rel.has_root_name()) return {};
    for (const auto& part : rel) if (part == "..") return {};
    const auto group = *rel.begin();
    if (group != "ocr" && group != "ort" && group != "manga-ort" && group != "wtp") return {};
    std::error_code ec;
    const auto base = fs::weakly_canonical(root, ec);
    if (ec) return {};
    const auto file = fs::weakly_canonical(base / rel, ec);
    if (ec) return {};
    const auto inside = file.lexically_relative(base);
    if (inside.empty() || inside.is_absolute()) return {};
    for (const auto& part : inside) if (part == "..") return {};
    if (!fs::is_regular_file(file, ec) || ec) return {};
    return file;
}

inline const char* contentType(const std::filesystem::path& file)
{
    const auto extension = file.extension();
    if (extension == ".wasm") return "application/wasm";
    if (extension == ".mjs" || extension == ".js") return "text/javascript; charset=utf-8";
    if (extension == ".json") return "application/json; charset=utf-8";
    if (extension == ".txt") return "text/plain; charset=utf-8";
    if (extension == ".tar") return "application/x-tar";
    return "application/octet-stream";
}

} // namespace runtime_assets
