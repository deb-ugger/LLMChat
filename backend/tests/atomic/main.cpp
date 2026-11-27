#include "../../src/AtomicFile.h"
#include <iostream>
#include <stdexcept>
#include <thread>

static void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

static std::string read(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(input), {}};
}

int main() {
    namespace fs = std::filesystem;
    const auto folder = fs::temp_directory_path() / ("llmchat-atomic-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    struct Cleanup {
        fs::path path;
        ~Cleanup() { std::error_code ignored; fs::remove_all(path, ignored); }
    } cleanup{folder};
    try {
        const auto target = folder / "project.json";
        std::string error;
        require(atomicfile::writeText(target, "old", &error), "initial write");
#ifdef _WIN32
        auto handle = CreateFileW(target.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        require(handle != INVALID_HANDLE_VALUE, "open transient reader");
        std::thread release([handle] { Sleep(150); CloseHandle(handle); });
        const bool written = atomicfile::writeText(target, "new", &error);
        release.join();
        require(written, "retry transient reader");
        require(read(target) == "new" && read(fs::path(target.wstring() + L".bak")) == "old", "content and backup");

        handle = CreateFileW(target.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        require(handle != INVALID_HANDLE_VALUE, "open persistent reader");
        const bool blocked = !atomicfile::writeText(target, "rejected", &error);
        CloseHandle(handle);
        require(blocked, "persistent lock must fail");
        require(read(target) == "new", "failed replacement preserves original");
        require(!fs::exists(fs::path(target.wstring() + L".tmp")), "failed replacement removes temporary");
        require(error.find("project.json") != std::string::npos && error.find("Windows") != std::string::npos, "failure identifies file and OS error");
#endif
        require(atomicfile::writeText(target, "final", &error) && read(target) == "final", "write after unlock");
        std::cout << "PASS atomic replacement, transient sharing, persistent lock, backup and cleanup\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
