#include "GameImageExportConfirmation.h"

#ifdef _WIN32
#include "GameImageExportIO.h"
#endif

namespace gameimageexport::confirmation {

bool portableIdentifier(std::string_view value, bool allowEmpty) {
    if (value.empty()) return allowEmpty;
    for (const auto character : value) {
        if (static_cast<unsigned char>(character) < 32 || character == '\x7f' ||
            character == ':' || character == '/' || character == '\\') return false;
    }
    return true;
}

#ifdef _WIN32
namespace {

using namespace io;

bool sha256(std::string_view value) { return value.size() == 64 && hexString(value); }

bool stamp(std::string_view value) {
    return !value.empty() && value.find_first_not_of("0123456789-") == std::string_view::npos;
}

Json boxRecords(const Json& boxes, uint32_t width, uint32_t height, bool translation, bool whole) {
    if (!boxes.is_array() || (whole ? !translation || !boxes.empty() : boxes.empty()))
        throw Error("INPUT_STALE", "确认记录的蒙版范围无效");
    std::set<std::pair<std::string, std::array<int64_t, 4>>> seen;
    unsigned translated = 0, repaired = 0, protectedCount = 0;
    auto result = Json::array();
    for (const auto& box : boxes) {
        const auto role = box.at("role").get<std::string>();
        const auto& coordinates = box.at("rect");
        if (!coordinates.is_array() || coordinates.size() != 4 ||
            !std::all_of(coordinates.begin(), coordinates.end(), [](const Json& coordinate) {
                return coordinate.is_number_integer() &&
                    (!coordinate.is_number_unsigned() || coordinate.get<uint64_t>() <= INT64_MAX);
            }))
            throw Error("INPUT_STALE", "确认记录的蒙版坐标无效");
        const auto rect = coordinates.get<std::array<int64_t, 4>>();
        const auto [left, top, right, bottom] = rect;
        if (left < 0 || top < 0 || right <= left || bottom <= top || right > width || bottom > height ||
            !seen.emplace(role, rect).second)
            throw Error("INPUT_STALE", "确认记录的蒙版坐标无效或重复");
        std::string id;
        if (translation && role == "translate") id = "t" + std::to_string(++translated);
        else if (!translation && role == "repair") id = "m" + std::to_string(++repaired);
        else if (!translation && role == "protect") id = "p" + std::to_string(++protectedCount);
        if (id.empty() || box.at("id") != id)
            throw Error("INPUT_STALE", "确认记录的蒙版编号无效");
        result.push_back({{"id", id}, {"role", role}, {"rect", rect}});
    }
    if (!translation && !repaired) throw Error("INPUT_STALE", "去码确认记录缺少重绘框");
    return result;
}

Json nullableIdentifier(const Json& value) {
    if (value.is_null()) return nullptr;
    if (!value.is_string() || !portableIdentifier(value.get_ref<const std::string&>()))
        throw Error("INPUT_STALE", "确认记录的便携标识无效");
    return value;
}

std::string confirmationId(const Json& value) {
    Sha256 digest;
    digest.field("llmchat-image-confirmation-v1");
    digest.add(value.dump(-1, ' ', true));
    auto code = digest.finish().substr(0, 32);
    code[12] = '8';
    code[16] = '8';
    return code.substr(0, 8) + "-" + code.substr(8, 4) + "-" + code.substr(12, 4) + "-" +
        code.substr(16, 4) + "-" + code.substr(20);
}

} // namespace

nlohmann::json seal(const Json& record, uint32_t width, uint32_t height) {
    try {
        const auto imageId = record.at("imageId").get<std::string>();
        const auto sourceHash = record.at("sourceHash").get<std::string>();
        const auto sourceSha256 = record.at("sourceSha256").get<std::string>();
        const auto layer = record.at("layer").get<std::string>();
        const auto candidateVersion = record.at("candidateVersion").get<std::string>();
        const auto pngSha256 = record.at("pngSha256").get<std::string>();
        const auto mask = record.at("maskMode").get<std::string>();
        const bool translation = layer == "translation";
        if (!hexString(imageId) || imageId.size() > 16 || !stamp(sourceHash) || !sha256(sourceSha256) ||
            (!translation && layer != "mosaic") || !sha256(pngSha256) ||
            (translation ? !stamp(candidateVersion) : candidateVersion != pngSha256) ||
            (mask != "boxes" && mask != "whole-image"))
            throw Error("INPUT_STALE", "确认记录的标识、版本或摘要无效");
        Json result{{"recordVersion", 1}, {"imageId", imageId}, {"sourceHash", sourceHash}, {"sourceSha256", sourceSha256},
            {"layer", layer}, {"candidateVersion", candidateVersion}, {"pngSha256", pngSha256},
            {"groupId", nullableIdentifier(record.at("groupId"))}, {"maskMode", mask},
            {"boxes", boxRecords(record.at("boxes"), width, height, translation, mask == "whole-image")}};
        if (translation) {
            const auto kind = record.at("renderedKind").get<std::string>();
            const auto language = record.at("targetLanguage").get<std::string>();
            if (kind != (mask == "whole-image" ? "imported" : "generated") || !portableIdentifier(language, true))
                throw Error("INPUT_STALE", "确认记录的译图来源或语言无效");
            result["renderedKind"] = kind;
            result["targetLanguage"] = language;
        } else {
            result["modelId"] = nullableIdentifier(record.value("modelId", Json(nullptr)));
        }
        const auto id = confirmationId(result);
        result["confirmationId"] = id;
        return result;
    } catch (const Json::exception&) {
        throw Error("INPUT_STALE", "确认记录的字段缺失或无效");
    }
}

nlohmann::json readVerified(const Path& game, const Source& source, std::string_view layer, const LayerSelection& selected) {
    if (!hexString(source.imageId) || source.imageId.size() > 16 || (layer != "translation" && layer != "mosaic"))
        throw Error("INPUT_STALE", "确认记录的图片或图层无效");
    const auto name = Path("LLMChat-JSON/images/export-inputs") / std::string(source.imageId) / (std::string(layer) + ".json");
    const auto file = openSource(game, name, true);
    if (!file)
        throw Error("CONFIRMATION_REQUIRED", "缺少图片确认记录，请重新确认", std::string(source.imageId));
    try {
        const auto raw = Json::parse(read(file, game / name));
        if (!raw.contains("recordVersion") || !raw.at("recordVersion").is_number_integer() ||
            raw.at("recordVersion") != 1)
            throw Error("CONFIRMATION_REQUIRED", "确认记录版本已过期，请重新确认", std::string(source.imageId));
        auto record = seal(raw, source.width, source.height);
        if (record.at("confirmationId") != raw.at("confirmationId") ||
            record.at("confirmationId") != selected.confirmationId ||
            record.at("layer").get_ref<const std::string&>() != layer ||
            record.at("imageId").get_ref<const std::string&>() != source.imageId ||
            record.at("sourceHash").get_ref<const std::string&>() != source.sourceHash ||
            record.at("sourceSha256").get_ref<const std::string&>() != source.sourceSha256 ||
            record.at("candidateVersion") != selected.version)
            throw Error("INPUT_STALE", "确认内容、原图或候选版本已改变，请重新确认", std::string(source.imageId));
        return record;
    } catch (const Json::exception&) {
        throw Error("INPUT_STALE", "确认记录无法读取或格式无效", std::string(source.imageId));
    }
}

nlohmann::json manifestLayer(const Json& verified) {
    Json result = Json::object();
    for (const auto field : {"layer", "confirmationId", "groupId", "candidateVersion", "pngSha256", "maskMode", "boxes"})
        result[field] = verified.at(field);
    if (verified.at("layer") == "translation") {
        result["renderedKind"] = verified.at("renderedKind");
        result["targetLanguage"] = verified.at("targetLanguage");
    } else {
        result["modelId"] = verified.at("modelId");
    }
    return result;
}

#else

nlohmann::json seal(const nlohmann::json&, uint32_t, uint32_t) {
    throw Error("UNSUPPORTED_PLATFORM", "图片确认记录需要 Windows");
}
nlohmann::json readVerified(const std::filesystem::path&, const Source&, std::string_view, const LayerSelection&) {
    throw Error("UNSUPPORTED_PLATFORM", "图片确认记录需要 Windows");
}
nlohmann::json manifestLayer(const nlohmann::json&) {
    throw Error("UNSUPPORTED_PLATFORM", "图片确认记录需要 Windows");
}

#endif

} // namespace gameimageexport::confirmation
