#include "GameImageExportTransaction.h"

#ifdef _WIN32
#include "GameImageExportIO.h"
#include "RpgImageProject.h"

#include <cstdio>

#include <cstddef>
#include <exception>
#include <iostream>

namespace gameimageexport::transaction {
namespace {
using namespace io;

constexpr wchar_t manifestName[] = L"manifest.json";
constexpr wchar_t receiptDir[] = L"receipts";
constexpr wchar_t payloadDir[] = L"payload";
constexpr wchar_t backupDir[] = L"receipts/backup";
constexpr wchar_t backupStage[] = L"receipts/.backup.partial";
constexpr wchar_t planName[] = L"plan.json";
constexpr wchar_t receiptName[] = L"receipts/receipt.json";
constexpr wchar_t receiptStage[] = L"receipts/.receipt.partial";
constexpr wchar_t restoreIntent[] = L"receipts/restore-intent.json";
constexpr wchar_t restoreStage[] = L"receipts/.restore-intent.partial";
constexpr auto fingerprintAlgorithm = "sha256-anchors-and-targets-v1";
constexpr auto legacyRule = "legacy-migration/1";
constexpr auto maxPlanBytes = 64ull << 20;

struct Digest {
    uint64_t bytes;
    std::string sha;
    bool operator==(const Digest&) const = default;
};

struct Entry {
    std::string name;
    Path path;
    std::string kind;
    Digest before;
    Digest after;
};

struct Manifest {
    std::string packageId;
    std::string engine;
    std::string fingerprint;
    std::string markerName;
    Path marker;
    Digest baseline;
    std::vector<Entry> files;
};

struct Plan {
    std::string id;
    Manifest manifest;
    std::string sha;
    std::optional<Digest> appliedMarker;
};

using FileMask = std::vector<bool>;

struct Transition {
    FileMask scope;
    bool apply;
};

struct Receipt {
    Json value = nullptr;
    bool layered = false;
    FileMask applied;
};

FileMask allFiles(const Manifest& manifest, bool selected = true) {
    return FileMask(manifest.files.size(), selected);
}

const char* receiptState(const FileMask& applied) {
    const auto count = std::count(applied.begin(), applied.end(), true);
    if (!count) return "restored";
    return static_cast<size_t>(count) == applied.size() ? "applied" : "partiallyRestored";
}

Recovery recoveryState(const FileMask& applied) {
    const std::string_view state = receiptState(applied);
    if (state == "restored") return Recovery::Restored;
    return state == "applied" ? Recovery::Applied : Recovery::PartiallyRestored;
}

std::string key(const Path& name) { return gamefiles::key(name); }

[[noreturn]] void invalidManifest(const std::string& message, std::string detail = {}) {
    throw Error("INVALID_MANIFEST", message, std::move(detail));
}

bool isSha(const std::string& value) { return value.size() == 64 && hexString(value); }

Digest parseDigest(const Json& json, uint64_t limit, bool allowEmpty = false) {
    if (!json.at("bytes").is_number_unsigned()) invalidManifest("清单字节数无效");
    Digest digest{json.at("bytes").get<uint64_t>(), json.at("sha256").get<std::string>()};
    if ((!allowEmpty && !digest.bytes) || digest.bytes > limit || !isSha(digest.sha))
        invalidManifest("清单中的字节数或 SHA-256 无效");
    return digest;
}

Json fields(const Digest& value) {
    return {{"bytes", value.bytes}, {"sha256", value.sha}};
}

Digest digest(const Handle& handle, const Path& path) {
    const auto size = length(handle, path);
    Sha256 hash;
    readChunks(handle, path, [&](std::string_view chunk) { hash.add(chunk); });
    return {size, hash.finish()};
}

Digest digestFile(const Path& root, const Path& path, const char* missing, uint64_t maxBytes) {
    const auto file = openSource(root, path, true);
    if (!file) throw Error(missing, "文件不存在：" + key(path), key(path));
    if (length(file, root / path) > maxBytes)
        throw Error(missing, "文件大小与记录不符：" + key(path), key(path));
    return digest(file, root / path);
}

std::string fingerprint(const Manifest& manifest) {
    Sha256 hash;
    hash.field("llmchat-game-image-baseline-v1");
    hash.field(manifest.engine);
    hash.field("marker");
    hash.field(manifest.markerName);
    hash.field(std::to_string(manifest.baseline.bytes));
    hash.field(manifest.baseline.sha);
    for (const auto& file : manifest.files) {
        hash.field("file");
        hash.field(file.name);
        hash.field(std::to_string(file.before.bytes));
        hash.field(file.before.sha);
    }
    return hash.finish();
}

bool imageKind(const std::string& kind) {
    return kind == "translated" || kind == "mosaic" || kind == "composed";
}

void verifyLegacyProvenance(const Json& item, const Entry& file) {
    const auto& source = item.at("sourceImage");
    const auto id = source.at("id").get<std::string>();
    const auto& layers = source.at("layers");
    const auto expected = Json::array({{{"kind", file.kind}, {"confirmationId", "legacy-migration"},
        {"pngSha256", file.after.sha}}});
    if (id.size() > 16 || !hexString(id) || source.at("relativePath") != file.name ||
        layers != expected || item.at("boxIds") != Json::array())
        invalidManifest("旧补丁迁移记录与成品文件不符", file.name);
}

void verifyProvenance(const Json& item, const Entry& file) {
    const auto& kind = file.kind;
    const auto& source = item.at("sourceImage");
    const auto id = source.at("id").get<std::string>();
    const auto version = source.at("sourceHash").get<std::string>();
    if (source.at("relativePath") != file.name || id.size() > 16 || !hexString(id) || version.empty() ||
        !source.at("width").is_number_unsigned() || !source.at("height").is_number_unsigned())
        invalidManifest("清单原图记录无效", file.name);
    const auto width = source.at("width").get<uint64_t>();
    const auto height = source.at("height").get<uint64_t>();
    if (!width || !height || width > UINT32_MAX || height > UINT32_MAX)
        invalidManifest("清单原图尺寸无效", file.name);
    const auto& layers = source.at("layers");
    if (!layers.is_array()) invalidManifest("清单图层记录无效", file.name);
    std::set<std::string> names;
    std::set<std::string> ids;
    for (const auto& layer : layers) {
        const auto name = layer.at("layer").get<std::string>();
        const auto mode = layer.at("maskMode").get<std::string>();
        const auto& group = layer.at("groupId");
        const auto& boxes = layer.at("boxes");
        if ((name != "translation" && name != "mosaic") || !names.insert(name).second ||
            !uuid(layer.at("confirmationId").get<std::string>()) || !isSha(layer.at("pngSha256").get<std::string>()) ||
            layer.at("candidateVersion").get<std::string>().empty() || (!group.is_null() && !group.is_string()) ||
            !boxes.is_array() || (mode == "whole-image" ? name != "translation" || !boxes.empty() :
                mode != "boxes" || boxes.empty()))
            invalidManifest("清单图层或蒙版记录无效", file.name);
        for (const auto& box : boxes) {
            const auto boxId = box.at("id").get<std::string>();
            const auto& rect = box.at("rect");
            if (boxId.empty() || !ids.insert(boxId).second || !rect.is_array() || rect.size() != 4 ||
                !std::all_of(rect.begin(), rect.end(), [](const Json& value) { return value.is_number_unsigned(); }))
                invalidManifest("清单蒙版坐标或编号无效", file.name);
            auto [left, top, right, bottom] = rect.get<std::array<uint64_t, 4>>();
            if (left >= right || top >= bottom || right > width || bottom > height)
                invalidManifest("清单蒙版超出原图", file.name);
        }
    }
    if ((kind == "translated" && names == std::set<std::string>{"translation"}) ||
        (kind == "mosaic" && names == std::set<std::string>{"mosaic"}) ||
        (kind == "composed" && names.size() == 2)) {
        const auto& refs = item.at("boxIds");
        if (refs.is_array() && refs.size() == ids.size()) {
            for (const auto& ref : refs) if (!ids.erase(ref.get<std::string>())) break;
            if (ids.empty()) return;
        }
    }
    invalidManifest("清单图层或蒙版引用与目标类型不符", file.name);
}

Manifest parseManifest(const Json& json, bool checkProvenance) {
    try {
        if (!json.at("schemaVersion").is_number_integer() || json.at("schemaVersion") != 1) throw Error("UNSUPPORTED_SCHEMA", "成品清单版本不支持");
        const auto& rule = json.at("composeRuleVersion");
        const bool legacy = rule == legacyRule;
        if (!legacy && (!rule.is_number_integer() || rule != 1))
            throw Error("UNSUPPORTED_COMPOSE_RULE", "合成规则版本不支持");
        if (legacy) {
            const auto& migration = json.at("migration");
            if (migration.at("from") != "legacy-patch" || migration.at("scannedAt") != json.at("generatedAt"))
                invalidManifest("旧补丁迁移来源或时间无效");
        }
        const auto& baseline = json.at("baseline");
        const auto& marker = baseline.at("marker");
        const auto& files = json.at("files");
        const auto packageId = json.at("packageId").get<std::string>();
        const auto engine = json.at("engine").get<std::string>();
        const auto rootSha = json.at("gameRootFingerprint").get<std::string>();
        const auto markerName = marker.at("relativePath").get<std::string>();
        if (!uuid(packageId) || (engine != "rpg-maker-mv" && engine != "rpg-maker-mz" && engine != "wolf") ||
            !isSha(rootSha) || baseline.at("algorithm") != fingerprintAlgorithm || !files.is_array() ||
            files.empty() || files.size() > 20000)
            invalidManifest("清单引擎、指纹或目标清单无效");
        if (checkProvenance && (json.at("toolVersion").get<std::string>().empty() ||
            json.at("generatedAt").get<std::string>().empty()))
            invalidManifest("清单生成时间或工具版本无效");
        Manifest result{packageId, engine, rootSha, markerName, relative(markerName), parseDigest(marker, UINT64_MAX), {}};
        std::set<std::wstring, CaseLess> seen;
        for (const auto& item : files) {
            auto name = item.at("relativePath").get<std::string>();
            auto path = relative(name);
            if (!seen.insert(path.native()).second)
                throw Error("INVALID_PATH", "清单包含大小写别名或重复目标：" + name, name);
            auto kind = item.at("kind").get<std::string>();
            if (!imageKind(kind)) invalidManifest("清单含不支持的成品图层", name);
            Entry file{std::move(name), std::move(path), std::move(kind), parseDigest(item.at("original"), maxImageBytes),
                parseDigest(item, maxImageBytes)};
            if (file.before == file.after) invalidManifest("成品文件与原件完全相同", file.name);
            if (checkProvenance) {
                if (engine == "wolf" && item.at("sourceImage").contains("archive"))
                    throw Error("WOLF_ARCHIVE_ENTRY_UNSUPPORTED", "清单目标来自 WOLF 封包：" + file.name, file.name);
                if (legacy) verifyLegacyProvenance(item, file);
                else verifyProvenance(item, file);
            }
            result.files.push_back(std::move(file));
        }
        if (!std::is_sorted(result.files.begin(), result.files.end(),
            [](const auto& left, const auto& right) { return left.name < right.name; }))
            invalidManifest("清单目标未按相对路径排序");
        return result;
    } catch (const Json::exception& error) {
        invalidManifest(std::string("清单字段缺失或格式无效：") + error.what());
    }
}

Json readJson(const Path& root, const Path& name, const char* code, uint64_t limit = maxMetadataBytes) {
    const auto handle = openSource(root, name, true);
    if (!handle) throw Error(code, "缺少文件：" + key(name), key(name));
    if (length(handle, root / name) > limit) throw Error(code, "文件超出允许大小：" + key(name), key(name));
    try {
        return Json::parse(read(handle, root / name, limit));
    } catch (const Json::exception& error) {
        throw Error(code, "JSON 文件无效：" + key(name) + "，" + error.what(), key(name));
    }
}

bool directoryExists(const Path& path) { return bool(openNode(path, true, true)); }

bool fileExists(const Path& root, const Path& name) { return bool(openSource(root, name, true)); }

void separate(const Root& game, const Root& package) {
    const auto contains = [](const auto& ancestor, const auto& candidate) {
        return std::find(candidate.ids.begin(), candidate.ids.end(), ancestor.ids.back()) != candidate.ids.end();
    };
    if (contains(game, package) || contains(package, game))
        throw Error("INVALID_PATH", "成品包与游戏目录必须互不包含", utf8(package.path));
}

struct BaselineCheck {
    Engine engine;
    Digest marker;
    bool changed;
};

constexpr auto markerChangedCode = "BASELINE_MARKER_CHANGED";
constexpr auto markerChangedMessage = "基准标记已被其他补丁更新，已按逐文件校验放行";

BaselineCheck validateBaseline(const Path& game, const Manifest& manifest,
    const std::optional<Digest>& appliedMarker, bool allowChange = false) {
    auto engine = detectEngine(game);
    if (engine.name != manifest.engine || manifest.markerName != key(engine.marker))
        throw Error("BASELINE_MISMATCH", "游戏引擎或基准标记路径与清单不符", manifest.markerName);
    auto marker = digestFile(game, engine.marker, "BASELINE_MISMATCH", UINT64_MAX);
    const bool changed = marker != appliedMarker.value_or(manifest.baseline);
    const bool validFingerprint = fingerprint(manifest) == manifest.fingerprint;
    if (changed && (!allowChange || !validFingerprint))
        throw Error("BASELINE_MISMATCH", "游戏引擎或基准标记与清单不符", manifest.markerName);
    if (!validFingerprint)
        throw Error("FINGERPRINT_MISMATCH", "清单的游戏根指纹与资源记录不符");
    return {std::move(engine), std::move(marker), changed};
}

[[noreturn]] void baselineConflict(const Entry& file, const std::optional<Digest>& actual) {
    const auto observed = actual ? actual->sha + "（" + std::to_string(actual->bytes) + " 字节）" : "不可用（文件不存在）";
    throw Error("BASELINE_MISMATCH", "基准标记已改变，且原图逐文件校验未通过：" + file.name +
        "，预期 SHA-256 " + file.before.sha + "（" + std::to_string(file.before.bytes) + " 字节），实际 SHA-256 " + observed,
        file.name);
}

template<class Match>
void walk(const Path& root, const Path& name, Match& check) {
    const auto path = name.empty() ? root : root / name;
    const auto pin = openNode(path, true);
    for (const auto& entry : fs::directory_iterator(path)) {
        const auto child = name / entry.path().filename();
        const auto attributes = GetFileAttributesW(entry.path().c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES)
            winError("IO_ERROR", "无法读取成品项", entry.path(), GetLastError());
        if (attributes & FILE_ATTRIBUTE_REPARSE_POINT)
            throw Error("INVALID_PATH", "成品包包含重解析点：" + key(child), key(child));
        if (attributes & FILE_ATTRIBUTE_DIRECTORY) walk(root, child, check);
        else {
            const auto file = openNode(entry.path(), false);
            check(child);
        }
    }
}

void payloadMembership(const Path& package, const Manifest& manifest) {
    std::set<std::string> remaining;
    for (const auto& file : manifest.files) remaining.insert(file.name);
    if (!directoryExists(package / payloadDir))
        throw Error("PAYLOAD_LIST_MISMATCH", "成品包缺少 payload 目录");
    auto match = [&](const Path& name) {
        auto value = key(name.lexically_relative(payloadDir));
        relative(value);
        if (!remaining.erase(value))
            throw Error("PAYLOAD_LIST_MISMATCH", "payload 中有清单未记录的文件：" + value, value);
    };
    walk(package, payloadDir, match);
    if (!remaining.empty())
        throw Error("PAYLOAD_LIST_MISMATCH", "payload 缺少清单文件：" + *remaining.begin(), *remaining.begin());
}

Path tempName(const Entry& entry, const std::string& id, size_t index) {
    return entry.path.parent_path() / (".llmchat-export-" + id + "-" + std::to_string(index) + ".partial");
}

void writable(const Path& game, const Entry& entry) {
    const auto parents = pinParents(game, entry.path);
    const auto name = game / entry.path;
    const auto attributes = GetFileAttributesW(name.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES || attributes & FILE_ATTRIBUTE_READONLY)
        throw Error("PERMISSION_DENIED", "游戏目标不可写：" + entry.name, entry.name);
    const Handle parent(CreateFileW(name.parent_path().c_str(), FILE_ADD_FILE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!parent) winError("PERMISSION_DENIED", "无法在目标所在目录创建文件", name.parent_path(), GetLastError());
    const Handle file(CreateFileW(name.c_str(), FILE_WRITE_DATA | DELETE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!file) winError("PERMISSION_DENIED", "无法取得替换游戏文件的权限", name, GetLastError());
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(file.value, &info))
        winError("IO_ERROR", "无法读取替换目标信息", name, GetLastError());
    if (info.nNumberOfLinks != 1 ||
        (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)))
        throw Error("INVALID_PATH", "替换目标包含链接或不是普通文件：" + entry.name, entry.name);
}

void deleteFile(const Path& root, const Path& name) {
    auto parents = pinParents(root, name);
    if (name.has_parent_path() && parents.empty()) return;
    const auto file = openNode(root / name, false, true, DELETE);
    if (!file) return;
    FILE_DISPOSITION_INFO disp{TRUE};
    if (!SetFileInformationByHandle(file.value, FileDispositionInfo, &disp, sizeof(disp)))
        winError("WRITE_FAILED", "无法删除事务临时文件", root / name, GetLastError());
}

void renameHandle(const Handle& source, const Path& target, bool replace) {
    const auto name = fs::absolute(target);
    const auto bytes = name.native().size() * sizeof(wchar_t);
    const auto size = offsetof(FILE_RENAME_INFO, FileName) + bytes + sizeof(wchar_t);
    std::vector<std::byte> buffer(size);
    const auto info = reinterpret_cast<FILE_RENAME_INFO*>(buffer.data());
    info->ReplaceIfExists = replace;
    info->FileNameLength = static_cast<DWORD>(bytes);
    std::memcpy(info->FileName, name.c_str(), bytes);
    if (!SetFileInformationByHandle(source.value, FileRenameInfo, info, static_cast<DWORD>(size))) {
        const auto status = GetLastError();
        winError(status == ERROR_ACCESS_DENIED || status == ERROR_SHARING_VIOLATION ? "PERMISSION_DENIED" : "WRITE_FAILED",
            "无法原子替换文件或目录", target, status);
    }
}

void copy(const Path& sourceRoot, const Path& sourceName, const Path& destinationRoot,
    const Path& destinationName, const Digest& expected, const char* sourceCode) {
    const auto source = openSource(sourceRoot, sourceName, true);
    if (!source || length(source, sourceRoot / sourceName) != expected.bytes)
        throw Error(sourceCode, "源文件缺失或大小已改变：" + key(sourceName), key(sourceName));

    const auto parents = createParents(destinationRoot, destinationName);
    const auto destination = destinationRoot / destinationName;
    const auto output = newFile(destination);
    Sha256 hash;
    readChunks(source, sourceRoot / sourceName, [&](std::string_view chunk) {
        hash.add(chunk);
        writeChunk(output, destination, chunk);
    });
    if (hash.finish() != expected.sha)
        throw Error(sourceCode, "源文件 SHA-256 不符：" + key(sourceName), key(sourceName));
    if (!FlushFileBuffers(output.value))
        winError("WRITE_FAILED", "无法刷盘事务文件", destination, GetLastError());
}

void replace(const Path& game, const Entry& entry, const Path& temp, const Path& sourceRoot,
    const Path& sourceName, const Digest& oldDigest, const Digest& newDigest, const char* sourceCode) {
    const auto parents = pinParents(game, entry.path);
    if (parents.empty()) throw Error("TARGET_CHANGED", "目标目录不存在：" + entry.name, entry.name);
    if (digestFile(game, entry.path, "TARGET_CHANGED", maxImageBytes) != oldDigest)
        throw Error("TARGET_CHANGED", "游戏目标已变化：" + entry.name, entry.name);
    copy(sourceRoot, sourceName, game, temp, newDigest, sourceCode);
    // Reopen the finished temporary and pin the exact bytes being published.
    const auto staged = openNode(game / temp, false, false, DELETE);
    if (digest(staged, game / temp) != newDigest)
        throw Error("WRITE_FAILED", "临时文件刷盘后校验失败：" + entry.name, entry.name);
    if (digestFile(game, entry.path, "TARGET_CHANGED", maxImageBytes) != oldDigest)
        throw Error("TARGET_CHANGED", "替换前游戏目标已变化：" + entry.name, entry.name);
    renameHandle(staged, game / entry.path, true);
}

void checkpoint(const ApplyControl& control, ApplyPhase phase, size_t index) {
    if (control.checkpoint) control.checkpoint(phase, index);
}

void writeAtomic(const Path& root, const Path& temp, const Path& target, const Json& value, bool replace,
    const ApplyControl& control = {}, size_t index = 0) {
    const auto parent = pinParents(root, target);
    const auto expected = write(root, temp, value.dump(2) + "\n");
    const auto written = openNode(root / temp, false, false, DELETE);
    if (digest(written, root / temp).sha != expected)
        throw Error("WRITE_FAILED", "事务记录写入后 SHA-256 不符：" + key(target), key(target));
    checkpoint(control, ApplyPhase::BeforeReceiptPublish, index);
    checkpoint(control, ApplyPhase::CommitReceipt, index);
    renameHandle(written, root / target, replace);
}

Json planHeader(const Plan& plan, const Root& game) {
    return {{"schemaVersion", 1}, {"packageId", plan.manifest.packageId}, {"transactionId", plan.id},
        {"gameRootId", game.ids.back()}, {"planSha256", plan.sha}};
}

Json fileRecords(const Manifest& manifest, const FileMask& applied, bool includeKinds, bool includeStates) {
    auto files = Json::array();
    for (size_t i = 0; i < manifest.files.size(); ++i) {
        const auto& file = manifest.files[i];
        Json value{{"relativePath", file.name}, {"backupPath", key(Path(backupDir) / file.path)},
            {"before", fields(file.before)}, {"after", fields(file.after)}};
        if (includeKinds) value["kind"] = file.kind;
        if (includeStates) value["state"] = applied[i] ? "applied" : "restored";
        files.push_back(std::move(value));
    }
    return files;
}

Json makeReceipt(const Plan& plan, const Root& game, const FileMask& applied, bool layered) {
    auto value = planHeader(plan, game);
    value["files"] = fileRecords(plan.manifest, applied, layered, layered);
    value["state"] = receiptState(applied);
    if (plan.appliedMarker)
        value["warning"] = {{"code", markerChangedCode}, {"message", markerChangedMessage}};
    return value;
}

FileMask restoreScope(const Manifest& manifest, const Receipt& receipt, const RestoreKinds& kinds) {
    if (!kinds) return allFiles(manifest);
    if (kinds->empty()) throw Error("INVALID_KINDS", "kinds 不能为空，整包恢复请省略该字段");
    std::set<std::string> requested;
    for (const auto& kind : *kinds) {
        const auto name = kind == "image" ? "translated" : kind;
        if (name != "translated" && name != "mosaic" && name != "composed")
            throw Error("INVALID_KINDS", "不支持的恢复图层", kind);
        requested.insert(name);
    }
    if (!receipt.layered) return allFiles(manifest);
    auto selected = allFiles(manifest, false);
    auto unmatched = requested;
    for (size_t i = 0; i < manifest.files.size(); ++i) {
        const auto& kind = manifest.files[i].kind;
        selected[i] = requested.contains(kind);
        if (selected[i]) unmatched.erase(kind);
    }
    if (!unmatched.empty()) throw Error("INVALID_KINDS", "成品包没有该图层", *unmatched.begin());
    return selected;
}

FileMask appliedIn(const FileMask& applied, const FileMask& scope) {
    FileMask result;
    for (size_t i = 0; i < applied.size(); ++i) result.push_back(applied[i] && scope[i]);
    return result;
}

bool anyFiles(const FileMask& files) {
    return std::any_of(files.begin(), files.end(), [](bool file) { return file; });
}

Json layerStates(const Manifest& manifest, const FileMask& applied) {
    std::map<std::string, std::pair<size_t, size_t>> counts;
    for (size_t i = 0; i < manifest.files.size(); ++i) {
        auto& [active, restored] = counts[manifest.files[i].kind];
        ++(applied[i] ? active : restored);
    }
    Json layers = Json::object();
    for (const auto& [kind, count] : counts) {
        const auto [active, restored] = count;
        layers[kind] = {{"state", active == 0 ? "restored" : restored == 0 ? "applied" : "partiallyRestored"},
            {"appliedFiles", active}, {"restoredFiles", restored}};
    }
    return layers;
}

struct Transaction {
    Root game;
    Root package;
    DirectoryLock gameLock;
    DirectoryLock packageLock;
    Handle receipts;

    Transaction(const Path& packageDir, const Path& gameRoot)
        : game(gameRoot), package(packageDir),
          gameLock(game.ids.back()), packageLock(packageIdentity()), receipts(openNode(package.path / receiptDir, true)) {}

    const std::string& packageIdentity() const {
        separate(game, package);
        return package.ids.back();
    }

    Receipt receipt(const Plan& plan) const {
        if (!fileExists(package.path, receiptName)) return {};
        auto stored = readJson(package.path, receiptName, "INVALID_RECEIPT", maxPlanBytes);
        const auto expected = planHeader(plan, game);
        for (const auto& field : expected.items())
            if (!stored.contains(field.key()) || stored.at(field.key()) != field.value())
                throw Error("INVALID_RECEIPT", "收据不属于当前成品包或游戏目录");
        const auto& files = stored.at("files");
        if (!files.is_array() || files.size() != plan.manifest.files.size())
            throw Error("INVALID_RECEIPT", "收据文件数量与备份计划不符");
        const bool layered = files.front().contains("kind");
        const bool hasStates = files.front().contains("state");
        if (layered && !hasStates) throw Error("INVALID_RECEIPT", "分层收据缺少文件状态");
        FileMask applied;
        for (const auto& file : files) {
            if (file.contains("kind") != layered || file.contains("state") != hasStates)
                throw Error("INVALID_RECEIPT", "收据的文件状态格式不一致");
            const auto state = hasStates ? file.at("state").get<std::string>() : stored.at("state").get<std::string>();
            if (state != "applied" && state != "restored") throw Error("INVALID_RECEIPT", "收据文件状态无效");
            applied.push_back(state == "applied");
        }
        if (stored.at("state") != receiptState(applied) || files != fileRecords(plan.manifest, applied, layered, hasStates))
            throw Error("INVALID_RECEIPT", "收据的文件记录与备份计划不符");
        return {std::move(stored), layered, std::move(applied)};
    }

    Json receiptValue(const Plan& plan, const FileMask& applied, bool layered) const {
        return makeReceipt(plan, game, applied, layered);
    }

    Json writeReceipt(const Plan& plan, const FileMask& applied, bool layered, bool replace,
        const ApplyControl& control = {}) const {
        auto value = receiptValue(plan, applied, layered);
        writeAtomic(package.path, receiptStage, receiptName, value, replace, control, plan.manifest.files.size());
        return value;
    }

    Plan readPlan() const {
        const auto path = Path(backupDir) / planName;
        const auto handle = openSource(package.path, path, true);
        if (!handle) throw Error("BACKUP_MISSING", "缺少原件备份计划", key(path));
        const auto raw = read(handle, package.path / path, maxPlanBytes);
        try {
            const auto json = Json::parse(raw);
            const auto id = json.at("transactionId").get<std::string>();
            if (json.at("schemaVersion") != 1 || !uuid(id) || json.at("gameRootId") != game.ids.back() ||
                json.at("packageRootId") != package.ids.back())
                throw Error("INVALID_RECEIPT", "备份计划不属于当前成品包或游戏目录");
            std::optional<Digest> appliedMarker;
            if (json.contains("appliedMarker")) appliedMarker = parseDigest(json.at("appliedMarker"), UINT64_MAX, true);
            return {id, parseManifest(json.at("manifest"), false), hash(raw), std::move(appliedMarker)};
        } catch (const Json::exception& e) {
            throw Error("INVALID_RECEIPT", std::string("备份计划无效：") + e.what());
        }
    }

    Plan prepare(const Json& json, const Manifest& manifest, const std::optional<Digest>& appliedMarker) const {
        const auto id = newId();
        const auto stage = package.path / backupStage;
        if (!CreateDirectoryW(stage.c_str(), nullptr))
            winError("WRITE_FAILED", "无法创建原件备份暂存目录", stage, GetLastError());
        const auto pin = openNode(stage, true, false, DELETE);
        for (size_t i = 0; i < manifest.files.size(); ++i) {
            const auto& file = manifest.files[i];
            if (fileExists(game.path, tempName(file, id, i)))
                throw Error("WRITE_FAILED", "临时文件与已有路径冲突：" + file.name, file.name);
            copy(game.path, file.path, stage, file.path, file.before, "TARGET_CHANGED");
            if (digestFile(stage, file.path, "BACKUP_MISSING", maxImageBytes) != file.before)
                throw Error("WRITE_FAILED", "备份写入后 SHA-256 不符：" + file.name, file.name);
        }
        Json record{{"schemaVersion", 1}, {"transactionId", id}, {"gameRootId", game.ids.back()},
            {"packageRootId", package.ids.back()}, {"manifest", json}};
        if (appliedMarker) record["appliedMarker"] = fields(*appliedMarker);
        const auto data = record.dump(2) + "\n";
        if (data.size() > maxPlanBytes) throw Error("WRITE_FAILED", "备份计划超出允许大小");
        const auto sha = write(stage, planName, data);
        renameHandle(pin, package.path / backupDir, false);
        return {id, manifest, sha, appliedMarker};
    }

    void verifyBackups(const Plan& plan, const FileMask& scope = {}) const {
        for (size_t i = 0; i < plan.manifest.files.size(); ++i) {
            if (!scope.empty() && !scope[i]) continue;
            const auto& file = plan.manifest.files[i];
            const auto path = Path(backupDir) / file.path;
            if (digestFile(package.path, path, "BACKUP_MISSING", maxImageBytes) != file.before)
                throw Error("BACKUP_CORRUPT", "原件备份已变化：" + file.name, file.name);
        }
    }

    FileMask verifyTargets(const Manifest& manifest, const Engine& engine, const FileMask& expected,
        const FileMask& allowEither = {}, const FileMask& requireWritable = {}, bool markerChanged = false) const {
        std::set<std::string> ids;
        FileMask applied;
        for (size_t i = 0; i < manifest.files.size(); ++i) {
            const auto& file = manifest.files[i];
            targetPath(game.path, engine, Json::object(), file.path, file.name);
            auto handle = openSource(game.path, file.path, true);
            if (!handle) {
                if (markerChanged) baselineConflict(file, std::nullopt);
                throw Error("TARGET_CHANGED", "游戏目标缺失或大小已变化：" + file.name, file.name);
            }
            if (!markerChanged && length(handle, game.path / file.path) > maxImageBytes)
                throw Error("TARGET_CHANGED", "游戏目标缺失或大小已变化：" + file.name, file.name);
            if (!ids.insert(identity(handle, game.path / file.path)).second)
                throw Error("INVALID_PATH", "多个目标指向同一游戏文件：" + file.name, file.name);
            const auto current = digest(handle, game.path / file.path);
            const bool after = current == file.after;
            if ((!after && current != file.before) || ((allowEither.empty() || !allowEither[i]) && after != expected[i])) {
                if (markerChanged) baselineConflict(file, current);
                throw Error("TARGET_CHANGED", "游戏目标已变化：" + file.name, file.name);
            }
            applied.push_back(after);
            if (!requireWritable.empty() && requireWritable[i] && after) {
                handle = Handle();
                writable(game.path, file);
            }
        }
        return applied;
    }

    std::optional<Digest> checkApplicationTargets(const Manifest& manifest) const {
        const auto baseline = validateBaseline(game.path, manifest, std::nullopt, true);
        verifyTargets(manifest, baseline.engine, allFiles(manifest, false), {}, {}, baseline.changed);
        if (baseline.changed) return baseline.marker;
        return std::nullopt;
    }

    FileMask targets(const Plan& plan, const FileMask& expected,
        const FileMask& allowEither = {}, const FileMask& requireWritable = {}) const {
        const auto baseline = validateBaseline(game.path, plan.manifest, plan.appliedMarker);
        return verifyTargets(plan.manifest, baseline.engine, expected, allowEither, requireWritable);
    }

    void cleanTemps(const Plan& plan) const {
        for (size_t i = 0; i < plan.manifest.files.size(); ++i)
            deleteFile(game.path, tempName(plan.manifest.files[i], plan.id, i));
    }

    FileMask changeTargets(const Plan& plan, FileMask applied, const Transition& change,
        const ApplyControl& control = {}) const {
        cleanTemps(plan);
        for (size_t step = 0; step < plan.manifest.files.size(); ++step) {
            const auto i = change.apply ? step : plan.manifest.files.size() - 1 - step;
            const auto& file = plan.manifest.files[i];
            if (!change.scope[i] || applied[i] == change.apply) continue;
            checkpoint(control, ApplyPhase::BeforeReplace, i);
            if (change.apply)
                replace(game.path, file, tempName(file, plan.id, i), package.path, Path(payloadDir) / file.path,
                    file.before, file.after, "PAYLOAD_HASH_MISMATCH");
            else
                replace(game.path, file, tempName(file, plan.id, i), package.path, Path(backupDir) / file.path,
                    file.after, file.before, "BACKUP_CORRUPT");
            applied[i] = change.apply;
        }
        targets(plan, applied);
        return applied;
    }

    std::optional<Transition> readRestoreIntent(const Plan& plan) const {
        if (!fileExists(package.path, restoreIntent)) return std::nullopt;
        auto value = readJson(package.path, restoreIntent, "INVALID_RECEIPT");
        const auto paths = value.contains("targetPaths") ? value.at("targetPaths") : Json(nullptr);
        const bool scoped = value.erase("targetPaths") != 0;
        const auto direction = value.value("direction", "restore");
        value.erase("direction");
        if (value != planHeader(plan, game) || (direction != "apply" && direction != "restore"))
            throw Error("INVALID_RECEIPT", "恢复标记与备份计划不符");
        if (!scoped) return Transition{allFiles(plan.manifest), false};
        if (!paths.is_array() || paths.empty())
            throw Error("INVALID_RECEIPT", "分层恢复标记缺少目标");
        std::set<std::string> remaining;
        for (const auto& path : paths)
            if (!path.is_string() || !remaining.insert(path.get<std::string>()).second)
                throw Error("INVALID_RECEIPT", "分层恢复标记的目标无效或重复");
        FileMask scope;
        for (const auto& file : plan.manifest.files) scope.push_back(remaining.erase(file.name) != 0);
        if (!remaining.empty()) throw Error("INVALID_RECEIPT", "分层恢复标记含有计划外的目标");
        return Transition{std::move(scope), direction == "apply"};
    }

    void writeRestoreIntent(const Plan& plan, const Transition& change) const {
        auto value = planHeader(plan, game);
        auto paths = Json::array();
        for (size_t i = 0; i < plan.manifest.files.size(); ++i)
            if (change.scope[i]) paths.push_back(plan.manifest.files[i].name);
        value["targetPaths"] = std::move(paths);
        if (change.apply) value["direction"] = "apply";
        writeAtomic(package.path, restoreStage, restoreIntent, value, false);
    }

    void cleanPackageTemps() const {
        if (directoryExists(package.path / backupStage)) removeTree(package.path / backupStage);
        deleteFile(package.path, receiptStage);
        deleteFile(package.path, restoreStage);
    }
};

void verifyPayload(const Transaction& tx, const Manifest& manifest, const FileMask& scope = {}) {
    for (size_t i = 0; i < manifest.files.size(); ++i) {
        if (!scope.empty() && !scope[i]) continue;
        const auto& file = manifest.files[i];
        if (digestFile(tx.package.path, Path(payloadDir) / file.path, "PAYLOAD_HASH_MISMATCH", maxImageBytes) != file.after)
            throw Error("PAYLOAD_HASH_MISMATCH", "成品文件 SHA-256 或大小与清单不符：" + file.name, file.name);
    }
}

void verifyReplaceAccess(const Transaction& tx, const Manifest& manifest, const FileMask& scope) {
    for (size_t i = 0; i < manifest.files.size(); ++i)
        if (scope[i]) writable(tx.game.path, manifest.files[i]);
}

Recovery recoverLocked(const Transaction& tx, const ApplyControl& control = {}) {
    const bool hasReceipt = fileExists(tx.package.path, receiptName);
    if (!directoryExists(tx.package.path / backupDir)) {
        if (hasReceipt) throw Error("BACKUP_MISSING", "收据存在，但原件备份目录缺失");
        tx.cleanPackageTemps();
        return Recovery::Clean;
    }
    const auto plan = tx.readPlan();
    const auto receipt = tx.receipt(plan);
    const auto intent = tx.readRestoreIntent(plan);
    if (!hasReceipt && intent)
        throw Error("INVALID_RECEIPT", "恢复标记存在，但应用收据缺失");

    if (intent || !hasReceipt) {
        const auto change = intent.value_or(Transition{allFiles(plan.manifest), false});
        const auto expected = hasReceipt ? receipt.applied : allFiles(plan.manifest, false);
        if (change.apply) verifyPayload(tx, plan.manifest, change.scope);
        else tx.verifyBackups(plan, change.scope);
        const auto applied = tx.targets(plan, expected, change.scope);
        auto pending = change.scope;
        for (size_t i = 0; i < pending.size(); ++i) pending[i] = pending[i] && applied[i] != change.apply;
        verifyReplaceAccess(tx, plan.manifest, pending);
        checkpoint(control, ApplyPhase::BeginMutation, 0);
        tx.cleanPackageTemps();
        const auto remaining = tx.changeTargets(plan, applied, change, control);
        if (intent) {
            checkpoint(control, ApplyPhase::BeforeReceipt, remaining.size());
            tx.writeReceipt(plan, remaining, receipt.layered, true, control);
            deleteFile(tx.package.path, restoreIntent);
            return recoveryState(remaining);
        }
        // Once every original is verified, retire the plan atomically. A
        // crash during deletion can then resume cleanup without the backups.
        {
            const auto backup = openNode(tx.package.path / backupDir, true, false, DELETE);
            renameHandle(backup, tx.package.path / backupStage, false);
        }
        removeTree(tx.package.path / backupStage);
        return Recovery::RolledBack;
    }
    tx.verifyBackups(plan);
    tx.targets(plan, receipt.applied);
    tx.cleanTemps(plan);
    tx.cleanPackageTemps();
    return recoveryState(receipt.applied);
}

Json updateReceipt(const Transaction& tx, const Plan& plan, const Receipt& receipt, const Transition& change,
    const ApplyControl& control, bool rollbackOnFailure) {
    checkpoint(control, ApplyPhase::BeginMutation, 0);
    tx.writeRestoreIntent(plan, change);
    bool committed = false;
    try {
        const auto remaining = tx.changeTargets(plan, receipt.applied, change, control);
        checkpoint(control, ApplyPhase::BeforeReceipt, remaining.size());
        auto result = tx.writeReceipt(plan, remaining, receipt.layered, true, control);
        committed = true;
        deleteFile(tx.package.path, restoreIntent);
        return result;
    } catch (...) {
        if (rollbackOnFailure && !committed) {
            try {
                const auto current = tx.targets(plan, receipt.applied, change.scope);
                tx.changeTargets(plan, current, {change.scope, !change.apply});
                tx.cleanPackageTemps();
                deleteFile(tx.package.path, restoreIntent);
            } catch (const std::exception& error) {
                throw Error("RECOVERY_REQUIRED", std::string("无法撤销未完成的文件替换：") + error.what());
            }
        }
        throw;
    }
}

struct Application {
    std::optional<Plan> plan;
    Receipt receipt;
    FileMask pending;
    std::optional<Digest> marker;
};

Application checkApplication(const Transaction& tx, const Manifest& manifest) {
    const auto& root = tx.package.path;
    const bool hasReceipt = fileExists(root, receiptName);
    if ((!hasReceipt && directoryExists(root / backupDir)) || directoryExists(root / backupStage) ||
        fileExists(root, receiptStage) || fileExists(root, restoreIntent) || fileExists(root, restoreStage))
        throw Error("RECOVERY_REQUIRED", "成品包有未完成的事务，请先恢复");

    payloadMembership(root, manifest);
    if (!hasReceipt) {
        const auto marker = tx.checkApplicationTargets(manifest);
        auto pending = allFiles(manifest);
        verifyReplaceAccess(tx, manifest, pending);
        return {std::nullopt, {}, std::move(pending), marker};
    }

    auto plan = tx.readPlan();
    auto receipt = tx.receipt(plan);
    if (plan.manifest.packageId != manifest.packageId || plan.manifest.fingerprint != manifest.fingerprint ||
        !std::equal(manifest.files.begin(), manifest.files.end(), plan.manifest.files.begin(),
            plan.manifest.files.end(), [](const Entry& left, const Entry& right) {
                return left.after == right.after && left.kind == right.kind;
            }))
        throw Error("TARGET_CHANGED", "当前成品清单与已应用收据不一致");
    if (!anyFiles(receipt.applied))
        throw Error("TARGET_CHANGED", "成品包已整包恢复，请重新生成后应用");
    tx.targets(plan, receipt.applied);
    auto pending = allFiles(manifest, false);
    for (size_t i = 0; i < receipt.applied.size(); ++i) pending[i] = !receipt.applied[i];
    verifyReplaceAccess(tx, manifest, pending);
    return {std::move(plan), std::move(receipt), std::move(pending), std::nullopt};
}

Json applyLocked(const Transaction& tx, const ApplyControl& control) {
    const auto json = readJson(tx.package.path, manifestName, "INVALID_MANIFEST");
    const auto manifest = parseManifest(json, true);
    auto application = checkApplication(tx, manifest);
    verifyPayload(tx, manifest);
    if (application.plan) {
        if (!anyFiles(application.pending)) {
            checkpoint(control, ApplyPhase::BeginMutation, 0);
            auto result = std::move(application.receipt.value);
            result["alreadyApplied"] = true;
            return result;
        }
        tx.verifyBackups(*application.plan, application.pending);
        auto result = updateReceipt(tx, *application.plan, application.receipt,
            {application.pending, true}, control, true);
        result["alreadyApplied"] = false;
        return result;
    }

    Json result;
    try {
        const auto plan = tx.prepare(json, manifest, application.marker);
        checkpoint(control, ApplyPhase::BeginMutation, 0);
        const auto remaining = tx.changeTargets(plan, allFiles(manifest, false), {application.pending, true}, control);
        checkpoint(control, ApplyPhase::BeforeReceipt, manifest.files.size());
        try {
            result = tx.writeReceipt(plan, remaining, true, false, control);
        } catch (const std::exception& error) {
            throw Error("RECEIPT_WRITE_FAILED", std::string("写入最终收据失败：") + error.what());
        }
        if (application.marker)
            std::clog << markerChangedCode << " [" << manifest.packageId << "] " << manifest.markerName
                      << " " << markerChangedMessage << std::endl;
    } catch (...) {
        const auto original = std::current_exception();
        try {
            recoverLocked(tx);
        } catch (const std::exception& rollback) {
            throw Error("RECOVERY_REQUIRED", std::string("未能自动回滚，请恢复事务：") + rollback.what());
        }
        std::rethrow_exception(original);
    }
    result["alreadyApplied"] = false;
    return result;
}

Json restoreLocked(const Transaction& tx, const RestoreKinds& kinds, const ApplyControl& control,
    bool rollbackOnFailure = false) {
    if (!fileExists(tx.package.path, receiptName))
        throw Error("INVALID_RECEIPT", "没有已应用的收据，若应用异常中断请先恢复事务");
    const auto plan = tx.readPlan();
    auto receipt = tx.receipt(plan);
    const auto scope = restoreScope(plan.manifest, receipt, kinds);
    const auto pending = tx.readRestoreIntent(plan);
    if (pending) {
        recoverLocked(tx, control);
        receipt = tx.receipt(plan);
    }
    if (!pending || !control.cancelRequested || !control.cancelRequested()) {
        const auto selected = appliedIn(receipt.applied, scope);
        tx.verifyBackups(plan, kinds && receipt.layered ? selected : scope);
        tx.targets(plan, receipt.applied, {}, selected);
        if (anyFiles(selected)) {
            if (rollbackOnFailure) verifyPayload(tx, plan.manifest, selected);
            receipt.value = updateReceipt(tx, plan, receipt, {selected, false}, control, rollbackOnFailure);
        } else {
            checkpoint(control, ApplyPhase::BeginMutation, 0);
        }
    }
    if (!receipt.layered) {
        receipt.value["layerRestoreSupported"] = false;
        receipt.value["restoredAsFullPackage"] = true;
        receipt.value["warning"] = "旧收据没有图层信息，已按整包恢复";
    }
    return std::move(receipt.value);
}

template<class Function>
decltype(auto) guard(Function run) {
    try {
        return run();
    } catch (const Error& error) {
        if (error.code == "OUTPUT_WRITE_FAILED") throw Error("WRITE_FAILED", error.what(), error.detail);
        throw;
    } catch (const Json::exception& error) {
        throw Error("INVALID_RECEIPT", std::string("事务记录格式错误：") + error.what());
    } catch (const fs::filesystem_error& error) {
        throw Error(error.code() == std::errc::permission_denied ? "PERMISSION_DENIED" : "WRITE_FAILED",
            std::string("成品事务文件操作失败：") + error.what());
    } catch (const std::runtime_error& error) {
        throw Error("WRITE_FAILED", error.what());
    }
}

} // namespace

nlohmann::json apply(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot,
    const ApplyControl& control) {
    return guard([&] { return applyLocked(Transaction(packageDir, gameRoot), control); });
}

nlohmann::json restore(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot,
    const RestoreKinds& kinds, const ApplyControl& control) {
    return guard([&] { return restoreLocked(Transaction(packageDir, gameRoot), kinds, control); });
}

Recovery recover(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot,
    const ApplyControl& control) {
    return guard([&] { return recoverLocked(Transaction(packageDir, gameRoot), control); });
}


void checkApply(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot) {
    guard([&] {
        const Transaction tx(packageDir, gameRoot);
        checkApplication(tx, parseManifest(readJson(tx.package.path, manifestName, "INVALID_MANIFEST"), true));
    });
}

PackageStatus inspect(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot,
    const RestoreKinds& kinds) {
    return guard([&] {
        const Transaction tx(packageDir, gameRoot);
        parseManifest(readJson(tx.package.path, manifestName, "INVALID_MANIFEST"), true);
        PackageStatus result;
        const auto hasReceipt = fileExists(tx.package.path, receiptName);
        const auto hasPlan = directoryExists(tx.package.path / backupDir);
        result.needsRecovery = (!hasReceipt && hasPlan) || directoryExists(tx.package.path / backupStage) ||
            fileExists(tx.package.path, restoreIntent) || fileExists(tx.package.path, receiptStage) ||
            fileExists(tx.package.path, restoreStage);
        if (!hasReceipt && !hasPlan) return result;
        if (hasReceipt) {
            result.receipt = readJson(tx.package.path, receiptName, "INVALID_RECEIPT", maxPlanBytes);
            const auto state = result.receipt.value("state", "");
            result.applied = state == "applied" || state == "partiallyRestored";
        }
        try {
            const auto plan = tx.readPlan();
            const auto receipt = tx.receipt(plan);
            const auto intent = tx.readRestoreIntent(plan);
            if (intent && !hasReceipt)
                throw Error("INVALID_RECEIPT", "恢复标记存在，但应用收据缺失");

            result.layerRestoreSupported = receipt.layered;
            if (receipt.layered) result.layers = layerStates(plan.manifest, receipt.applied);
            const auto scope = restoreScope(plan.manifest, receipt, kinds);
            const auto expected = hasReceipt ? receipt.applied : allFiles(plan.manifest, false);
            const auto uncertain = intent ? intent->scope : allFiles(plan.manifest, !hasReceipt);
            const auto selected = hasReceipt ? appliedIn(receipt.applied, scope) : scope;
            auto backups = kinds && receipt.layered ? selected : scope;
            auto writable = selected;
            for (size_t i = 0; i < uncertain.size(); ++i) {
                if (!uncertain[i]) continue;
                backups[i] = true;
                writable[i] = true;
            }
            tx.verifyBackups(plan, backups);
            tx.targets(plan, expected, uncertain, writable);
            result.canRestore = anyFiles(selected) || intent.has_value();
            if (!hasReceipt)
                result.rollbackReceipt = tx.receiptValue(plan, allFiles(plan.manifest, false), true);
        } catch (const Error& error) {
            result.restoreError.emplace(error.code, error.what(), error.detail);
        }
        return result;
    });
}

namespace {

bool validateRemoval(const Root& package, bool restoreFirst) {
    if (package.path.extension() != L".llmchat-images")
        throw Error("INVALID_PATH", "仅可删除成品包目录", utf8(package.path));
    const auto manifest = parseManifest(readJson(package.path, manifestName, "INVALID_MANIFEST"), true);
    if (directoryExists(package.path / backupStage) || fileExists(package.path, restoreIntent) ||
        fileExists(package.path, receiptStage) || fileExists(package.path, restoreStage))
        throw Error("RECOVERY_REQUIRED", "成品包有未完成的事务，请先恢复");
    const bool hasBackup = directoryExists(package.path / backupDir);
    const bool hasReceipt = fileExists(package.path, receiptName);
    bool applied = false;
    if (hasBackup || hasReceipt) {
        if (!hasReceipt) throw Error("RECOVERY_REQUIRED", "成品包有未完成的应用，请先恢复");
        const auto receipt = readJson(package.path, receiptName, "INVALID_RECEIPT", maxPlanBytes);
        if (receipt.at("packageId") != manifest.packageId || receipt.at("schemaVersion") != 1)
            throw Error("INVALID_RECEIPT", "收据不属于此成品包");
        applied = receipt.at("state") != "restored";
        if (applied && !restoreFirst) throw Error("PACKAGE_IN_USE", "成品仍已应用，请先恢复原件再清理");
        const auto planFile = Path(backupDir) / planName;
        const auto plan = digestFile(package.path, planFile, "BACKUP_MISSING", maxPlanBytes);
        if (receipt.at("planSha256") != plan.sha)
            throw Error("INVALID_RECEIPT", "收据的备份计划校验失败");
    }
    auto inspect = [](const Path& name) { relative(key(name)); };
    walk(package.path, {}, inspect);
    return applied;
}

void detachPackage(Root& package) {
    const auto retired = package.path.parent_path() / (".llmchat-removed-" + newId() + ".partial");
    package.handles.pop_back();
    {
        const auto source = openNode(package.path, true, false, DELETE);
        renameHandle(source, retired, false);
    }
    // The rename removes the package from its published path atomically.
    // Cleanup of the detached tree is separate from the committed removal.
    try {
        removeTree(retired);
    } catch (const std::exception& error) {
        std::clog << "PACKAGE_CLEANUP_PENDING " << utf8(retired) << ": " << error.what() << '\n';
    }
}

} // namespace

void remove(const std::filesystem::path& packageDir) {
    guard([&] {
        Root package(packageDir);
        const DirectoryLock lock(package.ids.back());
        validateRemoval(package, false);
        package.handles.pop_back();
        removeTree(package.path);
    });
}

nlohmann::json restoreAndRemove(const std::filesystem::path& packageDir,
    const std::optional<std::filesystem::path>& gameRoot, const ApplyControl& control) {
    return guard([&]() -> Json {
        {
            Root package(packageDir);
            const DirectoryLock lock(package.ids.back());
            if (!validateRemoval(package, true)) {
                detachPackage(package);
                return {{"restored", false}, {"removed", true}};
            }
        }
        if (!gameRoot) throw Error("INVALID_REQUEST", "已应用的成品包需要 gamePath 才能恢复并删除");
        Transaction tx(packageDir, *gameRoot);
        const bool applied = validateRemoval(tx.package, true);
        if (applied) restoreLocked(tx, std::nullopt, control, true);
        tx.receipts = Handle();
        detachPackage(tx.package);
        return {{"restored", applied}, {"removed", true}};
    });
}

std::optional<uint64_t> packageBytes(const std::filesystem::path& packageDir) {
    return guard([&]() -> std::optional<uint64_t> {
        if (!directoryExists(packageDir)) return std::nullopt;
        const Root package(packageDir);
        const auto manifest = openSource(package.path, manifestName, true);
        if (!manifest) throw Error("INVALID_MANIFEST", "成品包缺少 manifest.json");
        auto bytes = length(manifest, package.path / manifestName);
        auto add = [&](const Path& name) {
            const auto file = openSource(package.path, name);
            bytes += length(file, package.path / name);
        };
        for (const auto folder : {payloadDir, receiptDir})
            if (directoryExists(package.path / folder)) walk(package.path, folder, add);
        return bytes;
    });
}

class LegacyMigration {
    struct Marker {
        Path path;
        std::string kind;
        Digest content;
    };

    struct Candidate {
        std::string name, id, kind;
        std::string state = "unsupported", detail;
        Path path, backup;
        Digest before{}, after{};
        std::vector<Marker> markers;
        const Json* row = nullptr;

        Json value() const {
            return {{"relativePath", name}, {"imageId", id}, {"kind", kind}, {"state", state}, {"detail", detail}};
        }
    };

    static constexpr wchar_t projectDir[] = L"LLMChat-JSON/images";
    static constexpr wchar_t journalName[] = L"LLMChat-JSON/images/legacy-migration.json";
    static constexpr wchar_t journalStage[] = L"LLMChat-JSON/images/.legacy-migration.partial";
    struct PendingMigration {
        std::string id, suffix, outputId, packageDirectoryId, outputPath, manifestSha;
        std::map<Path, Digest> markers;

        Path retired(Path path) const {
            path += ".migrated-" + suffix;
            return path;
        }
        Path stage() const { return "." + id + ".partial"; }
        Path target() const { return "legacy-" + suffix + "-" + id.substr(0, 8) + ".llmchat-images"; }
    };
    const Root& game_;
    const Engine engine_;
    Json rows_ = Json::array();
    std::set<std::string> retired_;
    std::optional<PendingMigration> pending_;
    Handle baseline_;
    std::string key_;

    static bool validRevision(std::string_view value) {
        return !value.empty() && value.size() <= 64 && value.find_first_not_of("0123456789-") == std::string_view::npos;
    }

    PendingMigration readPending() const {
        const auto record = readJson(game_.path, journalName, "RECOVERY_REQUIRED");
        PendingMigration pending{record.at("id"), record.at("suffix"), record.at("outputId"),
            record.at("packageDirectoryId"), record.at("outputPath"), record.at("manifestSha"), {}};
        const auto& suffix = pending.suffix;
        if (record.at("schemaVersion") != 1 || !uuid(pending.id) || !isSha(pending.manifestSha) ||
            suffix.size() != 19 || suffix[8] != 'T' || suffix.back() != 'Z' ||
            !validRevision(suffix.substr(0, 8)) || !validRevision(suffix.substr(9, 9)))
            throw Error("RECOVERY_REQUIRED", "旧补丁迁移记录无效", key(journalName));
        for (const auto& marker : record.at("markers")) {
            const auto path = relative(marker.at("path").get<std::string>());
            const auto folder = path.parent_path();
            const auto id = utf8(path.stem());
            if ((folder != Path(projectDir) / "installed" && folder != Path(projectDir) / "mosaic-installed" &&
                 folder != Path(projectDir) / "composed-installed") ||
                path.extension() != ".bin" || !hexString(id) || id.size() > 16 ||
                !pending.markers.emplace(path, parseDigest(marker, maxImageBytes, true)).second)
                throw Error("RECOVERY_REQUIRED", "旧补丁迁移标记记录无效", key(path));
        }
        return pending;
    }

    std::optional<Json> recoverPending(const Root& output, const Control& control) const {
        if (!pending_) return std::nullopt;
        const auto& pending = *pending_;
        if (output.ids.back() != pending.outputId)
            throw Error("RECOVERY_REQUIRED", "请重新选择上次迁移的成品包目录", pending.outputPath);

        const auto target = output.path / pending.target();
        if (const auto published = openNode(target, true, true);
            published && identity(published, target) == pending.packageDirectoryId) {
            const auto manifest = openSource(target, manifestName);
            if (digest(manifest, target / manifestName).sha != pending.manifestSha)
                throw Error("RECOVERY_REQUIRED", "已发布的旧补丁成品清单已变化", key(target));
            const auto data = parseManifest(readJson(target, manifestName, "INVALID_MANIFEST"), true);
            const auto bytes = packageBytes(target);
            progress(control, "publish", data.files.size(), data.files.size());
            deleteFile(game_.path, journalName);
            return Json{{"packageId", pending.id}, {"packagePath", key(target)}, {"manifestSha256", pending.manifestSha},
                {"files", data.files.size()}, {"bytes", bytes.value()}};
        }

        const auto stage = output.path / pending.stage();
        bool hasStage = false;
        if (const auto staged = openNode(stage, true, true)) {
            if (identity(staged, stage) != pending.packageDirectoryId)
                throw Error("RECOVERY_REQUIRED", "上次迁移的暂存目录已被替换", key(stage));
            hasStage = true;
        }
        for (const auto& [path, expected] : pending.markers) {
            const auto parents = pinParents(game_.path, path);
            if (parents.empty()) sourceChanged(key(path));
            if (fileExists(game_.path, path)) continue;
            const auto retired = game_.path / pending.retired(path);
            const auto source = openNode(retired, false, true, DELETE);
            if (!source || length(source, retired) != expected.bytes || digest(source, retired) != expected)
                sourceChanged(key(path));
            renameHandle(source, game_.path / path, false);
        }
        if (hasStage) removeTree(stage);
        deleteFile(game_.path, journalName);
        return std::nullopt;
    }

    static void cancelled(const Control& control) {
        if (control.cancelled && control.cancelled()) throw Error("CANCELLED", "已取消旧图片补丁迁移");
    }

    static void progress(const Control& control, std::string_view phase, size_t done, size_t count, std::string_view name = {}) {
        cancelled(control);
        if (control.progress) control.progress({phase, done, count, name});
        cancelled(control);
    }

    static std::pair<std::string, std::string> utcTime() {
        SYSTEMTIME utc{};
        GetSystemTime(&utc);
        char date[32]{}, suffix[32]{};
        std::snprintf(date, sizeof(date), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ",
            unsigned(utc.wYear), unsigned(utc.wMonth), unsigned(utc.wDay), unsigned(utc.wHour),
            unsigned(utc.wMinute), unsigned(utc.wSecond), unsigned(utc.wMilliseconds));
        std::snprintf(suffix, sizeof(suffix), "%04u%02u%02uT%02u%02u%02u%03uZ",
            unsigned(utc.wYear), unsigned(utc.wMonth), unsigned(utc.wDay), unsigned(utc.wHour),
            unsigned(utc.wMinute), unsigned(utc.wSecond), unsigned(utc.wMilliseconds));
        return {date, suffix};
    }

    std::string original(const Candidate& entry, const Handle& source) const {
        auto pixels = read(source, game_.path / entry.backup, maxImageBytes);
        const auto [width, height] = RpgImageProject::dimensions(pixels);
        if (entry.row->at("width") != width || entry.row->at("height") != height)
            throw Error("INPUT_STALE", "受管原件尺寸与图片索引不符", entry.name);
        // The cache stores a decoded PNG. Restore needs the original on-disk format.
        return RpgImageProject::imageBytes(*entry.row, std::move(pixels), key_, true);
    }

    static Candidate blocked(Candidate entry, std::string state, std::string detail) {
        entry.state = std::move(state);
        entry.detail = std::move(detail);
        return entry;
    }

    std::optional<Candidate> examine(const Json& row) const {
        Candidate entry;
        entry.row = &row;
        entry.name = row.at("file").get<std::string>();
        entry.id = row.at("id").get<std::string>();
        const auto revision = row.at("sourceHash").get<std::string>();
        if (entry.id.size() > 16 || !hexString(entry.id) || !validRevision(revision))
            throw Error("INVALID_LEGACY_INDEX", "旧图片索引中的编号或版本无效");
        entry.backup = RpgImageProject::originalCache(game_.path, row).lexically_relative(game_.path);
        const auto backup = openSource(game_.path, entry.backup, true);
        const std::array<Path, 3> markPaths{
            RpgImageProject::composedImage(game_.path, entry.id),
            RpgImageProject::installedImage(game_.path, entry.id, false),
            RpgImageProject::installedImage(game_.path, entry.id, true),
        };
        const std::array<const char*, 3> kinds{"composed", "translated", "mosaic"};
        for (size_t i = 0; i < markPaths.size(); ++i) {
            auto path = markPaths[i].lexically_relative(game_.path);
            auto mark = openSource(game_.path, path, true);
            const Digest* expected = nullptr;
            if (!mark && pending_) {
                const auto recorded = pending_->markers.find(path);
                if (recorded != pending_->markers.end()) {
                    path = pending_->retired(path);
                    mark = openSource(game_.path, path, true);
                    expected = &recorded->second;
                }
            }
            if (mark) {
                const auto size = length(mark, game_.path / path);
                auto content = size <= maxImageBytes ? digest(mark, game_.path / path) : Digest{size, {}};
                if (expected && content != *expected) sourceChanged(entry.name);
                entry.markers.push_back({path, kinds[i], std::move(content)});
            }
        }
        if (entry.markers.empty()) {
            if (!backup || retired_.contains(entry.id)) return std::nullopt;
            // A blocked, unmarked image has no identifiable patch kind.
            entry.kind = "translated";
            return blocked(std::move(entry), "unsupported", "缺少受管标记，无法确认来源");
        }
        entry.kind = entry.markers.front().kind;
        try {
            entry.path = relative(entry.name);
            targetPath(game_.path, engine_, row, entry.path, entry.name);
            if (row.value("sourceFile", "") != entry.name)
                return blocked(std::move(entry), "unsupported", "图片索引未指向受支持的游戏文件");
        } catch (const Error& error) {
            return blocked(std::move(entry), "unsupported", error.what());
        }
        if (!backup) return blocked(std::move(entry), "missing-backup", "受管原件缺失，无法迁移");
        auto current = openSource(game_.path, entry.path, true);
        if (!current) return blocked(std::move(entry), "source-mismatch", "游戏图片已不存在");
        const auto bytes = length(current, game_.path / entry.path);
        if (!bytes || bytes > maxImageBytes)
            return blocked(std::move(entry), "unsupported", "游戏图片为空或超出允许大小");
        try {
            const auto raw = original(entry, backup);
            if (raw.size() > maxImageBytes)
                return blocked(std::move(entry), "unsupported", "受管原件超出允许大小");
            entry.before = {raw.size(), hash(raw)};
        } catch (const std::runtime_error&) {
            return blocked(std::move(entry), "unsupported", "受管原件不可用，无法验证原始内容");
        }
        entry.after = digest(current, game_.path / entry.path);
        // Applied state comes only from comparing the game image with its original.
        if (entry.after == entry.before)
            return blocked(std::move(entry), "unsupported", "图片与受管原件一致，当前没有可迁移的补丁内容");
        // Marker bytes establish ownership of the changed image; unrelated edits cannot be adopted.
        if (entry.kind == "composed") {
            if (entry.markers.front().content != entry.after)
                return blocked(std::move(entry), "source-mismatch", "游戏图片内容已变化，无法确认属于旧合成补丁");
        } else {
            const auto owns = [&](const Marker& mark) { return mark.content == entry.after; };
            if (std::count_if(entry.markers.begin(), entry.markers.end(), owns) != 1)
                return blocked(std::move(entry), "source-mismatch", "游戏图片内容已变化或来源不唯一，无法确认所属旧补丁");
            entry.kind = std::find_if(entry.markers.begin(), entry.markers.end(), owns)->kind;
        }
        return blocked(std::move(entry), "migratable", "已核实旧补丁内容和受管原件，可以迁移");
    }

    static void sourceChanged(const std::string& path) {
        throw Error("LEGACY_SOURCE_CHANGED", "旧图片补丁已变化或无法迁移：" + path, path);
    }

public:
    static std::unique_lock<std::recursive_mutex> lockProject(RpgImageProject& project) {
        std::unique_lock lock(project.mutex_, std::try_to_lock);
        if (!lock) throw Error("BUSY", "图片项目正在更新，请稍后重试");
        return lock;
    }

    explicit LegacyMigration(const Root& game)
        : game_(game), engine_(detectEngine(game.path)) {
        const auto index = Path(projectDir) / "project.json";
        if (!fileExists(game.path, index)) return;
        const auto project = readJson(game.path, index, "INVALID_LEGACY_INDEX");
        if (!project.contains("images") || !project.at("images").is_array())
            throw Error("INVALID_LEGACY_INDEX", "旧图片索引缺少图片清单");
        rows_ = project.at("images");
        if (fileExists(game.path, journalName)) pending_ = readPending();
        baseline_ = openSource(game.path, engine_.marker);
        if (engine_.name != "wolf") {
            try {
                key_ = Json::parse(read(baseline_, game.path / engine_.marker)).value("encryptionKey", "");
                baseline_ = openSource(game.path, engine_.marker);
            } catch (const Json::exception&) {
                throw Error("INVALID_LEGACY_INDEX", "无法读取游戏原图密钥");
            }
        }
        for (const auto folder : {"installed", "mosaic-installed", "composed-installed"}) {
            const auto path = Path(projectDir) / folder;
            const auto pins = pinParents(game.path, path / "entry");
            if (pins.empty()) continue;
            const auto dir = game.path / path;
            for (const auto& file : fs::directory_iterator(dir)) {
                const auto name = utf8(file.path().filename());
                const auto tag = name.find(".bin.migrated-");
                if (tag != std::string::npos && tag <= 16 && hexString(name.substr(0, tag)))
                    retired_.insert(name.substr(0, tag));
            }
        }
    }

    Json scan() const {
        Json values = Json::array();
        std::vector<Candidate> candidates;
        for (const auto& row : rows_)
            if (auto item = examine(row)) candidates.push_back(std::move(*item));
        std::sort(candidates.begin(), candidates.end(), [](const auto& a, const auto& b) { return a.name < b.name; });
        size_t count = 0;
        for (const auto& item : candidates) {
            count += item.state == "migratable";
            values.push_back(item.value());
        }
        return {{"entries", std::move(values)}, {"totals", {{"migratable", count}, {"blocked", candidates.size() - count}}}};
    }

    Json migrate(const Root& output, const Json& requested, const Control& control) const;
};

Json LegacyMigration::migrate(const Root& output, const Json& requested, const Control& control) const {
    progress(control, "snapshot", 0, requested.size());
    if (pending_) {
        if (const auto recovered = recoverPending(output, control)) return *recovered;
        return LegacyMigration(game_).migrate(output, requested, control);
    }
    const auto [timestamp, suffix] = utcTime();
    std::map<std::string, const Json*> rows;
    for (const auto& row : rows_) {
        const auto name = row.at("file").get<std::string>();
        if (!rows.emplace(name, &row).second)
            throw Error("INVALID_LEGACY_INDEX", "旧图片索引包含重复路径", name);
    }
    std::vector<Candidate> selected;
    std::set<std::string> ids;
    for (const auto& item : requested) {
        const auto name = item.at("relativePath").get<std::string>();
        cancelled(control);
        const auto row = rows.find(name);
        if (row == rows.end()) sourceChanged(name);
        auto entry = examine(*row->second);
        if (!entry || entry->state != "migratable" || entry->kind != item.at("kind").get_ref<const std::string&>() || !ids.insert(entry->id).second)
            sourceChanged(name);
        selected.push_back(std::move(*entry));
    }
    std::sort(selected.begin(), selected.end(), [](const auto& a, const auto& b) { return a.name < b.name; });

    const auto id = newId();
    const auto transactionId = newId();
    const auto stage = output.path / ("." + id + ".partial");
    const auto target = output.path / ("legacy-" + suffix + "-" + id.substr(0, 8) + ".llmchat-images");
    const auto anchor = digest(baseline_, game_.path / engine_.marker);
    auto marker = fields(anchor);
    marker["relativePath"] = key(engine_.marker);
    Manifest manifest{id, engine_.name, {}, key(engine_.marker), engine_.marker, anchor, {}};
    auto files = Json::array();

    struct Rename {
        Path oldName, newName;
        Handle source;
    };
    std::vector<Rename> marks;
    std::vector<Handle> resources;
    auto journalMarks = Json::array();
    size_t renamed = 0;
    bool journalWritten = false;
    Json result;
    if (!CreateDirectoryW(stage.c_str(), nullptr))
        winError("WRITE_FAILED", "无法创建旧补丁迁移暂存目录", stage, GetLastError());
    try {
        Root staging(stage);
        for (size_t i = 0; i < selected.size(); ++i) {
            const auto& entry = selected[i];
            progress(control, "copy", i, selected.size(), entry.name);
            auto current = openSource(game_.path, entry.path, true);
            auto backup = openSource(game_.path, entry.backup, true);
            if (!current || !backup) sourceChanged(entry.name);
            const auto raw = original(entry, backup);
            if (raw.size() != entry.before.bytes || hash(raw) != entry.before.sha) sourceChanged(entry.name);
            resources.push_back(std::move(current));
            resources.push_back(std::move(backup));
            copy(game_.path, entry.path, stage, Path(payloadDir) / entry.path, entry.after, "LEGACY_SOURCE_CHANGED");
            if (write(stage, Path(backupDir) / entry.path, raw) != entry.before.sha)
                throw Error("WRITE_FAILED", "受管原件备份写入后校验失败", entry.name);

            auto file = fields(entry.after);
            file.update(Json{{"relativePath", entry.name}, {"kind", entry.kind}, {"original", fields(entry.before)},
                {"boxIds", Json::array()}, {"sourceImage", {{"id", entry.id}, {"relativePath", entry.name},
                    {"sourceHash", entry.row->at("sourceHash")}, {"width", entry.row->at("width")},
                    {"height", entry.row->at("height")}, {"layers", Json::array({{{"kind", entry.kind},
                        {"confirmationId", "legacy-migration"}, {"pngSha256", entry.after.sha}}})}}}});
            files.push_back(std::move(file));
            manifest.files.push_back({entry.name, entry.path, entry.kind, entry.before, entry.after});
            for (const auto& mark : entry.markers) {
                const auto pins = pinParents(game_.path, mark.path);
                if (pins.empty()) sourceChanged(entry.name);
                const auto oldName = game_.path / mark.path;
                auto file = openNode(oldName, false, true, DELETE);
                if (!file || length(file, oldName) != mark.content.bytes || digest(file, oldName) != mark.content)
                    sourceChanged(entry.name);
                auto newName = oldName;
                newName += ".migrated-" + suffix;
                marks.push_back({oldName, std::move(newName), std::move(file)});
                auto record = fields(mark.content);
                record["path"] = key(mark.path);
                journalMarks.push_back(std::move(record));
            }
        }

        auto data = Json{{"schemaVersion", 1}, {"packageId", id}, {"engine", engine_.name},
            {"gameRootFingerprint", fingerprint(manifest)}, {"composeRuleVersion", legacyRule},
            {"generatedAt", timestamp}, {"toolVersion", "legacy-migration"},
            {"baseline", {{"algorithm", fingerprintAlgorithm}, {"marker", marker}}},
            {"migration", {{"from", "legacy-patch"}, {"scannedAt", timestamp}}}, {"files", std::move(files)}};
        auto manifestBytes = data.dump(2) + "\n";
        if (manifestBytes.size() > maxMetadataBytes) throw Error("OUTPUT_TOO_LARGE", "成品清单超出允许大小");
        const auto manifestSha = write(stage, manifestName, manifestBytes);
        const auto planData = Json{{"schemaVersion", 1}, {"transactionId", transactionId},
            {"gameRootId", game_.ids.back()}, {"packageRootId", staging.ids.back()}, {"manifest", data}}.dump(2) + "\n";
        if (planData.size() > maxPlanBytes) throw Error("OUTPUT_TOO_LARGE", "备份计划超出允许大小");
        const Plan plan{transactionId, parseManifest(data, true), write(stage, Path(backupDir) / planName, planData), std::nullopt};
        writeAtomic(stage, receiptStage, receiptName, makeReceipt(plan, game_, allFiles(plan.manifest), true), false);
        const auto bytes = packageBytes(stage);
        result = Json{{"packageId", id}, {"packagePath", key(target)}, {"manifestSha256", manifestSha},
            {"files", selected.size()}, {"bytes", bytes.value()}};

        deleteFile(game_.path, journalStage);
        writeAtomic(game_.path, journalStage, journalName, {
            {"schemaVersion", 1}, {"id", id}, {"suffix", suffix}, {"outputId", output.ids.back()},
            {"packageDirectoryId", staging.ids.back()}, {"outputPath", key(output.path)},
            {"manifestSha", manifestSha}, {"markers", std::move(journalMarks)},
        }, false);
        journalWritten = true;
        staging.handles.pop_back();
        const auto source = openNode(stage, true, false, DELETE);
        progress(control, "publish", selected.size(), selected.size());
        for (const auto& mark : marks) {
            renameHandle(mark.source, mark.newName, false);
            ++renamed;
        }
        renameHandle(source, target, false);
    } catch (...) {
        const auto original = std::current_exception();
        std::string failedRollback;
        while (renamed) {
            const auto& mark = marks[--renamed];
            try {
                renameHandle(mark.source, mark.oldName, false);
            } catch (const std::exception&) {
                failedRollback = utf8(mark.newName);
            }
        }
        try {
            if (failedRollback.empty()) {
                removeTree(stage);
                if (journalWritten) deleteFile(game_.path, journalName);
                else deleteFile(game_.path, journalStage);
            }
        } catch (const std::exception&) {
            if (failedRollback.empty()) failedRollback = utf8(stage);
        }
        if (!failedRollback.empty())
            throw Error("RECOVERY_REQUIRED", "旧补丁迁移回滚未能完成，请检查路径", failedRollback);
        std::rethrow_exception(original);
    }
    deleteFile(game_.path, journalName);
    return result;
}

void validateLegacyEntries(const Json& entries) {
    if (!entries.is_array() || entries.empty() || entries.size() > 20000)
        throw Error("INVALID_REQUEST", "请选择 1 至 20000 张旧补丁图片");
    std::set<std::wstring, CaseLess> names;
    for (const auto& entry : entries) {
        if (!entry.is_object() || !entry.contains("relativePath") || !entry.at("relativePath").is_string() ||
            !entry.contains("kind") || !entry.at("kind").is_string() || !imageKind(entry.at("kind").get<std::string>()))
            throw Error("INVALID_REQUEST", "旧补丁条目需要有效的 relativePath 与 kind");
        const auto name = entry.at("relativePath").get<std::string>();
        if (!names.insert(relative(name).native()).second)
            throw Error("INVALID_REQUEST", "旧补丁条目包含重复路径", name);
    }
}

Json scanLegacy(RpgImageProject& project, const Path& gameRoot) {
    return guard([&] {
        const Root game(gameRoot);
        const DirectoryLock gameLock(game.ids.back());
        const auto projectLock = LegacyMigration::lockProject(project);
        return LegacyMigration(game).scan();
    });
}

Json migrateLegacy(RpgImageProject& project, const Path& gameRoot, const Path& outputDir,
    const Json& entries, const Control& control) {
    return guard([&] {
        validateLegacyEntries(entries);
        const Root game(gameRoot);
        const Root output(outputDir);
        separate(game, output);
        const DirectoryLock gameLock(game.ids.back());
        const DirectoryLock outputLock(output.ids.back());
        const auto projectLock = LegacyMigration::lockProject(project);
        return LegacyMigration(game).migrate(output, entries, control);
    });
}

} // namespace gameimageexport::transaction

#else

namespace gameimageexport::transaction {

namespace {
[[noreturn]] void unsupported() { throw Error("UNSUPPORTED_PLATFORM", "成品包事务需要 Windows"); }
}

nlohmann::json apply(const std::filesystem::path&, const std::filesystem::path&, const ApplyControl&) { unsupported(); }
nlohmann::json restore(const std::filesystem::path&, const std::filesystem::path&, const RestoreKinds&, const ApplyControl&) { unsupported(); }
Recovery recover(const std::filesystem::path&, const std::filesystem::path&, const ApplyControl&) { unsupported(); }
void checkApply(const std::filesystem::path&, const std::filesystem::path&) { unsupported(); }
PackageStatus inspect(const std::filesystem::path&, const std::filesystem::path&, const RestoreKinds&) { unsupported(); }
void remove(const std::filesystem::path&) { unsupported(); }
nlohmann::json restoreAndRemove(const std::filesystem::path&, const std::optional<std::filesystem::path>&, const ApplyControl&) { unsupported(); }
std::optional<uint64_t> packageBytes(const std::filesystem::path&) { unsupported(); }
nlohmann::json scanLegacy(RpgImageProject&, const std::filesystem::path&) { unsupported(); }
nlohmann::json migrateLegacy(RpgImageProject&, const std::filesystem::path&, const std::filesystem::path&,
    const nlohmann::json&, const Control&) { unsupported(); }
void validateLegacyEntries(const nlohmann::json&) { unsupported(); }

} // namespace gameimageexport::transaction

#endif
