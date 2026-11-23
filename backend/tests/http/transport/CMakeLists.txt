cmake_minimum_required(VERSION 3.16)
project(http_transport_tests LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "The WinHTTP fixtures require Windows")
endif()

add_executable(http-transport-tests main.cpp ../../../src/http/HttpTransport.cpp)
target_compile_features(http-transport-tests PRIVATE cxx_std_20)
target_compile_definitions(http-transport-tests PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN LLMCHAT_HTTP_TRANSPORT_TEST)
target_include_directories(http-transport-tests PRIVATE ../../../src)
target_link_libraries(http-transport-tests PRIVATE winhttp)
