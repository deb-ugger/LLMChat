#pragma once

#include "UnityAutoTranslator.h"

#include <functional>
#include <string>
#include <filesystem>

namespace unity_runtime
{
UnityGameItem inspectGameDir(const std::filesystem::path& input);
UnityDetectInfo detect(const std::string& gamePath, bool recursive);
void detectStream(
    const std::string& gamePath,
    const std::function<void(const std::string&)>& emitLine,
    const std::function<bool()>& shouldStop);

// The runtime installer and self-check also use these detection primitives.
std::string readPeArch(const std::filesystem::path& exe);
bool nameLooksLikeXUnityConfig(const std::string& fileName);
bool detectAutoTranslator(const std::filesystem::path& gameDir);
bool detectBepInEx(const std::filesystem::path& gameDir);
bool detectReiPatcher(const std::filesystem::path& gameDir);

namespace detail
{
std::string trimCopy(std::string s);
bool iequals(const std::string& a, const std::string& b);
}
}
