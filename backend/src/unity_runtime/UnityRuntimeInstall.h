#pragma once

#include "UnityAutoTranslator.h"

#include <filesystem>
#include <string>
#include <vector>

namespace unity_runtime
{
UnityInstallResult install(const UnityInstallRequest& req, const UnityInstallControl& control);
UnityInstallResult fixFont(const UnityFixFontRequest& req);
UnityUninstallResult uninstall(const UnityUninstallRequest& req);
UnityInstallResult installLoader(const UnityLoaderRequest& req, const UnityInstallControl& control);
UnityUninstallResult uninstallLoader(const UnityLoaderRequest& req);
UnityConfigResult getConfig(const std::string& gamePath);
UnityConfigResult saveConfig(const std::string& gamePath, const std::vector<UnityIniSection>& sections);

// The runtime facade uses these helpers for launch and diagnostics.
bool resolveDetectedGame(
    const UnityDetectInfo& detected, std::string& gameDir, UnityGameItem& game, std::string& error);
std::filesystem::path findPatchAndRunShortcut(const std::filesystem::path& gameDir, const std::string& gameExe);
std::filesystem::path findReiPatcherIni(const std::filesystem::path& gameDir, const std::string& gameExe);
std::string checkOverrideFontStatus(const std::filesystem::path& gameDir, const std::string& method);
}
