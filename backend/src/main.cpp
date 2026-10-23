#include "Config.h"
#include "ConversationManager.h"
#include "HttpServer.h"
#include "StoragePaths.h"

#include <filesystem>
#include <iostream>
#include <string>
#include <functional>

#ifdef _WIN32
#include <windows.h>
#endif

namespace fs = std::filesystem;

namespace {

fs::path dataDir()
{
#ifdef _WIN32
    wchar_t buffer[MAX_PATH]{};
    GetModuleFileNameW(nullptr, buffer, MAX_PATH);
    fs::path exePath(buffer);
    return exePath.parent_path();
#else
    return fs::current_path();
#endif
}

} // namespace

int runApp(int argc, char* argv[])
{
    try {
    fs::path base = dataDir();
    const bool prepare = argc > 1 && std::string(argv[1]) == "--prepare-storage";
    const bool serve = argc > 1 && std::string(argv[1]) == "--serve";
    if (argc > 1 && !prepare && !serve)
    {
        base = utf8path::pathFromUtf8(argv[1]);
    }

    // Only the prepare invocation may migrate a WebView profile. Tauri runs it
    // synchronously before constructing the window.
#ifdef _WIN32
    const auto mutexName = L"Local\\LLMChat-storage-" + std::to_wstring(std::hash<std::wstring>{}(storage::normalized(base).wstring()));
    HANDLE session = CreateMutexW(nullptr, TRUE, mutexName.c_str());
    if (!session || GetLastError() == ERROR_ALREADY_EXISTS) {
        if (session) CloseHandle(session);
        throw std::runtime_error("此目录的 LLMChat 后端正在运行，请退出已有软件后重新启动");
    }
    struct SessionGuard { HANDLE handle; ~SessionGuard() { ReleaseMutex(handle); CloseHandle(handle); } } guard{session};
#endif
    storage::initialize(base, prepare && argc > 2 ? utf8path::pathFromUtf8(argv[2]) : fs::path{}, !serve);
    if (prepare) {
        std::cout << nlohmann::json{{"webview", utf8path::pathUtf8(storage::get("webview"))},
            {"data", utf8path::pathUtf8(storage::get("data"))}}.dump();
        return 0;
    }
    const fs::path configPath = storage::get("data") / "config.ini";
    const fs::path convPath = storage::get("data") / "conversations.json";

    std::cout << "Data directory: " << base.string() << std::endl;

    ConfigStore config(configPath.string());
    ConversationManager conversations(convPath.string());
    HttpServer server(config, conversations);
    return server.run();
    } catch (const std::exception& e) {
        std::cerr << "Storage initialization failed: " << e.what() << std::endl;
        return 1;
    }
}

#ifdef _WIN32
int wmain(int argc, wchar_t* argv[])
{
    std::vector<std::string> strings;
    for (int i = 0; i < argc; ++i) strings.push_back(utf8path::toUtf8(argv[i]));
    std::vector<char*> pointers;
    for (auto& s : strings) pointers.push_back(s.data());
    return runApp(argc, pointers.data());
}
#else
int main(int argc, char* argv[]) { return runApp(argc, argv); }
#endif
