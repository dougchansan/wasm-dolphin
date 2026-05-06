cmake_minimum_required(VERSION 3.23)

project(wasm_dolphin_native_core LANGUAGES CXX)

add_executable(dolphin_web_core dolphin_web_core.cpp)
target_compile_features(dolphin_web_core PRIVATE cxx_std_20)

if (EMSCRIPTEN)
  set_target_properties(dolphin_web_core PROPERTIES
    OUTPUT_NAME "dolphin"
    SUFFIX ".js"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/../../cores/dolphin"
  )

  target_link_options(dolphin_web_core PRIVATE
    "-sWASM=1"
    "-sMODULARIZE=1"
    "-sEXPORT_NAME=createDolphinCore"
    "-sEXPORT_ES6=1"
    "-sENVIRONMENT=web"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sFILESYSTEM=1"
    "-sEXPORTED_FUNCTIONS=['_MountDisc','_Reset','_SetInputMask','_RunFrame','_FrameWidth','_FrameHeight','_FrameBuffer','_SaveState','_LoadState','_GetFrame','_GetGameId','_GetGameTitle','_malloc','_free']"
    "-sEXPORTED_RUNTIME_METHODS=['FS','ccall','cwrap','UTF8ToString','HEAPU8']"
  )
endif()
