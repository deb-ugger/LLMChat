#include "HttpTransport.h"

#ifdef _WIN32
#include "CancellableWinHttp.h"
#include <algorithm>
#include <array>
#include <memory>
#include <mutex>
#include <utility>
#include <vector>

namespace http_transport {
namespace {

using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
#ifdef LLMCHAT_HTTP_TRANSPORT_TEST
std::atomic<unsigned> openedSessions{0};
#endif

struct Handle {
    HINTERNET value = nullptr;
    ~Handle() { if (value) WinHttpCloseHandle(value); }
    Handle() = default;
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};

struct Session {
    Origin origin;
    SessionOptions options;
    std::optional<Proxy> requestProxy;
    Handle session;
    Handle connection;
    Clock::time_point idleSince;

    bool matches(const Request& request) const {
        return origin == request.origin && options == request.session && requestProxy == request.requestProxy;
    }
};

class Pool {
    std::mutex mutex_;
    std::vector<std::unique_ptr<Session>> idle_;

public:
    std::unique_ptr<Session> take(const Request& request, Failure& failure) {
        {
            std::lock_guard lock(mutex_);
            const auto now = Clock::now();
            std::erase_if(idle_, [now](const auto& entry) { return now - entry->idleSince >= 60s; });
            const auto found = std::find_if(idle_.rbegin(), idle_.rend(),
                [&](const auto& entry) { return entry->matches(request); });
            if (found != idle_.rend()) {
                const auto it = std::prev(found.base());
                auto entry = std::move(*it);
                idle_.erase(it);
                return entry;
            }
        }

        auto entry = std::make_unique<Session>();
        entry->origin = request.origin;
        entry->options = request.session;
        entry->requestProxy = request.requestProxy;
        const auto& options = request.session;
        const auto& proxy = options.proxy;
        entry->session.value = WinHttpOpen(options.userAgent.c_str(), proxy.access,
            proxy.server.empty() ? WINHTTP_NO_PROXY_NAME : proxy.server.c_str(), WINHTTP_NO_PROXY_BYPASS, WINHTTP_FLAG_ASYNC);
        if (!entry->session.value && options.fallbackToDefaultProxy && proxy.access == WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY)
            entry->session.value = WinHttpOpen(options.userAgent.c_str(), WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, WINHTTP_FLAG_ASYNC);
        if (!entry->session.value) {
            failure = {Stage::session, GetLastError()};
            return {};
        }
#ifdef LLMCHAT_HTTP_TRANSPORT_TEST
        ++openedSessions;
#endif
        const auto& timeouts = options.timeouts;
        WinHttpSetTimeouts(entry->session.value, timeouts.resolveMs, timeouts.connectMs, timeouts.sendMs, timeouts.readMs);
        if (DWORD protocols = options.secureProtocols)
            WinHttpSetOption(entry->session.value, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols));
        entry->connection.value = WinHttpConnect(entry->session.value, request.origin.host.c_str(), request.origin.port, 0);
        if (!entry->connection.value) {
            failure = {Stage::connection, GetLastError()};
            return {};
        }
        return entry;
    }

    void put(std::unique_ptr<Session> entry) {
        std::lock_guard lock(mutex_);
        if (idle_.size() >= 64) idle_.erase(idle_.begin());
        entry->idleSince = Clock::now();
        idle_.push_back(std::move(entry));
    }
};

Pool& pool() {
    static Pool value;
    return value;
}

bool isRetryable(const Failure& failure) {
    if (failure.stage != Stage::connection && failure.stage != Stage::send && failure.stage != Stage::receive)
        return false;
    return failure.code == ERROR_WINHTTP_CANNOT_CONNECT || failure.code == ERROR_WINHTTP_CONNECTION_ERROR ||
        failure.code == ERROR_WINHTTP_NAME_NOT_RESOLVED;
}

Result attempt(Session& entry, const Request& input, const Callbacks& callbacks,
               const Cancellation& cancellation, bool& reusable) {
    Result result;
    // The read buffer and request input must both outlive the handle-closing callback.
    std::array<char, 64 * 1024> buffer;
    const auto request = WinHttpOpenRequest(entry.connection.value, input.verb.c_str(), input.target.c_str(),
        nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, input.origin.secure ? WINHTTP_FLAG_SECURE : 0);
    if (!request) { result.failure = Failure{Stage::request, GetLastError()}; return result; }
    CancellableWinHttp operation(request, cancellation);
    if (!operation.configured()) { result.failure = Failure{Stage::send, ERROR_WINHTTP_OPERATION_CANCELLED}; return result; }
    if (input.requestProxy) {
        const auto& proxy = *input.requestProxy;
        WINHTTP_PROXY_INFO info{proxy.access, proxy.server.empty() ? nullptr : const_cast<LPWSTR>(proxy.server.c_str()), nullptr};
        if (!WinHttpSetOption(request, WINHTTP_OPTION_PROXY, &info, sizeof(info))) {
            result.failure = Failure{Stage::options, GetLastError()}; return result;
        }
    }
    if (input.redirectPolicy) {
        DWORD redirect = *input.redirectPolicy;
        WinHttpSetOption(request, WINHTTP_OPTION_REDIRECT_POLICY, &redirect, sizeof(redirect));
    }

    result.attemptedSend = true;
    const auto length = static_cast<DWORD>(input.body.size());
    if (const auto error = operation.run([&] {
        return WinHttpSendRequest(request, input.headers.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : input.headers.c_str(),
            input.headers.empty() ? 0 : static_cast<DWORD>(-1),
            length ? const_cast<char*>(input.body.data()) : WINHTTP_NO_REQUEST_DATA, length, length, 0);
    }, WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE)) {
        result.failure = Failure{Stage::send, error}; return result;
    }
    if (const auto error = operation.run([&] { return WinHttpReceiveResponse(request, nullptr); },
        WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE)) {
        result.failure = Failure{Stage::receive, error}; return result;
    }

    const ResponseHeaders headers(request);
    result.status = headers.number(WINHTTP_QUERY_STATUS_CODE).value_or(0);
    const bool cleanSession = operation.canReuse();
    if (callbacks.headers && !callbacks.headers(result.status, headers)) return result;
    for (;;) {
        auto capacity = static_cast<DWORD>(buffer.size());
        if (input.readWhenAvailable) {
            DWORD available = 0;
            if (const auto error = operation.run([&] { return WinHttpQueryDataAvailable(request, nullptr); },
                WINHTTP_CALLBACK_STATUS_DATA_AVAILABLE, &available)) {
                result.failure = Failure{Stage::read, error}; return result;
            }
            if (!available) break;
            capacity = std::min(capacity, available);
        }
        DWORD received = 0;
        if (const auto error = operation.run([&] {
            return WinHttpReadData(request, buffer.data(), capacity, nullptr);
        }, WINHTTP_CALLBACK_STATUS_READ_COMPLETE, &received)) {
            result.failure = Failure{Stage::read, error}; return result;
        }
        if (!received) break;
        if (callbacks.bytes && !callbacks.bytes({buffer.data(), received})) return result;
    }
    reusable = cleanSession;
    return result;
}

} // namespace

#ifdef LLMCHAT_HTTP_TRANSPORT_TEST
unsigned openedSessionsForTesting() { return openedSessions.load(); }
#endif

bool Cancellation::stopped() const {
    return stop.stop_requested() || (flag && flag->load()) || (deadline && Clock::now() >= *deadline);
}

std::optional<DWORD> ResponseHeaders::number(DWORD query) const {
    DWORD value = 0, size = sizeof(value);
    if (!WinHttpQueryHeaders(request_, query | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX,
        &value, &size, WINHTTP_NO_HEADER_INDEX)) return std::nullopt;
    return value;
}

std::wstring ResponseHeaders::raw() const {
    DWORD bytes = 0;
    WinHttpQueryHeaders(request_, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX,
        nullptr, &bytes, WINHTTP_NO_HEADER_INDEX);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || !bytes) return {};
    std::wstring value(bytes / sizeof(wchar_t), L'\0');
    if (!WinHttpQueryHeaders(request_, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX,
        value.data(), &bytes, WINHTTP_NO_HEADER_INDEX)) return {};
    value.resize(bytes / sizeof(wchar_t));
    return value;
}

std::wstring ResponseHeaders::url() const {
    DWORD bytes = 0;
    WinHttpQueryOption(request_, WINHTTP_OPTION_URL, nullptr, &bytes);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || !bytes) return {};
    std::wstring value(bytes / sizeof(wchar_t), L'\0');
    if (!WinHttpQueryOption(request_, WINHTTP_OPTION_URL, value.data(), &bytes)) return {};
    value.resize(bytes / sizeof(wchar_t));
    if (!value.empty() && value.back() == L'\0') value.pop_back();
    return value;
}

Result perform(const Request& request, const Callbacks& callbacks, const Cancellation& cancellation) {
    const bool retry = request.retryGet && request.verb == L"GET";
    bool attemptedSend = false;
    for (int i = 0;; ++i) {
        Result result;
        if (cancellation.stopped()) result.failure = Failure{Stage::send, ERROR_WINHTTP_OPERATION_CANCELLED};
        else {
            Failure failure{};
            auto session = pool().take(request, failure);
            if (!session) result.failure = failure;
            else {
                bool reusable = false;
                result = attempt(*session, request, callbacks, cancellation, reusable);
                if (reusable) pool().put(std::move(session));
            }
        }
        result.attemptedSend = result.attemptedSend || attemptedSend;
        if (!retry || i != 0 || !result.failure || !isRetryable(*result.failure)) return result;
        attemptedSend = result.attemptedSend;
    }
}

} // namespace http_transport
#endif
