#pragma once

#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>

#include <atomic>
#include <chrono>
#include <functional>
#include <optional>
#include <stop_token>
#include <string>
#include <string_view>

namespace http_transport {

struct Origin {
    std::wstring host;
    INTERNET_PORT port;
    bool secure;
    bool operator==(const Origin&) const = default;
};

struct Proxy {
    DWORD access = WINHTTP_ACCESS_TYPE_NO_PROXY;
    std::wstring server;
    bool operator==(const Proxy&) const = default;
};

struct Timeouts {
    int resolveMs;
    int connectMs;
    int sendMs;
    int readMs;
    bool operator==(const Timeouts&) const = default;
};

struct SessionOptions {
    std::wstring userAgent;
    Proxy proxy;
    Timeouts timeouts;
    bool fallbackToDefaultProxy = false;
    DWORD secureProtocols = 0;
    bool operator==(const SessionOptions&) const = default;
};

struct Cancellation {
    std::stop_token stop;
    const std::atomic<bool>* flag = nullptr;
    std::optional<std::chrono::steady_clock::time_point> deadline;

    bool stopped() const;
};

struct Request {
    Origin origin;
    SessionOptions session;
    std::wstring verb;
    std::wstring target;
    std::wstring headers;
    std::string_view body;
    std::optional<Proxy> requestProxy;
    std::optional<DWORD> redirectPolicy;
    bool retryGet = true;
    bool readWhenAvailable = true;
};

enum class Stage { session, connection, request, options, send, receive, read };

struct Failure {
    Stage stage;
    DWORD code;
};

struct Result {
    DWORD status = 0;
    bool attemptedSend = false;
    std::optional<Failure> failure;
};

class ResponseHeaders {
public:
    explicit ResponseHeaders(HINTERNET request) : request_(request) {}
    std::optional<DWORD> number(DWORD query) const;
    std::wstring raw() const;
    std::wstring url() const;

private:
    HINTERNET request_;
};

struct Callbacks {
    // Returning false stops reading without retrying. The views are valid only during the callback.
    std::function<bool(DWORD status, const ResponseHeaders&)> headers;
    std::function<bool(std::string_view)> bytes;
};

Result perform(const Request&, const Callbacks& = {}, const Cancellation& = {});

#ifdef LLMCHAT_HTTP_TRANSPORT_TEST
unsigned openedSessionsForTesting();
#endif

} // namespace http_transport
#endif
