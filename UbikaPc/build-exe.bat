@echo off
REM Gera ..\UbikaPC.exe (1 clique): bundle esbuild + Node SEA + postject
REM Inclui assets: driver VDD, scripts stream/, catalogo library/ e default.env
setlocal
cd /d %~dp0

echo [0/5] Gera build\default.env (servidor+segredo, sem userId)...
mkdir build 2>nul
(
  echo UBIKA_SERVER=http://18.223.108.137:3000
  findstr /b "UBIKA_SHARED_SECRET=" .env
  echo UBIKA_DOWNLOAD_DIR=C:\UbikaGames\Downloads
  echo UBIKA_SYNC_INTERVAL_MS=21600000
) > build\default.env

echo [1/5] Bundle (esbuild)...
call npx --yes esbuild launcher.js --bundle --platform=node --format=cjs --target=node20 --outfile=build/ubika-pc.cjs --external:utp-native --external:mdns --external:node-datachannel --external:wrtc --external:bufferutil --external:utf-8-validate --external:electron --external:vlc-command --external:chromecast-api --external:airplay-js --external:dlna-player --external:mediaserver --external:node-ssdp || goto :fail

echo [2/5] SEA blob (com assets)...
node --experimental-sea-config sea-config.json || goto :fail

echo [3/5] Copia node.exe -^> UbikaPC.exe...
for /f "delims=" %%i in ('where node') do set NODE_EXE=%%i
copy /y "%NODE_EXE%" "..\UbikaPC.exe" >nul || goto :fail

echo [4/5] Injeta o blob (postject)...
call npx --yes postject "..\UbikaPC.exe" NODE_SEA_BLOB build/ubika-pc.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 || goto :fail

echo.
echo  Pronto: %CD%\..\UbikaPC.exe
echo  Exe unico: extrai tudo para %%LOCALAPPDATA%%\Ubika na 1a execucao.
goto :eof

:fail
echo.
echo  FALHOU — veja o erro acima.
exit /b 1
