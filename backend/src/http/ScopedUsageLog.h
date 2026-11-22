#pragma once

#include "UsageStore.h"

#include <utility>

namespace http_router
{
/** Writes markPending on construction and finalize on destruction (same event id). */
class ScopedUsageLog {
public:
    ScopedUsageLog(UsageStore& store, UsageEvent ev)
        : store_(store), ev_(std::move(ev))
    {
        store_.markPending(ev_);
    }

    ~ScopedUsageLog()
    {
        store_.finalize(ev_);
    }

    UsageEvent& ev() { return ev_; }

    ScopedUsageLog(const ScopedUsageLog&) = delete;
    ScopedUsageLog& operator=(const ScopedUsageLog&) = delete;

private:
    UsageStore& store_;
    UsageEvent ev_;
};
}
