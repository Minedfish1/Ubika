#include <iostream>
#include <string>
#include <thread>
#include <chrono>
#include <winsock2.h>
#include <ws2tcpip.h>

// Includes do libtorrent (baixado via vcpkg)
#include <libtorrent/session.hpp>
#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/torrent_handle.hpp>
#include <libtorrent/alert_types.hpp>

#pragma comment(lib, "Ws2_32.lib")

#define PORT 8080

// Função que roda em background para gerenciar o download do torrent
void backgroundTorrentTask(std::string magnetLink) {
    try {
        lt::settings_pack pack;
        pack.set_int(lt::settings_pack::alert_mask, lt::alert::status_notification | lt::alert::error_notification);
        lt::session ses(pack);

        lt::add_torrent_params atp;
        lt::parse_magnet_uri(magnetLink, atp);
        
        // Pasta onde os jogos/arquivos serão salvos no PC do usuário
        atp.save_path = "C:\\UbikaGames\\Downloads"; 
        
        lt::torrent_handle h = ses.add_torrent(atp);
        std::cout << "[TORRENT THREAD] Download iniciado para o magnet: " << magnetLink << "\n";

        bool baixando = true;
        while (baixando) {
            lt::torrent_status s = h.status();

            // Imprime o progresso no console do PC em background
            std::cout << "\rProgresso: " << (s.progress * 100) << "% "
                      << "| Taxa: " << (s.download_rate / 1024) << " KB/s " << std::flush;

            if (s.is_finished) {
                std::cout << "\n[TORRENT THREAD] Download concluído com sucesso!\n";
                baixando = false;
            }

            std::this_thread::sleep_for(std::chrono::seconds(2));
        }
    } catch (const std::exception& e) {
        std::cerr << "[ERRO NO TORRENT]: " << e.what() << "\n";
    }
}

// Manipulador das requisições HTTP vindas do app mobile
void handleClient(SOCKET clientSocket) {
    char buffer[2048] = {0};
    recv(clientSocket, buffer, sizeof(buffer), 0);

    std::string request(buffer);

    // Exemplo simulando um endpoint POST /download?magnet=...
    if (request.find("POST /download") != std::string::npos) {
        // Aqui você extrairia o magnet link do corpo da requisição HTTP
        std::string magnetExemplo = "magnet:?xt=urn:btih:exemplo_hash_aqui&dn=JogoExemplo";

        // Dispara o torrent em uma thread separada para não travar a API HTTP
        std::thread(backgroundTorrentTask, magnetExemplo).detach();

        std::string httpResponse = 
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: application/json; charset=UTF-8\r\n"
            "Connection: close\r\n\r\n"
            "{\"status\": \"success\", \"message\": \"Download iniciado em background no PC!\"}";

        send(clientSocket, httpResponse.c_str(), (int)httpResponse.length(), 0);
    } else {
        // Resposta padrão para outros status (ex: GET /status)
        std::string httpResponse = 
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: application/json; charset=UTF-8\r\n"
            "Connection: close\r\n\r\n"
            "{\"status\": \"online\", \"daemon\": \"Ubika PC Core\"}";

        send(clientSocket, httpResponse.c_str(), (int)httpResponse.length(), 0);
    }

    closesocket(clientSocket);
}

int main() {
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

    sockaddr_in serverAddr;
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

    std::cout << "[UBIKA PC CORE] Daemon rodando e escutando na porta " << PORT << "...\n";

    while (true) {
        SOCKET clientSocket = accept(serverSocket, NULL, NULL);
        if (clientSocket != INVALID_SOCKET) {
            handleClient(clientSocket);
        }
    }

    closesocket(serverSocket);
    WSACleanup();
    return 0;
}#iostream>
#string>
#thread>
#chrono>
#winsock2.h>
#ws2tcpip.h>

// Includes do libtorrent (baixado via vcpkg)
#libtorrent/session.hpp>
#libtorrent/add_torrent_params.hpp>
#libtorrent/torrent_handle.hpp>
#libtorrent/alert_types.hpp>

#pragma comment(lib, "Ws2_32.lib")

#define PORT 8080

// Função que roda em background para gerenciar o download do torrent
void backgroundTorrentTask(std::string magnetLink) {
    try {
        lt::settings_pack pack;
        pack.set_int(lt::settings_pack::alert_mask, lt::alert::status_notification | lt::alert::error_notification);
        lt::session ses(pack);

        lt::add_torrent_params atp;
        lt::parse_magnet_uri(magnetLink, atp);
        
        // Pasta onde os jogos/arquivos serão salvos no PC do usuário
        atp.save_path = "C:\\UbikaGames\\Downloads"; 
        
        lt::torrent_handle h = ses.add_torrent(atp);
        std::cout << "[TORRENT THREAD] Download iniciado para o magnet: " << magnetLink << "\n";

        bool baixando = true;
        while (baixando) {
            lt::torrent_status s = h.status();

            // Imprime o progresso no console do PC em background
            std::cout << "\rProgresso: " << (s.progress * 100) << "% "
                      << "| Taxa: " << (s.download_rate / 1024) << " KB/s " << std::flush;

            if (s.is_finished) {
                std::cout << "\n[TORRENT THREAD] Download concluído com sucesso!\n";
                baixando = false;
            }

            std::this_thread::sleep_for(std::chrono::seconds(2));
        }
    } catch (const std::exception& e) {
        std::cerr << "[ERRO NO TORRENT]: " << e.what() << "\n";
    }
}

// Manipulador das requisições HTTP vindas do app mobile
void handleClient(SOCKET clientSocket) {
    char buffer[2048] = {0};
    recv(clientSocket, buffer, sizeof(buffer), 0);

    std::string request(buffer);

    // Exemplo simulando um endpoint POST /download?magnet=...
    if (request.find("POST /download") != std::string::npos) {
        // Aqui você extrairia o magnet link do corpo da requisição HTTP
        std::string magnetExemplo = "magnet:?xt=urn:btih:exemplo_hash_aqui&dn=JogoExemplo";

        // Dispara o torrent em uma thread separada para não travar a API HTTP
        std::thread(backgroundTorrentTask, magnetExemplo).detach();

        std::string httpResponse = 
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: application/json; charset=UTF-8\r\n"
            "Connection: close\r\n\r\n"
            "{\"status\": \"success\", \"message\": \"Download iniciado em background no PC!\"}";

        send(clientSocket, httpResponse.c_str(), (int)httpResponse.length(), 0);
    } else {
        // Resposta padrão para outros status (ex: GET /status)
        std::string httpResponse = 
            "HTTP/1.1 200 OK\r\n"
            "Content-Type: application/json; charset=UTF-8\r\n"
            "Connection: close\r\n\r\n"
            "{\"status\": \"online\", \"daemon\": \"Ubika PC Core\"}";

        send(clientSocket, httpResponse.c_str(), (int)httpResponse.length(), 0);
    }

    closesocket(clientSocket);
}

int main() {
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

    sockaddr_in serverAddr;
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

    std::cout << "[UBIKA PC CORE] Daemon rodando e escutando na porta " << PORT << "...\n";

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