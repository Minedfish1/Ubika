# display-detach.ps1 — chamado pelo Sunshine (global_prep_cmd "undo") quando o
# cliente desconecta. Restaura o primário anterior e desliga o display virtual.
$ErrorActionPreference = 'Continue'
$LogFile = Join-Path $env:ProgramData 'Ubika\display-detach.log'
$StateFile = Join-Path $env:ProgramData 'Ubika\display-state.json'
New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null

function Log($msg) { "$(Get-Date -Format o) $msg" | Out-File -Append $LogFile }
Log "detach iniciado"

$cs = @'
using System;
using System.Runtime.InteropServices;
public class Disp {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct DEVMODE { [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string devName; public short specVer; public short drvVer; public short size; public short drvExtra; public int fields;
        public int x; public int y; public int orientation; public int fixedOut; public short color; public short duplex; public short yRes; public short ttOpt; public short collate;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string formName; public short logPx; public int bpp; public int pelsW; public int pelsH; public int dispFlags; public int freq;
        public int fixedRes; public int trueRes; public int vrefresh; public int t0; public int t1; public int t2; public int t3; public int t4; public int t5; public int t6; public int t7; }
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr hwnd, int flags, IntPtr param);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string dev, IntPtr dm, IntPtr hwnd, int flags, IntPtr param);
    public const int ENUM_CURRENT=-1, CDS_UPDATEREGISTRY=1, CDS_SET_PRIMARY=0x10, CDS_NORESET=0x10000000, DM_POSITION=0x20;
}
'@
Add-Type -TypeDefinition $cs -Language CSharp

$prevPrimary = $null
$vddName = $null
if (Test-Path $StateFile) {
    try {
        $state = Get-Content $StateFile -Raw | ConvertFrom-Json
        $prevPrimary = $state.primary
        $vddName = $state.vdd
    } catch {}
}
Log "restaurando primário: $prevPrimary / vdd: $vddName"

# 1. Devolve o primário ao monitor original
if ($prevPrimary) {
    $dm = New-Object Disp+DEVMODE
    $dm.size = [short][System.Runtime.InteropServices.Marshal]::SizeOf($dm)
    [Disp]::EnumDisplaySettings($prevPrimary, [Disp]::ENUM_CURRENT, [ref]$dm) | Out-Null
    $dm.fields = $dm.fields -bor [Disp]::DM_POSITION
    $dm.x = 0; $dm.y = 0
    [Disp]::ChangeDisplaySettingsEx($prevPrimary, [ref]$dm, [IntPtr]::Zero, [Disp]::CDS_SET_PRIMARY -bor [Disp]::CDS_UPDATEREGISTRY -bor [Disp]::CDS_NORESET, [IntPtr]::Zero) | Out-Null
    [Disp]::ChangeDisplaySettingsEx($null, [IntPtr]::Zero, [IntPtr]::Zero, 0, [IntPtr]::Zero) | Out-Null
    Log "primário restaurado"
}

# 2. Desliga o dispositivo VDD (display some, janelas voltam p/ físico)
try {
    $dev = Get-PnpDevice -ErrorAction Stop | Where-Object {
        $_.FriendlyName -match 'VDD|Virtual Display|IddSample' -or $_.InstanceId -match 'MTT|IDD'
    } | Select-Object -First 1
    if ($dev) {
        pnputil /disable-device "`"$($dev.InstanceId)`"" 2>&1 | Out-Null
        Log "VDD desabilitado: $($dev.InstanceId)"
    }
} catch { Log "disable VDD falhou: $($_.Exception.Message)" }

Remove-Item $StateFile -ErrorAction SilentlyContinue
Log "detach concluído"
exit 0
