#include "GameImageExportPackage.h"
#include "GameImageExportConfirmation.h"

#include <utility>

namespace gameimageexport {

Error::Error(std::string code, std::string message, std::string detail)
    : std::runtime_error(std::move(message)), code(std::move(code)), detail(std::move(detail)) {}

} // namespace gameimageexport

#ifdef _WIN32
#include "RpgImageProject.h"
#include "GameImageExportIO.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <ctime>
#include <exception>
#include <map>
#include <memory>
#include <set>

namespace gameimageexport {
namespace {

using namespace io;

constexpr uint64_t maxPixels = 64ull << 20;
constexpr uint64_t maxWorkingBytes = 1ull << 30;

Json parse(const Handle& file, const Path& path) {
    try {
        return Json::parse(read(file, path));
    } catch (const Json::exception& error) {
        throw Error("INPUT_STALE", "项目 JSON 无效：" + utf8(path) + "，" + error.what(), utf8(path));
    }
}

void cancel(const Control& control) {
    if (control.cancelled && control.cancelled()) throw Error("CANCELLED", "已取消生成成品");
}

void copySnapshot(const Handle& source, const Path& path, const Control& control) {
    const auto file = newFile(path);
    readChunks(source, path, [&](std::string_view chunk) { cancel(control); writeChunk(file, path, chunk); });
}

void report(const Control& control, std::string_view phase, size_t done, size_t total, std::string_view path = {}) {
    if (control.progress) control.progress({phase, done, total, path});
    cancel(control);
}

bool legacyPatchMatches(const Path& game, const Path& project, const std::string& id,
    const Path& target, std::optional<std::string_view> current = {}) {
    std::string targetBytes;
    for (const auto dir : {"installed", "mosaic-installed", "composed-installed"}) {
        const auto marker = project / dir / (id + ".bin");
        const auto installed = openSource(game, marker, true);
        if (!installed) continue;
        if (!current) {
            const auto file = openSource(game, target, true);
            if (!file) return false;
            targetBytes = read(file, game / target, maxImageBytes);
            current = targetBytes;
        }
        if (length(installed, game / marker) == current->size() &&
            read(installed, game / marker, maxImageBytes) == *current)
            return true;
    }
    return false;
}

struct Selection {
    const ImageSelection* expected;
    const Json* row;
    std::string name;
    Path relative;
};

using Rows = std::map<std::string, Json>;

Rows stateRows(const Path& game, const Path& stage, const Path& folder, const Control& control) {
    Rows rows;
    const auto dbPath = folder / "state.sqlite3";
    auto database = openSource(game, dbPath, true);
    if (database) {
        const auto walPath = folder / "state.sqlite3-wal";
        const auto wal = openSource(game, walPath, true);
        // The existing game mutex and deny-write handles freeze the pair while
        // it is copied. SQLite only opens the copies and writes SHM in staging.
        const auto snapshot = stage / ".snapshot";
        if (!CreateDirectoryW(snapshot.c_str(), nullptr))
            winError("OUTPUT_WRITE_FAILED", "无法创建项目暂存目录", snapshot, GetLastError());
        {
            const auto pins = openNode(snapshot, true);
            copySnapshot(database, snapshot / "state.sqlite3", control);
            if (wal) copySnapshot(wal, snapshot / "state.sqlite3-wal", control);
            auto& api = sqlite_support::sqliteApi();
            if (!api.ready()) throw Error("IO_ERROR", "Windows SQLite 不可用");
            sqlite_support::sqlite3* raw = nullptr;
            const int status = api.openV2(utf8(snapshot / "state.sqlite3").c_str(), &raw,
                sqlite_support::kSqliteOpenReadWrite, nullptr);
            std::unique_ptr<sqlite_support::sqlite3, decltype(api.close)> db(raw, api.close);
            if (status != sqlite_support::kSqliteOk) throw Error("INPUT_STALE", "无法打开项目数据库快照");
            sqlite_support::Statement version(api, db.get(), "PRAGMA user_version");
            if (!version.valid() || api.step(version.get()) != sqlite_support::kSqliteRow)
                throw Error("INPUT_STALE", "无法读取项目数据库版本");
            if (api.columnInt64(version.get(), 0) == 1) {
                sqlite_support::Statement query(api, db.get(), "SELECT id,payload FROM image_state");
                if (!query.valid()) throw Error("INPUT_STALE", "无法读取项目图片状态");
                int next;
                while ((next = api.step(query.get())) == sqlite_support::kSqliteRow) {
                    cancel(control);
                    rows.emplace(sqlite_support::columnText(api, query.get(), 0),
                        Json::parse(sqlite_support::columnText(api, query.get(), 1)));
                }
                if (next != sqlite_support::kSqliteDone) throw Error("INPUT_STALE", "项目图片状态读取失败");
            } else {
                database = Handle();
            }
        }
        removeTree(snapshot);
        if (database) return rows;
    }
    const auto legacy = folder / "state";
    auto pins = pinParents(game, legacy / "entry");
    if (pins.empty()) return rows;
    for (const auto& entry : fs::directory_iterator(game / legacy)) {
        cancel(control);
        if (entry.path().extension() != ".json") continue;
        const auto file = openNode(entry.path(), false);
        auto value = parse(file, entry.path());
        rows.insert_or_assign(value.at("id").get<std::string>(), std::move(value));
    }
    return rows;
}

constexpr std::string_view markerPrefix = "llmchat-game-image-export-v1:";
constexpr std::wstring_view markerSuffix = L".export-owner";

void eraseMarker(const Path& path) {
    if (!DeleteFileW(path.c_str())) winError("CLEANUP_FAILED", "无法清理生成标记", path, GetLastError());
}

void cleanAbandoned(const Path& output) {
    for (const auto& item : fs::directory_iterator(output)) {
        const auto name = item.path().filename().native();
        if (name.size() != 37 + markerSuffix.size() || name.front() != L'.' || !name.ends_with(markerSuffix)) continue;
        auto id = utf8path::toUtf8(name.substr(1, 36));
        if (!uuid(id)) continue;
        const auto marker = item.path();
        bool owned;
        {
            const auto handle = openNode(marker, false);
            owned = read(handle, marker, 1024) == std::string(markerPrefix) + id;
        }
        if (!owned) continue;
        const auto stage = output / ("." + id + ".partial");
        if (openNode(stage, true, true)) removeTree(stage);
        eraseMarker(marker);
    }
}

std::string formattedTime(std::tm utc, const char* format) {
    char buffer[32]{};
    if (!std::strftime(buffer, sizeof(buffer), format, &utc)) throw Error("IO_ERROR", "无法格式化生成时间");
    return buffer;
}

std::wstring gameName(std::wstring name) {
    std::erase_if(name, illegal);
    if (name.size() > 60) {
        name.resize(60);
        if (name.back() >= 0xd800 && name.back() <= 0xdbff) name.pop_back();
    }
    while (!name.empty() && (name.back() == L'.' || name.back() == L' ')) name.pop_back();
    return name.empty() || reserved(name) ? L"game" : name;
}

void publish(const Handle& source, const Path& target) {
    const auto nameBytes = target.native().size() * sizeof(wchar_t);
    const auto size = offsetof(FILE_RENAME_INFO, FileName) + nameBytes + sizeof(wchar_t);
    std::vector<std::byte> buffer(size);
    const auto rename = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
    rename->ReplaceIfExists = FALSE;
    rename->FileNameLength = static_cast<DWORD>(nameBytes);
    std::memcpy(rename->FileName, target.c_str(), nameBytes);
    if (!SetFileInformationByHandle(source.value, FileRenameInfo, rename, static_cast<DWORD>(size))) {
        const auto status = GetLastError();
        if (status == ERROR_ALREADY_EXISTS || status == ERROR_FILE_EXISTS ||
            GetFileAttributesW(target.c_str()) != INVALID_FILE_ATTRIBUTES)
            throw Error("OUTPUT_EXISTS", "同名成品目录已存在：" + utf8(target), utf8(target));
        winError("OUTPUT_WRITE_FAILED", "无法发布成品目录", target, status);
    }
}

struct Layer {
    Json record;
    std::string pixels;
};

} // namespace

class PackageGenerator {
    const Request& request_;
    const Control& control_;
    const Path& game_;
    const Path& stage_;
    const Path projectDir_;
    const Engine engine_;

    Json catalog(RpgImageProject& project) const {
        if (project.restored_.contains(game_)) return project.catalogs_.at(game_);
        const auto file = projectDir_ / "project.json";
        auto projectJson = parse(openSource(game_, file), game_ / file);
        const auto rows = stateRows(game_, stage_, projectDir_, control_);
        for (auto& image : projectJson.at("images")) {
            cancel(control_);
            const auto saved = rows.find(image.at("id").get<std::string>());
            if (saved != rows.end() && saved->second.at("sourceHash") == image.at("sourceHash")) image = saved->second;
        }
        return projectJson;
    }

    std::vector<Selection> selections(const Json& project) const {
        std::map<std::string, const Json*> rows;
        for (const auto& image : project.at("images"))
            if (!rows.emplace(image.at("id").get<std::string>(), &image).second)
                throw Error("INPUT_STALE", "项目索引中出现重复图片编号");
        std::set<std::string> ids;
        std::set<std::wstring, CaseLess> targets;
        std::vector<Selection> selected;
        for (const auto& image : request_.images) {
            cancel(control_);
            if (!hexString(image.imageId) || image.imageId.size() > 16 ||
                (!image.translation && !image.mosaic) || !ids.insert(image.imageId).second)
                throw Error("INVALID_REQUEST", "图片编号或导出层无效：" + image.imageId, image.imageId);
            const auto found = rows.find(image.imageId);
            if (found == rows.end() || found->second->at("sourceHash") != image.sourceHash ||
                image.sourceHash.empty() || image.sourceHash.find_first_not_of("0123456789-") != std::string::npos)
                throw Error("INPUT_STALE", "图片版本已改变，请重新确认：" + image.imageId, image.imageId);
            const auto& row = *found->second;
            auto name = row.at("file").get<std::string>();
            auto file = relative(name);
            targetPath(game_, engine_, row, file, name);
            if (!targets.insert(file.native()).second)
                throw Error("INVALID_PATH", "多个图片目标只有大小写不同：" + name, name);
            const auto source = relative(row.at("sourceFile").get<std::string>());
            if (ordinal(file.native(), source.native()) != CSTR_EQUAL)
                throw Error("INPUT_STALE", "散装原图与目标路径不一致：" + name, name);
            selected.push_back({&image, &row, std::move(name), std::move(file)});
        }
        std::sort(selected.begin(), selected.end(), [](const Selection& left, const Selection& right) {
            return left.name.compare(right.name) < 0;
        });
        return selected;
    }

    Layer layer(const Selection& selected, bool translation, uint32_t width, uint32_t height,
        std::string_view sourceSha256, uint64_t byteBudget) const {
        const auto& row = *selected.row;
        const auto& image = *selected.expected;
        const auto& chosen = translation ? *image.translation : *image.mosaic;
        auto record = confirmation::readVerified(game_, {image.imageId, image.sourceHash, sourceSha256, width, height},
            translation ? "translation" : "mosaic", chosen);
        const auto input = translation ? projectDir_ / "rendered" / (image.imageId + ".png") :
            RpgImageProject::mosaicImage(game_, row).lexically_relative(game_);
        if (translation && (!row.value("selected", false) || !row.value("completed", false) ||
            row.value("noTranslationNeeded", false) || row.value("renderedFile", "") != "rendered/" + image.imageId + ".png"))
            throw Error("INPUT_STALE", "译图已取消选择或失效：" + selected.name, selected.name);

        const auto parents = pinParents(game_, input);
        const auto png = openSource(game_, input);
        const auto limit = std::min(maxImageBytes, byteBudget);
        if (length(png, game_ / input) > limit)
            throw Error("IMAGE_TOO_LARGE", "候选图片超出处理大小：" + selected.name, selected.name);
        auto pixels = read(png, game_ / input, limit);
        const auto digest = hash(pixels);
        const bool matches = translation ?
            row.value("renderedHash", "") == chosen.version && RpgImageProject::stamp(game_ / input) == chosen.version :
            digest == chosen.version;
        if (!matches || record.at("pngSha256") != digest)
            throw Error("INPUT_STALE", "候选图片已改变，请重新确认：" + selected.name, selected.name);
        if (RpgImageProject::dimensions(pixels) != std::pair{width, height})
            throw Error("INPUT_STALE", "候选图片与原图尺寸不同：" + selected.name, selected.name);
        if (translation) {
            const auto origin = record.at("renderedKind").get<std::string>();
            if (row.value("renderedKind", origin) != origin || record.at("targetLanguage") != row.value("renderedTarget", ""))
                throw Error("INPUT_STALE", "译图来源或语言已改变，请重新确认：" + selected.name, selected.name);
        }
        return {confirmation::manifestLayer(record), std::move(pixels)};
    }

    std::optional<Json> compose(const Selection& selected, const std::string& key, std::set<std::string>& sourceIds,
        Sha256& confirmedFingerprint) const {
        const auto& row = *selected.row;
        const auto& image = *selected.expected;
        const auto parents = pinParents(game_, selected.relative);
        const auto original = openSource(game_, selected.relative);
        if (!sourceIds.insert(identity(original, game_ / selected.relative)).second)
            throw Error("INVALID_PATH", "多个目标指向同一个游戏文件：" + selected.name, selected.name);
        const auto current = read(original, game_ / selected.relative, maxImageBytes);
        const auto sourceSha256 = hash(current);
        if (legacyPatchMatches(game_, projectDir_, image.imageId, selected.relative, current))
            throw Error("LEGACY_PATCH_ACTIVE", "请先卸载已应用的旧图片补丁：" + selected.name, selected.name);
        if (RpgImageProject::stamp(game_ / selected.relative) != image.sourceHash)
            throw Error("INPUT_STALE", "原图已改变，请重新扫描：" + selected.name, selected.name);
        const auto encrypted = gameresourcebackup::imageExtension(selected.relative) != ".png";
        if (encrypted != row.value("encrypted", false))
            throw Error("INPUT_STALE", "原图格式与项目记录不一致：" + selected.name, selected.name);

        const auto decoded = RpgImageProject::imageBytes(row, current, key, false);
        const auto [width, height] = RpgImageProject::dimensions(decoded);
        if (width != row.at("width") || height != row.at("height"))
            throw Error("INPUT_STALE", "原图尺寸与项目记录不一致：" + selected.name, selected.name);
        const auto pixels = static_cast<uint64_t>(width) * height;
        if (pixels > maxPixels)
            throw Error("IMAGE_TOO_LARGE", "原图像素数量超出允许上限：" + selected.name, selected.name);
        const auto workingPixels = pixels * (image.translation && image.mosaic ? 12 : 4);
        const auto encodedBudget = (maxWorkingBytes - workingPixels) / 2;
        const auto originalBytes = current.size() + decoded.size();
        if (originalBytes >= encodedBudget)
            throw Error("IMAGE_TOO_LARGE", "图片处理预计内存超出允许上限：" + selected.name, selected.name);
        confirmedFingerprint.field("file");
        confirmedFingerprint.field(selected.name);
        confirmedFingerprint.field(std::to_string(current.size()));
        confirmedFingerprint.field(sourceSha256);
        auto remaining = encodedBudget - originalBytes;
        auto translation = image.translation ?
            std::optional(layer(selected, true, width, height, sourceSha256, remaining)) : std::nullopt;
        if (translation) remaining -= translation->pixels.size();
        auto mosaic = image.mosaic ?
            std::optional(layer(selected, false, width, height, sourceSha256, remaining)) : std::nullopt;

        Json layers = Json::array();
        Json boxes = Json::array();
        for (auto* layer : {&translation, &mosaic}) {
            if (!*layer) continue;
            for (const auto& box : (*layer)->record.at("boxes")) boxes.push_back(box.at("id"));
            layers.push_back(std::move((*layer)->record));
        }
        const bool combined = translation && mosaic;
        const auto kind = combined ? "composed" : translation ? "translated" : "mosaic";
        const bool processPixels = combined && mosaic->pixels != translation->pixels &&
            mosaic->pixels != decoded && translation->pixels != decoded;
        auto final = combined ? rpgimagecompose::combine(decoded, mosaic->pixels, translation->pixels) :
            std::move(translation ? translation->pixels : mosaic->pixels);
        // The pure combine function can take an equality fast path. Validate
        // these PNGs too, including imported single-layer candidates.
        if (!processPixels) {
            const rpgimagecompose::PngCodec codec;
            codec.read(decoded);
            codec.read(final);
        }
        final = RpgImageProject::imageBytes(row, std::move(final), key, true);
        if (final == current) return std::nullopt;
        if (final.size() > maxImageBytes)
            throw Error("IMAGE_TOO_LARGE", "成品图片超出允许大小：" + selected.name, selected.name);
        const auto digest = write(stage_, Path("payload") / selected.relative, final);
        return Json{{"relativePath", selected.name}, {"kind", kind}, {"bytes", final.size()}, {"sha256", digest},
            {"original", {{"bytes", current.size()}, {"sha256", sourceSha256}}},
            {"sourceImage", {{"id", image.imageId}, {"relativePath", selected.name}, {"sourceHash", image.sourceHash},
                {"width", width}, {"height", height}, {"layers", std::move(layers)}}}, {"boxIds", std::move(boxes)}};
    }

    PackageGenerator(const Request& request, const Control& control, const Path& game, const Path& stage)
        : request_(request), control_(control), game_(game), stage_(stage),
          projectDir_(RpgImageProject::folder(game).lexically_relative(game)), engine_(detectEngine(game)) {}

    Result manifest(RpgImageProject& project, const std::string& id, std::tm utc, const Path& target) const {
        report(control_, "snapshot", 0, request_.images.size());
        const auto projectJson = catalog(project);
        const auto inputs = selections(projectJson);
        const auto engineMarker = openSource(game_, engine_.marker);
        const auto markerPath = gamefiles::key(engine_.marker);
        const auto markerLength = length(engineMarker, game_ / engine_.marker);
        Sha256 markerHash;
        std::string markerJson;
        if (engine_.name != "wolf" && markerLength > maxMetadataBytes)
            throw Error("INPUT_TOO_LARGE", "System.json 超出允许大小", markerPath);
        readChunks(engineMarker, game_ / engine_.marker, [&](std::string_view bytes) {
            cancel(control_);
            markerHash.add(bytes);
            if (engine_.name != "wolf") markerJson.append(bytes);
        });
        const auto markerDigest = markerHash.finish();
        const auto key = markerJson.empty() ? std::string() : Json::parse(markerJson).value("encryptionKey", "");

        Sha256 fingerprint;
        Sha256 confirmedFingerprint;
        for (auto* digest : {&fingerprint, &confirmedFingerprint}) {
            digest->field("llmchat-game-image-baseline-v1");
            digest->field(engine_.name);
            digest->field("marker");
            digest->field(markerPath);
            digest->field(std::to_string(markerLength));
            digest->field(markerDigest);
        }
        Json outputs = Json::array();
        std::set<std::string> sourceIds;
        for (size_t i = 0; i < inputs.size(); ++i) {
            report(control_, "compose", i, inputs.size(), inputs[i].name);
            auto item = compose(inputs[i], key, sourceIds, confirmedFingerprint);
            if (!item) continue;
            fingerprint.field("file");
            fingerprint.field(inputs[i].name);
            fingerprint.field(std::to_string(item->at("original").at("bytes").get<uint64_t>()));
            fingerprint.field(item->at("original").at("sha256").get_ref<const std::string&>());
            outputs.push_back(std::move(*item));
        }
        if (outputs.empty()) throw Error("NO_OUTPUT", "选择的图片没有需要导出的改动");
        const auto count = outputs.size();
        auto data = Json{{"schemaVersion", 1}, {"packageId", id}, {"engine", engine_.name},
            {"gameRootFingerprint", fingerprint.finish()}, {"confirmationGameRootFingerprint", confirmedFingerprint.finish()},
            {"composeRuleVersion", 1},
            {"generatedAt", formattedTime(utc, "%Y-%m-%dT%H:%M:%SZ")}, {"toolVersion", request_.toolVersion},
            {"baseline", {{"algorithm", "sha256-anchors-and-targets-v1"}, {"marker",
                {{"relativePath", markerPath}, {"bytes", markerLength}, {"sha256", markerDigest}}}}},
            {"files", std::move(outputs)}}.dump(2) + "\n";
        if (data.size() > maxMetadataBytes) throw Error("OUTPUT_TOO_LARGE", "成品清单超出允许大小");
        const auto digest = write(stage_, "manifest.json", data);
        const auto receipts = stage_ / "receipts";
        if (!CreateDirectoryW(receipts.c_str(), nullptr))
            winError("OUTPUT_WRITE_FAILED", "无法创建收据目录", receipts, GetLastError());
        return {id, target, digest, count, inputs.size() - count};
    }

public:
    static Result run(RpgImageProject& project, const Request& request, const Control& control) {
        if (request.images.empty() || request.images.size() > 20000 ||
            !confirmation::portableIdentifier(request.toolVersion))
            throw Error("INVALID_REQUEST", "请指定待导出的图片和工具版本");
        cancel(control);
        const Root game(request.gamePath);
        const Root output(request.outputDir);
        const auto contains = [](const Root& ancestor, const Root& candidate) {
            return std::find(candidate.ids.begin(), candidate.ids.end(), ancestor.ids.back()) != candidate.ids.end();
        };
        if (contains(game, output) || contains(output, game))
            throw Error("INVALID_PATH", "输出目录与游戏目录必须互不包含", utf8(output.path));
        const DirectoryLock gameLock(game.ids.back());
        const DirectoryLock outputLock(output.ids.back());
        const std::unique_lock projectLock(project.mutex_, std::try_to_lock);
        if (!projectLock) throw Error("BUSY", "图片项目正在更新，请稍后重试");

        const auto id = newId();
        const auto stage = output.path / ("." + id + ".partial");
        const auto marker = output.path / ("." + id + ".export-owner");
        const auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
        std::tm utc{};
        if (gmtime_s(&utc, &now) != 0) throw Error("IO_ERROR", "无法读取生成时间");
        const auto suffix = "-" + formattedTime(utc, "%Y%m%dT%H%M%SZ") + "-" + id.substr(0, 8) + ".llmchat-images";
        const auto target = output.path / (gameName(game.path.filename().native()) + utf8path::toWide(suffix));
        cleanAbandoned(output.path);
        bool marked = false;
        bool staged = false;
        try {
            {
                const auto file = newFile(marker);
                marked = true;
                writeChunk(file, marker, std::string(markerPrefix) + id);
                if (!FlushFileBuffers(file.value))
                    winError("OUTPUT_WRITE_FAILED", "无法刷盘生成标记", marker, GetLastError());
            }
            if (!CreateDirectoryW(stage.c_str(), nullptr))
                winError("OUTPUT_WRITE_FAILED", "无法创建成品暂存目录", stage, GetLastError());
            staged = true;
            auto source = openNode(stage, true, false, DELETE);
            PackageGenerator generator(request, control, game.path, stage);
            auto result = generator.manifest(project, id, utc, target);
            report(control, "publish", request.images.size(), request.images.size());
            publish(source, target);
            staged = false;
            // The package is already published; the next operation can remove
            // the ownership marker if its immediate deletion fails.
            DeleteFileW(marker.c_str());
            return result;
        } catch (...) {
            try {
                if (staged) removeTree(stage);
                if (marked) eraseMarker(marker);
            } catch (const std::exception& cleanup) {
                throw Error("CLEANUP_FAILED", std::string(cleanup.what()) + "；暂存目录：" + utf8(stage), utf8(stage));
            }
            throw;
        }
    }
};

bool legacyPatchInstalled(const std::filesystem::path& gamePath) {
    const Root game(gamePath);
    const DirectoryLock lock(game.ids.back());
    const Path project = "LLMChat-JSON/images";
    const auto file = project / "project.json";
    const auto index = openSource(game.path, file, true);
    if (!index) return false;
    const auto rows = parse(index, game.path / file);
    for (const auto& image : rows.at("images")) {
        if (image.contains("archive")) continue;
        const auto id = image.at("id").get<std::string>();
        if (!hexString(id) || id.size() > 16) continue;
        if (legacyPatchMatches(game.path, project, id, relative(image.at("file").get<std::string>()))) return true;
    }
    return false;
}

Result generate(RpgImageProject& project, const Request& request, const Control& control) {
    try {
        return PackageGenerator::run(project, request, control);
    } catch (const Error&) {
        throw;
    } catch (const Json::exception& error) {
        throw Error("INPUT_STALE", std::string("图片项目或确认记录无效：") + error.what());
    } catch (const fs::filesystem_error& error) {
        throw Error("IO_ERROR", std::string("成品生成文件操作失败：") + error.what());
    } catch (const std::runtime_error& error) {
        throw Error("INPUT_STALE", std::string("无法读取或合成图片：") + error.what());
    }
}

} // namespace gameimageexport
#else
namespace gameimageexport {

bool legacyPatchInstalled(const std::filesystem::path&) {
    throw Error("UNSUPPORTED_PLATFORM", "图片成品导出需要 Windows");
}

Result generate(RpgImageProject&, const Request&, const Control&) {
    throw Error("UNSUPPORTED_PLATFORM", "图片成品导出需要 Windows");
}

} // namespace gameimageexport
#endif
