#pragma once

#ifdef _WIN32
#include "http/HttpTransport.h"
#include "RequestCancellation.h"

#include <condition_variable>

// Request callbacks live until HANDLE_CLOSING. The worker owns closing and all
// caller-provided buffers remain live until that final callback completes.
class CancellableWinHttp {
    HINTERNET handle_;
    std::shared_ptr<request_cancel::State> legacyState_;
    http_transport::Cancellation cancellation_;
    std::mutex mutex_;
    std::condition_variable ready_;
    DWORD status_ = 0;
    DWORD bytes_ = 0;
    DWORD error_ = 0;
    unsigned responses_ = 0;
    bool redirected_ = false;
    bool closed_ = false;
    bool configured_ = false;

    static void CALLBACK callback(HINTERNET, DWORD_PTR context, DWORD status, void* info, DWORD length) {
        auto* self = reinterpret_cast<CancellableWinHttp*>(context);
        if (!self) return;
        std::lock_guard lock(self->mutex_);
        switch (status) {
        case WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING: self->closed_ = true; break;
        case WINHTTP_CALLBACK_STATUS_REQUEST_ERROR:
            self->error_ = static_cast<WINHTTP_ASYNC_RESULT*>(info)->dwError;
            break;
        case WINHTTP_CALLBACK_STATUS_DATA_AVAILABLE:
            self->bytes_ = *static_cast<DWORD*>(info);
            self->status_ = status;
            break;
        case WINHTTP_CALLBACK_STATUS_READ_COMPLETE:
            self->bytes_ = length;
            self->status_ = status;
            break;
        case WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE:
        case WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE:
            self->status_ = status;
            break;
        case WINHTTP_CALLBACK_STATUS_REDIRECT: self->redirected_ = true; break;
        case WINHTTP_CALLBACK_STATUS_RESPONSE_RECEIVED: ++self->responses_; break;
        default: break;
        }
        self->ready_.notify_all();
    }

public:
    CancellableWinHttp(HINTERNET handle, const http_transport::Cancellation& cancellation)
        : handle_(handle), cancellation_(cancellation) { configure(); }

    // Keeps the original entry point usable when an individual caller migration is reverted.
    explicit CancellableWinHttp(HINTERNET handle) : handle_(handle),
        legacyState_(request_cancel::current ? request_cancel::current : std::make_shared<request_cancel::State>()),
        cancellation_{{}, &legacyState_->cancelled, legacyState_->deadline} { configure(); }
    CancellableWinHttp(const CancellableWinHttp&) = delete;
    CancellableWinHttp& operator=(const CancellableWinHttp&) = delete;
    ~CancellableWinHttp() { close(); }
    bool configured() const { return configured_; }
    bool isOpen() const { return handle_ != nullptr; }

    void close() {
        if (!handle_) return;
        const auto handle = handle_;
        handle_ = nullptr;
        WinHttpCloseHandle(handle);
        if (configured_) {
            std::unique_lock lock(mutex_);
            ready_.wait(lock, [&] { return closed_; });
        }
    }

private:
    void configure() {
        DWORD_PTR context = reinterpret_cast<DWORD_PTR>(this);
        configured_ = WinHttpSetOption(handle_, WINHTTP_OPTION_CONTEXT_VALUE, &context, sizeof(context)) &&
            WinHttpSetStatusCallback(handle_, callback, WINHTTP_CALLBACK_FLAG_ALL_COMPLETIONS |
                WINHTTP_CALLBACK_FLAG_HANDLES | WINHTTP_CALLBACK_FLAG_REDIRECT |
                WINHTTP_CALLBACK_STATUS_RESPONSE_RECEIVED, 0) != WINHTTP_INVALID_STATUS_CALLBACK;
    }

public:
    template<class Start>
    DWORD run(Start start, DWORD expected, DWORD* received = nullptr) {
        if (cancellation_.stopped()) return ERROR_WINHTTP_OPERATION_CANCELLED;
        {
            std::lock_guard lock(mutex_);
            status_ = bytes_ = error_ = 0;
        }
        if (!start()) return GetLastError();
        std::unique_lock lock(mutex_);
        for (;;) {
            if (cancellation_.stopped()) {
                lock.unlock();
                close();
                return ERROR_WINHTTP_OPERATION_CANCELLED;
            }
            if (status_ == expected || error_) break;
            ready_.wait_for(lock, std::chrono::milliseconds(50));
        }
        if (received) *received = bytes_;
        return error_;
    }

    bool send(const wchar_t* headers, void* body, DWORD length) {
        if (!configured_) return setError(ERROR_WINHTTP_OPERATION_CANCELLED);
        return setError(run([&] {
            return WinHttpSendRequest(handle_, headers, static_cast<DWORD>(-1), body, length, length, 0);
        }, WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE));
    }

    bool receive() {
        return setError(run([&] { return WinHttpReceiveResponse(handle_, nullptr); }, WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE));
    }

    bool available(DWORD& bytes) {
        return setError(run([&] { return WinHttpQueryDataAvailable(handle_, nullptr); }, WINHTTP_CALLBACK_STATUS_DATA_AVAILABLE, &bytes));
    }

    bool read(void* buffer, DWORD size, DWORD& bytes) {
        return setError(run([&] { return WinHttpReadData(handle_, buffer, size, nullptr); }, WINHTTP_CALLBACK_STATUS_READ_COMPLETE, &bytes));
    }

    bool canReuse() {
        // WinHTTP stores automatic cookies per session. An exclusive lease keeps them
        // available for redirects within this request without carrying them to the next.
        {
            std::lock_guard lock(mutex_);
            if (redirected_ || responses_ > 1) return false;
        }
        DWORD size = 0;
        WinHttpQueryHeaders(handle_, WINHTTP_QUERY_SET_COOKIE, WINHTTP_HEADER_NAME_BY_INDEX,
            nullptr, &size, WINHTTP_NO_HEADER_INDEX);
        const auto error = GetLastError();
        return error == ERROR_WINHTTP_HEADER_NOT_FOUND;
    }

private:
    static bool setError(DWORD error) {
        if (error) SetLastError(error);
        return error == 0;
    }
};

#endif
