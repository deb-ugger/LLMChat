#include "GameImageExportConfirmation.h"

#ifdef _WIN32
#include "GameImageExportIO.h"
#include "RpgImageProject.h"
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
        if (record.contains("confirmationGameRootFingerprint") || record.contains("gameRootFingerprint")) {
            for (const auto name : {"confirmationGameRootFingerprint", "gameRootFingerprint"}) {
                const auto digest = record.at(name).get<std::string>();
                if (!sha256(digest)) throw Error("INPUT_STALE", "确认范围指纹无效");
                result[name] = digest;
            }
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
            record.at("candidateVersion") != selected.version)
            throw Error("INPUT_STALE", "确认内容、原图或候选版本已改变，请重新确认", std::string(source.imageId));
        if (record.at("sourceSha256").get_ref<const std::string&>() != source.sourceSha256)
            throw Error("INPUT_STALE", "源文件内容与确认时不同，请重新确认", std::string(source.imageId));
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


class ProjectConfirmation {
    struct Resource {
        Path relativePath;
        Handle original;
        Handle candidate;
        std::vector<Handle> originalParents;
        std::vector<Handle> candidateParents;
        std::string sourceHash;
        std::string sourceSha256;
        std::string candidateVersion;
        std::string pngSha256;
        std::string png;
        std::string originalHeader;
        uint32_t width;
        uint32_t height;
        uint64_t bytes;
    };

    Root game_;
    DirectoryLock lock_;
    std::unique_lock<std::recursive_mutex> projectLock_;
    Engine engine_;
    std::string id_;
    std::string layer_;
    Path metadata_;
    Json row_;

    static std::string fingerprint(const Engine& engine, uint64_t markerBytes, std::string_view markerSha,
        const Resource* resource) {
        Sha256 digest;
        digest.field("llmchat-game-image-baseline-v1");
        digest.field(engine.name);
        digest.field("marker");
        digest.field(gamefiles::key(engine.marker));
        digest.field(std::to_string(markerBytes));
        digest.field(markerSha);
        if (resource) {
            digest.field("file");
            digest.field(gamefiles::key(resource->relativePath));
            digest.field(std::to_string(resource->bytes));
            digest.field(resource->sourceSha256);
        }
        return digest.finish();
    }

    Resource resources() const {
        const auto name = row_.at("file").get<std::string>();
        const auto relativePath = relative(name);
        targetPath(game_.path, engine_, row_, relativePath, name);
        if (ordinal(relative(row_.at("sourceFile").get<std::string>()).native(), relativePath.native()) != CSTR_EQUAL)
            throw Error("INVALID_PATH", "图片原件路径与游戏目标不一致", id_);

        auto originalParents = pinParents(game_.path, relativePath);
        auto original = openSource(game_.path, relativePath, true);
        const auto sourceHash = row_.at("sourceHash").get<std::string>();
        if (!original)
            throw Error("INPUT_STALE", "源文件已改变，请重新扫描并确认", id_);
        const auto bytes = length(original, game_.path / relativePath);
        if (bytes > maxImageBytes) throw Error("IMAGE_TOO_LARGE", "源文件超出成品导出的大小限制", id_);
        Sha256 sourceDigest;
        std::string originalHeader;
        readChunks(original, game_.path / relativePath, [&](std::string_view chunk) {
            sourceDigest.add(chunk);
            if (originalHeader.size() < 40) originalHeader.append(chunk.substr(0, 40 - originalHeader.size()));
        });
        const auto originalSha = sourceDigest.finish();
        if (RpgImageProject::stamp(game_.path / relativePath) != sourceHash &&
            managedOriginalSha256(game_.path, row_) != originalSha)
            throw Error("INPUT_STALE", "源文件已改变，请重新扫描并确认", id_);

        const auto folder = RpgImageProject::folder(game_.path);
        const auto path = layer_ == "translation" ? folder / "rendered" / (id_ + ".png") :
            RpgImageProject::mosaicImage(game_.path, row_);
        const auto candidateName = path.lexically_relative(game_.path);
        auto candidateParents = pinParents(game_.path, candidateName);
        auto candidate = openSource(game_.path, candidateName, true);
        if (!candidate) throw Error("CONFIRMATION_REQUIRED", "请先保存候选图片，再确认此版", id_);
        auto png = read(candidate, path, maxImageBytes);
        const auto [width, height] = RpgImageProject::dimensions(png);
        if (row_.at("width") != width || row_.at("height") != height)
            throw Error("INPUT_STALE", "候选图片尺寸与原图不一致，请重新确认", id_);
        const auto pngSha = hash(png);
        const auto version = layer_ == "translation" ? RpgImageProject::stamp(path) : pngSha;
        if (layer_ == "translation" && row_.value("renderedHash", "") != version)
            throw Error("INPUT_STALE", "译图版本已改变，请重新确认", id_);
        return {relativePath, std::move(original), std::move(candidate), std::move(originalParents),
            std::move(candidateParents), sourceHash, originalSha, version, pngSha, std::move(png),
            std::move(originalHeader), width, height, bytes};
    }

    void put(const Json& record) const {
        const auto serialized = record.dump(2) + "\n";
        const auto parents = createParents(game_.path, metadata_);
        {
            const auto existing = openSource(game_.path, metadata_, true);
            if (existing && read(existing, game_.path / metadata_) == serialized) return;
        }
        const auto temp = metadata_.parent_path() / ("." + newId() + ".partial");
        try {
            write(game_.path, temp, serialized);
            if (!MoveFileExW((game_.path / temp).c_str(), (game_.path / metadata_).c_str(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
                const auto status = GetLastError();
                winError(status == ERROR_ACCESS_DENIED ? "PERMISSION_DENIED" : "OUTPUT_WRITE_FAILED",
                    "无法发布确认记录", game_.path / metadata_, status);
            }
        } catch (...) {
            DeleteFileW((game_.path / temp).c_str());
            throw;
        }
    }

    static Json confirmed(const Json& record) {
        Json result{{"state", "confirmed"}, {"confirmationId", record.at("confirmationId")},
            {"candidateVersion", record.at("candidateVersion")}, {"pngSha256", record.at("pngSha256")}};
        for (const auto name : {"confirmationGameRootFingerprint", "gameRootFingerprint"})
            if (record.contains(name)) result[name] = record.at(name);
        return result;
    }

public:
    static std::optional<std::string> managedOriginalDigest(const Path& game, const Json& image, const std::string* imageKey) {
        const auto id = image.at("id").get<std::string>();
        const auto version = image.at("sourceHash").get<std::string>();
        if (!hexString(id) || id.size() > 16 || !stamp(version) || version.size() > 64) return std::nullopt;
        const auto backup = RpgImageProject::originalCache(game, image);
        const auto original = openSource(game, backup.lexically_relative(game), true);
        if (!original) return std::nullopt;
        std::string key;
        if (!imageKey && image.value("encrypted", false)) {
            const auto system = detectEngine(game).marker;
            key = Json::parse(read(openSource(game, system), game / system)).value("encryptionKey", "");
            imageKey = &key;
        }
        return hash(RpgImageProject::imageBytes(image, read(original, backup, maxImageBytes), imageKey ? *imageKey : key, true));
    }

    ProjectConfirmation(RpgImageProject& project, const Path& game, const Json& request)
        : game_(game), lock_(game_.ids.back()), projectLock_(project.mutex_, std::try_to_lock),
          engine_(detectEngine(game_.path)), id_(request.at("imageId").get<std::string>()),
          layer_(request.at("layer").get<std::string>()) {
        if (!projectLock_) throw Error("BUSY", "图片工程正在更新，请稍后重试");
        if (!hexString(id_) || id_.size() > 16 || (layer_ != "mosaic" && layer_ != "translation"))
            throw Error("INVALID_REQUEST", "无效的图片编号或确认图层");
        metadata_ = Path("LLMChat-JSON/images/export-inputs") / id_ / (layer_ + ".json");
        row_ = project.imageRow(game_.path, id_);
    }

    Json save(const Json& request) const {
        const auto resource = resources();
        if (request.at("sourceHash") != resource.sourceHash || request.at("candidateVersion") != resource.candidateVersion ||
            request.at("pngSha256") != resource.pngSha256)
            throw Error("INPUT_STALE", "源文件或候选图已改变，请重新确认", id_);

        const auto markerPath = game_.path / engine_.marker;
        const auto marker = openSource(game_.path, engine_.marker);
        const auto markerBytes = length(marker, markerPath);
        const bool encrypted = row_.value("encrypted", false);
        const auto markerText = encrypted ? read(marker, markerPath) : std::string{};
        Sha256 markerHash;
        if (encrypted) markerHash.add(markerText);
        else readChunks(marker, markerPath, [&](std::string_view chunk) { markerHash.add(chunk); });
        const auto markerSha = markerHash.finish();
        if (encrypted != (gameresourcebackup::imageExtension(resource.relativePath) != ".png"))
            throw Error("INPUT_STALE", "原图格式与项目记录不一致，请重新扫描并确认", id_);
        const auto key = encrypted ? Json::parse(markerText).value("encryptionKey", "") : std::string{};
        std::pair<uint32_t, uint32_t> sourceSize;
        try {
            sourceSize = RpgImageProject::dimensions(RpgImageProject::imageBytes(row_, resource.originalHeader, key, false));
        } catch (const std::runtime_error&) {
            throw Error("INPUT_STALE", "源文件格式或密钥已改变，请重新扫描并确认", id_);
        }
        if (sourceSize != std::pair{resource.width, resource.height})
            throw Error("INPUT_STALE", "源文件尺寸已改变，请重新扫描并确认", id_);
        // Rewrapping must match the byte equality test in package generation.
        const auto writtenSha = encrypted ? hash(RpgImageProject::imageBytes(row_, resource.png, key, true)) :
            resource.pngSha256;
        Json record{{"imageId", id_}, {"layer", layer_}, {"sourceHash", resource.sourceHash},
            {"sourceSha256", resource.sourceSha256}, {"candidateVersion", resource.candidateVersion},
            {"pngSha256", resource.pngSha256}, {"groupId", request.value("groupId", Json(nullptr))},
            {"maskMode", request.at("maskMode")}, {"boxes", request.at("boxes")},
            {"confirmationGameRootFingerprint", fingerprint(engine_, markerBytes, markerSha, &resource)},
            {"gameRootFingerprint", fingerprint(engine_, markerBytes, markerSha,
                writtenSha == resource.sourceSha256 ? nullptr : &resource)}};
        if (layer_ == "translation") {
            record["renderedKind"] = request.at("renderedKind");
            record["targetLanguage"] = request.at("targetLanguage");
        } else {
            record["modelId"] = request.value("modelId", Json(nullptr));
        }
        const auto verified = seal(record, resource.width, resource.height);
        put(verified);
        return confirmed(verified);
    }

    Json status() const {
        try {
            const auto existing = openSource(game_.path, metadata_, true);
            if (!existing) throw Error("CONFIRMATION_REQUIRED", "缺少图片确认记录");
            const auto stored = Json::parse(read(existing, game_.path / metadata_));
            if (!stored.contains("recordVersion") || stored.at("recordVersion") != 1)
                throw Error("CONFIRMATION_REQUIRED", "旧确认记录需要重新确认");
            const auto resource = resources();
            auto record = readVerified(game_.path,
                {id_, resource.sourceHash, resource.sourceSha256, resource.width, resource.height}, layer_,
                {stored.at("confirmationId").get<std::string>(), resource.candidateVersion});
            if (record.at("pngSha256") != resource.pngSha256 || (layer_ == "translation" &&
                (record.at("renderedKind") != row_.value("renderedKind", "generated") ||
                record.at("targetLanguage") != row_.value("renderedTarget", ""))))
                throw Error("INPUT_STALE", "候选图或确认内容已改变，请重新确认", id_);
            return confirmed(record);
        } catch (const Error& error) {
            if (error.code != "INPUT_STALE" && error.code != "CONFIRMATION_REQUIRED") throw;
            return {{"state", "needsConfirmation"}, {"reason", error.code}, {"message", error.what()}};
        } catch (const Json::exception&) {
            return {{"state", "needsConfirmation"}, {"reason", "INPUT_STALE"}, {"message", "确认记录不完整，请重新确认"}};
        }
    }
};

std::optional<std::string> managedOriginalSha256(const Path& game, const Json& image, const std::string* imageKey) {
    return ProjectConfirmation::managedOriginalDigest(game, image, imageKey);
}

nlohmann::json save(RpgImageProject& project, const std::filesystem::path& game, const nlohmann::json& request) {
    return ProjectConfirmation(project, game, request).save(request);
}

nlohmann::json status(RpgImageProject& project, const std::filesystem::path& game, const nlohmann::json& request) {
    return ProjectConfirmation(project, game, request).status();
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

nlohmann::json save(RpgImageProject&, const std::filesystem::path&, const nlohmann::json&) {
    throw Error("UNSUPPORTED_PLATFORM", "图片确认记录需要 Windows");
}
nlohmann::json status(RpgImageProject&, const std::filesystem::path&, const nlohmann::json&) {
    throw Error("UNSUPPORTED_PLATFORM", "图片确认记录需要 Windows");
}

#endif

} // namespace gameimageexport::confirmation
