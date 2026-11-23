#include "http/HttpTransport.h"

#include <chrono>
#include <future>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>

using namespace http_transport;
using namespace std::chrono_literals;
using Clock = std::chrono::steady_clock;

void require(bool condition, const char* reason) {
    if (!condition) throw std::runtime_error(reason);
}

Request makeRequest(INTERNET_PORT port, std::wstring target = L"/body") {
    return {{L"127.0.0.1", port, false}, {L"T094 fixture", {}, {1000, 1000, 1000, 2000}}, L"GET", std::move(target)};
}

std::pair<Result, std::string> fetch(const Request& request, const Cancellation& cancellation = {}) {
    std::string body;
    const auto result = perform(request, {{}, [&](std::string_view bytes) {
        require(bytes.size() <= 64 * 1024, "fixed read buffer");
        body.append(bytes);
        return true;
    }}, cancellation);
    return {result, body};
}

void ok(const Request& request, std::string_view expected = "body") {
    const auto [result, body] = fetch(request);
    if (result.failure || result.status != 200 || body != expected) {
        std::wcerr << request.target << L": status=" << result.status << L", WinHTTP=" << (result.failure ? result.failure->code : 0) << L'\n';
        throw std::runtime_error("unexpected successful response: " + body);
    }
}

void legacy(INTERNET_PORT port) {
    const auto session = WinHttpOpen(L"T094 fixture", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    require(session != nullptr, "legacy session");
    const auto connection = WinHttpConnect(session, L"127.0.0.1", port, 0);
    const auto request = WinHttpOpenRequest(connection, L"GET", L"/body", nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    require(request != nullptr, "legacy request");
    bool success = WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, nullptr, 0, 0, 0) && WinHttpReceiveResponse(request, nullptr);
    char buffer[16];
    DWORD read = 0;
    std::string body;
    while (success && (success = !!WinHttpReadData(request, buffer, sizeof(buffer), &read)) && read)
        body.append(buffer, read);
    WinHttpCloseHandle(request);
    WinHttpCloseHandle(connection);
    WinHttpCloseHandle(session);
    require(success && body == "body", "legacy body");
}

void cancellation(INTERNET_PORT port) {
    std::promise<void> reading;
    std::stop_source stop;
    Clock::time_point cancelled;
    std::jthread worker([&] {
        reading.get_future().wait();
        std::this_thread::sleep_for(125ms);
        cancelled = Clock::now();
        stop.request_stop();
    });
    const auto result = perform(makeRequest(port, L"/stall"), {
        [&](DWORD status, const ResponseHeaders&) { reading.set_value(); return status == 200; },
        [](std::string_view) { return true; },
    }, {stop.get_token()});
    const auto returned = Clock::now();
    worker.join();
    require(result.failure && result.failure->stage == Stage::read &&
        result.failure->code == ERROR_WINHTTP_OPERATION_CANCELLED, "cancellation during blocked read");
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(returned - cancelled).count();
    require(ms < 1000, "cancellation took at least one second");
    std::cout << "cancelMs=" << ms << '\n';
}

int main(int argc, char** argv) {
    try {
        require(argc == 3, "usage: http-transport-tests PORT CASE");
        const auto port = static_cast<INTERNET_PORT>(std::stoi(argv[1]));
        const std::string test = argv[2];
        if (test == "legacy") {
            for (int i = 0; i != 20; ++i) legacy(port);
        } else if (test == "reuse") {
            for (int i = 0; i != 20; ++i) ok(makeRequest(port));
            std::cout << "openedSessions=" << openedSessionsForTesting() << '\n';
            ok(makeRequest(port, L"/close"));
            ok(makeRequest(port));
        } else if (test == "concurrent") {
            std::vector<std::future<void>> jobs;
            for (int i = 0; i != 16; ++i)
                jobs.push_back(std::async(std::launch::async, [&] { ok(makeRequest(port, L"/bytes"), std::string(180000, 'x')); }));
            for (auto& job : jobs) job.get();
        } else if (test == "restart") {
            ok(makeRequest(port));
            std::cout << "restart" << std::endl;
            std::string next;
            std::getline(std::cin, next);
            require(next == "go", "expected restarted server");
            ok(makeRequest(port));
        } else if (test == "policy") {
            ok(makeRequest(port, L"/get-fault"));
            auto options = makeRequest(port, L"/post-fault");
            options.verb = L"POST";
            options.body = "payload";
            require(fetch(options).first.failure.has_value(), "POST must fail without replay");
            const auto error4 = fetch(makeRequest(port, L"/4xx")).first;
            const auto error5 = fetch(makeRequest(port, L"/5xx")).first;
            require(!error4.failure && error4.status == 408 && !error5.failure && error5.status == 503, "HTTP errors remain responses");
            auto timeout = makeRequest(port, L"/timeout");
            timeout.session.timeouts.readMs = 160;
            const auto timed = fetch(timeout).first;
            require(timed.failure && timed.failure->code == ERROR_WINHTTP_TIMEOUT, "read timeout");
            ok(makeRequest(port, L"/cookie-redirect"), "session=fixture");
            ok(makeRequest(port, L"/cookie-target"), "none");
            ok(makeRequest(port, L"/set-cookie"));
            ok(makeRequest(port, L"/cookie-target"), "none");
            cancellation(port);
            std::atomic<bool> canceled{true};
            const auto early = fetch(makeRequest(port, L"/early-cancel"), {{}, &canceled}).first;
            require(early.failure && early.failure->code == ERROR_WINHTTP_OPERATION_CANCELLED, "atomic flag cancellation before send");
        } else throw std::runtime_error("unknown fixture");
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
