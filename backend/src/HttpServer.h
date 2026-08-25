#pragma once

#include "Config.h"
#include "ConversationManager.h"
#include "PricingStore.h"
#include "OcrModelStore.h"
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
    std::unique_ptr<PricingStore> pricing_;
    std::unique_ptr<OcrModelStore> ocrModels_;
};
