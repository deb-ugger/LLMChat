#include "GameImageExportTransaction.h"

#ifdef _WIN32
#include "GameImageExportIO.h"

#include <cstddef>
#include <exception>

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
constexpr auto maxPlanBytes = 64ull << 20;

struct Digest {
    uint64_t bytes;
    std::string sha;
    bool operator==(const Digest&) const = default;
};

struct Entry {
    std::string name;
    Path path;
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
};

enum class Receipt { None, Applied, Restored };

std::string key(const Path& name) { return gamefiles::key(name); }

[[noreturn]] void invalidManifest(const std::string& message, std::string detail = {}) {
    throw Error("INVALID_MANIFEST", message, std::move(detail));
}

bool isSha(const std::string& value) { return value.size() == 64 && hexString(value); }

Digest parseDigest(const Json& json, uint64_t limit) {
    if (!json.at("bytes").is_number_unsigned()) invalidManifest("清单字节数无效");
    Digest digest{json.at("bytes").get<uint64_t>(), json.at("sha256").get<std::string>()};
    if (!digest.bytes || digest.bytes > limit || !isSha(digest.sha))
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

void verifyProvenance(const Json& item, const Entry& file) {
    const auto kind = item.at("kind").get<std::string>();
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
        if (!json.at("composeRuleVersion").is_number_integer() || json.at("composeRuleVersion") != 1) throw Error("UNSUPPORTED_COMPOSE_RULE", "合成规则版本不支持");
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
            Entry file{std::move(name), std::move(path), parseDigest(item.at("original"), maxImageBytes),
                parseDigest(item, maxImageBytes)};
            if (file.before == file.after) invalidManifest("成品文件与原件完全相同", file.name);
            if (checkProvenance) {
                if (engine == "wolf" && item.at("sourceImage").contains("archive"))
                    throw Error("WOLF_ARCHIVE_ENTRY_UNSUPPORTED", "清单目标来自 WOLF 封包：" + file.name, file.name);
                verifyProvenance(item, file);
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

Engine validateBaseline(const Path& game, const Manifest& manifest) {
    const auto engine = detectEngine(game);
    if (engine.name != manifest.engine || manifest.markerName != key(engine.marker) ||
        digestFile(game, engine.marker, "BASELINE_MISMATCH", manifest.baseline.bytes) != manifest.baseline)
        throw Error("BASELINE_MISMATCH", "游戏引擎或基准标记与清单不符", manifest.markerName);
    if (fingerprint(manifest) != manifest.fingerprint)
        throw Error("FINGERPRINT_MISMATCH", "清单的游戏根指纹与资源记录不符");
    return engine;
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
    renameHandle(written, root / target, replace);
}

Json planHeader(const Plan& plan, const Root& game) {
    return {{"schemaVersion", 1}, {"packageId", plan.manifest.packageId}, {"transactionId", plan.id},
        {"gameRootId", game.ids.back()}, {"planSha256", plan.sha}};
}

Json fileRecords(const Manifest& manifest) {
    auto files = Json::array();
    for (const auto& file : manifest.files)
        files.push_back({{"relativePath", file.name}, {"backupPath", key(Path(backupDir) / file.path)},
            {"before", fields(file.before)}, {"after", fields(file.after)}});
    return files;
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
        if (!fileExists(package.path, receiptName)) return Receipt::None;
        const auto stored = readJson(package.path, receiptName, "INVALID_RECEIPT", maxPlanBytes);
        const auto expected = planHeader(plan, game);
        for (const auto& field : expected.items())
            if (!stored.contains(field.key()) || stored.at(field.key()) != field.value())
                throw Error("INVALID_RECEIPT", "收据不属于当前成品包或游戏目录");
        if (!stored.contains("files") || stored.at("files") != fileRecords(plan.manifest))
            throw Error("INVALID_RECEIPT", "收据的文件记录与备份计划不符");
        if (stored.value("state", "") == "applied") return Receipt::Applied;
        if (stored.value("state", "") == "restored") return Receipt::Restored;
        throw Error("INVALID_RECEIPT", "收据状态无效");
    }

    void writeReceipt(const Plan& plan, const char* state, bool replace, const ApplyControl& control = {}) const {
        auto value = planHeader(plan, game);
        value["files"] = fileRecords(plan.manifest);
        value["state"] = state;
        writeAtomic(package.path, receiptStage, receiptName, value, replace, control, plan.manifest.files.size());
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
            return {id, parseManifest(json.at("manifest"), false), hash(raw)};
        } catch (const Json::exception& e) {
            throw Error("INVALID_RECEIPT", std::string("备份计划无效：") + e.what());
        }
    }

    Plan prepare(const Json& json, const Manifest& manifest) const {
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
        auto data = Json{{"schemaVersion", 1}, {"transactionId", id}, {"gameRootId", game.ids.back()},
            {"packageRootId", package.ids.back()}, {"manifest", json}}.dump(2) + "\n";
        if (data.size() > maxPlanBytes) throw Error("WRITE_FAILED", "备份计划超出允许大小");
        const auto sha = write(stage, planName, data);
        renameHandle(pin, package.path / backupDir, false);
        return {id, manifest, sha};
    }

    void verifyBackups(const Plan& plan) const {
        for (const auto& file : plan.manifest.files) {
            const auto path = Path(backupDir) / file.path;
            if (digestFile(package.path, path, "BACKUP_MISSING", maxImageBytes) != file.before)
                throw Error("BACKUP_CORRUPT", "原件备份已变化：" + file.name, file.name);
        }
    }

    std::vector<bool> targets(const Manifest& manifest, Receipt want, bool allowMixed, bool checkAccess) const {
        const auto engine = validateBaseline(game.path, manifest);
        std::set<std::string> ids;
        std::vector<bool> applied;
        for (const auto& file : manifest.files) {
            targetPath(game.path, engine, Json::object(), file.path, file.name);
            auto handle = openSource(game.path, file.path, true);
            if (!handle || length(handle, game.path / file.path) > maxImageBytes)
                throw Error("TARGET_CHANGED", "游戏目标缺失或大小已变化：" + file.name, file.name);
            if (!ids.insert(identity(handle, game.path / file.path)).second)
                throw Error("INVALID_PATH", "多个目标指向同一游戏文件：" + file.name, file.name);
            const auto current = digest(handle, game.path / file.path);
            const bool after = current == file.after;
            if ((!after && current != file.before) || (!allowMixed && after != (want == Receipt::Applied)))
                throw Error("TARGET_CHANGED", "游戏目标已变化：" + file.name, file.name);
            applied.push_back(after);
            if (checkAccess && after) {
                handle = Handle();
                writable(game.path, file);
            }
        }
        return applied;
    }

    void cleanTemps(const Plan& plan) const {
        for (size_t i = 0; i < plan.manifest.files.size(); ++i)
            deleteFile(game.path, tempName(plan.manifest.files[i], plan.id, i));
    }

    void toOriginal(const Plan& plan, const std::vector<bool>& applied) const {
        cleanTemps(plan);
        for (auto i = plan.manifest.files.size(); i != 0;) {
            const auto& file = plan.manifest.files[--i];
            if (!applied[i]) continue;
            replace(game.path, file, tempName(file, plan.id, i), package.path, Path(backupDir) / file.path,
                file.after, file.before, "BACKUP_CORRUPT");
        }
        targets(plan.manifest, Receipt::Restored, false, false);
    }

    bool hasRestoreIntent(const Plan& plan) const {
        if (!fileExists(package.path, restoreIntent)) return false;
        if (readJson(package.path, restoreIntent, "INVALID_RECEIPT") != planHeader(plan, game))
            throw Error("INVALID_RECEIPT", "恢复标记与备份计划不符");
        return true;
    }

    void cleanPackageTemps() const {
        if (directoryExists(package.path / backupStage)) removeTree(package.path / backupStage);
        deleteFile(package.path, receiptStage);
        deleteFile(package.path, restoreStage);
    }
};

Recovery recoverLocked(const Transaction& tx) {
    const bool hasReceipt = fileExists(tx.package.path, receiptName);
    if (!directoryExists(tx.package.path / backupDir)) {
        if (hasReceipt) throw Error("BACKUP_MISSING", "收据存在，但原件备份目录缺失");
        tx.cleanPackageTemps();
        return Recovery::Clean;
    }
    const auto plan = tx.readPlan();
    const auto receipt = tx.receipt(plan);
    const bool restoring = tx.hasRestoreIntent(plan);
    if (receipt == Receipt::None && restoring)
        throw Error("INVALID_RECEIPT", "恢复标记存在，但应用收据缺失");

    if (restoring || receipt == Receipt::None) {
        tx.verifyBackups(plan);
        const auto applied = tx.targets(plan.manifest, Receipt::Applied, true, true);
        tx.cleanPackageTemps();
        tx.toOriginal(plan, applied);
        if (restoring) {
            tx.writeReceipt(plan, "restored", true);
            deleteFile(tx.package.path, restoreIntent);
            return Recovery::Restored;
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
    tx.targets(plan.manifest, receipt, false, false);
    tx.cleanTemps(plan);
    tx.cleanPackageTemps();
    return receipt == Receipt::Applied ? Recovery::Applied : Recovery::Restored;
}

void applyLocked(const Transaction& tx, const ApplyControl& control) {
    if (fileExists(tx.package.path, receiptName))
        throw Error("ALREADY_APPLIED", "这个成品包已使用过，请勿重复应用");
    if (directoryExists(tx.package.path / backupDir) || directoryExists(tx.package.path / backupStage) ||
        fileExists(tx.package.path, receiptStage) || fileExists(tx.package.path, restoreIntent) ||
        fileExists(tx.package.path, restoreStage))
        throw Error("RECOVERY_REQUIRED", "成品包有未完成的事务，请先恢复");

    const auto json = readJson(tx.package.path, manifestName, "INVALID_MANIFEST");
    const auto manifest = parseManifest(json, true);
    payloadMembership(tx.package.path, manifest);
    tx.targets(manifest, Receipt::None, false, false);
    for (const auto& file : manifest.files) {
        if (digestFile(tx.package.path, Path(payloadDir) / file.path, "PAYLOAD_HASH_MISMATCH", maxImageBytes) != file.after)
            throw Error("PAYLOAD_HASH_MISMATCH", "成品文件 SHA-256 或大小与清单不符：" + file.name, file.name);
    }
    for (const auto& file : manifest.files) writable(tx.game.path, file);

    try {
        const auto plan = tx.prepare(json, manifest);
        for (size_t i = 0; i < manifest.files.size(); ++i) {
            checkpoint(control, ApplyPhase::BeforeReplace, i);
            const auto& file = manifest.files[i];
            replace(tx.game.path, file, tempName(file, plan.id, i), tx.package.path, Path(payloadDir) / file.path,
                file.before, file.after, "PAYLOAD_HASH_MISMATCH");
        }
        tx.targets(manifest, Receipt::Applied, false, false);
        checkpoint(control, ApplyPhase::BeforeReceipt, manifest.files.size());
        try {
            tx.writeReceipt(plan, "applied", false, control);
        } catch (const std::exception& error) {
            throw Error("RECEIPT_WRITE_FAILED", std::string("写入最终收据失败：") + error.what());
        }
    } catch (...) {
        const auto original = std::current_exception();
        try {
            recoverLocked(tx);
        } catch (const std::exception& rollback) {
            throw Error("RECOVERY_REQUIRED", std::string("未能自动回滚，请恢复事务：") + rollback.what());
        }
        std::rethrow_exception(original);
    }
}

void restoreLocked(const Transaction& tx) {
    if (!fileExists(tx.package.path, receiptName))
        throw Error("INVALID_RECEIPT", "没有已应用的收据，若应用异常中断请先恢复事务");
    const auto plan = tx.readPlan();
    const auto receipt = tx.receipt(plan);
    if (tx.hasRestoreIntent(plan)) {
        recoverLocked(tx);
        return;
    }
    tx.verifyBackups(plan);
    const auto applied = tx.targets(plan.manifest, receipt, false, receipt == Receipt::Applied);
    if (receipt == Receipt::Restored) return;

    writeAtomic(tx.package.path, restoreStage, restoreIntent, planHeader(plan, tx.game), false);
    tx.toOriginal(plan, applied);
    tx.writeReceipt(plan, "restored", true);
    deleteFile(tx.package.path, restoreIntent);
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

void apply(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot,
    const ApplyControl& control) {
    guard([&] { applyLocked(Transaction(packageDir, gameRoot), control); });
}

void restore(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot) {
    guard([&] { restoreLocked(Transaction(packageDir, gameRoot)); });
}

Recovery recover(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot) {
    return guard([&] { return recoverLocked(Transaction(packageDir, gameRoot)); });
}


void checkApply(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot) {
    guard([&] {
        const Transaction tx(packageDir, gameRoot);
        if (fileExists(tx.package.path, receiptName))
            throw Error("ALREADY_APPLIED", "这个成品包已使用过，请勿重复应用");
        if (directoryExists(tx.package.path / backupDir) || directoryExists(tx.package.path / backupStage) ||
            fileExists(tx.package.path, receiptStage) || fileExists(tx.package.path, restoreIntent) ||
            fileExists(tx.package.path, restoreStage))
            throw Error("RECOVERY_REQUIRED", "成品包有未完成的事务，请先恢复");
        const auto manifest = parseManifest(readJson(tx.package.path, manifestName, "INVALID_MANIFEST"), true);
        payloadMembership(tx.package.path, manifest);
        tx.targets(manifest, Receipt::None, false, false);
        for (const auto& file : manifest.files) writable(tx.game.path, file);
    });
}

PackageStatus inspect(const std::filesystem::path& packageDir, const std::filesystem::path& gameRoot) {
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
            result.applied = result.receipt.value("state", "") == "applied";
        }
        try {
            const auto plan = tx.readPlan();
            const auto receipt = tx.receipt(plan);
            const auto restoring = tx.hasRestoreIntent(plan);
            if (restoring && !hasReceipt)
                throw Error("INVALID_RECEIPT", "恢复标记存在，但应用收据缺失");
            tx.verifyBackups(plan);
            tx.targets(plan.manifest, hasReceipt ? receipt : Receipt::Applied, restoring || !hasReceipt,
                receipt != Receipt::Restored);
            result.canRestore = receipt == Receipt::Applied || !hasReceipt || restoring;
            if (!hasReceipt) {
                result.rollbackReceipt = planHeader(plan, tx.game);
                result.rollbackReceipt["files"] = fileRecords(plan.manifest);
                result.rollbackReceipt["state"] = "restored";
            }
        } catch (const Error& error) {
            result.restoreError.emplace(error.code, error.what(), error.detail);
        }
        return result;
    });
}

void remove(const std::filesystem::path& packageDir) {
    guard([&] {
        Root package(packageDir);
        const DirectoryLock lock(package.ids.back());
        if (package.path.extension() != L".llmchat-images")
            throw Error("INVALID_PATH", "仅可删除成品包目录", utf8(package.path));
        const auto manifest = parseManifest(readJson(package.path, manifestName, "INVALID_MANIFEST"), true);
        if (directoryExists(package.path / backupStage) || fileExists(package.path, restoreIntent) ||
            fileExists(package.path, receiptStage) || fileExists(package.path, restoreStage))
            throw Error("RECOVERY_REQUIRED", "成品包有未完成的事务，请先恢复");
        const bool hasBackup = directoryExists(package.path / backupDir);
        const bool hasReceipt = fileExists(package.path, receiptName);
        if (hasBackup || hasReceipt) {
            if (!hasReceipt) throw Error("RECOVERY_REQUIRED", "成品包有未完成的应用，请先恢复");
            const auto receipt = readJson(package.path, receiptName, "INVALID_RECEIPT", maxPlanBytes);
            if (receipt.at("packageId") != manifest.packageId || receipt.at("schemaVersion") != 1)
                throw Error("INVALID_RECEIPT", "收据不属于此成品包");
            if (receipt.at("state") != "restored")
                throw Error("PACKAGE_IN_USE", "成品仍已应用，请先恢复原件再清理");
            const auto planFile = Path(backupDir) / planName;
            const auto plan = digestFile(package.path, planFile, "BACKUP_MISSING", maxPlanBytes);
            if (receipt.at("planSha256") != plan.sha)
                throw Error("INVALID_RECEIPT", "收据的备份计划校验失败");
        }
        auto inspect = [](const Path& name) { relative(key(name)); };
        walk(package.path, {}, inspect);
        package.handles.pop_back();
        removeTree(package.path);
    });
}

} // namespace gameimageexport::transaction

#else

namespace gameimageexport::transaction {

namespace {
[[noreturn]] void unsupported() { throw Error("UNSUPPORTED_PLATFORM", "成品包事务需要 Windows"); }
}

void apply(const std::filesystem::path&, const std::filesystem::path&, const ApplyControl&) { unsupported(); }
void restore(const std::filesystem::path&, const std::filesystem::path&) { unsupported(); }
Recovery recover(const std::filesystem::path&, const std::filesystem::path&) { unsupported(); }
void checkApply(const std::filesystem::path&, const std::filesystem::path&) { unsupported(); }
PackageStatus inspect(const std::filesystem::path&, const std::filesystem::path&) { unsupported(); }
void remove(const std::filesystem::path&) { unsupported(); }

} // namespace gameimageexport::transaction

#endif
