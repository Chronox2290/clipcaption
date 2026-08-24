# Builds extract-embedding.exe against the sherpa-onnx "static" Windows
# release archive that scripts/get-sidecars.ps1 already fetches (it ships
# headers + .lib files, but no prebuilt tool that does this - see
# extract_embedding.cpp's top comment for why this needs to exist at all).
#
# Invoked from CI (see .github/workflows/release.yml) as:
#   cmake -B build -DSHERPA_ONNX_DIR=<path to the extracted release archive>
#   cmake --build build --config Release
#
# Verified compiling + running correctly (against the equivalent Linux
# shared-library release, for local testing - Windows static libs can only
# actually be linked on a Windows/MSVC toolchain) before this was wired into
# CI; see the build log for the details.

cmake_minimum_required(VERSION 3.16)
project(extract_embedding CXX)

if(NOT DEFINED SHERPA_ONNX_DIR)
  message(FATAL_ERROR "Pass -DSHERPA_ONNX_DIR=<path to extracted sherpa-onnx static release>")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(extract-embedding extract_embedding.cpp)
target_include_directories(extract-embedding PRIVATE "${SHERPA_ONNX_DIR}/include")

# Link every .lib in the release's lib/ directory rather than hand-picking
# the exact transitive set: MSVC's linker (unlike GNU ld) doesn't care about
# link order or about libraries with no referenced symbols, so this is a
# strictly lower-risk choice than trying to reproduce the project's own
# pkg-config Libs: line by hand and possibly missing one.
file(GLOB SHERPA_ONNX_LIBS "${SHERPA_ONNX_DIR}/lib/*.lib")
target_link_libraries(extract-embedding PRIVATE ${SHERPA_ONNX_LIBS})

if(WIN32)
  # onnxruntime's static build needs Windows' crypto RNG (BCryptGenRandom)
  # for its own internals; MSVC's other usual implicit dependencies
  # (kernel32/advapi32/ole32/...) are already in its default library set.
  target_link_libraries(extract-embedding PRIVATE bcrypt)
endif()

# Fully static CRT: matches how the sherpa-onnx binaries themselves are
# built (no accompanying DLLs at all in the release archive - verified by
# listing it), so this tool needs no extra runtime redistributable either.
if(MSVC)
  set_property(TARGET extract-embedding PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()
