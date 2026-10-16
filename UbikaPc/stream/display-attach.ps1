# display-attach.ps1 — chamado pelo Sunshine (global_prep_cmd "do") quando um
# cliente conecta. Cria o display virtual na resolução do cliente e o torna primário.
#
# Uso direto p/ teste (admin):  powershell -File display-attach.ps1 -Width 2400 -Height 1080 -Fps 60
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
using System.Text;
public class Disp {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct DD { [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string cb; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string name; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string str; public int flags; public IntPtr id; public IntPtr key; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct DEVMODE { [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string devName; public short specVer; public short drvVer; public short size; public short drvExtra; public int fields;
        public int x; public int y; public int orientation; public int fixedOut; public short color; public short duplex; public short yRes; public short ttOpt; public short collate;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string formName; public short logPx; public int bpp; public int pelsW; public int pelsH; public int dispFlags; public int freq;
        public int fixedRes; public int trueRes; public int vrefresh; public int t0; public int t1; public int t2; public int t3; public int t4; public int t5; public int t6; public int t7; }
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumDisplayDevices(string dev, int i, ref DD dd, int flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr hwnd, int flags, IntPtr param);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string dev, IntPtr dm, IntPtr hwnd, int flags, IntPtr param);
    public const int ENUM_CURRENT=-1, CDS_UPDATEREGISTRY=1, CDS_SET_PRIMARY=0x10, CDS_NORESET=0x10000000, DM_PELSWIDTH=0x80000, DM_PELSHEIGHT=0x100000, DM_DISPLAYFREQUENCY=0x400000, DM_POSITION=0x20;
}
'@
Add-Type -TypeDefinition $cs -Language CSharp

function Find-VddDisplay {
    for ($i = 0; $i -lt 16; $i++) {
        $dd = New-Object Disp+DD
        if (-not [Disp]::EnumDisplayDevices($null, $i, [ref]$dd, 0)) { break }
        if (($dd.str -match 'VDD|Virtual Display|IddSample|MttVdd') -and ($dd.flags -band 1)) {
            return $dd.name
        }
    }
    return $null
}

function Find-VddDevice {
    try {
        $dev = Get-PnpDevice -ErrorAction Stop | Where-Object {
            $_.FriendlyName -match 'VDD|Virtual Display|IddSample' -or $_.InstanceId -match 'MTT|IDD'
        } | Select-Object -First 1
        return $dev
    } catch { return $null }
}

function Set-Resolution($devName, $w, $h, $fps) {
    $dm = New-Object Disp+DEVMODE
    $dm.size = [short][System.Runtime.InteropServices.Marshal]::SizeOf($dm)
    $dm.pelsW = $w; $dm.pelsH = $h; $dm.freq = $fps
    $dm.fields = [Disp]::DM_PELSWIDTH -bor [Disp]::DM_PELSHEIGHT -bor [Disp]::DM_DISPLAYFREQUENCY
    $r = [Disp]::ChangeDisplaySettingsEx($devName, [ref]$dm, [IntPtr]::Zero, [Disp]::CDS_UPDATEREGISTRY -bor [Disp]::CDS_NORESET, [IntPtr]::Zero)
    [Disp]::ChangeDisplaySettingsEx($null, [IntPtr]::Zero, [IntPtr]::Zero, 0, [IntPtr]::Zero) | Out-Null
    return $r
}

function Set-Primary($devName) {
    $dm = New-Object Disp+DEVMODE
    $dm.size = [short][System.Runtime.InteropServices.Marshal]::SizeOf($dm)
    [Disp]::EnumDisplaySettings($devName, [Disp]::ENUM_CURRENT, [ref]$dm) | Out-Null
    $dm.fields = $dm.fields -bor [Disp]::DM_POSITION
    $dm.x = 0; $dm.y = 0
    $r = [Disp]::ChangeDisplaySettingsEx($devName, [ref]$dm, [IntPtr]::Zero, [Disp]::CDS_SET_PRIMARY -bor [Disp]::CDS_UPDATEREGISTRY -bor [Disp]::CDS_NORESET, [IntPtr]::Zero)
    [Disp]::ChangeDisplaySettingsEx($null, [IntPtr]::Zero, [IntPtr]::Zero, 0, [IntPtr]::Zero) | Out-Null
    return $r
}

function Current-Primary {
    for ($i = 0; $i -lt 16; $i++) {
        $dd = New-Object Disp+DD
        if (-not [Disp]::EnumDisplayDevices($null, $i, [ref]$dd, 0)) { break }
        if (($dd.flags -band 5) -eq 5) { return $dd.name } # ATTACHED_TO_DESKTOP+PRIMARY_DEVICE
    }
    return $null
}

# --- 1. Garante a resolução no vdd_settings.xml (driver lê no enable) ---
$xmlPath = 'C:\VirtualDisplayDriver\vdd_settings.xml'
if (Test-Path $xmlPath) {
    try {
        $xml = Get-Content $xmlPath -Raw
        if ($xml -notmatch "<width>\s*$Width\s*</width>\s*<height>\s*$Height\s*</height>") {
            $entry = "    <resolution>`n      <width>$Width</width>`n      <height>$Height</height>`n      <refresh_rate>$Fps</refresh_rate>`n    </resolution>`n  "
            $xml = $xml -replace '</resolutions>', ($entry + '</resolutions>')
            [System.IO.File]::WriteAllText($xmlPath, $xml)
            Log "vdd_settings.xml: resolução ${Width}x${Height} injetada"
        }
    } catch { Log "xml edit falhou: $($_.Exception.Message)" }
} else {
    Log "vdd_settings.xml não encontrado em $xmlPath (driver VDD instalado?)"
}

# --- 2. Liga o dispositivo VDD (re-enable p/ reler o XML) ---
$dev = Find-VddDevice
if ($null -ne $dev) {
    Log "VDD device: $($dev.InstanceId) status=$($dev.Status)"
    pnputil /disable-device "`"$($dev.InstanceId)`"" 2>&1 | Out-Null
    Start-Sleep -Milliseconds 700
    pnputil /enable-device "`"$($dev.InstanceId)`"" 2>&1 | Out-Null
} else {
    Log "VDD device NÃO encontrado — instale https://github.com/VirtualDrivers/Virtual-Display-Driver"
}

# --- 3. Espera o display virtual aparecer e aplica resolução ---
$vddName = $null
for ($t = 0; $t -lt 20; $t++) {
    $vddName = Find-VddDisplay
    if ($vddName) { break }
    Start-Sleep -Milliseconds 500
}
if (-not $vddName) { Log "ERRO: display virtual não apareceu"; exit 1 }
Log "display virtual: $vddName"

$prevPrimary = Current-Primary
@{ primary = $prevPrimary; vdd = $vddName } | ConvertTo-Json | Out-File -Encoding utf8 $StateFile
Log "primário anterior: $prevPrimary salvo"

$r = Set-Resolution $vddName $Width $Height $Fps
Log "set resolução ${Width}x${Height}@${Fps} -> $r"
$r = Set-Primary $vddName
Log "set primário -> $r"
exit 0
