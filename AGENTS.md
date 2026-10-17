# AGENTS.md — Ubika

Contexto completo do projeto para agentes de IA. **Este arquivo contém segredos reais — mantenha o repositório privado.**

## O que é o Ubika

Plataforma integrada de **gaming remoto + downloads remotos**:

- **PC Windows** = host (daemon Node.js empacotado em `UbikaPC.exe`): gerencia Sunshine (stream), display virtual na resolução do celular, downloads torrent/HTTP, catálogo de jogos, pareamento.
- **Android** = cliente (Kotlin/Compose): navega catálogo, inicia/monitora downloads no PC, abre Moonlight no host certo, gamepad-friendly.
- **VPS** = só matchmaking + contas + signaling. **O vídeo NÃO passa pela VPS** — Moonlight↔Sunshine direto. Não usar Tailscale/relay (decisão do usuário: latência).

## Arquitetura

```
Android app ──HTTPS──> VPS (Express+SQLite+Socket.IO)
    │                      │ registra PC / casa o par
    │                      v
    │                 PC daemon (UbikaPC.exe) ──> Sunshine instalado
    └──── Moonlight ──> vídeo direto (Sunshine:47984+)
```

### Componentes

| Peça | Local | Stack |
|---|---|---|
| VPS backend | `server/server.js` | Node/Express, SQLite (`better-sqlite3`), Socket.IO, PM2 |
| PC daemon | `UbikaPc/client.js` | Node SEA single-exe, Socket.IO client, extrai assets em `%LOCALAPPDATA%\Ubika` |
| Downloads | `UbikaPc/downloads.js` | qBittorrent WebUI (se instalado) → WebTorrent fallback → HTTP direto |
| Catálogo | `UbikaPc/library.js` | JSONs Hydra-style, `groupKey` dedup, RAWG via VPS |
| Display virtual | `UbikaPc/stream/*.ps1` | MttVDD (IddCx), pipe `\\.\pipe\MTTVirtualDisplayPipe`, CCD `SetDisplayConfig` |
| Android | repo `Ubika-mobile` | Kotlin/Compose, Coil, Socket.IO client |

## Infraestrutura e credenciais

- **VPS**: `http://18.223.108.137:3000` — Ubuntu, Node via PM2 (processo PM2 chama `server`, não `ubika-server`)
- **SSH VPS**: `ssh -i C:\Users\Ian\Downloads\ubika-keys.pem ubuntu@18.223.108.137`
- **Shared secret** (header `x-ubika-key` p/ rotas PC↔VPS): `b52a5e77a138693161e2850f9db889af1a9872378acc94f5594fa0daf33b346a`
- **Sessão**: header `x-ubika-session`; validar via `GET /api/auth/me`
- **Admin seed**: `admin@gmail.com` / `IGsv050706` — único usuário seed do banco
- **DB**: `~/ubika.db` na VPS (SQLite). Tabelas: users, pcs, game_meta, subs. `game_meta.descriptionPt` = cache pt-BR
- **Repos**: `github.com/Minedfish1/Ubika` (este) e `github.com/Minedfish1/Ubika-mobile` (app). Push funciona (credential manager configurado)

## Endpoints principais (VPS)

- `POST /api/auth/register|login` · `GET /api/auth/me` · `POST /api/me {name}` (persiste displayName)
- Avatar: `POST /api/me/avatar {b64}` → serve `GET /avatars/<uid>.jpg`
- `GET /api/trending?genre=<slug>` — RAWG; horror é **tag** não gênero; cache por categoria; enrich via `rawgEnrich` (Steam `l=brazilian` → fallback MyMemory p/ pt-BR)
- `GET /api/pc/status` → `online`, `streamHost` (IPv4), `streamHostV6`, `portsOpen` (VPS prova TCP 47984 de fora, máx 1x/10min)
- `GET /api/stream` → host p/ Moonlight. Ordem de preferência: IPv6 público > IPv4 público > LAN
- `POST /api/pc/download` — roteia `iniciar_download` ao PC registrado
- `GET /covers/<slug>.jpg` — espelha capa RAWG em `~/covers/` na 1ª vez, depois serve do disco

## Eventos Socket.IO

- Android → VPS → PC: `preparar_stream {w,h,fps}`, `iniciar_download {magnet|url,title,coverUrl,description}`, `launch_game {path}`, `restaurar_display`
- PC registra com `registrar_pc` incluindo `ipv6` público; VPS prova portas
- Pareamento: código de 6 dígitos rotativo, persistido em `C:\Users\Ian\AppData\Local\Ubika\PAREAR.txt`

## Display virtual (parte mais frágil — foi depurada a fundo)

Driver: **MttVDD** (`VirtualDrivers/Virtual-Display-Driver`), IddCx/UMDF. Instalado em `C:\VirtualDisplayDriver\` (dll, inf, cer, cat, `vdd_settings.xml`).

**Receita que funciona** (testada ao vivo 2460×1080@120):

Attach (`display-attach.ps1`):
1. Injeta a resolução como PRIMEIRO `<resolution>` do `vdd_settings.xml`
2. `SETDISPLAYCOUNT 0` → `SETDISPLAYCOUNT 1` no pipe `\\.\pipe\MTTVirtualDisplayPipe` (UTF-16LE, one-shot) — recria o monitor, que **auto-anexa** e expõe os modos do XML
3. Acha o display via `EnumDisplayDevices` (`str='Virtual Display Driver'` ou `id~Root\MttVDD`)
4. `ChangeDisplaySettingsEx` aplica WxH@Fps
5. Desanexa a tela física (DEVMODE `W=H=0` + `DM_POSITION`, `CDS_UPDATEREGISTRY|NORESET` + flush NULL) → virtual vira única+primária

Detach (`display-detach.ps1`):
1. Desanexa o virtual (mesmo W=H=0)
2. `SETDISPLAYCOUNT 0` no pipe
3. `SetDisplayConfig(SDC_TOPOLOGY_EXTEND|SDC_APPLY = 0x84)` — física volta sozinha como primária

**Armadilhas conhecidas**:
- PowerShell 5.1 exige **UTF-8 com BOM** — sem BOM, em-dash/acentos viram mojibake e quebram o parser silenciosamente
- `EnumDisplayDevices($null,...)` falha — `$null` vira `""`; usar `[IntPtr]::Zero` e `cb=int` inicializado
- IddCx **não pode ser primário** (CDS_SET_PRIMARY no-op) — por isso desanexamos a física
- IddCx não responde `EnumDisplaySettings` quando desanexado; CDS_EX direto dá BADPARAM -5
- `pnputil /add-driver` só faz staging — o dispositivo raiz precisa ser criado (`create-vdd-device.ps1`, SetupAPI `UpdateDriverForPlugAndPlayDevices`, cria `ROOT\MTTVDD\0000`)
- Classes C# em scripts que rodam na mesma sessão precisam de nomes únicos (Add-Type colide)
- Escrever `C:\VirtualDisplayDriver\vdd_settings.xml` pede admin — o daemon/Sunshine elevados cuidam disso
- Dispositivos: `ROOT\MTTVDD\0000` (adaptador Display), `DISPLAY\MTT1337\...` (monitor filho)

## Downloads

- Magnet → injeta trackers públicos (`opentrackr`, `openbittorrent`...) + DHT. **Sem isso trava em `torrent not registered`** — trackers privados das fontes rejeitam hashes desconhecidos (não é problema de conta)
- Jogos salvos em `C:\UbikaGames\<Nome>\` + `meta.json` (capa/descrição que o app manda no payload)
- qBittorrent WebUI se instalado; senão WebTorrent; HTTP direto p/ links não-magnet

## Catálogo

- `library.js`: `groupKey` corta título no primeiro token de versão (`v1.4`, repack, "free download", builds) → 1 card/jogo (~19.6k). Dentro do grupo, **1 versão por fonte** (a mais nova)
- App: `CatalogScreen.kt` — pódio top-3 semanal + "EM ALTA" + prateleiras por gênero (AÇÃO/TERROR/AVENTURA/RPG/TIRO/CORRIDA), cards ~84×112dp
- Jogo trending chega sem `versions` → app busca na biblioteca pelo título ao abrir o detalhe

## Build / comandos

```bash
# Exe do PC (mate o processo antes — ele trava o arquivo)
taskkill /F /IM UbikaPC.exe
cd UbikaPc && node build-exe.js   # Node SEA + postject

# Android (JAVA_HOME aponta pro JBR do Android Studio — PATH não tem java)
export JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"
cd Ubika-mobile && ./gradlew assembleDebug

# ADB: C:\Users\Ian\AppData\Local\Android\Sdk\platform-tools\adb.exe

# Deploy VPS
scp -i ~/.ubika/keys/ubika-keys.pem server/server.js ubuntu@18.223.108.137:~/
ssh -i ~/.ubika/keys/ubika-keys.pem ubuntu@18.223.108.137 'pm2 restart server'

# Teste attach (admin, aceita UAC)
powershell -File UbikaPc\stream\display-attach.ps1 -Width 2460 -Height 1080 -Fps 120
# Logs: C:\ProgramData\Ubika\display-attach.log / display-detach.log
```

## Regras do usuário (importantes)

- Vídeo sempre **direto** Moonlight↔Sunshine; VPS só casa o par uma vez — sem relay/mesh
- Resolução do stream = resolução exata do celular (atual: `2460x1080@120`, o app anuncia `realDeviceRes`)
- Um instalador Windows + um APK Play Store cobrem tudo
- UI do app em pt-BR; descrições de jogos localizadas (Steam `l=brazilian` → MyMemory fallback)
- Commits com trailer `Generated with Devin`
