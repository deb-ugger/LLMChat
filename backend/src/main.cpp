#include "Config.h"
#include "ConversationManager.h"
#include "HttpServer.h"

#include <filesystem>
#include <iostream>
#include <string>

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

int main(int argc, char* argv[])
{
    fs::path base = dataDir();
    if (argc > 1)
    {
        base = fs::path(argv[1]);
    }

    const fs::path configPath = base / "config.ini";
    const fs::path convPath = base / "conversations.json";

    std::cout << "Data directory: " << base.string() << std::endl;

    ConfigStore config(configPath.string());
    ConversationManager conversations(convPath.string());
    HttpServer server(config, conversations);
    return server.run();
}
