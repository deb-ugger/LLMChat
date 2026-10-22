#include "SpeechOnline.h"
#include "RequestCancellation.h"
#include <httplib.h>
#include <atomic>
#include <chrono>
#include <future>
#include <iostream>
#include <thread>

void expect(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
int main() {
    using json = nlohmann::json;
    using namespace std::chrono_literals;
    AppConfig config; config.proxyMode = "direct";
    httplib::Server server;
    std::atomic<bool> slowStarted{false}, finishSlow{false};
    json received;
    server.Post("/chat/completions", [&](const httplib::Request& request, httplib::Response& response) {
        const auto body = json::parse(request.body);
        if (body["model"] == "slow") {
            slowStarted = true;
            while (!finishSlow) std::this_thread::sleep_for(10ms);
        } else received = body;
        json reply;
        reply["choices"] = json::array();
        reply["choices"].push_back({{"message", {{"content", R"({"language":"zh","cues":[{"start":0,"end":1,"text":"测试"}]})"}}}});
        reply["usage"] = {{"prompt_tokens", 10}, {"completion_tokens", 5}, {"total_tokens", 15}};
        response.set_content(reply.dump(), "application/json");
    });
    const int port = server.bind_to_any_port("127.0.0.1");
    expect(port > 0, "bind mock provider");
    std::thread serve([&] { server.listen_after_bind(); });
    try {
        json body{{"operation", "recognize"}, {"apiUrl", "http://127.0.0.1:" + std::to_string(port) + "/chat/completions"},
            {"apiKey", "fixture-only"}, {"model", "test-audio"}, {"protocol", "google"}, {"audio", "UklGRg=="}, {"duration", 1.0}, {"language", "chinese"}};
        auto request = speech_online::buildRequest(body, config);
        expect(request.messages[0]["content"][1]["input_audio"]["data"] == "UklGRg==", "Google raw base64");
        auto response = LlmClient::chat(request);
        expect(response.ok && response.totalTokens == 15, "actual WinHTTP compatible response and token usage");
        expect(received["response_format"]["type"] == "json_object" && received["stream"] == false, "JSON output parameters");
        body["protocol"] = "qwen";
        request = speech_online::buildRequest(body, config);
        expect(request.messages[0]["content"][1]["input_audio"]["data"] == "data:audio/wav;base64,UklGRg==", "Qwen data URI");
        response = LlmClient::chat(request);
        expect(response.ok && received["modalities"][0] == "text" && received["reasoning_effort"] == "none", "Qwen text-only response");
        body["duration"] = 31;
        bool rejected = false; try { speech_online::buildRequest(body, config); } catch (...) { rejected = true; }
        expect(rejected, "reject excessive audio chunk");
        body["operation"] = "proofread"; body["cues"] = json::array({{{"text", "测试"}, {"start", 1}, {"end", 2}}});
        request = speech_online::buildRequest(body, config);
        expect(request.messages.dump().find("input_audio") == std::string::npos, "proofreading never includes audio");
        expect(json::parse(request.messages[1]["content"].get<std::string>())[0].size() == 2, "only cue ID and text sent for correction");
        request.model = "slow";
        request_cancel::Registry registry;
        auto state = registry.begin("cancel-test");
        auto pending = std::async(std::launch::async, [&] {
            request_cancel::Scope scope(registry, "cancel-test", state);
            return LlmClient::chat(request);
        });
        for (int i = 0; i < 300 && !slowStarted; ++i) std::this_thread::sleep_for(10ms);
        registry.cancel("cancel-test");
        const bool cancelled = pending.wait_for(3s) == std::future_status::ready;
        finishSlow = true;
        expect(cancelled && !pending.get().ok, "in-flight WinHTTP cancelled promptly");
        server.stop(); serve.join();
        std::cout << "PASS: audio request formats, native HTTP, proxy, usage, proofreading payload, cancellation\n";
    } catch (const std::exception& error) {
        finishSlow = true; server.stop(); serve.join(); std::cerr << error.what() << '\n'; return 1;
    }
}
