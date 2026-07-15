#pragma once

#include "Config.h"
#include "ConversationManager.h"

class HttpServer {
public:
    HttpServer(ConfigStore& config, ConversationManager& conversations);
    int run();

private:
    ConfigStore& config_;
    ConversationManager& conversations_;
};
