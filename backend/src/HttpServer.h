#pragma once

#include "Config.h"
#include "ConversationManager.h"
#include "PricingStore.h"
#include "OcrModelStore.h"
#include "UsageStore.h"


class HttpServer {
public:
    HttpServer(ConfigStore& config, ConversationManager& conversations);
    int run();

private:
    ConfigStore& config_;
    ConversationManager& conversations_;
    UsageStore usage_;
    PricingStore pricing_;
    OcrModelStore ocrModels_;
};
