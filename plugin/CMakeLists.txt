cmake_minimum_required(VERSION 3.16...3.28)

project(stream-live-translate-obs VERSION 0.7.0 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# ---------------------------------------------------------------------------
# OBS SDK. We only need the libobs *headers* plus something to satisfy the
# linker; real symbols resolve at runtime against the OBS installation.
#
#   -DLIBOBS_INCLUDE_DIR=<obs-studio source>/libobs
#
# Windows additionally wants an import library generated from the installed
# obs.dll (see scripts/package-plugin.ps1):
#   -DOBS_IMPORT_LIB=<path>/obs.lib
#
# Linux links a stub shared library with soname libobs.so.0:
#   -DOBS_STUB_LIB=<path>/libobs.so
#
# macOS uses -undefined dynamic_lookup and needs nothing extra.
#
# Version compatibility (OBS 30+):
#   Headers from ANY 30+ tag are fine. plugin/stream-live-translate.c calls
#   obs_register_source_s(info, size); libobs copies only `size` bytes into
#   its own (possibly larger) struct and zeroes the remaining fields. That
#   is libobs' official ABI contract, so a single module built here loads on
#   OBS 30, 31, 32, 33 and later. Only the Windows import library has to
#   match the installed obs.dll, which package-plugin.ps1 regenerates from
#   the real DLL on every build.
# ---------------------------------------------------------------------------

if(NOT LIBOBS_INCLUDE_DIR)
  message(FATAL_ERROR
    "LIBOBS_INCLUDE_DIR is not set. Point it at an obs-studio checkout's "
    "libobs/ directory (headers only, no build required).")
endif()

add_library(stream-live-translate MODULE stream-live-translate.c)
target_include_directories(stream-live-translate PRIVATE "${LIBOBS_INCLUDE_DIR}")
set_target_properties(stream-live-translate PROPERTIES
  PREFIX ""
  OUTPUT_NAME "stream-live-translate")

if(WIN32)
  target_link_libraries(stream-live-translate PRIVATE ws2_32)
  if(OBS_IMPORT_LIB)
    target_link_libraries(stream-live-translate PRIVATE "${OBS_IMPORT_LIB}")
  else()
    message(FATAL_ERROR
      "OBS_IMPORT_LIB is not set. Generate obs.lib from obs.dll with "
      "dumpbin+lib (see scripts/package-plugin.ps1).")
  endif()
elseif(APPLE)
  find_package(Threads REQUIRED)
  target_link_libraries(stream-live-translate PRIVATE Threads::Threads)
  target_link_options(stream-live-translate PRIVATE "-undefined" "dynamic_lookup")
  set_target_properties(stream-live-translate PROPERTIES SUFFIX "")
else()
  find_package(Threads REQUIRED)
  target_link_libraries(stream-live-translate PRIVATE Threads::Threads)
  if(OBS_STUB_LIB)
    target_link_libraries(stream-live-translate PRIVATE "${OBS_STUB_LIB}")
  else()
    message(FATAL_ERROR
      "OBS_STUB_LIB is not set. Create a stub libobs.so with soname "
      "libobs.so.0 (see scripts/package-plugin.sh).")
  endif()
endif()

if(MSVC)
  target_compile_options(stream-live-translate PRIVATE /W3)
else()
  target_compile_options(stream-live-translate PRIVATE -Wall -Wextra -Wno-unused-parameter)
endif()
