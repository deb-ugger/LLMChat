#include "GameImageExportSelection.h"
#include "GameImageExportConfirmation.h"
#include "GameImageExportPackage.h"

#ifdef _WIN32
#include "GameImageExportIO.h"
#include "RpgImageProject.h"

#include <chrono>
#include <ctime>

namespace gameimageexport::selection {
namespace {

using namespace io;

std::string_view layerName(LayerKind kind) {
    switch (kind) {
    case LayerKind::Translation: return "translation";
    case LayerKind::Mosaic: return "mosaic";
    }
    throw Error("INVALID_SELECTION", "确认的图片图层无效");
}

LayerKind parseLayer(std::string_view name) {
    if (name == "translation") return LayerKind::Translation;
    if (name == "mosaic") return LayerKind::Mosaic;
    throw Error("INVALID_SNAPSHOT", "快照含无效的图层类型");
}

struct Source {
    const Entry* input;
    const Json* row;
    std::string name;
    Path path;
    std::string header;
    std::string sha256;
};

struct FileDigest {
    uint64_t bytes;
    std::string sha256;
    std::string header;
};

FileDigest inspect(const Handle& file, const Path& path, uint64_t limit = maxImageBytes,
    std::string* contents = nullptr) {
    const auto bytes = length(file, path);
    if (bytes > limit)
        throw Error("UNSUPPORTED_RESOURCE", "资源大小超出确认快照支持范围：" + utf8(path), utf8(path));
    Sha256 hash;
    std::string header;
    readChunks(file, path, [&](std::string_view chunk) {
        hash.add(chunk);
        // MV/MZ adds a 16-byte wrapper to the 24 bytes required for PNG dimensions.
        if (header.size() < 40) header.append(chunk.substr(0, 40 - header.size()));
        if (contents) contents->append(chunk);
    });
    return {bytes, hash.finish(), std::move(header)};
}

void requireEntries(std::span<const Entry> entries) {
    if (entries.empty()) throw Error("EMPTY_SELECTION", "请至少确认一张待导出的图片");
    std::set<std::string> ids;
    for (const auto& entry : entries) {
        if (!ids.insert(entry.id).second)
            throw Error("DUPLICATE_ENTRY", "确认列表包含重复的图片：" + entry.id, entry.id);
        if (entry.layers.empty())
            throw Error("EMPTY_SELECTION", "请为图片至少确认一个图层：" + entry.id, entry.id);
    }
}

template<class Call>
decltype(auto) checked(Call run, const char* invalidCode) {
    try {
        return run();
    } catch (const Error& error) {
        if (error.code == "INVALID_PATH") throw Error("PATH_OUTSIDE_GAME", error.what(), error.detail);
        if (error.code == "UNSUPPORTED_ENGINE" || error.code == "WOLF_ARCHIVE_ENTRY_UNSUPPORTED")
            throw Error("UNSUPPORTED_RESOURCE", error.what(), error.detail);
        throw;
    } catch (const Json::exception& error) {
        throw Error(invalidCode, std::string("图片确认数据无效：") + error.what());
    } catch (const fs::filesystem_error& error) {
        throw Error("IO_ERROR", std::string("无法读取图片确认资源：") + error.what());
    }
}

std::string utcNow() {
    const auto seconds = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm utc{};
    char value[21]{};
    if (gmtime_s(&utc, &seconds) != 0 || !std::strftime(value, sizeof(value), "%Y-%m-%dT%H:%M:%SZ", &utc))
        throw Error("IO_ERROR", "无法生成图片确认时间");
    return value;
}

bool isUtcTimestamp(std::string_view value) {
    if (value.size() != 20 || value[4] != '-' || value[7] != '-' || value[10] != 'T' ||
        value[13] != ':' || value[16] != ':' || value[19] != 'Z') return false;
    const auto number = [&](size_t start, size_t size) {
        int result = 0;
        for (const auto c : value.substr(start, size)) {
            if (c < '0' || c > '9') return -1;
            result = result * 10 + (c - '0');
        }
        return result;
    };
    const auto year = number(0, 4);
    const auto month = number(5, 2);
    const auto day = number(8, 2);
    const auto hour = number(11, 2);
    const auto minute = number(14, 2);
    const auto second = number(17, 2);
    return year > 0 && month > 0 && day > 0 &&
        std::chrono::year_month_day(std::chrono::year(year), std::chrono::month(month), std::chrono::day(day)).ok() &&
        hour >= 0 && hour < 24 && minute >= 0 && minute < 60 && second >= 0 && second < 60;
}

std::vector<Entry> parseEntries(const Json& snapshot) {
    const auto& rows = snapshot.at("entries");
    if (!rows.is_array()) throw Error("INVALID_SNAPSHOT", "快照的 entries 必须是数组");
    std::vector<Entry> entries;
    for (const auto& row : rows) {
        Entry entry{row.at("id").get<std::string>(), row.at("sourceHash").get<std::string>(), {}};
        const auto& layers = row.at("layers");
        if (!layers.is_array()) throw Error("INVALID_SNAPSHOT", "快照的 layers 必须是数组", entry.id);
        for (const auto& layer : layers) {
            const auto& rect = layer.at("rect");
            if (!rect.is_array() || rect.size() != 4 ||
                !std::all_of(rect.begin(), rect.end(), [](const Json& coordinate) {
                    return coordinate.is_number_integer() &&
                        (!coordinate.is_number_unsigned() || coordinate.get<uint64_t>() <= INT64_MAX);
                }))
                throw Error("LAYER_OUT_OF_BOUNDS", "快照图层坐标必须是四个整数", entry.id);
            entry.layers.push_back({parseLayer(layer.at("layer").get<std::string>()),
                rect.get<std::array<int64_t, 4>>(), layer.at("versionId").get<std::string>(),
                layer.at("sha256").get<std::string>(), layer.at("confirmationId").get<std::string>(),
                layer.at("boxId").get<std::string>(), layer.at("role").get<std::string>()});
        }
        entries.push_back(std::move(entry));
    }
    return entries;
}

} // namespace

class SnapshotBuilder {
    const Root game_;
    const DirectoryLock lock_;
    const Engine engine_;
    const Json& project_;

    Path checkedTarget(const std::string& name, const Json& row) const {
        auto path = relative(name);
        if (!gameresourcebackup::isImage(path) ||
            (engine_.name == "wolf" && gameresourcebackup::imageExtension(path) != ".png"))
            throw Error("UNSUPPORTED_RESOURCE", "确认快照不支持这个图片类型：" + name, name);
        targetPath(game_.path, engine_, row, path, name);
        return path;
    }

    std::vector<Source> sources(std::span<const Entry> entries) const {
        const auto& images = project_.at("images");
        if (!images.is_array()) throw Error("INVALID_SELECTION", "项目图片索引必须是数组");
        std::map<std::string, const Json*> rows;
        for (const auto& row : images) {
            const auto id = row.at("id").get<std::string>();
            if (!rows.emplace(id, &row).second)
                throw Error("DUPLICATE_ENTRY", "项目包含重复的图片编号：" + id, id);
        }

        std::set<std::wstring, CaseLess> targets;
        std::vector<Source> result;
        for (const auto& input : entries) {
            const auto found = rows.find(input.id);
            if (found == rows.end() || input.id.size() > 16 || !hexString(input.id))
                throw Error("UNKNOWN_ENTRY", "项目中没有该图片：" + input.id, input.id);
            const auto& row = *found->second;
            auto name = row.at("file").get<std::string>();
            auto path = checkedTarget(name, row);
            const auto original = relative(row.at("sourceFile").get<std::string>());
            if (ordinal(original.native(), path.native()) != CSTR_EQUAL)
                throw Error("PATH_OUTSIDE_GAME", "项目原图路径与游戏目标不一致：" + name, name);
            if (!targets.insert(path.native()).second)
                throw Error("DUPLICATE_ENTRY", "多个图片编号指向同一个目标：" + name, name);
            result.push_back({&input, &row, std::move(name), std::move(path), {}, {}});
        }
        std::sort(result.begin(), result.end(), [](const Source& left, const Source& right) {
            return left.name < right.name;
        });
        return result;
    }

    void fingerprintSource(Source& source, Sha256& fingerprint) const {
        const auto file = game_.path / source.path;
        const auto parents = pinParents(game_.path, source.path);
        const auto original = openSource(game_.path, source.path, true);
        if (!original || source.row->at("sourceHash") != source.input->sourceHash ||
            RpgImageProject::stamp(file) != source.input->sourceHash)
            throw Error("SOURCE_CHANGED", "原图已变更，请重新扫描：" + source.name, source.name);
        auto record = inspect(original, file);
        source.header = std::move(record.header);
        source.sha256 = record.sha256;
        fingerprint.field("file");
        fingerprint.field(source.name);
        fingerprint.field(std::to_string(record.bytes));
        fingerprint.field(record.sha256);
    }

    std::string initFingerprint(Sha256& fingerprint) const {
        const auto marker = openSource(game_.path, engine_.marker);
        const auto wolf = engine_.name == "wolf";
        std::string markerJson;
        const auto record = inspect(marker, game_.path / engine_.marker,
            wolf ? UINT64_MAX : maxMetadataBytes, wolf ? nullptr : &markerJson);
        fingerprint.field("llmchat-game-image-baseline-v1");
        fingerprint.field(engine_.name);
        fingerprint.field("marker");
        fingerprint.field(gamefiles::key(engine_.marker));
        fingerprint.field(std::to_string(record.bytes));
        fingerprint.field(record.sha256);
        return wolf ? std::string{} : Json::parse(markerJson).value("encryptionKey", "");
    }

    std::pair<uint32_t, uint32_t> dimensions(const Source& source, const std::string& key) const {
        const auto encrypted = gameresourcebackup::imageExtension(source.path) != ".png";
        if (encrypted != source.row->value("encrypted", false))
            throw Error("UNSUPPORTED_RESOURCE", "原图扩展名与项目的加密状态不一致：" + source.name, source.name);
        try {
            auto header = RpgImageProject::imageBytes(*source.row, source.header, key, false);
            return RpgImageProject::dimensions(header);
        } catch (const std::runtime_error&) {
            throw Error("UNSUPPORTED_RESOURCE", "原图的 PNG 格式或加密包裹无法读取：" + source.name, source.name);
        }
    }

    std::pair<std::string, std::string> candidate(const Source& source, LayerKind kind,
        std::pair<uint32_t, uint32_t> size) const {
        const auto& row = *source.row;
        const auto& id = source.input->id;
        const auto projectFolder = RpgImageProject::folder(game_.path);
        const bool translation = kind == LayerKind::Translation;
        if (translation && (!row.value("selected", false) || !row.value("completed", false) ||
            row.value("noTranslationNeeded", false) || row.value("renderedFile", "") != "rendered/" + id + ".png"))
            throw Error("CANDIDATE_CHANGED", "译图未选中或已失效：" + source.name, source.name);
        const auto path = translation ? projectFolder / "rendered" / (id + ".png") :
            RpgImageProject::mosaicImage(game_.path, row);
        const auto relativePath = path.lexically_relative(game_.path);
        const auto parents = pinParents(game_.path, relativePath);
        const auto file = openSource(game_.path, relativePath, true);
        if (!file)
            throw Error("CANDIDATE_CHANGED", "确认的候选图已不存在：" + source.name, source.name);
        const auto digest = inspect(file, path);
        const auto version = translation ? RpgImageProject::stamp(path) : digest.sha256;
        bool validSize = false;
        try {
            validSize = RpgImageProject::dimensions(digest.header) == size;
        } catch (const std::runtime_error&) {
            // A saved candidate that is no longer a PNG must be confirmed again.
        }
        if (!validSize || (translation && row.value("renderedHash", "") != version))
            throw Error("CANDIDATE_CHANGED", "确认的候选图已变化：" + source.name, source.name);
        return {version, digest.sha256};
    }

    Json makeEntry(const Source& source, const std::string& key) const {
        const auto size = dimensions(source, key);
        const auto [width, height] = size;
        if (source.row->at("width") != width || source.row->at("height") != height)
            throw Error("SOURCE_CHANGED", "原图尺寸与项目记录不一致：" + source.name, source.name);

        std::map<LayerKind, std::map<std::string, const Layer*>> wanted;
        for (const auto& layer : source.input->layers) {
            const auto [left, top, right, bottom] = layer.rect;
            if (left < 0 || top < 0 || right <= left || bottom <= top || right > width || bottom > height)
                throw Error("LAYER_OUT_OF_BOUNDS", "确认框超出原图或面积为空：" + source.name, source.name);
            if (!wanted[layer.kind].emplace(layer.boxId, &layer).second)
                throw Error("INPUT_STALE", "快照中有重复的确认框：" + source.name, source.name);
        }

        Json output = Json::array();
        for (const auto& [kind, boxes] : wanted) {
            const auto& first = *boxes.begin()->second;
            const auto layer = layerName(kind);
            const auto record = confirmation::readVerified(game_.path,
                {source.input->id, source.input->sourceHash, source.sha256, width, height},
                layer, {first.confirmationId, first.versionId});
            const auto [version, hash] = candidate(source, kind, size);
            if (record.at("pngSha256") != hash || record.at("candidateVersion") != version)
                throw Error("CANDIDATE_CHANGED", "确认记录的候选版本或摘要已变化：" + source.name, source.name);
            if (kind == LayerKind::Translation) {
                const auto origin = record.at("renderedKind").get<std::string>();
                if (source.row->value("renderedKind", origin) != origin ||
                    record.at("targetLanguage") != source.row->value("renderedTarget", ""))
                    throw Error("INPUT_STALE", "译图来源或语言已改变：" + source.name, source.name);
            }

            auto canonical = record.at("boxes");
            if (record.at("maskMode") == "whole-image")
                canonical.push_back({{"id", "whole-image"}, {"role", "whole-image"}, {"rect", {0, 0, width, height}}});
            if (boxes.size() != canonical.size())
                throw Error("INPUT_STALE", "快照的确认框与已确认记录不符：" + source.name, source.name);
            for (const auto& box : canonical) {
                const auto id = box.at("id").get<std::string>();
                const auto found = boxes.find(id);
                if (found == boxes.end())
                    throw Error("INPUT_STALE", "快照没有引用已确认的框：" + source.name, source.name);
                const auto& selected = *found->second;
                if (selected.versionId != version || selected.sha256 != hash)
                    throw Error("CANDIDATE_CHANGED", "候选版本或 SHA-256 已变化：" + source.name, source.name);
                if (record.at("confirmationId") != selected.confirmationId || box.at("role") != selected.role ||
                    box.at("rect") != Json(selected.rect))
                    throw Error("INPUT_STALE", "快照的确认编号、角色或坐标不一致：" + source.name, source.name);
                output.push_back({{"layer", layer}, {"rect", box.at("rect")}, {"boxId", id},
                    {"role", box.at("role")}, {"confirmationId", record.at("confirmationId")},
                    {"versionId", version}, {"sha256", hash}});
            }
        }
        return {{"id", source.input->id}, {"relativePath", source.name}, {"sourceHash", source.input->sourceHash},
            {"width", width}, {"height", height}, {"layers", std::move(output)}};
    }

public:
    SnapshotBuilder(const Path& game, const Json& project)
        : game_(game), lock_(game_.ids.back()), engine_(detectEngine(game_.path)), project_(project) {}

    Json build(std::span<const Entry> entries, std::string_view createdAt, const Json* saved = nullptr) const {
        auto selected = sources(entries);
        if (saved) {
            if (saved->at("engine") != engine_.name)
                throw Error("SOURCE_CHANGED", "游戏引擎与确认快照不一致");
            for (const auto& entry : saved->at("entries"))
                checkedTarget(entry.at("relativePath").get<std::string>(), Json::object());
        }

        Sha256 fingerprint;
        const auto key = initFingerprint(fingerprint);
        for (auto& source : selected) fingerprintSource(source, fingerprint);
        const auto digest = fingerprint.finish();
        if (saved && saved->at("gameRootFingerprint") != digest)
            throw Error("SOURCE_CHANGED", "基准文件或确认图片的原始字节已变化");

        auto output = Json::array();
        for (const auto& source : selected) output.push_back(makeEntry(source, key));
        return {{"snapshotVersion", 2}, {"engine", engine_.name}, {"gameRootFingerprint", digest},
            {"createdAt", createdAt}, {"entries", std::move(output)}};
    }
};

std::string createSnapshot(const std::filesystem::path& gameRoot, const Json& project,
    std::span<const Entry> entries) {
    return checked([&] {
        requireEntries(entries);
        return SnapshotBuilder(gameRoot, project).build(entries, utcNow()).dump(2) + "\n";
    }, "INVALID_SELECTION");
}

void validateSnapshot(const std::filesystem::path& gameRoot, const Json& project, std::string_view serialized) {
    checked([&] {
        const auto saved = Json::parse(serialized);
        if (!saved.at("snapshotVersion").is_number_integer() || saved.at("snapshotVersion") != 2)
            throw Error("INVALID_SNAPSHOT", "图片确认快照版本不支持");
        const auto createdAt = saved.at("createdAt").get<std::string>();
        const auto digest = saved.at("gameRootFingerprint").get<std::string>();
        if (!isUtcTimestamp(createdAt) || digest.size() != 64 || !hexString(digest))
            throw Error("INVALID_SNAPSHOT", "图片确认快照缺少有效的时间或指纹");
        const auto entries = parseEntries(saved);
        requireEntries(entries);
        const auto current = SnapshotBuilder(gameRoot, project).build(entries, createdAt, &saved);
        if (current != saved) throw Error("INVALID_SNAPSHOT", "图片确认快照字段与当前记录不一致");
    }, "INVALID_SNAPSHOT");
}

} // namespace gameimageexport::selection

#else

namespace gameimageexport::selection {

std::string createSnapshot(const std::filesystem::path&, const nlohmann::json&,
    std::span<const Entry>) {
    throw Error("UNSUPPORTED_PLATFORM", "图片确认快照需要 Windows");
}

void validateSnapshot(const std::filesystem::path&, const nlohmann::json&, std::string_view) {
    throw Error("UNSUPPORTED_PLATFORM", "图片确认快照需要 Windows");
}

} // namespace gameimageexport::selection

#endif
