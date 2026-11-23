#include "http/ExportRoutes.h"
#include "GameImageExportTransaction.h"
#include "RpgImageProject.h"
#include <httplib.h>

#include <chrono>
#include <fstream>
#include <iostream>
#include <thread>

int wmain(int argc, wchar_t** argv) {
    if (argc != 3) return 2;
    const auto port = std::stoi(argv[1]);
    const std::filesystem::path scope(argv[2]);
    using namespace gameimageexport;
    using transaction::ApplyPhase;
    RpgImageProject project;
    httplib::Server server;
    server.Get("/api/health", [](const auto&, auto& response) { response.set_content("{}", "application/json"); });
    http_router::registerExportRoutes(server, project, [&](ApplyPhase phase, size_t index) {
        std::ifstream file(scope / "mode");
        std::string mode;
        file >> mode;
        file.close();
        if (mode == "restore-fail" && phase == ApplyPhase::BeforeReplace && index == 0)
            throw Error("WRITE_FAILED", "fixture interrupted restore before final file");
        if ((mode != "early" || phase != ApplyPhase::BeginMutation) &&
            (mode != "middle-apply" || phase != ApplyPhase::BeforeReplace || index != 1) &&
            (mode != "middle-restore" || phase != ApplyPhase::BeforeReplace || index != 0) &&
            (mode != "late" || phase != ApplyPhase::BeforeReceiptPublish)) return;
        std::ofstream(scope / "reached") << mode;
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
        while (!std::filesystem::exists(scope / "continue")) {
            if (std::chrono::steady_clock::now() >= deadline)
                throw Error("WRITE_FAILED", "fixture checkpoint timed out");
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
    });
    return server.listen("127.0.0.1", port) ? 0 : 1;
}
