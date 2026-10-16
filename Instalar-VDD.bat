@echo off
:: Instala o Virtual Display Driver — botao direito > "Executar como administrador"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0UbikaPc\stream\install-vdd.ps1" -Source "%~dp0UbikaPc\driver"
pause
