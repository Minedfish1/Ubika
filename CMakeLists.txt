cmake_minimum_required(VERSION 3.10)
project(UbikaDaemon)

set(CMAKE_CXX_STANDARD 17)

find_package(libtorrent CONFIG REQUIRED)

add_executable(daemon daemon.cpp)

target_link_libraries(daemon PRIVATE libtorrent::torrent Ws2_32)