# create-vdd-device.ps1 — cria o nó de dispositivo root-enumerado Root\MttVDD
# via SetupAPI (equivalente ao "devcon install MttVDD.inf Root\MttVDD").
# Precisa rodar elevado.
param([string]$Inf = 'C:\VirtualDisplayDriver\MttVDD.inf')
$ErrorActionPreference = 'Stop'
$LogFile = Join-Path $env:ProgramData 'Ubika\create-vdd.log'
New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null
function Log($msg) { "$(Get-Date -Format o) $msg" | Out-File -Append $LogFile; Write-Host $msg }

$cs = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Dev {
    [StructLayout(LayoutKind.Sequential)]
    public struct SP_DEVINFO_DATA {
        public int cbSize; public Guid ClassGuid; public uint DevInst; public IntPtr Reserved;
    }
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid ClassGuid, IntPtr hwndParent);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetupDiCreateDeviceInfoW(IntPtr set, string DeviceName, ref Guid ClassGuid,
        string DeviceDescription, IntPtr hwndParent, int CreationFlags, ref SP_DEVINFO_DATA DeviceInfoData);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetupDiSetDeviceRegistryPropertyW(IntPtr set, ref SP_DEVINFO_DATA data,
        int Property, byte[] PropertyBuffer, int PropertyBufferSize);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetupDiCallClassInstaller(int InstallFunction, IntPtr set, ref SP_DEVINFO_DATA data);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("newdev.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool UpdateDriverForPlugAndPlayDevicesW(IntPtr hwndParent, string HardwareId,
        string FullInfPath, int InstallFlags, out bool bRebootRequired);
    public const int DICD_GENERATE_ID = 1, DIF_REGISTERDEVICE = 25, SPDRP_HARDWAREID = 1;
}
'@
Add-Type -TypeDefinition $cs -Language CSharp

$DisplayClass = New-Object Guid('{4d36e968-e325-11ce-bfc1-08002be10318}')
$set = [Dev]::SetupDiCreateDeviceInfoList([ref]$DisplayClass, [IntPtr]::Zero)
if ($set -eq [IntPtr]::MinusOne -or $set -eq [IntPtr]::Zero) { Log "SetupDiCreateDeviceInfoList falhou: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }

$data = New-Object Dev+SP_DEVINFO_DATA
$data.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($data)
$ok = [Dev]::SetupDiCreateDeviceInfoW($set, 'MttVDD', [ref]$DisplayClass, 'Virtual Display Driver (Ubika)', [IntPtr]::Zero, [Dev]::DICD_GENERATE_ID, [ref]$data)
if (-not $ok) { Log "CreateDeviceInfo falhou: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; [Dev]::SetupDiDestroyDeviceInfoList($set) | Out-Null; exit 1 }

# HardwareID multi-string: "Root\MttVDD\0\0" em UTF-16
$hwBytes = [Text.Encoding]::Unicode.GetBytes("Root\MttVDD`0`0")
$ok = [Dev]::SetupDiSetDeviceRegistryPropertyW($set, [ref]$data, [Dev]::SPDRP_HARDWAREID, $hwBytes, $hwBytes.Length)
if (-not $ok) { Log "SetRegistryProperty falhou: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; [Dev]::SetupDiDestroyDeviceInfoList($set) | Out-Null; exit 1 }

$ok = [Dev]::SetupDiCallClassInstaller([Dev]::DIF_REGISTERDEVICE, $set, [ref]$data)
[Dev]::SetupDiDestroyDeviceInfoList($set) | Out-Null
if (-not $ok) { Log "RegisterDevice falhou: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }
Log "nó Root\MttVDD criado"

$reboot = $false
$ok = [Dev]::UpdateDriverForPlugAndPlayDevicesW([IntPtr]::Zero, 'Root\MttVDD', $Inf, 0, [ref]$reboot)
Log "UpdateDriverForPlugAndPlay: $ok (reboot=$reboot)"
if (-not $ok) { Log "driver bind falhou: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }

Start-Sleep -Seconds 2
$dev = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
    $_.FriendlyName -match 'VDD|Virtual Display|IddSample|MttVdd' -or $_.InstanceId -match 'MTT|IDD'
} | Select-Object -First 1
if ($dev) { Log "OK: $($dev.FriendlyName) status=$($dev.Status) id=$($dev.InstanceId)"; exit 0 }
Log "FALHOU: dispositivo ainda não apareceu"
exit 1
