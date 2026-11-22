#pragma once

#include <array>
#include <cstdint>
#include <filesystem>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace gameimageexport::selection {

enum class LayerKind { Translation, Mosaic };

struct Layer {
    LayerKind kind;
    // Source-image pixels, left/top inclusive and right/bottom exclusive.
    std::array<int64_t, 4> rect;
    // The stored renderedHash for translation, the saved candidate SHA-256 for mosaic.
    std::string versionId;
    std::string sha256;
    std::string confirmationId;
    std::string boxId;
    std::string role;
};

struct Entry {
    std::string id;
    std::string sourceHash;
    std::vector<Layer> layers;
};

// project is the server's loaded picture catalog with current persisted row state.
// The server stamps each capture in UTC. The remaining JSON is canonical for the confirmed inputs.
// These functions read the game directory and never write a snapshot or any other file.
// Input errors are reported as gameimageexport::Error.
std::string createSnapshot(const std::filesystem::path& gameRoot, const nlohmann::json& project,
    std::span<const Entry> entries);

void validateSnapshot(const std::filesystem::path& gameRoot, const nlohmann::json& project,
    std::string_view serialized);

} // namespace gameimageexport::selection
