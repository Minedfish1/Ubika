# display-attach.ps1 — chamado pelo Sunshine (global_prep_cmd "do") quando um
# cliente conecta. Cria o display virtual na resolução do cliente e o torna primário.
#
# Uso direto p/ teste (admin):  powershell -File display-attach.ps1 -Width 2460 -Height 1080 -Fps 120
param(
    [int]$Width  = 1920,
    [int]$Height = 1080,
    [int]$Fps    = 60
)
$ErrorActionPreference = 'Continue'
$LogFile = Join-Path $env:ProgramData 'Ubika\display-attach.log'
$StateFile = Join-Path $env:ProgramData 'Ubika\display-state.json'
New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null

function Log($msg) { "$(Get-Date -Format o) $msg" | Out-File -Append $LogFile }
Log "attach: ${Width}x${Height}@${Fps}"

# --- C# helpers Win32 ---
$cs = @'
using System;
using System.Runtime.InteropServices;
public class Disp {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct DD { public int cb; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string name; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string str; public int flags; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string id; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string key;
        public static DD Create() { var d = new DD(); d.cb = Marshal.SizeOf(typeof(DD)); return d; } }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct DEVMODE { [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string devName; public short specVer; public short drvVer; public short size; public short drvExtra; public int fields;
        public int x; public int y; public int orientation; public int fixedOut; public short color; public short duplex; public short yRes; public short ttOpt; public short collate;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string formName; public short logPx; public int bpp; public int pelsW; public int pelsH; public int dispFlags; public int freq;
        public int f1,f2,f3,f4,f5,f6,f7,f8; }
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumDisplayDevices(IntPtr dev, int i, ref DD dd, int flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr hwnd, int flags, IntPtr param);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string dev, IntPtr dm, IntPtr hwnd, int flags, IntPtr param);
    public const int ENUM_CURRENT=-1, CDS_UPDATEREGISTRY=1, CDS_SET_PRIMARY=0x10, CDS_NORESET=0x10000000, DM_PELSWIDTH=0x80000, DM_PELSHEIGHT=0x100000, DM_DISPLAYFREQUENCY=0x400000, DM_POSITION=0x20;
}
'@
Add-Type -TypeDefinition $cs -Language CSharp

# O adaptador IddCx aparece como "Virtual Display Driver" (id Root\MttVDD).
function Find-VddDisplay {
    for ($i = 0; $i -lt 16; $i++) {
        $dd = [Disp+DD]::Create()
        if (-not [Disp]::EnumDisplayDevices([IntPtr]::Zero, $i, [ref]$dd, 0)) { break }
        if ($dd.str -match 'VDD|Virtual Display|IddSample|MttVdd' -or $dd.id -match 'MTTVDD|MTT1337|IDD') {
            return $dd.name
        }
    }
    return $null
}

# Envia comando pro pipe de controle do driver (\\.\pipe\MTTVirtualDisplayPipe).
# Protocolo: conexão one-shot, comando em UTF-16LE, driver responde e desconecta.
function Send-Vdd($cmd) {
    try {
        $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'MTTVirtualDisplayPipe', 'InOut')
        $pipe.Connect(10000)
        $bytes = [System.Text.Encoding]::Unicode.GetBytes($cmd)
        $pipe.Write($bytes, 0, $bytes.Length)
        $pipe.Flush()
        Start-Sleep -Milliseconds 400
        $pipe.Close()
        return $true
    } catch { Log "pipe '$cmd' falhou: $($_.Exception.Message)"; return $false }
}

function Current-Primary {
    for ($i = 0; $i -lt 16; $i++) {
        $dd = [Disp+DD]::Create()
        if (-not [Disp]::EnumDisplayDevices([IntPtr]::Zero, $i, [ref]$dd, 0)) { break }
        if (($dd.flags -band 5) -eq 5) { return $dd.name }
    }
    return $null
}

# --- 1. Reescreve vdd_settings.xml com a resolução pedida em PRIMEIRO ---
$xmlPath = 'C:\VirtualDisplayDriver\vdd_settings.xml'
if (Test-Path $xmlPath) {
    try {
        $xml = Get-Content $xmlPath -Raw
        $entry = "        <resolution>`n            <width>$Width</width>`n            <height>$Height</height>`n            <refresh_rate>$Fps</refresh_rate>`n            <refresh_rate>60</refresh_rate>`n        </resolution>`n"
        # remove resolução existente idêntica p/ não duplicar
        $xml = $xml -replace "(?s)\s*<resolution>\s*<width>$Width</width>\s*<height>$Height</height>.*?</resolution>", "`n"
        $xml = $xml -replace '<resolutions>', "<resolutions>`n$entry"
        [System.IO.File]::WriteAllText($xmlPath, $xml)
        Log "vdd_settings.xml: ${Width}x${Height}@${Fps} injetado no topo"
    } catch { Log "xml edit falhou: $($_.Exception.Message)" }
} else {
    Log "vdd_settings.xml nao encontrado em $xmlPath (driver VDD instalado?)"
}

# --- 2. Recria o monitor via pipe (re-lê o XML e expõe os modos novos) ---
# SETDISPLAYCOUNT 0 remove todos os monitores; 1 recria com o XML atual.
Send-Vdd "SETDISPLAYCOUNT 0" | Out-Null
Start-Sleep -Seconds 2
Send-Vdd "SETDISPLAYCOUNT 1" | Out-Null

# --- 3. Espera o display virtual aparecer (auto-anexa) ---
$vddName = $null
for ($t = 0; $t -lt 24; $t++) {
    $vddName = Find-VddDisplay
    if ($vddName) {
        $dd = [Disp+DD]::Create()
        for ($i = 0; $i -lt 16; $i++) {
            $dd = [Disp+DD]::Create()
            if (-not [Disp]::EnumDisplayDevices([IntPtr]::Zero, $i, [ref]$dd, 0)) { break }
            if ($dd.name -eq $vddName -and ($dd.flags -band 1)) { break }
        }
        if ($dd.name -eq $vddName -and ($dd.flags -band 1)) { break }
    }
    Start-Sleep -Milliseconds 500
}
if (-not $vddName) { Log "ERRO: display virtual nao apareceu"; exit 1 }
Log "display virtual: $vddName"

# --- 4. Salva primário anterior ---
$prevPrimary = Current-Primary
@{ primary = $prevPrimary; vdd = $vddName } | ConvertTo-Json | Out-File -Encoding utf8 $StateFile
Log "primario anterior: $prevPrimary salvo"

# --- 5. Aplica resolução pedida ---
$dm = New-Object Disp+DEVMODE
$dm.size = [short]220
[Disp]::EnumDisplaySettings($vddName, [Disp]::ENUM_CURRENT, [ref]$dm) | Out-Null
$dm.pelsW = $Width; $dm.pelsH = $Height; $dm.freq = $Fps
$dm.fields = $dm.fields -bor [Disp]::DM_PELSWIDTH -bor [Disp]::DM_PELSHEIGHT -bor [Disp]::DM_DISPLAYFREQUENCY
$r = [Disp]::ChangeDisplaySettingsEx($vddName, [ref]$dm, [IntPtr]::Zero, 0, [IntPtr]::Zero)
Log "set resolucao ${Width}x${Height}@${Fps} -> $r"

# --- 6. Desliga a tela física: IddCx nao pode ser primario, entao o virtual
#        vira a UNICA tela ativa -> Sunshine captura ela, jogo abre nela.
#        O detach reconecta a fisica com o modo salvo.
if ($prevPrimary -and $prevPrimary -ne $vddName) {
    # salva o modo atual da fisica p/ restaurar no detach
    $pm = New-Object Disp+DEVMODE
    $pm.size = [short]220
    [Disp]::EnumDisplaySettings($prevPrimary, [Disp]::ENUM_CURRENT, [ref]$pm) | Out-Null
    $state = @{ primary = $prevPrimary; vdd = $vddName; pw = $pm.pelsW; ph = $pm.pelsH; pf = $pm.freq }
    $state | ConvertTo-Json | Out-File -Encoding utf8 $StateFile

    $dm3 = New-Object Disp+DEVMODE
    $dm3.size = [short]220
    [Disp]::EnumDisplaySettings($prevPrimary, [Disp]::ENUM_CURRENT, [ref]$dm3) | Out-Null
    $dm3.devName = $prevPrimary
    $dm3.fields = [Disp]::DM_POSITION -bor [Disp]::DM_PELSWIDTH -bor [Disp]::DM_PELSHEIGHT
    $dm3.pelsW = 0; $dm3.pelsH = 0  # w=h=0 + POSITION = desanexa do desktop
    $r3 = [Disp]::ChangeDisplaySettingsEx($prevPrimary, [ref]$dm3, [IntPtr]::Zero, [Disp]::CDS_UPDATEREGISTRY -bor [Disp]::CDS_NORESET, [IntPtr]::Zero)
    [Disp]::ChangeDisplaySettingsEx([NullString]::Value, [IntPtr]::Zero, [IntPtr]::Zero, 0, [IntPtr]::Zero) | Out-Null
    Log "fisica $prevPrimary desanexada -> $r3"
}
exit 0
