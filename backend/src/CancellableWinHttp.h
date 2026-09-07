#pragma once

#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#include <condition_variable>
#include "RequestCancellation.h"

// WinHTTP async operations, awaited on the existing bounded HTTP worker. Only
// this worker closes the handle, after the API call returned; HANDLE_CLOSING
// keeps callback context and caller-owned buffers alive through cancellation.
class CancellableWinHttp {
    HINTERNET handle_;
    std::mutex mutex_;
    std::condition_variable ready_;
    DWORD status_ = 0;
    DWORD bytes_ = 0;
    DWORD error_ = 0;
    bool closed_ = false;
    bool configured_ = false;
    std::shared_ptr<request_cancel::State> cancellation_ = request_cancel::current
        ? request_cancel::current : std::make_shared<request_cancel::State>();

    static void CALLBACK callback(HINTERNET, DWORD_PTR context, DWORD status,
                                  void* info, DWORD length) {
        auto* self = reinterpret_cast<CancellableWinHttp*>(context);
        if (!self) return;
        std::lock_guard lock(self->mutex_);
        if (status == WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING) self->closed_ = true;
        else if (status == WINHTTP_CALLBACK_STATUS_REQUEST_ERROR) {
            self->error_ = static_cast<WINHTTP_ASYNC_RESULT*>(info)->dwError;
            self->status_ = status;
        } else if (status == WINHTTP_CALLBACK_STATUS_DATA_AVAILABLE) {
            self->bytes_ = *static_cast<DWORD*>(info);
            self->status_ = status;
        } else if (status == WINHTTP_CALLBACK_STATUS_READ_COMPLETE) {
            self->bytes_ = length;
            self->status_ = status;
        } else if (status == WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE ||
                   status == WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE) self->status_ = status;
        self->ready_.notify_all();
    }
    void reset() { std::lock_guard lock(mutex_); status_ = bytes_ = error_ = 0; }
    bool wait(BOOL started, DWORD expected) {
        if (!started) return false;
        std::unique_lock lock(mutex_);
        for (;;) {
            if (cancellation_->stopped()) {
                lock.unlock();
                close();
                SetLastError(ERROR_WINHTTP_OPERATION_CANCELLED);
                return false;
            }
            if (status_ == expected || error_) break;
            ready_.wait_for(lock, std::chrono::milliseconds(50));
        }
        if (error_) SetLastError(error_);
        return !error_;
    }
public:
    explicit CancellableWinHttp(HINTERNET handle) : handle_(handle) {
        DWORD_PTR context = reinterpret_cast<DWORD_PTR>(this);
        configured_ = WinHttpSetOption(handle_, WINHTTP_OPTION_CONTEXT_VALUE,
                                      &context, sizeof(context)) &&
            WinHttpSetStatusCallback(handle_, callback,
                WINHTTP_CALLBACK_FLAG_ALL_COMPLETIONS | WINHTTP_CALLBACK_FLAG_HANDLES, 0)
                != WINHTTP_INVALID_STATUS_CALLBACK;
    }
    ~CancellableWinHttp() { close(); }
    CancellableWinHttp(const CancellableWinHttp&) = delete;
    CancellableWinHttp& operator=(const CancellableWinHttp&) = delete;
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
    bool send(const wchar_t* headers, void* body, DWORD length) {
        if (!configured_ || cancellation_->stopped()) {
            SetLastError(ERROR_WINHTTP_OPERATION_CANCELLED); return false;
        }
        reset();
        return wait(WinHttpSendRequest(handle_, headers, static_cast<DWORD>(-1),
            body, length, length, reinterpret_cast<DWORD_PTR>(this)),
            WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE);
    }
    bool receive() {
        reset();
        return wait(WinHttpReceiveResponse(handle_, nullptr), WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE);
    }
    bool available(DWORD& bytes) {
        reset();
        const bool ok = wait(WinHttpQueryDataAvailable(handle_, nullptr), WINHTTP_CALLBACK_STATUS_DATA_AVAILABLE);
        bytes = bytes_; return ok;
    }
    bool read(void* buffer, DWORD size, DWORD& bytes) {
        reset();
        const bool ok = wait(WinHttpReadData(handle_, buffer, size, nullptr), WINHTTP_CALLBACK_STATUS_READ_COMPLETE);
        bytes = bytes_; return ok;
    }
};
#endif
