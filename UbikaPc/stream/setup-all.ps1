# setup-all.ps1 — setup completo num prompt UAC só:
# 1) instala Sunshine (winget; fallback: instalador do GitHub, silencioso)
# 2) instala o VDD vendored (chama install-vdd.ps1)
# Rode elevado. Log: %ProgramData%\Ubika\setup-all.log
param(
    [string]$DriverSource = (Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'driver')
)
$ErrorActionPreference = 'Continue'
$LogFile = Join-Path $env:ProgramData 'Ubika\setup-all.log'
New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null
function Log($msg) { "$(Get-Date -Format o) $msg" | Out-File -Append $LogFile; Write-Host $msg }

# ---------- 1. Sunshine ----------
$installed = Test-Path 'C:\Program Files\Sunshine\sunshine.exe'
if ($installed) {
    Log 'Sunshine já instalado'
} else {
    Log 'Instalando Sunshine via winget…'
    $w = winget install --id LizardByte.Sunshine -e --silent --accept-source-agreements --accept-package-agreements 2>&1
    Log "winget: $($w | Out-String)"
    if (-not (Test-Path 'C:\Program Files\Sunshine\sunshine.exe')) {
        Log 'winget falhou — baixando instalador do GitHub'
        try {
            $rel = Invoke-RestMethod 'https://api.github.com/repos/LizardByte/Sunshine/releases/latest' -TimeoutSec 30
            $asset = $rel.assets | Where-Object { $_.name -match 'windows.*installer.*\.exe$' } | Select-Object -First 1
            if ($asset) {
                $dst = "$env:TEMP\sunshine-installer.exe"
                Invoke-WebRequest $asset.browser_download_url -OutFile $dst -TimeoutSec 600
                Log "baixado $($asset.name) — instalando silencioso"
                Start-Process $dst '/S' -Wait
            } else { Log 'ERRO: asset windows não achado no release' }
        } catch { Log "ERRO download sunshine: $($_.Exception.Message)" }
    }
}

# ---------- 2. VDD ----------
$vdd = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
    $_.FriendlyName -match 'VDD|Virtual Display|IddSample' -or $_.InstanceId -match 'MTT|IDD'
} | Select-Object -First 1
if ($vdd) {
    Log "VDD já instalado: $($vdd.InstanceId)"
} else {
    $ivdd = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'install-vdd.ps1'
    Log "instalando VDD de $DriverSource"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $ivdd -Source $DriverSource
}

# ---------- 3. Inicia Sunshine ----------
if (Test-Path 'C:\Program Files\Sunshine\sunshine.exe') {
    $run = Get-Process sunshine -ErrorAction SilentlyContinue
    if (-not $run) { Start-Process 'C:\Program Files\Sunshine\sunshine.exe'; Log 'Sunshine iniciado' }
}
Log 'setup-all concluído'
