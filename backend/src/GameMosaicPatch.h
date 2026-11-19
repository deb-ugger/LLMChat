#pragma once
#include "UnrealResources.h"
#include <array>
#include <cctype>
#include <mutex>
#include <regex>
#ifdef _WIN32
#include <wincrypt.h>
#pragma comment(lib, "Advapi32.lib")
#endif

namespace mosaic {
using namespace gamefiles;
inline std::mutex operation;
inline fs::path backups(const fs::path& game) { return checkedPath(game, "LLMChat-Mods/backups"); }
inline std::string lower(std::string text) {
    std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return text;
}
inline Json destinations(const fs::path& game, bool isUnreal) {
    Json result = Json::array({{{"id","game"},{"label","游戏根目录"}}});
    if (isUnreal) {
        for (const auto& folder : unreal::binaryFolders(game))
            result.push_back({{"id",key(folder.lexically_relative(game))},{"label",key(folder.lexically_relative(game))}});
        for (const auto& content : unreal::contentFolders(game))
            if (unreal::directory(content / "Paks")) {
                const auto path = key((content / "Paks/~mods").lexically_relative(game));
                result.push_back({{"id",path},{"label",path}});
            }
    } else result.push_back({{"id","BepInEx/plugins"},{"label","BepInEx 插件目录"}});
    return result;
}
inline fs::path selectedDestination(const fs::path& game, bool isUnreal, const std::string& target) {
    for (const auto& entry : destinations(game, isUnreal)) if (entry.at("id") == target)
        return target == "game" ? fs::path{} : relative(target);
    throw std::runtime_error("请选择此游戏可用的补丁位置");
}
inline std::string fingerprint(const fs::path& file) {
#ifdef _WIN32
    struct Hash {
        HCRYPTPROV provider = 0;
        HCRYPTHASH object = 0;
        ~Hash() { if (object) CryptDestroyHash(object); if (provider) CryptReleaseContext(provider, 0); }
    } hash;
    if (!CryptAcquireContextW(&hash.provider, nullptr, nullptr, PROV_RSA_AES, CRYPT_VERIFYCONTEXT) ||
        !CryptCreateHash(hash.provider, CALG_SHA_256, 0, 0, &hash.object))
        throw std::runtime_error("无法校验补丁文件");
    std::ifstream input(file, std::ios::binary);
    if (!input) throw std::runtime_error("无法读取补丁文件：" + key(file.filename()));
    std::array<char, 65536> buffer;
    while (input.read(buffer.data(), buffer.size()) || input.gcount() > 0)
        if (!CryptHashData(hash.object, reinterpret_cast<const BYTE*>(buffer.data()), static_cast<DWORD>(input.gcount()), 0))
            throw std::runtime_error("补丁文件校验失败");
    std::array<BYTE,32> bytes;
    DWORD size = static_cast<DWORD>(bytes.size());
    if (!input.eof() || !CryptGetHashParam(hash.object, HP_HASHVAL, bytes.data(), &size, 0))
        throw std::runtime_error("补丁文件校验失败");
    std::string result;
    for (const auto value : bytes) { result += "0123456789abcdef"[value >> 4]; result += "0123456789abcdef"[value & 15]; }
    return result;
#else
    throw std::runtime_error("去码补丁安装当前支持 Windows");
#endif
}
inline std::pair<fs::path, Json> active(const fs::path& game) {
    const auto root = backups(game);
    if (!fs::is_directory(root)) return {};
    std::pair<fs::path, Json> current;
    for (const auto& item : fs::directory_iterator(root)) {
        if (reparsePoint(item.path()) || !item.is_directory() || !item.path().filename().wstring().starts_with(L"files-")) continue;
        const auto manifest = checkedPath(item.path(), "manifest.json");
        if (!fs::is_regular_file(manifest)) continue;
        auto record = Json::parse(read(manifest));
        if (record.value("kind","") == "mosaic" && record.value("state","") != "rolledBack" && item.path() > current.first)
            current = {item.path(),std::move(record)};
    }
    return current;
}
inline Json status(const fs::path& game, bool isUnreal) {
    const auto [folder, record] = active(game);
    Json out = {{"destinations",destinations(game,isUnreal)}};
    if (!folder.empty()) {
        out["patch"] = {{"name",record.at("name")},{"state",record.at("state")},{"layer",record.value("layer","package")},
            {"files",record.at("resources").size()},{"backup",key(folder)}};
    }
    return out;
}
inline bool accepted(const fs::path& name, bool isUnreal) {
    const auto path = lower(key(name));
    const auto ext = lower(key(name.extension()));
    const auto leaf = lower(key(name.filename()));
    if (ext == ".exe" || ext == ".bat" || ext == ".cmd" || ext == ".ps1" || ext == ".lnk") return false;
    if (leaf == "d3d11.dll" || leaf == "dxgi.dll" || leaf == "d3dx.ini" || leaf == "reshade.ini" ||
        leaf == "reshadepreset.ini" || leaf == "reshadepreset.txt" || leaf == "shadertoggler.addon64" ||
        leaf == "shadertoggler.ini" || leaf == "nvapi64.dll" || leaf == "nvapi.dll") return true;
    if (path.starts_with("shaderfixes/") || path.starts_with("mods/") || path.starts_with("reshade-shaders/") ||
        path.find("/shaderfixes/") != std::string::npos || path.find("/mods/") != std::string::npos || path.find("/reshade-shaders/") != std::string::npos)
        return ext != ".dll";
    if (isUnreal) {
        return (path.starts_with("content/paks/") || path.find("/content/paks/") != std::string::npos) &&
            (ext == ".pak" || ext == ".sig" || ext == ".utoc" || ext == ".ucas");
    }
    if (path.starts_with("bepinex/") || path.starts_with("dotnet/")) return true;
    if (leaf == "winhttp.dll" || leaf == "doorstop_config.ini" || leaf == ".doorstop_version") return true;
    const auto unityData = path.substr(0, path.find('/')).ends_with("_data");
    return unityData && (ext == ".assets" || ext == ".ress" || ext == ".resource" || ext == ".bundle" ||
        ext == ".unity3d" || leaf == "globalgamemanagers" || std::regex_match(leaf,std::regex("level[0-9]+")));
}
struct Package {
    std::map<fs::path,fs::path> files;
    Json list = Json::array();
    size_t ignored = 0;
};
inline Package package(const fs::path& game, bool isUnreal, const fs::path& source, const std::string& target) {
    if (!fs::is_directory(source) || reparsePoint(source)) throw std::runtime_error("请选择已解压的补丁目录");
    const auto input = fs::canonical(source);
    if (input == game) throw std::runtime_error("请选择单独的补丁目录");
    const auto prefix = selectedDestination(game,isUnreal,target);
    Package result;
    std::set<std::string> names;
    for (auto it = fs::recursive_directory_iterator(input); it != fs::recursive_directory_iterator(); ++it) {
        if (reparsePoint(it->path())) throw std::runtime_error("补丁包含链接，无法导入");
        if (!it->is_regular_file()) continue;
        const auto name = prefix / it->path().lexically_relative(input);
        if (!accepted(name,isUnreal)) { ++result.ignored; continue; }
        if (!names.insert(lower(key(name))).second) throw std::runtime_error("补丁包含重复的目标路径");
        const auto destination = checkedPath(game,name);
        if (fs::exists(destination) && !fs::is_regular_file(destination)) throw std::runtime_error("补丁目标与目录冲突：" + key(name));
        if (destination == it->path() || (fs::exists(destination) && fs::equivalent(destination,it->path())))
            throw std::runtime_error("补丁文件已位于游戏目标位置，请选择单独的补丁目录");
        result.files.emplace(name,it->path());
        result.list.push_back({{"path",key(name)},{"size",it->file_size()},{"replace",fs::exists(destination)},
            {"modified",std::to_string(it->last_write_time().time_since_epoch().count())}});
    }
    if (result.files.empty()) throw std::runtime_error("目录里没有可安装的去码补丁文件，请检查包内布局和目标位置");
    std::sort(result.list.begin(),result.list.end(),[](const Json& a,const Json& b){return a.at("path") < b.at("path");});
    return result;
}
inline void ensureInactive(const fs::path& game) {
    if (!active(game).first.empty()) throw std::runtime_error("请先卸载或恢复当前去码补丁");
}
inline Json install(const fs::path& game, bool isUnreal, const fs::path& source, const std::string& target, const Json& checked) {
    std::lock_guard lock(operation);
    ensureInactive(game);
    const auto bundle = package(game,isUnreal,source,target);
    if (bundle.list != checked) throw std::runtime_error("补丁文件或目标已变化，请重新检查清单");
    Json expected = Json::object();
    for (const auto& [name,file] : bundle.files) expected[key(name)] = fingerprint(file);
    applyPrepared(game,[&](const auto& stage) {
        for (const auto& [name,file] : bundle.files) stage(name,nullptr,&file);
    },backups(game),{{"kind","mosaic"},{"name",key(source.filename())},{"expected",expected}});
    return status(game,isUnreal);
}
inline std::pair<fs::path,std::string> shaderRule(const fs::path& game, bool isUnreal, const Json& body) {
    const auto prefix = selectedDestination(game,isUnreal,body.at("target").get<std::string>());
    const auto name = prefix / "d3dx.ini";
    const auto ini = checkedPath(game,name);
    if (!fs::is_regular_file(ini) || !fs::is_regular_file(checkedPath(game,prefix / "d3d11.dll")))
        throw std::runtime_error("目标位置需已有 3Dmigoto 的 d3dx.ini 和 d3d11.dll");
    const auto shader = lower(body.at("shader").get<std::string>());
    const auto texture = lower(body.value("texture",""));
    const auto slot = lower(body.value("slot",""));
    if (!std::regex_match(shader,std::regex("[a-f0-9]{16}")) ||
        (!texture.empty() && (!std::regex_match(texture,std::regex("[a-f0-9]{8}")) ||
          !std::regex_match(slot,std::regex("ib|vb[0-9]+|[pv]s-t[0-9]+")))))
        throw std::runtime_error("请输入有效的着色器哈希、纹理哈希和绑定槽");
    auto original = read(ini);
    const auto normalized = lower(original);
    if (normalized.find("llmchatmosaic") != std::string::npos ||
        std::regex_search(normalized,std::regex("(^|[\\r\\n])[ \\t]*hash[ \\t]*=[ \\t]*" + shader + "([ \\t\\r\\n;]|$)")))
        throw std::runtime_error("目标配置已包含该着色器或同名规则，请检查已有配置");
    original += "\r\n[ShaderOverrideLLMChatMosaic]\r\nhash = " + shader + "\r\n";
    if (texture.empty()) original += "handling = skip\r\n";
    else original += "checktextureoverride = " + slot + "\r\n\r\n[TextureOverrideLLMChatMosaic]\r\nhash = " + texture + "\r\nhandling = skip\r\n";
    return {name,std::move(original)};
}
inline Json installRule(const fs::path& game, bool isUnreal, const Json& body) {
    std::lock_guard lock(operation);
    const auto [existing,record] = active(game);
    if (!existing.empty() && (record.value("layer","package") == "rule" || record.at("state") != "applied"))
        throw std::runtime_error("请先卸载或恢复当前去码规则");
    const auto [name,bytes] = shaderRule(game,isUnreal,body);
    // Stage the generated bytes under the verified game work directory.
    const auto staging = checkedPath(game,"LLMChat-Mods/rule-preview.ini");
    write(staging,bytes);
    try {
        const Json expected = {{key(name),fingerprint(staging)}};
        applyPrepared(game,[&](const auto& stage){stage(name,&bytes);},backups(game),
            {{"kind","mosaic"},{"layer","rule"},{"name","3Dmigoto 去码规则"},{"expected",expected}});
    } catch (...) {
        std::error_code ignored; fs::remove(staging,ignored); throw;
    }
    std::error_code ignored; fs::remove(staging,ignored);
    return status(game,isUnreal);
}
inline Json uninstall(const fs::path& game, bool isUnreal) {
    std::lock_guard lock(operation);
    const auto [folder,record] = active(game);
    if (folder.empty()) throw std::runtime_error("没有已安装的去码补丁");
    for (const auto& row : record.at("resources")) {
        const auto path = row.at("name").get<std::string>();
        const auto destination = checkedPath(game,relative(path));
        checkedPath(folder,fs::path("original") / relative(path));
        checkedPath(folder,fs::path("retained") / relative(path));
        if (record.at("state") == "applied" &&
            (!fs::is_regular_file(destination) || fingerprint(destination) != record.at("expected").at(path).get<std::string>()))
            throw std::runtime_error("补丁文件已被其他操作修改，未覆盖：" + path);
    }
    for (const auto& path : record.value("createdDirectories",Json::array())) checkedPath(game,relative(path.get<std::string>()));
    restore(game,folder);
    return status(game,isUnreal);
}
}
