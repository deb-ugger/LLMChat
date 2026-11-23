#pragma once

#include <filesystem>
#include <functional>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

class RpgImageProject;

namespace gameimageexport {

struct LayerSelection {
    std::string confirmationId;
    // renderedHash for translation, PNG SHA-256 for mosaic.
    std::string version;
};

struct ImageSelection {
    std::string imageId;
    std::string sourceHash;
    std::optional<LayerSelection> translation;
    std::optional<LayerSelection> mosaic;
};

struct Request {
    std::filesystem::path gamePath;
    std::filesystem::path outputDir;
    std::string toolVersion;
    std::vector<ImageSelection> images;
};

struct Progress {
    std::string_view phase;
    size_t completed;
    size_t total;
    std::string_view relativePath;
};

struct Control {
    std::function<bool()> cancelled;
    std::function<void(const Progress&)> progress;
};

struct Result {
    std::string packageId;
    std::filesystem::path packagePath;
    std::string manifestSha256;
    size_t files;
    size_t skipped;
};

class Error : public std::runtime_error {
public:
    Error(std::string code, std::string message, std::string detail = {});
    const std::string code;
    const std::string detail;
};

bool legacyPatchInstalled(const std::filesystem::path& gamePath);
Result generate(RpgImageProject& project, const Request& request, const Control& control = {});

} // namespace gameimageexport
