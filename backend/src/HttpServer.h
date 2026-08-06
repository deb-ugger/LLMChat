#pragma once

#include "Config.h"
#include "ConversationManager.h"
#include "UsageStore.h"

#include <memory>

class HttpServer {
public:
    HttpServer(ConfigStore& config, ConversationManager& conversations);
    int run();

private:
    ConfigStore& config_;
    ConversationManager& conversations_;
    std::unique_ptr<UsageStore> usage_;
};
