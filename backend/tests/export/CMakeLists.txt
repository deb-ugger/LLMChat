cmake_minimum_required(VERSION 3.16)
project(game_image_export_tests LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "The image export fixtures require Windows")
endif()

add_library(game-image-export-fixture-core STATIC
    ../../src/GameImageExportConfirmation.cpp ../../src/GameImageExportPackage.cpp
    ../../src/GameImageExportSelection.cpp ../../src/GameImageExportTransaction.cpp)
target_compile_features(game-image-export-fixture-core PUBLIC cxx_std_20)
target_compile_definitions(game-image-export-fixture-core PUBLIC NOMINMAX WIN32_LEAN_AND_MEAN)
target_compile_options(game-image-export-fixture-core PUBLIC /utf-8)
target_include_directories(game-image-export-fixture-core PUBLIC ../../src ../../third_party)
target_link_libraries(game-image-export-fixture-core PUBLIC pathcch)

add_executable(game-image-export-tests main.cpp)
target_link_libraries(game-image-export-tests PRIVATE game-image-export-fixture-core)

add_executable(game-image-export-http-fixture http-fixture.cpp
    ../../src/http/ExportRoutes.cpp ../../src/http/HttpRouter.cpp)
target_link_libraries(game-image-export-http-fixture PRIVATE game-image-export-fixture-core ws2_32)
