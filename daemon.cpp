#include <iostream>
#include <winsock2.h>
#include <ws2tcpip.h>
#include <string>

#pragma comment(lib, "Ws2_32.lib")

#define PORT 8080

void handleClient(SOCKET clientSocket) {
    char buffer[1024] = {0};
    recv(clientSocket, buffer, sizeof(buffer), 0);

    // Resposta HTTP simples simulando o endpoint de status/jogos
    std::string httpResponse = 
        "HTTP/1.1 200 OK\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n"
        "Connection: close\r\n\r\n"
        "{\"status\": \"online\", \"message\": \"Daemon do PC rodando com sucesso!\"}";

    send(clientSocket, httpResponse.c_str(), (int)httpResponse.length(), 0);
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

    std::cout << "[DAEMON] Rodando na porta " << PORT << "...\n";

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