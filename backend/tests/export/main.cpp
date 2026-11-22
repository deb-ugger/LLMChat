#include "GameImageExportPackage.h"
#include "GameImageExportTransaction.h"
#include "GameMosaicPatch.h"
#include "RpgImageProject.h"

#include <iostream>
#include <map>
#include <system_error>
#include <winioctl.h>
#include <aclapi.h>

namespace {
namespace fs = std::filesystem;
using Json = nlohmann::json;
using namespace gameimageexport;

const std::string key = "00112233445566778899aabbccddeeff";
const std::string translationId = "17d00a7f-c773-46f1-9123-579012ed6dc1";
const std::string mosaicId = "8076a612-0dbd-4676-9e93-16c4bde49fc0";

void check(bool value, const std::string& message) {
    if (!value) throw std::runtime_error(message);
}

std::string sha(const fs::path& file) { return mosaic::fingerprint(file); }

std::string shaBytes(const fs::path& scratch, const std::string& bytes) {
    const auto path = scratch / "hash-input";
    gamefiles::write(path, bytes);
    auto result = sha(path);
    fs::remove(path);
    return result;
}

std::string stamp(const fs::path& file) {
    return std::to_string(fs::file_size(file)) + "-" + std::to_string(fs::last_write_time(file).time_since_epoch().count());
}

using Colors = std::vector<unsigned char>;
const Colors original{1,2,3,255, 8,9,10,255, 0,0,0,0};
const Colors translation{4,5,6,255, 8,9,10,255, 90,91,92,0};
const Colors repaired{16,17,18,255, 24,25,26,255, 32,33,34,255};
const Colors combined{4,5,6,255, 24,25,26,255, 32,33,34,255};

std::string png(Colors colors) {
    rpgimagecompose::Pixels pixels{3, 1, std::move(colors)};
    return rpgimagecompose::PngCodec{}.write(pixels);
}

// Fixture generator and decoder independent of the private RPG codec.
std::string rpgBytes(std::string bytes, bool read) {
    const std::string header("RPGMV\0\0\0\0\3\1\0\0\0\0\0", 16);
    if (read) {
        check(bytes.starts_with(header), "encrypted payload header");
        bytes.erase(0, header.size());
    }
    for (size_t i = 0; i < 16; ++i) bytes[i] ^= static_cast<char>(i * 17);
    if (!read) bytes.insert(0, header);
    return bytes;
}

struct Fixture {
    fs::path root, game, output, project, marker, imageRoot;
    bool encrypted;
    Json rows = Json::array();
    Request request;

    Fixture(const fs::path& temp, std::string engine)
        : root(temp), game(root / "Game"), output(root / "Output"), project(game / "LLMChat-JSON/images"),
          encrypted(engine != "wolf"), request{game, output, "1.2.3", {}} {
        fs::create_directories(output);
        fs::create_directories(project);
        if (engine == "wolf") {
            marker = "Data/BasicData/Game.dat";
            imageRoot = "Data/Picture";
        } else if (engine == "rpg-maker-mv") {
            marker = "www/data/System.json";
            imageRoot = "www/img/pictures";
        } else {
            marker = "data/System.json";
            imageRoot = "img/pictures";
            gamefiles::write(game / "js/rmmz_core.js", "fixture");
        }
        gamefiles::write(game / marker, encrypted ? Json{{"encryptionKey", key}}.dump() : "WOLF fixture");
    }

    std::string add(bool translated, bool mosaicked) {
        const auto id = std::to_string(rows.size() + 1);
        const auto suffix = imageRoot == "www/img/pictures" ? ".rpgmvp" : encrypted ? ".png_" : ".png";
        const auto path = imageRoot / ("image" + id + suffix);
        const auto name = gamefiles::key(path);
        const auto bytes = png(original);
        gamefiles::write(game / path, encrypted ? rpgBytes(bytes, false) : bytes);
        const auto source = stamp(game / path);
        Json row{{"id", id}, {"file", name}, {"sourceFile", name}, {"sourceHash", source}, {"encrypted", encrypted},
            {"width", 3}, {"height", 1}, {"selected", translated}, {"completed", translated}};
        ImageSelection image{id, source, {}, {}};

        if (translated) {
            const auto output = project / "rendered" / (id + ".png");
            gamefiles::write(output, png(translation));
            const auto version = stamp(output);
            row.update(Json{{"renderedFile", "rendered/" + id + ".png"}, {"renderedHash", version},
                {"renderedKind", "generated"}, {"renderedTarget", "zh-CN"}});
            confirm(id, "translation", source, translationId, version, sha(output),
                Json::array({{{"id", "t1"}, {"role", "translate"}, {"rect", {0, 0, 1, 1}}}}));
            image.translation = LayerSelection{translationId, version};
        }
        if (mosaicked) {
            const auto output = project / "mosaic" / (id + "-" + source + ".png");
            gamefiles::write(output, png(repaired));
            const auto digest = sha(output);
            confirm(id, "mosaic", source, mosaicId, digest, digest,
                Json::array({{{"id", "m1"}, {"role", "repair"}, {"rect", {0, 0, 3, 1}}},
                    {{"id", "p1"}, {"role", "protect"}, {"rect", {0, 0, 1, 1}}}}));
            image.mosaic = LayerSelection{mosaicId, digest};
        }
        rows.push_back(row);
        request.images.push_back(image);
        return name;
    }

    void confirm(const std::string& id, const std::string& layer, const std::string& source,
        const std::string& confirmationId, const std::string& version, const std::string& digest, const Json& boxes) {
        gamefiles::write(project / "export-inputs" / id / (layer + ".json"),
            Json{{"imageId", id}, {"sourceHash", source}, {"confirmationId", confirmationId},
                {"layer", layer}, {"candidateVersion", version}, {"pngSha256", digest}, {"groupId", "scene-03"},
                {"maskMode", "boxes"}, {"boxes", boxes}}.dump());
    }

    void save() { gamefiles::write(project / "project.json", Json{{"images", rows}}.dump()); }
};

struct ReadOnly {
    std::vector<HANDLE> handles;

    explicit ReadOnly(const fs::path& root) {
        try {
            for (const auto& entry : fs::recursive_directory_iterator(root)) {
                if (!entry.is_regular_file()) continue;
                const auto handle = CreateFileW(entry.path().c_str(), GENERIC_READ, FILE_SHARE_READ,
                    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
                check(handle != INVALID_HANDLE_VALUE, "open fixture with read-only share");
                handles.push_back(handle);
                const auto write = CreateFileW(entry.path().c_str(), GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE,
                    nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
                if (write != INVALID_HANDLE_VALUE) CloseHandle(write);
                check(write == INVALID_HANDLE_VALUE, "fixture write handle denied");
            }
        } catch (...) {
            for (auto handle : handles) CloseHandle(handle);
            throw;
        }
    }

    ~ReadOnly() { for (auto handle : handles) CloseHandle(handle); }
};

using Tree = std::map<std::string, Json>;

Tree snapshot(const fs::path& root) {
    Tree result;
    for (const auto& entry : fs::recursive_directory_iterator(root)) {
        const auto path = entry.path();
        const auto handle = CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        check(handle != INVALID_HANDLE_VALUE, "read fixture metadata");
        BY_HANDLE_FILE_INFORMATION i{};
        const auto ok = GetFileInformationByHandle(handle, &i);
        CloseHandle(handle);
        check(ok != 0, "read fixture file identity");
        Json meta{{"attributes", i.dwFileAttributes}, {"fileId", {i.dwVolumeSerialNumber, i.nFileIndexHigh, i.nFileIndexLow}},
            {"links", i.nNumberOfLinks}, {"creation", {i.ftCreationTime.dwHighDateTime, i.ftCreationTime.dwLowDateTime}},
            {"lastWrite", {i.ftLastWriteTime.dwHighDateTime, i.ftLastWriteTime.dwLowDateTime}}};
        if (entry.is_regular_file()) {
            meta["bytes"] = entry.file_size();
            meta["sha256"] = sha(path);
        }
        result.emplace(gamefiles::key(path.lexically_relative(root)), std::move(meta));
    }
    return result;
}

void validate(const Fixture& f, const Result& result, const std::map<std::string, std::pair<std::string, Colors>>& expected) {
    const auto manifest = result.packagePath / "manifest.json";
    const auto j = Json::parse(gamefiles::read(manifest));
    check(result.manifestSha256 == sha(manifest), "manifest SHA-256");
    check(j.at("schemaVersion") == 1 && j.at("composeRuleVersion") == 1 && j.at("packageId") == result.packageId &&
        j.at("toolVersion") == "1.2.3", "manifest versions");
    check(j.at("files").size() == expected.size() && result.files == expected.size() && result.skipped == 0, "file count");
    check(fs::is_empty(result.packagePath / "receipts"), "empty receipts");
    check(std::distance(fs::directory_iterator(result.packagePath), fs::directory_iterator()) == 3, "exact package layout");
    const auto marker = j.at("baseline").at("marker");
    const auto markerName = gamefiles::key(f.marker);
    check(marker.at("relativePath") == markerName && marker.at("sha256") == sha(f.game / f.marker) &&
        marker.at("bytes") == fs::file_size(f.game / f.marker), "baseline marker");
    std::vector<std::string> fields{"llmchat-game-image-baseline-v1", j.at("engine").get<std::string>(), "marker", markerName,
        std::to_string(fs::file_size(f.game / f.marker)), sha(f.game / f.marker)};
    for (const auto& [name, value] : expected) {
        const auto& [kind, colors] = value;
        const auto index = std::distance(expected.begin(), expected.find(name));
        const auto& file = j.at("files").at(index);
        check(file.at("relativePath") == name && file.at("kind") == kind, "sorted targets and layer kind");
        const auto out = result.packagePath / "payload" / utf8path::pathFromUtf8(name);
        const auto raw = f.game / utf8path::pathFromUtf8(name);
        check(file.at("sha256") == sha(out) && file.at("bytes") == fs::file_size(out), "per-file payload SHA-256 and length");
        check(file.at("original").at("sha256") == sha(raw) && file.at("original").at("bytes") == fs::file_size(raw),
            "per-file original SHA-256 and length");
        check(file.at("sourceImage").at("relativePath") == name, "sourceImage provenance");
        Json ids = Json::array();
        for (const auto& layer : file.at("sourceImage").at("layers"))
            for (const auto& box : layer.at("boxes")) ids.push_back(box.at("id"));
        check(ids == file.at("boxIds"), "box references");
        auto bytes = gamefiles::read(out);
        if (f.encrypted) bytes = rpgBytes(std::move(bytes), true);
        check(rpgimagecompose::PngCodec{}.read(bytes).bytes == colors, "expected decoded BGRA pixels");
        fields.insert(fields.end(), {"file", name, std::to_string(fs::file_size(raw)), sha(raw)});
        std::cout << "  " << name << " " << kind << " SHA-256=" << sha(out) << '\n';
    }
    std::string byteFields;
    for (const auto& field : fields) { byteFields += field; byteFields += '\0'; }
    check(j.at("gameRootFingerprint") == shaBytes(f.root, byteFields), "fingerprint");
}

void successes(const fs::path& scratch) {
    for (const std::string engine : {"rpg-maker-mv", "rpg-maker-mz", "wolf"}) {
        Fixture f(scratch / engine, engine);
        const auto name = f.add(true, true);
        const auto single = f.add(engine == "rpg-maker-mz", engine != "rpg-maker-mz");
        if (engine == "rpg-maker-mz") {
            const auto db = f.root / "sqlite-source";
            GameImageStateStore writer(db);
            writer.save(f.rows);
            for (const auto file : {"state.sqlite3", "state.sqlite3-wal"})
                fs::copy_file(db / file, f.project / file);
            f.rows[0]["selected"] = false;
            f.rows[1]["completed"] = false;
        }
        if (engine == "wolf") {
            // The mosaic-only test has no selection flag. Legacy state still
            // has to override the stale source fields in the scan index.
            gamefiles::write(f.project / "state/1.json", f.rows[0].dump());
            f.rows[0]["selected"] = false;
        }
        f.save();
        const auto before = snapshot(f.game);
        RpgImageProject project;
        const ReadOnly readOnly(f.game);
        const auto package = generate(project, f.request);
        const auto j = Json::parse(gamefiles::read(package.packagePath / "manifest.json"));
        check(j.at("engine") == engine, "engine identity");
        validate(f, package, {{name, {"composed", combined}},
            {single, {engine == "rpg-maker-mz" ? "translated" : "mosaic", engine == "rpg-maker-mz" ? translation : repaired}}});
        check(before == snapshot(f.game), "read-only fixture tree unchanged");
        std::cout << "PASS A/B: " << engine << " pixels, manifest, fixture tree and read-only handles\n";
    }
}

void reject(Fixture& f, std::string_view code, const std::string& label, const Control& control = {},
    size_t remaining = 0) {
    RpgImageProject project;
    try {
        generate(project, f.request, control);
        throw std::runtime_error(label + ": unexpectedly generated");
    } catch (const Error& error) {
        check(error.code == code, label + ": expected " + std::string(code) + ", got " + error.code + ": " + error.what());
        check(std::strlen(error.what()) > 0, label + ": missing message");
        std::cout << "PASS " << label << ": " << error.code << " " << error.what() << '\n';
    }
    check(static_cast<size_t>(std::distance(fs::directory_iterator(f.output), fs::directory_iterator())) == remaining,
        label + ": unexpected content in output");
}

fs::path partial(const fs::path& output) {
    for (const auto& item : fs::directory_iterator(output))
        if (item.path().extension() == ".partial") return item.path();
    throw std::runtime_error("unable to locate staging in test");
}

void failures(const fs::path& scratch) {
    Fixture f(scratch / "failure", "wolf");
    f.add(true, false);
    f.add(true, false);
    f.save();
    const auto before = snapshot(f.game);
    const auto staleId = "c08020ce-7ea5-4e4a-9ec1-d46189a0f664";
    const auto stale = f.output / (std::string(".") + staleId + ".partial");
    fs::create_directory(stale);
    gamefiles::write(stale / "manifest.json", "abandoned staging");
    gamefiles::write(f.output / (std::string(".") + staleId + ".export-owner"),
        std::string("llmchat-game-image-export-v1:") + staleId);
    reject(f, "OUTPUT_WRITE_FAILED", "C second payload write", {{}, [&](const Progress& progress) {
        if (progress.phase == "compose" && progress.completed == 1)
            fs::create_directories(partial(f.output) / "payload" / utf8path::pathFromUtf8(std::string(progress.relativePath)));
    }});
    bool cancel = false;
    reject(f, "CANCELLED", "C cancel before publish", {[&] { return cancel; }, [&](const Progress& progress) {
        if (progress.phase == "publish") cancel = true;
    }});
    fs::path blocked;
    reject(f, "OUTPUT_EXISTS", "C target collision", {{}, [&](const Progress& progress) {
        if (progress.phase != "publish") return;
        const auto m = Json::parse(gamefiles::read(partial(f.output) / "manifest.json"));
        auto timestamp = m.at("generatedAt").get<std::string>();
        std::erase_if(timestamp, [](char c) { return c == '-' || c == ':'; });
        blocked = f.output / ("Game-" + timestamp + "-" + m.at("packageId").get<std::string>().substr(0, 8) + ".llmchat-images");
        fs::create_directory(blocked);
        gamefiles::write(blocked / "untouched", "existing");
    }}, 1);
    check(gamefiles::read(blocked / "untouched") == "existing", "published collision not overwritten");
    check(before == snapshot(f.game), "stopped operations kept source tree unchanged");
}

void junction(const fs::path& link, const fs::path& target) {
    fs::create_directory(link);
    const auto to = L"\\??\\" + target.native();
    struct {
        DWORD tag = IO_REPARSE_TAG_MOUNT_POINT;
        WORD size = 0, reserved = 0, substituteOffset = 0, substituteLength = 0, printOffset = 0, printLength = 0;
        wchar_t characters[1024]{};
    } data;
    const auto bytes = to.size() * sizeof(wchar_t);
    check(to.size() + 2 < std::size(data.characters), "fixture junction path fits");
    data.substituteLength = static_cast<WORD>(bytes);
    data.printOffset = static_cast<WORD>(bytes + sizeof(wchar_t));
    data.size = static_cast<WORD>(8 + bytes + 2 * sizeof(wchar_t));
    std::copy(to.begin(), to.end(), data.characters);
    const auto file = CreateFileW(link.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    check(file != INVALID_HANDLE_VALUE, "open junction fixture");
    DWORD returned = 0;
    const auto success = DeviceIoControl(file, FSCTL_SET_REPARSE_POINT, &data, 8 + data.size, nullptr, 0, &returned, nullptr);
    CloseHandle(file);
    check(success != 0, "create fixture junction, Windows " + std::to_string(GetLastError()));
}

void paths(const fs::path& scratch) {
    Fixture f(scratch / "paths", "wolf");
    const auto valid = f.add(true, false);
    for (const auto& [label, value] : std::map<std::string, std::string>{
        {"absolute", "/Data/Picture/image1.png"}, {"drive", "C:/Data/Picture/image1.png"},
        {"drive-relative", "C:Data/Picture/image1.png"}, {"UNC", "//server/share/image1.png"},
        {"ADS", "Data/Picture/image1.png:more"}, {"backslash", "Data\\Picture\\image1.png"},
        {"parent", "Data/../Picture/image1.png"}, {"dot", "Data/./Picture/image1.png"},
        {"empty-segment", "Data//Picture/image1.png"}, {"control", "Data/Picture/abc\n.png"},
        {"NUL", std::string("Data/Picture/a\0b.png", 20)}, {"illegal", "Data/Picture/a?.png"},
        {"device", "Data/Picture/COM1.png"}, {"dos-superscript-device", "Data/Picture/LPT¹.png"},
        {"trailing-space", "Data/Picture /image1.png"}, {"trailing-dot", "Data/Picture./image1.png"},
        {"outside-image-root", "other/Picture/image1.png"}, {"unsupported-extension", "Data/Picture/image1.jpg"}}) {
        f.rows[0]["file"] = value;
        f.rows[0]["sourceFile"] = value;
        f.save();
        reject(f, "INVALID_PATH", "D " + label);
    }
    f.rows[0]["file"] = f.rows[0]["sourceFile"] = valid;
    const auto other = f.add(false, true);
    auto upper = valid;
    upper[0] = 'd';
    f.rows[1]["file"] = f.rows[1]["sourceFile"] = upper;
    f.save();
    reject(f, "INVALID_PATH", "D Windows case alias");
    f.rows[1]["file"] = f.rows[1]["sourceFile"] = other;

    const auto target = f.game / utf8path::pathFromUtf8(valid);
    check(CreateHardLinkW((f.game / "hardlink.png").c_str(), target.c_str(), nullptr) != 0, "create fixture hard link");
    f.save();
    reject(f, "INVALID_PATH", "D hard link");
    fs::remove(f.game / "hardlink.png");

    junction(f.game / "Data/Linked", f.game / "Data/Picture");
    f.rows[0]["file"] = f.rows[0]["sourceFile"] = "Data/Linked/image1.png";
    f.save();
    reject(f, "INVALID_PATH", "D reparse junction within target path");
    check(RemoveDirectoryW((f.game / "Data/Linked").c_str()) != 0, "remove fixture junction");
    f.rows[0]["file"] = f.rows[0]["sourceFile"] = valid;
    f.save();
    const auto outAlias = f.root / "LinkedOutput";
    junction(outAlias, f.output);
    f.request.outputDir = outAlias;
    reject(f, "INVALID_PATH", "D reparse output root");
    check(RemoveDirectoryW(outAlias.c_str()) != 0, "remove output junction");
    f.request.outputDir = f.output;

    gamefiles::write(f.game / "Data/Picture.wolf", "opaque sealed archive");
    reject(f, "WOLF_ARCHIVE_ENTRY_UNSUPPORTED", "E WOLF archive overlay");
    fs::remove(f.game / "Data/Picture.wolf");
    f.rows[0]["archive"] = "Data/Picture.wolf";
    f.save();
    reject(f, "WOLF_ARCHIVE_ENTRY_UNSUPPORTED", "E archive-backed row");
}

void warmProject(const fs::path& scratch) {
    Fixture f(scratch / "warm-project", "wolf");
    const auto name = f.add(true, true);
    f.save();
    RpgImageProject project;
    project.load(f.game);
    const auto before = snapshot(f.game);
    bool checked = false;
    const auto package = generate(project, f.request, {{}, [&](const Progress& progress) {
        if (progress.phase != "compose") return;
        try {
            generate(project, f.request);
            throw std::runtime_error("reentrant export acquired the same directory");
        } catch (const Error& error) {
            check(error.code == "BUSY", "simultaneous export must return BUSY");
            checked = true;
        }
    }});
    validate(f, package, {{name, {"composed", combined}}});
    check(checked && before == snapshot(f.game), "warm cache and concurrent export did not write project state");
    std::cout << "PASS warm project and same-root concurrency\n";
}

void confirmation(const fs::path& scratch) {
    Fixture f(scratch / "confirmation", "wolf");
    f.add(true, true);
    f.save();
    const auto candidate = f.project / "rendered/1.png";
    const auto bytes = gamefiles::read(candidate);
    const auto time = fs::last_write_time(candidate);
    auto damaged = bytes;
    damaged.back() ^= 1;
    gamefiles::write(candidate, damaged);
    fs::last_write_time(candidate, time);
    reject(f, "INPUT_STALE", "confirmation SHA with same size and timestamp");
    gamefiles::write(candidate, bytes);
    fs::last_write_time(candidate, time);
    fs::remove(f.project / "export-inputs/1/mosaic.json");
    reject(f, "CONFIRMATION_REQUIRED", "missing mosaic confirmation");
}

namespace tx = gameimageexport::transaction;

using FileTree = std::map<std::string, std::string>;

FileTree fileTree(const fs::path& root) {
    FileTree files;
    for (const auto& entry : fs::recursive_directory_iterator(root)) {
        const auto name = gamefiles::key(entry.path().lexically_relative(root));
        files[name] = entry.is_directory() ? "directory" : sha(entry.path());
    }
    return files;
}

struct Exported {
    Fixture fixture;
    fs::path dir;
    FileTree original;
    FileTree installed;

    Exported(const fs::path& path, const std::string& engine) : fixture(path, engine) {
        fixture.add(true, true);
        fixture.add(false, true);
        fixture.save();
        original = fileTree(game());
        RpgImageProject project;
        dir = generate(project, fixture.request).packagePath;
        installed = original;
        for (const auto& file : manifest().at("files").get<std::vector<Json>>()) {
            const auto name = file.at("relativePath").get<std::string>();
            const auto payload = dir / "payload" / utf8path::pathFromUtf8(name);
            check(file.at("sha256") == sha(payload), "exported payload SHA-256");
            installed[name] = sha(payload);
        }
    }

    const fs::path& game() const { return fixture.game; }
    Json manifest() const { return Json::parse(gamefiles::read(dir / "manifest.json")); }
    void manifest(const Json& value) const { gamefiles::write(dir / "manifest.json", value.dump()); }

    fs::path backup() const { return dir / "receipts/backup"; }
    void noPartials() const {
        for (const auto& root : {game(), dir})
            for (const auto& entry : fs::recursive_directory_iterator(root))
                check(entry.path().extension() != ".partial", "unexpected partial: " + entry.path().string());
    }
};

template<class Operation>
void requireError(std::string_view code, std::string label, Operation operation) {
    try {
        operation();
        throw std::runtime_error(label + ": unexpectedly succeeded");
    } catch (const Error& e) {
        check(e.code == code, label + ": expected " + std::string(code) + ", got " + e.code + ": " + e.what());
        check(std::strlen(e.what()) > 0, label + ": empty error");
        std::cout << "PASS " << label << ": " << e.code << '\n';
    }
}

void normalTransactions(const fs::path& scratch) {
    for (const std::string engine : {"rpg-maker-mv", "rpg-maker-mz", "wolf"}) {
        Exported data(scratch / ("txn-" + engine), engine);
        tx::apply(data.dir, data.game());
        check(fileTree(data.game()) == data.installed, "A installed tree: " + engine);
        check(tx::recover(data.dir, data.game()) == tx::Recovery::Applied, "applied receipt checkpoint");
        data.noPartials();
        std::cout << "PASS T072 A " << engine << " target payload hashes and non-target tree\n";
        requireError("ALREADY_APPLIED", "T072 B repeat apply", [&] { tx::apply(data.dir, data.game()); });
        check(fileTree(data.game()) == data.installed, "B repeated apply unchanged");
        requireError("PACKAGE_IN_USE", "T072 remove active package", [&] { tx::remove(data.dir); });

        const auto first = data.manifest().at("files").at(0).at("relativePath").get<std::string>();
        const auto backup = data.backup() / utf8path::pathFromUtf8(first);
        const auto original = gamefiles::read(backup);
        check(sha(backup) == data.original.at(first), "backup hash");
        fs::remove(backup);
        requireError("BACKUP_MISSING", "T072 E missing backup", [&] { tx::restore(data.dir, data.game()); });
        check(fileTree(data.game()) == data.installed, "missing backup left game unchanged");
        gamefiles::write(backup, original);
        tx::restore(data.dir, data.game());
        check(fileTree(data.game()) == data.original, "E restored game tree");
        tx::restore(data.dir, data.game());
        check(fileTree(data.game()) == data.original, "E repeated restore unchanged");
        check(tx::recover(data.dir, data.game()) == tx::Recovery::Restored, "restored receipt checkpoint");
        data.noPartials();
        std::cout << "PASS T072 E restored and repeated restore " << engine << '\n';
        const auto sibling = data.dir.parent_path() / "keep";
        gamefiles::write(sibling, "sentinel");
        tx::remove(data.dir);
        check(!fs::exists(data.dir) && gamefiles::read(sibling) == "sentinel" && fileTree(data.game()) == data.original,
            "safe package deletion");
    }
}

void transactionManifestErrors(const fs::path& scratch) {
    Exported data(scratch / "txn-manifest", "wolf");
    const auto original = data.manifest();
    using Mutation = std::function<void(Json&)>;
    const std::vector<std::tuple<std::string, std::string, Mutation>> cases{
        {"schema", "UNSUPPORTED_SCHEMA", [](Json& j) { j["schemaVersion"] = 2; }},
        {"compose version", "UNSUPPORTED_COMPOSE_RULE", [](Json& j) { j["composeRuleVersion"] = 2; }},
        {"baseline sha", "BASELINE_MISMATCH", [](Json& j) { j["baseline"]["marker"]["sha256"] = std::string(64, 'a'); }},
        {"payload sha", "PAYLOAD_HASH_MISMATCH", [](Json& j) { j["files"][1]["sha256"] = std::string(64, 'b'); }},
        {"delete item", "PAYLOAD_LIST_MISMATCH", [](Json& j) { j["files"].erase(1); }},
        {"add item", "PAYLOAD_LIST_MISMATCH", [](Json& j) {
            auto item = j["files"][1];
            item["relativePath"] = item["sourceImage"]["relativePath"] = "Data/Picture/image3.png";
            j["files"].push_back(std::move(item));
        }}
    };
    for (const auto& [label, error, modify] : cases) {
        auto j = original;
        modify(j);
        data.manifest(j);
        requireError(error, "T072 C " + label, [&] { tx::apply(data.dir, data.game()); });
        check(fileTree(data.game()) == data.original && fs::is_empty(data.dir / "receipts"), "manifest failure made no changes");
    }
    data.manifest(original);
    const auto first = original.at("files").at(0).at("relativePath").get<std::string>();
    const auto target = data.game() / utf8path::pathFromUtf8(first);
    gamefiles::write(target, "external edit");
    const auto before = fileTree(data.game());
    requireError("TARGET_CHANGED", "T072 changed target", [&] { tx::apply(data.dir, data.game()); });
    check(fileTree(data.game()) == before && fs::is_empty(data.dir / "receipts"), "changed target untouched");
}

class DenyAddFile {
    fs::path path_;
    PSECURITY_DESCRIPTOR descriptor_ = nullptr;
    PACL acl_ = nullptr;
public:
    explicit DenyAddFile(const fs::path& path) : path_(path) {
        try {
            auto status = GetNamedSecurityInfoW(path_.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                nullptr, nullptr, &acl_, nullptr, &descriptor_);
            check(status == ERROR_SUCCESS, "read fixture directory ACL");
            HANDLE token = nullptr;
            check(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token) != 0, "open fixture identity");
            DWORD size = 0;
            GetTokenInformation(token, TokenUser, nullptr, 0, &size);
            std::vector<std::byte> information(size);
            const auto read = GetTokenInformation(token, TokenUser, information.data(), size, &size);
            CloseHandle(token);
            check(read != 0, "read fixture identity");

            EXPLICIT_ACCESSW rule{};
            rule.grfAccessPermissions = FILE_ADD_FILE;
            rule.grfAccessMode = DENY_ACCESS;
            rule.grfInheritance = NO_INHERITANCE;
            BuildTrusteeWithSidW(&rule.Trustee, reinterpret_cast<TOKEN_USER*>(information.data())->User.Sid);
            PACL changed = nullptr;
            status = SetEntriesInAclW(1, &rule, acl_, &changed);
            check(status == ERROR_SUCCESS, "create deny-add-file ACL");
            auto native = path_.native();
            status = SetNamedSecurityInfoW(native.data(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                nullptr, nullptr, changed, nullptr);
            LocalFree(changed);
            check(status == ERROR_SUCCESS, "apply fixture ACL");
        } catch (...) {
            if (descriptor_) LocalFree(descriptor_);
            throw;
        }
    }
    ~DenyAddFile() {
        auto native = path_.native();
        SetNamedSecurityInfoW(native.data(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
            nullptr, nullptr, acl_, nullptr);
        LocalFree(descriptor_);
    }
    DenyAddFile(const DenyAddFile&) = delete;
    DenyAddFile& operator=(const DenyAddFile&) = delete;
};

void transactionFaults(const fs::path& scratch) {
    Exported data(scratch / "txn-faults", "wolf");
    requireError("WRITE_FAILED", "T072 D second replacement", [&] {
        tx::apply(data.dir, data.game(), {{[&](tx::ApplyPhase phase, size_t index) {
            if (phase == tx::ApplyPhase::BeforeReplace && index == 1) {
                check(fileTree(data.game()) != data.original && fileTree(data.game()) != data.installed,
                    "first target committed before second failure");
                throw Error("WRITE_FAILED", "fixture failed before second replacement");
            }
        }}});
    });
    check(tx::recover(data.dir, data.game()) == tx::Recovery::Clean, "second replacement rollback finished");
    check(fileTree(data.game()) == data.original, "D second replacement hash rollback");
    data.noPartials();

    requireError("WRITE_FAILED", "T072 D after replace before receipt", [&] {
        tx::apply(data.dir, data.game(), {{[&](tx::ApplyPhase phase, size_t) {
            if (phase == tx::ApplyPhase::BeforeReceipt) {
                check(fileTree(data.game()) == data.installed, "all targets replaced before receipt");
                throw Error("WRITE_FAILED", "fixture interrupted after replacements");
            }
        }}});
    });
    check(tx::recover(data.dir, data.game()) == tx::Recovery::Clean, "after-replace rollback finished");
    check(fileTree(data.game()) == data.original, "D after write hash rollback");
    data.noPartials();

    std::optional<DenyAddFile> denyReceipt;
    requireError("RECEIPT_WRITE_FAILED", "T072 D receipt write denied", [&] {
        tx::apply(data.dir, data.game(), {{[&](tx::ApplyPhase phase, size_t) {
            if (phase == tx::ApplyPhase::BeforeReceipt) denyReceipt.emplace(data.dir / "receipts");
        }}});
    });
    denyReceipt.reset();
    check(tx::recover(data.dir, data.game()) == tx::Recovery::Clean, "receipt rollback finished");
    check(fileTree(data.game()) == data.original && fs::is_empty(data.dir / "receipts"), "D receipt hash rollback");
    data.noPartials();
}

void interrupted(const fs::path& scratch) {
    Exported data(scratch / "txn-crash", "wolf");
    std::wstring executable(32768, L'\0');
    const auto length = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
    check(length != 0 && length < executable.size(), "find test binary");
    executable.resize(length);
    std::wstring command = L"\"" + executable + L"\" --interrupt \"" + data.dir.native() + L"\" \"" +
        data.game().native() + L"\"";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    check(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &startup,
        &process) != 0, "start interrupted child");
    CloseHandle(process.hThread);
    const auto wait = WaitForSingleObject(process.hProcess, 30000);
    DWORD code = 0;
    GetExitCodeProcess(process.hProcess, &code);
    CloseHandle(process.hProcess);
    check(wait == WAIT_OBJECT_0 && code == 73, "child exited without destructors, code " + std::to_string(code));
    check(fs::exists(data.dir / "receipts/.receipt.partial") && !fs::exists(data.dir / "receipts/receipt.json"),
        "crash left staged but no committed receipt");
    const auto plan = Json::parse(gamefiles::read(data.backup() / "plan.json"));
    const auto partialName = ".llmchat-export-" + plan.at("transactionId").get<std::string>() + "-1.partial";
    const auto partial = data.game() / "Data/Picture" / partialName;
    check(fs::exists(partial), "interrupted transaction left a game temporary");
    auto beforeRecovery = fileTree(data.game());
    beforeRecovery.erase("Data/Picture/" + partialName);
    check(beforeRecovery == data.installed, "all files replaced before observed crash");
    requireError("RECOVERY_REQUIRED", "T072 remove interrupted package", [&] { tx::remove(data.dir); });
    check(tx::recover(data.dir, data.game()) == tx::Recovery::RolledBack, "recover uncommitted application");
    check(fileTree(data.game()) == data.original && fs::is_empty(data.dir / "receipts"), "crash rolled back all hashes");
    data.noPartials();
    std::cout << "PASS T072 D process exit after receipt staging, recover removed partial and restored hashes\n";
}

void interruptedRestore(const fs::path& scratch) {
    Exported data(scratch / "txn-restore-crash", "wolf");
    tx::apply(data.dir, data.game());
    auto intent = Json::parse(gamefiles::read(data.dir / "receipts/receipt.json"));
    intent.erase("state");
    intent.erase("files");
    gamefiles::write(data.dir / "receipts/restore-intent.json", intent.dump());
    const auto descriptor = data.manifest().at("files").at(0).at("relativePath").get<std::string>();
    const auto file = utf8path::pathFromUtf8(descriptor);
    fs::copy_file(data.backup() / file, data.game() / file, fs::copy_options::overwrite_existing);
    check(fileTree(data.game()) != data.original && fileTree(data.game()) != data.installed,
        "interrupted restore is between versions");
    check(tx::recover(data.dir, data.game()) == tx::Recovery::Restored, "recover interrupted restore");
    check(fileTree(data.game()) == data.original && !fs::exists(data.dir / "receipts/restore-intent.json"),
        "recover restored all originals and cleared the intent");
    tx::restore(data.dir, data.game());
    data.noPartials();
    std::cout << "PASS T072 recover resumes an interrupted restore\n";
}

void transactionPaths(const fs::path& scratch) {
    Exported data(scratch / "txn-paths", "wolf");
    const auto original = data.manifest();
    for (const auto& [label, path] : std::map<std::string, std::string>{
        {"parent", "Data/../image1.png"}, {"absolute", "/Data/image1.png"}, {"drive", "C:/Data/image1.png"},
        {"drive relative", "C:Data/image1.png"}, {"ADS", "Data/Picture/a.png:stream"},
        {"CON", "Data/Picture/CON.png"}, {"NUL", "Data/Picture/NUL.png"}}) {
        auto j = original;
        j["files"][0]["relativePath"] = j["files"][0]["sourceImage"]["relativePath"] = path;
        data.manifest(j);
        requireError("INVALID_PATH", "T072 F " + label, [&] { tx::apply(data.dir, data.game()); });
        check(fileTree(data.game()) == data.original, "bad relative path made no game changes");
    }
    auto j = original;
    auto name = j.at("files").at(0).at("relativePath").get<std::string>();
    name[0] = 'd';
    j["files"][1]["relativePath"] = j["files"][1]["sourceImage"]["relativePath"] = name;
    data.manifest(j);
    requireError("INVALID_PATH", "T072 F Windows case alias", [&] { tx::apply(data.dir, data.game()); });
    check(fileTree(data.game()) == data.original, "alias made no game changes");
    data.manifest(original);

    const auto path = original.at("files").at(0).at("relativePath").get<std::string>();
    const auto linked = data.fixture.root / "link.png";
    check(CreateHardLinkW(linked.c_str(), (data.game() / utf8path::pathFromUtf8(path)).c_str(), nullptr) != 0,
        "create hard-link fixture");
    requireError("INVALID_PATH", "T072 F game hard link", [&] { tx::apply(data.dir, data.game()); });
    check(fileTree(data.game()) == data.original, "hard-link case made no game changes");
    fs::remove(linked);

    const auto linkedPayload = data.dir / "payload/Data/Picture";
    const auto staged = data.fixture.root / "foreign";
    fs::rename(linkedPayload, staged);
    junction(linkedPayload, staged);
    requireError("INVALID_PATH", "T072 F payload junction", [&] { tx::apply(data.dir, data.game()); });
    requireError("INVALID_PATH", "T072 remove rejects junction", [&] { tx::remove(data.dir); });
    check(fileTree(data.game()) == data.original && fs::is_directory(staged) && !fs::is_empty(staged),
        "junction target and game untouched");
    check(RemoveDirectoryW(linkedPayload.c_str()) != 0, "remove fixture junction");
    fs::rename(staged, linkedPayload);

    gamefiles::write(data.game() / "Data/Picture.wolf", "opaque archive");
    const auto archived = fileTree(data.game());
    requireError("WOLF_ARCHIVE_ENTRY_UNSUPPORTED", "T072 WOLF archive", [&] { tx::apply(data.dir, data.game()); });
    check(fileTree(data.game()) == archived, "WOLF archives unchanged");
    fs::remove(data.game() / "Data/Picture.wolf");

    const DenyAddFile readonly(data.game() / "Data/Picture");
    requireError("PERMISSION_DENIED", "T072 G read-only game target directory", [&] {
        tx::apply(data.dir, data.game());
    });
    check(fileTree(data.game()) == data.original && fs::is_empty(data.dir / "receipts"), "read-only directory remained unchanged");
}

void transactionCases(const fs::path& scratch) {
    normalTransactions(scratch);
    transactionManifestErrors(scratch);
    transactionFaults(scratch);
    interrupted(scratch);
    interruptedRestore(scratch);
    transactionPaths(scratch);
    std::cout << "PASS T072 transaction fixtures\n";
}

int interruptChild(const char* package, const char* game) {
    const auto packageDir = utf8path::pathFromUtf8(package);
    const auto gameDir = utf8path::pathFromUtf8(game);
    tx::apply(packageDir, gameDir, {{[&](tx::ApplyPhase phase, size_t) {
        if (phase != tx::ApplyPhase::BeforeReceiptPublish) return;
        const auto plan = Json::parse(gamefiles::read(packageDir / "receipts/backup/plan.json"));
        const auto partial = ".llmchat-export-" + plan.at("transactionId").get<std::string>() + "-1.partial";
        gamefiles::write(gameDir / "Data/Picture" / partial, "leftover transaction temporary");
        ExitProcess(73);
    }}});
    return 3;
}

} // namespace

int main(int argc, char** argv) {
    if (argc == 4 && std::string_view(argv[1]) == "--interrupt") {
        try { return interruptChild(argv[2], argv[3]); }
        catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 4; }
    }
    if (argc != 2) {
        std::cerr << "Usage: game-image-export-tests <new absolute fixture directory>\n";
        return 2;
    }
    try {
        const auto path = utf8path::pathFromUtf8(argv[1]);
        check(path.is_absolute() && fs::create_directory(path), "fixtures must use a fresh absolute directory");
        successes(path);
        failures(path);
        paths(path);
        warmProject(path);
        confirmation(path);
        transactionCases(path);
        std::cout << "PASS game image export fixtures\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n';
        return 1;
    }
}
