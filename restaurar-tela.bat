@echo off
REM RESTAURAR TELA — emergencia: volta a tela fisica 1920x1080.
REM Use quando a tela ficar preta depois de um teste/stream.
REM Nao precisa de admin — SetDisplayConfig e pipe rodam como usuario.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0UbikaPc\stream\display-detach.ps1"
powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | Format-Table -AutoSize"
pause
