cmake_minimum_required(VERSION 3.16)
project(game_image_export_tests LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "The image export fixtures require Windows")
endif()

add_executable(game-image-export-tests main.cpp ../../src/GameImageExportConfirmation.cpp ../../src/GameImageExportPackage.cpp ../../src/GameImageExportSelection.cpp ../../src/GameImageExportTransaction.cpp)
target_compile_features(game-image-export-tests PRIVATE cxx_std_20)
target_compile_definitions(game-image-export-tests PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
target_compile_options(game-image-export-tests PRIVATE /utf-8)
target_include_directories(game-image-export-tests PRIVATE ../../src ../../third_party)
target_link_libraries(game-image-export-tests PRIVATE pathcch)
