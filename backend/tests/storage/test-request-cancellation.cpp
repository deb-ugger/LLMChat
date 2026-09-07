#include "httplib.h"
#include "CancellableWinHttp.h"
#include "RequestCancellation.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <future>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using namespace std::chrono_literals;

void expect(bool value, const std::string& message)
{
    if (!value) throw std::runtime_error(message);
}

struct MockServer {
    httplib::Server server;
    int port = -1;
    std::thread thread;
    std::atomic<int> hits{0};
    std::mutex mutex;
    std::condition_variable ready;
    bool entered = false;
    bool released = false;

    MockServer()
    {
        server.Get("/ok", [&](const httplib::Request&, httplib::Response& response) {
            ++hits;
            response.set_content("local cancellation fixture", "text/plain");
        });
        server.Get("/slow", [&](const httplib::Request&, httplib::Response& response) {
            ++hits;
            std::unique_lock lock(mutex);
            entered = true;
            ready.notify_all();
            ready.wait_for(lock, 10s, [&] { return released; });
            response.set_content("slow response released", "text/plain");
        });
        port = server.bind_to_any_port("127.0.0.1");
        expect(port > 0, "bind loopback random port");
        thread = std::thread([&] { server.listen_after_bind(); });
        server.wait_until_ready();
    }
    void release()
    {
        std::lock_guard lock(mutex);
        released = true;
        ready.notify_all();
    }
    ~MockServer()
    {
        release();
        server.stop();
        if (thread.joinable()) thread.join();
    }
    bool waitForSlow()
    {
        std::unique_lock lock(mutex);
        return ready.wait_for(lock, 3s, [&] { return entered; });
    }
};

struct WinHttpConnection {
    HINTERNET session = nullptr;
    HINTERNET connection = nullptr;
    explicit WinHttpConnection(int port)
    {
        session = WinHttpOpen(L"LLMChat local regression test",
            WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME,
            WINHTTP_NO_PROXY_BYPASS, WINHTTP_FLAG_ASYNC);
        expect(session != nullptr, "open asynchronous WinHTTP session");
        WinHttpSetTimeouts(session, 3000, 3000, 3000, 3000);
        connection = WinHttpConnect(session, L"127.0.0.1",
            static_cast<INTERNET_PORT>(port), 0);
        if (!connection)
        {
            WinHttpCloseHandle(session);
            session = nullptr;
            throw std::runtime_error("connect local WinHTTP");
        }
    }
    ~WinHttpConnection()
    {
        if (connection) WinHttpCloseHandle(connection);
        if (session) WinHttpCloseHandle(session);
    }
    HINTERNET request(const wchar_t* path)
    {
        const auto handle = WinHttpOpenRequest(connection, L"GET", path, nullptr,
            WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
        expect(handle != nullptr, "open local WinHTTP request");
        return handle;
    }
};

void testRegistry()
{
    request_cancel::Registry registry;
    for (int i = 0; i < 12; ++i)
        expect(static_cast<bool>(registry.begin(std::to_string(i))), "first twelve accepted");
    expect(!registry.begin("overflow"), "thirteenth rejected");
    expect(!registry.begin("0"), "duplicate ID rejected");
    registry.finish("4");
    expect(static_cast<bool>(registry.begin("replacement")), "finished slot reused");
    registry.cancel("0");
    // Other live requests remain in the registry until their Scope completes.
    registry.finish("0");
    auto reused = registry.begin("0");
    expect(reused && !reused->stopped(), "cancelled completed ID starts cleanly");

    request_cancel::Registry scoped;
    auto state = scoped.begin("scoped");
    {
        request_cancel::Scope scope(scoped, "scoped", state);
        expect(request_cancel::current == state, "scope installs current state");
        scoped.cancel("scoped");
        expect(request_cancel::stopped(), "scope sees cancellation");
    }
    expect(!request_cancel::current, "scope restores previous thread context");
    expect(static_cast<bool>(scoped.begin("scoped")), "scope releases active registry entry");
    std::cout << "PASS registry: twelve active limit, duplicate IDs, release, scope\n";
}

void testSuccess(MockServer& mock)
{
    for (int i = 0; i < 5; ++i)
    {
        request_cancel::Registry registry;
        const std::string id = "success-" + std::to_string(i);
        request_cancel::Scope scope(registry, id, registry.begin(id));
        WinHttpConnection connection(mock.port);
        CancellableWinHttp request(connection.request(L"/ok"));
        expect(request.send(L"", WINHTTP_NO_REQUEST_DATA, 0), "send local request");
        expect(request.receive(), "receive local response");
        std::string body;
        for (;;)
        {
            DWORD available = 0;
            expect(request.available(available), "query data available");
            if (!available) break;
            std::vector<char> buffer(available);
            DWORD read = 0;
            expect(request.read(buffer.data(), available, read), "read response body");
            body.append(buffer.data(), read);
        }
        expect(body == "local cancellation fixture", "response bytes intact");
        request.close(); // Returns only after HANDLE_CLOSING released callback context.
        request.close(); // Explicit close + destructor must also be idempotent.
    }
    std::cout << "PASS WinHTTP success: send/receive/available/read and completed close\n";
}

void testEarlyCancel(MockServer& mock)
{
    const int before = mock.hits.load();
    request_cancel::Registry registry;
    registry.cancel("early");
    auto state = registry.begin("early");
    expect(state && state->stopped(), "early cancel consumed before POST");
    {
        request_cancel::Scope scope(registry, "early", state);
        WinHttpConnection connection(mock.port);
        CancellableWinHttp request(connection.request(L"/ok"));
        expect(!request.send(L"", WINHTTP_NO_REQUEST_DATA, 0), "early cancel prevents send");
        expect(GetLastError() == ERROR_WINHTTP_OPERATION_CANCELLED, "early cancellation code");
        request.close();
    }
    expect(mock.hits.load() == before, "early cancel never reaches mock server");
    auto expired = registry.begin("expired");
    expired->deadline = request_cancel::Clock::now() - 1ms;
    {
        request_cancel::Scope scope(registry, "expired", expired);
        WinHttpConnection connection(mock.port);
        CancellableWinHttp request(connection.request(L"/ok"));
        expect(!request.send(L"", WINHTTP_NO_REQUEST_DATA, 0), "expired deadline prevents send");
    }
    expect(mock.hits.load() == before, "expired request never reaches server");
    std::cout << "PASS early cancellation and deadline: no request sent\n";
}

void testSlowCancel(MockServer& mock)
{
    request_cancel::Registry registry;
    auto state = registry.begin("slow");
    auto completion = std::async(std::launch::async, [&] {
        request_cancel::Scope scope(registry, "slow", state);
        WinHttpConnection connection(mock.port);
        CancellableWinHttp request(connection.request(L"/slow"));
        const bool sent = request.send(L"", WINHTTP_NO_REQUEST_DATA, 0);
        // WinHTTP may still be completing SendRequest after the server sees
        // headers. Cancellation must work in either phase, not force one race.
        const bool received = sent && request.receive();
        const DWORD error = GetLastError();
        request.close();
        return !received && error == ERROR_WINHTTP_OPERATION_CANCELLED;
    });
    if (!mock.waitForSlow())
    {
        registry.cancel("slow");
        mock.release();
        throw std::runtime_error("slow local request did not reach handler");
    }
    registry.cancel("slow");
    const auto status = completion.wait_for(2s);
    if (status != std::future_status::ready)
    {
        mock.release();
        throw std::runtime_error("cancel did not complete before delayed response");
    }
    expect(completion.get(), "cancel stops pending network operation and close callback finishes");
    mock.release();
    expect(static_cast<bool>(registry.begin("slow")), "cancelled worker scope released ID");
    std::cout << "PASS slow response: cancel completes before server releases response\n";
}

int main()
{
    try
    {
        testRegistry();
        MockServer mock;
        testSuccess(mock);
        testEarlyCancel(mock);
        testSlowCancel(mock);
        std::cout << "All request cancellation tests passed (loopback only).\n";
        return 0;
    }
    catch (const std::exception& error)
    {
        std::cerr << "FAIL: " << error.what() << '\n';
        return 1;
    }
}
