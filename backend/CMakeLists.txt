cmake_minimum_required(VERSION 3.16)
project(llmchat_backend LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(llmchat-backend
    src/main.cpp
    src/Config.cpp
    src/ConversationManager.cpp
    src/LlmClient.cpp
    src/TranslateClient.cpp
    src/UnityAutoTranslator.cpp
    src/SqliteUsageDb.cpp
    src/UsageStore.cpp
    src/PricingStore.cpp
    src/OcrModelStore.cpp
    src/HttpServer.cpp
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
    target_link_libraries(llmchat-backend PRIVATE winhttp ws2_32)
endif()

install(TARGETS llmchat-backend RUNTIME DESTINATION bin)
