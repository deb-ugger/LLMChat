#pragma once

#include "GameImageExportPackage.h"

#include <cstdint>
#include <nlohmann/json.hpp>

namespace gameimageexport::confirmation {

struct Source {
    std::string_view imageId;
    std::string_view sourceHash;
    std::string_view sourceSha256;
    uint32_t width;
    uint32_t height;
};

bool portableIdentifier(std::string_view value, bool allowEmpty = false);

// Creates the on-disk record from the confirmed data, ignoring unrecognized fields.
nlohmann::json seal(const nlohmann::json& record, uint32_t width, uint32_t height);

// Reads one record, checks its ID against the exact authorized source and metadata,
// and returns the canonical record for subsequent use without rereading the file.
nlohmann::json readVerified(const std::filesystem::path& game, const Source& source,
    std::string_view layer, const LayerSelection& selected);

nlohmann::json manifestLayer(const nlohmann::json& verified);

} // namespace gameimageexport::confirmation
