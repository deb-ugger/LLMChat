#pragma once

#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

struct UnityInstallControl;

namespace unity_runtime
{
struct ArtifactSpec
{
    std::filesystem::path path;
    std::uintmax_t minimumSize;
};

std::filesystem::path resolveCachedArtifact(const ArtifactSpec& artifact);
std::filesystem::path bepinexCacheDir();
std::filesystem::path fontsCacheDir();
std::filesystem::path ensureSevenZr(
    std::vector<std::string>& steps, const UnityInstallControl* control, std::string& error);
bool downloadFile(
    const std::string& url, const std::filesystem::path& dest,
    const UnityInstallControl* control, std::string& error);
}
