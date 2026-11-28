#include "JsonEmbedding.h"
#include <iostream>
#include <stdexcept>

using Json = nlohmann::json;
namespace fs = std::filesystem;
void require(bool ok, const std::string& reason) { if (!ok) throw std::runtime_error(reason); }
void put(const fs::path& path, const std::string& text) { fs::create_directories(path.parent_path()); std::ofstream(path, std::ios::binary) << text; }
std::string bytes(const fs::path& path) { std::ifstream input(path, std::ios::binary); return {std::istreambuf_iterator<char>(input), {}}; }
Json run(JsonEmbedding& job, Json request, bool allowError = false) {
    job.start(request);
    for (int i = 0; i < 2000; ++i) { const auto state = job.status(); if (state["state"] != "running") { require(allowError || state["state"] != "error", state.dump()); return state; } std::this_thread::sleep_for(std::chrono::milliseconds(5)); }
    throw std::runtime_error("job timed out");
}
Json command(int code, Json parameters) { return {{"code", code}, {"indent", 0}, {"parameters", parameters}}; }
void rpg(const fs::path& game, bool mz) {
    const auto data = mz ? game / "data" : game / "www" / "data";
    if (mz) put(game / "js" / "rmmz_core.js", "fixture");
    put(game / "Game.exe", "fixture");
    put(data / "System.json", R"({"gameTitle":"Title","currencyUnit":"Gold","terms":{"messages":{"victory":"%1 wins!"}},"switches":["scriptFlag"],"variables":["scriptVar"],"title1Name":"Title"})");
    Json events = Json::array({command(101, Json::array({"face.png", 0, 0, 2, "Speaker"})), command(401, {"Hello"}), command(401, {"World"}), command(102, Json::array({Json::array({"Yes", "No"}), 0, 0, 2, 0})), command(402, {0, "Yes"}), command(355, {"Hello"}), command(108, {"Hello"}), command(356, {"Plugin Hello"}), command(401, {"Value \\V[1]"}), command(0, Json::array())});
    Json map = {{"displayName", "Town"}, {"note", "<Hello>"}, {"events", Json::array({nullptr, {{"id", 1}, {"name", "Hello"}, {"pages", Json::array({{{"list", events}, {"image", {{"characterName", "Hello"}}}}})}}})}};
    put(data / "Map001.json", map.dump()); const auto original = bytes(data / "Map001.json");
    put(data / "Actors.json", R"([null,{"id":1,"name":"Hero","nickname":"Brave","profile":"Biography","note":"<Hello>","characterName":"Hero"}])");
    put(data / "Plugins.json", R"({"parameters":{"text":"Hello"}})");
    put(game / "save" / "file1.rmmzsave", "DO NOT TOUCH");
    const auto path = utf8path::pathUtf8(game);
    Json request = {{"gamePath", path}, {"action", "extract"}};
    JsonEmbedding job(game / "unused-tools");
    auto state = run(job, request); require(state["state"] == "exported", "export phase");
    auto dictionary = Json::parse(bytes(utf8path::pathFromUtf8(state["exportPath"])));
    require(dictionary.contains("Hello\nWorld") && dictionary.contains("Yes") && dictionary.contains("Hero") && dictionary.contains("Speaker"), "visible fields exported");
    require(!dictionary.contains("Hello") && !dictionary.contains("scriptVar") && !dictionary.contains("face.png") && !dictionary.contains("Plugin Hello"), "script, path and identifiers excluded");
    dictionary["Hello\nWorld"] = "你好\n世界\n第三行"; dictionary["Yes"] = "是"; dictionary["Hero"] = "勇者"; dictionary["Town"] = "城镇"; dictionary["Speaker"] = "角色";
    dictionary["Value \\V[1]"] = "错误的译文"; dictionary["Hello"] = "禁止改动脚本"; dictionary["%1 wins!"] = "%1 获胜！";
    const auto translated = game / "translated.json"; put(translated, dictionary.dump());
    request["action"] = "inspect"; request["jsonPath"] = utf8path::pathUtf8(translated);
    state = run(job, request); require(state["blocked"] == 1, "lost control sequence blocked");
    request["action"] = "embed"; state = run(job, request);
    require(bytes(data / "Map001.json") == original, "generation does not modify game");
    const auto patch = utf8path::pathFromUtf8(state["patchPath"]); const auto relative = fs::relative(data, game);
    auto patched = Json::parse(bytes(patch / relative / "Map001.json"));
    const auto& list = patched["events"][1]["pages"][0]["list"];
    require(list[1]["parameters"][0] == "你好" && list[3]["parameters"][0] == "第三行", "multi-line structure written");
    require(list[4]["parameters"][0][0] == "是" && list[5]["parameters"][1] == "是", "choice and branch agree");
    require(list[6]["parameters"][0] == "Hello" && list[7]["parameters"][0] == "Hello" && list[9]["parameters"][0] == "Value \\V[1]", "code and blocked text preserved");
    require(patched["events"][1]["name"] == "Hello" && patched["note"] == "<Hello>", "editor identifiers preserved");
    request["action"] = "apply"; state = run(job, request); const auto backup = utf8path::pathFromUtf8(state["backupPath"]);
    require(bytes(backup / "original" / relative / "Map001.json") == original && Json::parse(bytes(data / "Map001.json")) == patched, "apply and exact original backup");
    require(!fs::exists(backup / "original" / relative / "Plugins.json") && bytes(game / "save" / "file1.rmmzsave") == "DO NOT TOUCH", "backup limited to modified resources");
    // Discover and restore using a fresh job, as after restarting the application.
    JsonEmbedding restarted(game / "unused-tools");
    auto backups = JsonEmbedding::backups(game); require(backups.size() == 2, "automatic snapshot and installation receipt rediscovered");
    const auto receipt = utf8path::pathFromUtf8(backups[0].at("path"));
    run(restarted, {{"gamePath", path}, {"action", "rollback"}, {"backupId", backups[0]["id"]}});
    require(bytes(data / "Map001.json") == original && Json::parse(bytes(receipt / "retained" / relative / "Map001.json")) == patched, "rollback preserves translated resource");
    auto snapshot = run(restarted, {{"gamePath", path}, {"action", "backup"}});
    put(data / "Map001.json", "NEW USER DATA"); backups = JsonEmbedding::backups(game);
    run(restarted, {{"gamePath", path}, {"action", "rollback"}, {"backupId", backups[0]["id"]}});
    require(bytes(data / "Map001.json") == original && bytes(utf8path::pathFromUtf8(snapshot["backupPath"]) / "retained" / "Map001.json") == "NEW USER DATA", "standalone snapshot recovery");
}
#ifdef _WIN32
struct LockedFile {
    HANDLE handle;
    explicit LockedFile(const fs::path& path, DWORD share)
        : handle(CreateFileW(path.c_str(), GENERIC_READ, share, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)) {
        require(handle != INVALID_HANDLE_VALUE, "failed to set up file-sharing failure");
    }
    ~LockedFile() { CloseHandle(handle); }
};
#endif

void rollbackCopyFailure(const fs::path& game, bool legacyRpg) {
    const fs::path name = legacyRpg ? "Map001.json" : "data/Map001.json";
    const auto target = game / "data" / "Map001.json";
    const std::string id = legacyRpg ? "rpg-1" : "files-1";
    const auto backup = game / "LLMChat-JSON/backups" / id;
    const auto original = backup / "original" / name, saved = backup / "retained" / name;
    put(target, "complete translated resource");
    put(original, "complete original resource");
    Json manifest = {{"engine", legacyRpg ? "rpgmaker" : "files"}, {"state", "applied"},
        {"resources", Json::array({{{"name", gamefiles::key(name)}, {"existed", true}}})}};
    if (legacyRpg) manifest["dataDirectory"] = "data";
    gamefiles::ledger(backup, manifest);

    JsonEmbedding job(game / "unused-tools");
    const Json request = {{"gamePath", utf8path::pathUtf8(game)}, {"action", "rollback"}, {"backupId", id}};
    const auto readLedger = [&] { return Json::parse(bytes(backup / "manifest.json")); };
#ifdef _WIN32
    {
        const LockedFile locked(original, 0);
        require(run(job, request, true)["state"] == "error", "unreadable original must fail");
    }
#else
    const auto unlocked = original.parent_path() / "unlocked";
    fs::rename(original, unlocked);
    fs::create_directory(original);
    require(run(job, request, true)["state"] == "error", "uncopyable original must fail");
    fs::remove(original);
    fs::rename(unlocked, original);
#endif
    manifest = readLedger();
    require(bytes(target) == "complete translated resource" && !fs::exists(saved), "failed copy must leave current resource in place");
    require(manifest["state"] != "rolledBack" && !manifest["resources"][0].value("restored", false), "failed copy must remain retryable");
    if (manifest["resources"][0].contains("restoreTemp")) {
        const auto name = gamefiles::relative(manifest["resources"][0].at("restoreTemp"));
        require(!fs::exists(target.parent_path() / name), "failed copy cleans the temporary file");
    }

#ifdef _WIN32
    {
        const LockedFile locked(target, FILE_SHARE_READ | FILE_SHARE_WRITE);
        require(run(job, request, true)["state"] == "error", "target that denies replacement must fail");
    }
    manifest = readLedger();
    require(manifest["state"] == "rollingBack" && manifest["resources"][0].value("retainedSaved", false)
        && !manifest["resources"][0].value("restored", false), "record distinguishes saved current bytes from replacement");
    require(bytes(target) == "complete translated resource" && bytes(saved) == "complete translated resource",
        "replacement failure preserves both the live resource and its retained copy");
    // Simulate an interruption after the replacement and before its ledger update.
    put(target, "complete original resource");
#endif

    JsonEmbedding restarted(game / "unused-tools");
    require(run(restarted, request)["state"] == "rolledBack", "rollback can resume");
    require(bytes(target) == "complete original resource" && bytes(saved) == "complete translated resource",
        "resume restores the original and preserves the first retained version");
    require(!fs::exists(utf8path::pathFromUtf8(gamefiles::key(saved) + "-2")), "resume does not duplicate retained files");
    require(readLedger()["state"] == "rolledBack", "manifest records the completed rollback");
}

void wolfRollback(const fs::path& game) {
    const auto backup = game / "LLMChat-JSON/backups/wolf-1";
    const auto data = game / "Data", original = backup / "Data", retained = backup / "retained";
    put(data / "BasicData.wolf", "translated archive");
    put(data / "BasicData" / "entry.dat", "translated entry");
    put(data / "BasicData" / "added" / "extra.dat", "added entry");
    fs::create_directories(data / "BasicData" / "old-empty");
    put(original / "BasicData.wolf", "original archive");
    put(original / "BasicData" / "entry.dat", "original entry");
    fs::create_directories(original / "BasicData" / "original-empty");
    gamefiles::ledger(backup, {{"engine", "wolf"}, {"kind", "snapshot"}, {"state", "snapshot"},
        {"resources", Json::array({{{"name", "BasicData"}, {"hadArchive", true}, {"hadDirectory", true}}})}});

    JsonEmbedding job(game / "unused-tools");
    require(run(job, {{"gamePath", utf8path::pathUtf8(game)}, {"action", "rollback"}, {"backupId", "wolf-1"}})["state"] == "rolledBack",
        "legacy Wolf archive and directory restored");
    require(bytes(data / "BasicData.wolf") == "original archive" && bytes(retained / "BasicData.wolf") == "translated archive",
        "Wolf archive replacement retains the previous archive");
    require(bytes(data / "BasicData" / "entry.dat") == "original entry" && bytes(retained / "BasicData" / "entry.dat") == "translated entry",
        "Wolf directory replacement retains the previous file");
    require(!fs::exists(data / "BasicData" / "added") && bytes(retained / "BasicData" / "added" / "extra.dat") == "added entry",
        "files added since the snapshot are retained and removed from the game");
    require(fs::is_directory(data / "BasicData" / "original-empty") && fs::is_directory(retained / "BasicData" / "old-empty")
        && !fs::exists(data / "BasicData" / "old-empty"), "empty directories follow the snapshot");
}

void rpgScenes(const fs::path& game) {
    put(game / "js/rmmz_core.js", "fixture"); put(game / "Game.exe", "fixture");
    put(game / "data/System.json", R"({"gameTitle":"Scenes","terms":{"params":["Attack"]}})");
    const auto page = [](const std::string& previous) { return Json{{"list", Json::array({command(101, Json::array({"",0,0,2,""})), command(401,{previous}), command(101,Json::array({"",0,0,2,""})), command(401,{"Ready?"}), command(0,Json::array())})}}; };
    const Json map = {{"events", Json::array({nullptr, {{"id",1},{"pages",Json::array({page("Injured")})}}, {{"id",2},{"pages",Json::array({page("Start mission")})}}})}};
    put(game / "data/Map001.json",map.dump());
    JsonEmbedding job(game / "unused-tools");
    const auto gamePath = utf8path::pathUtf8(game);
    const auto extracted = run(job, {{"gamePath",gamePath},{"action","extract"}});
    auto project = gametext::load({{"gamePath",gamePath},{"sourcePath",extracted["exportPath"]}});
    bool found = false;
    for (auto& row : project["entries"]) {
        if (row["source"] == "Ready?") { require(row["dialoguePositions"].size()==2 && !row.contains("dialoguePosition"),"all repeated occurrences retained"); row["translation"]="通用译文"; found=true; }
        if (row["source"] == "Attack") require(row["rpgTerm"]==true,"attribute name is a term candidate");
    }
    require(found,"repeated source exported");
    project["options"]={{"target","zh-CN"}}; project["gamePath"]=gamePath;
    project["glossary"]=Json::array({{{"src","Attack"},{"dst","攻击"},{"target","zh-CN"}}});
    const auto scene = [](int event,const std::string& text) { return Json{{"file","Map001.json"},{"event",event},{"page",0},{"command",3},{"slot","message"},{"source","Ready?"},{"translation",text},{"error",""},{"target","zh-CN"},{"contextKnown",true}}; };
    project["sceneTranslations"]=Json::array({scene(1,"伤得重吗？"),scene(2,"准备好了吗？")});
    gametext::save(project);
    Json request={{"gamePath",gamePath},{"jsonPath",utf8path::pathUtf8(game/"LLMChat-JSON/text-translation.json")},{"action","inspect"}};
    auto state=run(job,request); require(state["blocked"]==0,"valid scene translations accepted");
    request["action"]="embed"; state=run(job,request);
    auto patched=Json::parse(bytes(utf8path::pathFromUtf8(state["patchPath"])/"data/Map001.json"));
    require(patched["events"][1]["pages"][0]["list"][3]["parameters"][0]=="伤得重吗？" && patched["events"][2]["pages"][0]["list"][3]["parameters"][0]=="准备好了吗？","same source patched independently at its physical event location");
    require(Json::parse(bytes(game/"data/Map001.json"))==map,"scene patch generation leaves game files intact");
    auto pending=scene(2,"准备好了吗？"); pending["contextKnown"]=false;
    gametext::checkpoint({{"gamePath",gamePath},{"sourcePath",project["sourcePath"]},{"entries",Json::array()},{"sceneTranslations",Json::array({pending})}});
    project=gametext::load({{"gamePath",gamePath},{"sourcePath",project["sourcePath"]}}); project["gamePath"]=gamePath;
    require(project["glossary"].size()==1 && project["sceneTranslations"].size()==2,"glossary and scene deltas survive checkpoint resume");
    gametext::save(project); request["action"]="inspect"; state=run(job,request); require(state["blocked"]==1,"pending scene blocked instead of falling back to generic dictionary");
    request["action"]="embed"; state=run(job,request); patched=Json::parse(bytes(utf8path::pathFromUtf8(state["patchPath"])/"data/Map001.json"));
    require(patched["events"][2]["pages"][0]["list"][3]["parameters"][0]=="Ready?","uncertain scene remains original");
    project["sceneTranslations"][0]["source"]="Changed";
    put(game/"LLMChat-JSON/text-scenes.json",Json{{"version",1},{"entries",project["sceneTranslations"]}}.dump());
    request["action"]="inspect"; require(run(job,request,true)["state"]=="error","stale scene/source association is rejected");
    gametext::resetForScan(game);
    const auto reset=Json::parse(bytes(game/"LLMChat-JSON/text-project.json"));
    require(reset["glossary"].size()==1 && !reset.contains("sceneTranslations"),"new scan retains formal glossary but clears old scene translations");
}

int main(int argc, char** argv) {
    try {
        require(argc == 2, "provide an empty fixture output directory"); const auto root = fs::absolute(argv[1]); require(!fs::exists(root), "fixture directory must be new");
        rpg(root / "mv", false); rpg(root / "mz", true);
        put(root / "wolf" / "Data" / "BasicData.wolf", "fixture"); put(root / "nested" / "unity" / "UnityPlayer.dll", "fixture");
        const auto games = JsonEmbedding::detect(root); require(games.size() == 4, "mixed game directory recognized");
        require(JsonEmbedding::detect(root / "mz" / "Game.exe")[0]["engine"] == "RPG Maker MZ", "direct executable recognized");
        rpgScenes(root / "scene-fixture");
        rollbackCopyFailure(root / "file-rollback", false); rollbackCopyFailure(root / "rpg-rollback", true);
        wolfRollback(root / "wolf-rollback");
        std::cout << "PASS MV/MZ extraction, multiline event round trip, apply, rollback copy failure and retry, Wolf archive/directory rollback, snapshots and mixed-engine detection\n";
    } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
