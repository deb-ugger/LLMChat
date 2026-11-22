cmake_minimum_required(VERSION 3.16)
project(llmchat_backend LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(llmchat-backend
    src/main.cpp
    src/Config.cpp
    src/ConversationManager.cpp
    src/http/ConversationRoutes.cpp
    src/LlmClient.cpp
    src/http/LlmRoutes.cpp
    src/TranslateClient.cpp
    src/UnityAutoTranslator.cpp
    src/unity_runtime/UnityGameDetection.cpp
    src/unity_runtime/UnityRuntimeDownload.cpp
    src/unity_runtime/UnityRuntimeFont.cpp
    src/unity_runtime/UnityRuntimePlan.cpp
    src/unity_runtime/UnityRuntimeInstall.cpp
    src/SqliteUsageDb.cpp
    src/UsageStore.cpp
    src/PricingStore.cpp
    src/OcrModelStore.cpp
    src/http/OcrRoutes.cpp
    src/GameImageExportPackage.cpp
    src/GameImageExportTransaction.cpp
    src/HttpServer.cpp
    src/http/HttpRouter.cpp
    src/http/UnityRoutes.cpp
    src/http/TextRoutes.cpp
    src/http/ImageRoutes.cpp
)

target_include_directories(llmchat-backend PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party
)

if(WIN32)
    target_compile_definitions(llmchat-backend PRIVATE
        _CRT_SECURE_NO_WARNINGS
        NOMINMAX
        WIN32_LEAN_AND_MEAN
    )
    target_compile_options(llmchat-backend PRIVATE /utf-8)
    target_link_libraries(llmchat-backend PRIVATE winhttp ws2_32 pathcch)
endif()

install(TARGETS llmchat-backend RUNTIME DESTINATION bin)
