# display-detach.ps1 — chamado pelo Sunshine (global_prep_cmd "undo") quando o
# cliente desconecta. Restaura o primário anterior e remove o monitor virtual.
$ErrorActionPreference = 'Continue'
$LogFile = Join-Path $env:ProgramData 'Ubika\display-detach.log'
$StateFile = Join-Path $env:ProgramData 'Ubika\display-state.json'
New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null

function Log($msg) { "$(Get-Date -Format o) $msg" | Out-File -Append $LogFile }
Log "detach iniciado"

$cs = @'
using System;
using System.Runtime.InteropServices;
public class DispD {
    [DllImport("user32.dll")] public static extern int SetDisplayConfig(int nPaths, IntPtr paths, int nModes, IntPtr modes, int flags);
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct DEVMODE { [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string devName; public short specVer; public short drvVer; public short size; public short drvExtra; public int fields;
        public int x; public int y; public int orientation; public int fixedOut; public short color; public short duplex; public short yRes; public short ttOpt; public short collate;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string formName; public short logPx; public int bpp; public int pelsW; public int pelsH; public int dispFlags; public int freq;
        public int f1,f2,f3,f4,f5,f6,f7,f8; }
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr hwnd, int flags, IntPtr param);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string dev, IntPtr dm, IntPtr hwnd, int flags, IntPtr param);
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

# 1. Desanexa o display virtual do desktop (W=H=0 + POSITION)
if ($vddName) {
    $dm = New-Object DispD+DEVMODE
    $dm.size = [short]220
    $dm.devName = $vddName
    $dm.fields = 0x20 -bor 0x80000 -bor 0x100000
    $dm.pelsW = 0; $dm.pelsH = 0
    $r0 = [DispD]::ChangeDisplaySettingsEx($vddName, [ref]$dm, [IntPtr]::Zero, 1 -bor 0x10000000, [IntPtr]::Zero)
    [DispD]::ChangeDisplaySettingsEx([NullString]::Value, [IntPtr]::Zero, [IntPtr]::Zero, 0, [IntPtr]::Zero) | Out-Null
    Log "vdd $vddName desanexado -> $r0"
}

# 2. Remove o monitor virtual via pipe do driver (mantém o adaptador vivo)
try {
    $pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'MTTVirtualDisplayPipe', 'InOut')
    $pipe.Connect(10000)
    $bytes = [System.Text.Encoding]::Unicode.GetBytes('SETDISPLAYCOUNT 0')
    $pipe.Write($bytes, 0, $bytes.Length)
    $pipe.Flush()
    Start-Sleep -Milliseconds 400
    $pipe.Close()
    Log "monitor virtual removido via pipe"
} catch { Log "pipe SETDISPLAYCOUNT falhou: $($_.Exception.Message)" }

# 3. Reanexa a física: SDC_TOPOLOGY_EXTEND|SDC_APPLY religa todos os
#    monitores conectados-inativos no modo preferido (a física volta sozinha
#    e reassume primário).
$r1 = [DispD]::SetDisplayConfig(0, [IntPtr]::Zero, 0, [IntPtr]::Zero, 4 -bor 0x80)
Log "EXTEND fisica -> $r1"
Start-Sleep -Milliseconds 500

Remove-Item $StateFile -ErrorAction SilentlyContinue
Log "detach concluído"
exit 0
