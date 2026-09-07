cmake_minimum_required(VERSION 3.16)
project(llmchat_storage_tests LANGUAGES CXX)
if(NOT WIN32)
    message(FATAL_ERROR "Storage tests use the same winsqlite3.dll as the Windows app.")
endif()
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
add_executable(storage-tests
    main.cpp
    ../../src/SqliteUsageDb.cpp
    ../../src/UsageStore.cpp
    ../../src/ConversationManager.cpp
)
target_include_directories(storage-tests PRIVATE ../../src ../../third_party)
target_compile_definitions(storage-tests PRIVATE _CRT_SECURE_NO_WARNINGS NOMINMAX WIN32_LEAN_AND_MEAN)
target_compile_options(storage-tests PRIVATE /utf-8)
enable_testing()
add_test(NAME storage COMMAND storage-tests)

add_executable(request-cancellation-tests test-request-cancellation.cpp)
target_include_directories(request-cancellation-tests PRIVATE ../../src ../../third_party)
target_compile_definitions(request-cancellation-tests PRIVATE _CRT_SECURE_NO_WARNINGS NOMINMAX WIN32_LEAN_AND_MEAN)
target_compile_options(request-cancellation-tests PRIVATE /utf-8)
target_link_libraries(request-cancellation-tests PRIVATE winhttp ws2_32)
add_test(NAME request-cancellation COMMAND request-cancellation-tests)
set_tests_properties(storage request-cancellation PROPERTIES TIMEOUT 30)
