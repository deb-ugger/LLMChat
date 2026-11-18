#pragma once
#include <string>
#include <string_view>

namespace ascii_text {
// Pricing tables and usage logs trim all ASCII control bytes as well as spaces.
inline std::string trimCopy(std::string_view value)
{
    while (!value.empty() && static_cast<unsigned char>(value.front()) <= 0x20)
        value.remove_prefix(1);
    while (!value.empty() && static_cast<unsigned char>(value.back()) <= 0x20)
        value.remove_suffix(1);
    return std::string(value);
}
} // namespace ascii_text
