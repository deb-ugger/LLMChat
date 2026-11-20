#pragma once
#include "GameFileOps.h"
#include <functional>
#include <mutex>

namespace wolfarchive {
namespace fs = std::filesystem;
using Path = fs::path;
inline void runTool(const Path& tools, const Path& work, const std::string& name,
                    const std::vector<std::wstring>& args, const std::function<bool()>& stopped) {
    if (stopped()) throw std::runtime_error("WOLF 操作已中止");
    const auto executable = tools / name;
    if (!std::filesystem::exists(executable)) throw std::runtime_error("缺少 WOLF 工具 " + name + "，请先准备 resources/wolf");
#ifdef _WIN32
    std::wstring command = L"\"" + executable.wstring() + L"\"";
    for (const auto& arg : args) command += L" \"" + arg + L"\"";
    SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    HANDLE log = CreateFileW((work / "tools.log").c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (log == INVALID_HANDLE_VALUE) throw std::runtime_error("无法创建工具日志");
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESTDHANDLES; startup.hStdOutput = log; startup.hStdError = log; startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    PROCESS_INFORMATION process{};
    const bool ok = CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, work.c_str(), &startup, &process);
    CloseHandle(log); if (!ok) throw std::runtime_error("无法启动工具：" + name);
    CloseHandle(process.hThread);
    while (WaitForSingleObject(process.hProcess, 100) == WAIT_TIMEOUT) if (stopped()) { TerminateProcess(process.hProcess, 2); WaitForSingleObject(process.hProcess, INFINITE); CloseHandle(process.hProcess); throw std::runtime_error("WOLF 操作已中止"); }
    DWORD code; GetExitCodeProcess(process.hProcess, &code); CloseHandle(process.hProcess);
    if (code != 0) throw std::runtime_error(name + " 处理失败，日志：" + utf8path::pathUtf8(work / "tools.log"));
#else
    throw std::runtime_error("WOLF 嵌入目前仅支持 Windows");
#endif
}

inline std::string revision(const Path& archive) {
    return std::to_string(fs::file_size(archive)) + "-" + std::to_string(fs::last_write_time(archive).time_since_epoch().count());
}

inline Path unpack(const Path& game, const Path& archive, const Path& tools, const std::function<bool()>& stopped) {
    static std::timed_mutex writer;
    std::unique_lock lock(writer, std::defer_lock);
    while (!lock.try_lock_for(std::chrono::milliseconds(100)))
        if (stopped()) throw std::runtime_error("WOLF 解包已中止");
    const auto version = revision(archive);
    const auto base = game / "LLMChat-JSON" / "wolf-archives" / archive.lexically_relative(game);
    const auto ready = base / version;
    if (fs::is_regular_file(ready / "png.json")) return ready / "archive";
    fs::create_directories(base);
    const auto job = base / ("work-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    fs::create_directory(job);
    const auto input = job / "archive.wolf";
    try {
        std::error_code ec;
        fs::create_hard_link(archive, input, ec);
        if (ec) fs::copy_file(archive, input);
        runTool(tools, job, "DxaDecode.exe", {L"-K:WLFRPrO!p(;s5((8P@((UFWlu$#5(=", input.wstring()}, stopped);
        const auto output = job / "archive";
        if (!fs::is_directory(output) || fs::is_empty(output))
            throw std::runtime_error("未解出资源，请检查封包版本或密钥");
        const bool whole = archive == game / "Data.wolf";
        const auto textGroup = [](const Path& group) {
            const auto name = utf8path::pathUtf8(group);
            return name == "BasicData" || name == "MapData" || name.starts_with("Evtext");
        };
        const bool textPack = textGroup(archive.stem());
        auto png = gamefiles::Json::array();
        for (const auto& entry : fs::recursive_directory_iterator(output)) {
            if (stopped()) throw std::runtime_error("WOLF 解包已中止");
            if (!entry.is_regular_file()) continue;
            const auto& path = entry.path();
            const auto relative = path.lexically_relative(output);
            auto ext = path.extension().wstring();
            std::transform(ext.begin(), ext.end(), ext.begin(), [](wchar_t c) { return c >= L'A' && c <= L'Z' ? wchar_t(c + 32) : c; });
            if (ext == L".png") png.push_back({gamefiles::key(relative), revision(path)});
            else if (!textPack && !(whole && textGroup(relative.begin()->stem()))) fs::remove(path);
        }
        gamefiles::write(job / "png.json", png.dump());
        fs::remove(input);
        if (revision(archive) != version) throw std::runtime_error("解包期间文件已改变，请重新扫描");
        fs::rename(job, ready);
    } catch (const std::exception& e) {
        std::error_code ec;
        fs::remove(input, ec);
        fs::remove_all(job / "archive", ec);
        throw std::runtime_error(utf8path::pathUtf8(archive.filename()) + "：" + e.what());
    }
    return ready / "archive";
}
}
