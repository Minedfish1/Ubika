# install-vdd.ps1 — instala o Virtual Display Driver (MTT VDD) vendored em UbikaPc\driver.
# Precisa rodar elevado (o launcher chama com Start-Process -Verb RunAs → prompt UAC).
param(
    [string]$Source = (Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'driver'),
    [string]$Target = 'C:\VirtualDisplayDriver'
)
$ErrorActionPreference = 'Continue'
$LogFile = Join-Path $env:ProgramData 'Ubika\install-vdd.log'
New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null
function Log($msg) { "$(Get-Date -Format o) $msg" | Out-File -Append $LogFile; Write-Host $msg }

Log "install-vdd: source=$Source target=$Target"

if (-not (Test-Path (Join-Path $Source 'MttVDD.inf'))) {
    Log "ERRO: MttVDD.inf não encontrado em $Source"
    exit 1
}

# 1. Arquivos no lugar onde o driver procura o vdd_settings.xml
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item -Force "$Source\*" $Target
Log "arquivos copiados para $Target"

# 2. Certificado do driver (assinatura self-signed da MTT)
$cer = Join-Path $Target 'Virtual_Display_Driver.cer'
certutil -addstore -f TrustedPublisher "$cer" 2>&1 | Out-Null
certutil -addstore -f Root "$cer" 2>&1 | Out-Null
Log "certificado instalado em TrustedPublisher + Root"

# 3. Driver + dispositivo virtual
$out = pnputil /add-driver (Join-Path $Target 'MttVDD.inf') /install 2>&1
Log "pnputil: $($out | Out-String)"

# 4. Resultado
Start-Sleep -Seconds 2
$dev = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
    $_.FriendlyName -match 'VDD|Virtual Display|IddSample' -or $_.InstanceId -match 'MTT|IDD'
} | Select-Object -First 1
if ($dev) {
    Log "OK: dispositivo $($dev.InstanceId) status=$($dev.Status)"
    exit 0
}
Log "FALHOU: dispositivo VDD não apareceu — veja $LogFile"
exit 1
