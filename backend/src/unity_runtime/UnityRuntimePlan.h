#pragma once

#include "UnityAutoTranslator.h"

#include <filesystem>
#include <string>
#include <vector>

namespace unity_runtime
{
struct CjkFontSettings;

inline constexpr const char* kReleaseVersion = "5.6.1";
inline constexpr const char* kBepInExVersion = "6.0.0-pre.2";

struct RuntimeInstallPlan
{
    std::string package;
    std::string url;
};

RuntimeInstallPlan buildInstallPlan(const std::string& method);
RuntimeInstallPlan buildBepInExInstallPlan(const std::string& arch);
UnityInstallRequest resolveInstallConfig(const UnityInstallRequest& req);

std::string defaultAutoTranslatorIniTemplate();
std::string readIniValue(const std::string& content, const std::string& key);
std::vector<std::filesystem::path> autoTranslatorConfigPaths(
    const std::filesystem::path& gameDir, const std::string& method);
std::vector<UnityIniSection> parseIniSections(const std::string& content);
std::string serializeIniSections(const std::vector<UnityIniSection>& sections);
std::vector<UnityIniSection> mergeIniOverDefaults(
    const std::vector<UnityIniSection>& defaults, const std::vector<UnityIniSection>& fileSecs);
std::string buildConfigIni(const UnityInstallRequest& req, const CjkFontSettings& fonts);
}
