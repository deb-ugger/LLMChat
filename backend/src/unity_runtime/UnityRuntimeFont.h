#pragma once

#include <filesystem>
#include <string>
#include <vector>

struct UnityInstallControl;

namespace unity_runtime
{
struct CjkFontSettings
{
    std::string uguiFont;    // OverrideFont (UGUI system face or path)
    std::string tmpFont;     // TMP asset bundle name for Override + Fallback
};

struct FontArchiveOperations
{
    bool (*extractZip)(const std::filesystem::path&, const std::filesystem::path&, std::string& error);
    bool (*runTool)(const std::filesystem::path&, const std::wstring&, std::string& error);
};

CjkFontSettings resolveRuntimeFonts(
    const std::filesystem::path& gameDir, const std::string& language,
    const UnityInstallControl* control, std::vector<std::string>& steps,
    std::string& warning, const FontArchiveOperations& archives);
std::string applyFontOverrides(std::string content, const CjkFontSettings& fonts);
std::string checkRuntimeFontStatus(const std::filesystem::path& gameDir, const CjkFontSettings& fonts);
}
