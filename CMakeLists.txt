cmake_minimum_required(VERSION 3.10)
project(UbikaDaemon CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# libtorrent via vcpkg: configure com -DCMAKE_TOOLCHAIN_FILE=<vcpkg>/scripts/buildsystems/vcpkg.cmake
find_package(libtorrent CONFIG REQUIRED)

# Daemon HTTP antigo (stub de health check)
add_executable(daemon daemon.cpp)
target_link_libraries(daemon PRIVATE Ws2_32)

# Backend libtorrent: POST /download?magnet=... | GET /downloads | GET /status
add_executable(ubika-torrentd Torrent.cpp)
target_link_libraries(ubika-torrentd PRIVATE libtorrent::torrent Ws2_32)
