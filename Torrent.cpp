// Ubika Torrent Daemon (backend libtorrent)
// API HTTP local:
//   POST /download?magnet=<urlencoded>   -> inicia download { ok, id }
//   GET  /downloads                    -> snapshot JSON de todos os torrents
//   GET  /status                       -> health check
#include <iostream>
#include <string>
#include <vector>
#include <mutex>
#include <map>
#include <winsock2.h>
#include <ws2tcpip.h>

// Includes do libtorrent (baixado via vcpkg)
#include <libtorrent/session.hpp>
#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/torrent_handle.hpp>
#include <libtorrent/alert_types.hpp>
#include <libtorrent/magnet_uri.hpp>
#include <libtorrent/torrent_status.hpp>
#include <libtorrent/info_hash.hpp>

#pragma comment(lib, "Ws2_32.lib")

#define PORT 8080

// Sessão única compartilhada (um lt::session por processo, não por torrent)
static lt::session g_session;
static std::mutex g_mutex;
static std::map<std::string, lt::torrent_handle> g_torrents; // infoHash -> handle
static std::map<std::string, std::string> g_names;           // infoHash -> gameName

static std::string jsonEscape(const std::string& s) {
    std::string out;
    for (char c : s) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default: out += c;
        }
    }
    return out;
}

static std::string urlDecode(const std::string& in) {
    std::string out;
    for (size_t i = 0; i < in.size(); ++i) {
        if (in[i] == '%' && i + 2 < in.size()) {
            int hi = isdigit(in[i+1]) ? in[i+1]-'0' : tolower(in[i+1])-'a'+10;
            int lo = isdigit(in[i+2]) ? in[i+2]-'0' : tolower(in[i+2])-'a'+10;
            out += (char)(hi * 16 + lo);
            i += 2;
        } else if (in[i] == '+') {
            out += ' ';
        } else {
            out += in[i];
        }
    }
    return out;
}

static void sendJson(SOCKET s, const std::string& body, const char* status = "200 OK") {
    std::string resp = std::string("HTTP/1.1 ") + status + "\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n"
        "Connection: close\r\n\r\n" + body;
    send(s, resp.c_str(), (int)resp.length(), 0);
}

static std::string downloadsSnapshot() {
    std::lock_guard<std::mutex> lock(g_mutex);
    std::string out = "{\"downloads\":[";
    bool first = true;
    for (auto& [hash, h] : g_torrents) {
        if (!h.is_valid()) continue;
        lt::torrent_status st = h.status();
        if (!first) out += ",";
        first = false;
        out += "{";
        out += "\"id\":\"" + hash + "\"";
        out += ",\"gameName\":\"" + jsonEscape(g_names[hash]) + "\"";
        out += ",\"name\":\"" + jsonEscape(st.name) + "\"";
        out += ",\"progress\":" + std::to_string(st.progress * 100.0);
        out += ",\"downSpeed\":" + std::to_string(st.download_rate);
        out += ",\"upSpeed\":" + std::to_string(st.upload_rate);
        out += ",\"peers\":" + std::to_string(st.num_peers);
        out += ",\"finished\":" + std::string(st.is_finished ? "true" : "false");
        out += ",\"paused\":" + std::string(st.paused ? "true" : "false");
        out += "}";
    }
    out += "]}";
    return out;
}

static std::string addTorrent(const std::string& magnet, const std::string& name) {
    try {
        lt::add_torrent_params atp;
        lt::error_code ec;
        lt::parse_magnet_uri(magnet, atp, ec);
        if (ec) return "{\"ok\":false,\"error\":\"" + jsonEscape(ec.message()) + "\"}";

        atp.save_path = "C:\\UbikaGames\\Downloads";

        lt::torrent_handle h;
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            h = g_session.add_torrent(atp, ec);
        }
        if (ec) return "{\"ok\":false,\"error\":\"" + jsonEscape(ec.message()) + "\"}";

        std::ostringstream oss;
        oss << h.info_hash();
        std::string hash = oss.str();
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            g_torrents[hash] = h;
            g_names[hash] = name;
        }
        std::cout << "[TORRENT] adicionado: " << name << " (" << hash << ")\n";
        return "{\"ok\":true,\"id\":\"" + hash + "\"}";
    } catch (const std::exception& e) {
        return std::string("{\"ok\":false,\"error\":\"") + jsonEscape(e.what()) + "\"}";
    }
}

// Extrai ?magnet=...&name=... do request-target
static std::string getParam(const std::string& target, const std::string& key) {
    auto pos = target.find(key + "=");
    if (pos == std::string::npos) return "";
    pos += key.size() + 1;
    auto end = target.find('&', pos);
    return urlDecode(target.substr(pos, end == std::string::npos ? end : end - pos));
}

void handleClient(SOCKET clientSocket) {
    char buffer[8192] = {0};
    int n = recv(clientSocket, buffer, sizeof(buffer) - 1, 0);
    if (n <= 0) { closesocket(clientSocket); return; }
    std::string request(buffer, n);

    // Linha 1: "METHOD /path?query HTTP/1.1"
    auto sp1 = request.find(' ');
    auto sp2 = request.find(' ', sp1 == std::string::npos ? sp1 : sp1 + 1);
    std::string method = sp1 == std::string::npos ? "" : request.substr(0, sp1);
    std::string target = sp2 == std::string::npos ? "" : request.substr(sp1 + 1, sp2 - sp1 - 1);

    if (method == "POST" && target.rfind("/download", 0) == 0) {
        std::string magnet = getParam(target, "magnet");
        std::string name = getParam(target, "name");
        if (magnet.rfind("magnet:", 0) != 0) {
            sendJson(clientSocket, "{\"ok\":false,\"error\":\"INVALID_MAGNET\"}", "400 Bad Request");
        } else {
            sendJson(clientSocket, addTorrent(magnet, name.empty() ? "download" : name));
        }
    } else if (method == "GET" && target.rfind("/downloads", 0) == 0) {
        sendJson(clientSocket, downloadsSnapshot());
    } else {
        sendJson(clientSocket, "{\"status\":\"online\",\"daemon\":\"Ubika Torrent Daemon\"}");
    }

    closesocket(clientSocket);
}

int main() {
    // Configura alerts mínimos da sessão global
    lt::settings_pack pack;
    pack.set_int(lt::settings_pack::alert_mask,
        lt::alert::status_notification | lt::alert::error_notification);
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_session.apply_settings(pack);
    }

    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
        std::cerr << "Falha ao iniciar o Winsock.\n";
        return 1;
    }

    SOCKET serverSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (serverSocket == INVALID_SOCKET) {
        std::cerr << "Falha ao criar o socket.\n";
        WSACleanup();
        return 1;
    }

    int opt = 1;
    setsockopt(serverSocket, SOL_SOCKET, SO_REUSEADDR, (const char*)&opt, sizeof(opt));

    sockaddr_in serverAddr{};
    serverAddr.sin_family = AF_INET;
    serverAddr.sin_addr.s_addr = INADDR_ANY;
    serverAddr.sin_port = htons(PORT);

    if (bind(serverSocket, (sockaddr*)&serverAddr, sizeof(serverAddr)) == SOCKET_ERROR) {
        std::cerr << "Falha no bind da porta " << PORT << ".\n";
        closesocket(serverSocket);
        WSACleanup();
        return 1;
    }

    if (listen(serverSocket, SOMAXCONN) == SOCKET_ERROR) {
        std::cerr << "Falha ao escutar na porta.\n";
        closesocket(serverSocket);
        WSACleanup();
        return 1;
    }

    std::cout << "[UBIKA TORRENT DAEMON] libtorrent ouvindo na porta " << PORT << "...\n";

    while (true) {
        SOCKET clientSocket = accept(serverSocket, NULL, NULL);
        if (clientSocket != INVALID_SOCKET) {
            handleClient(clientSocket);
        }
    }

    closesocket(serverSocket);
    WSACleanup();
    return 0;
}
