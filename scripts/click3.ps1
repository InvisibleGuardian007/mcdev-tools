$ErrorActionPreference='Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class C3 {
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e);
 [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
}
"@
$p = Get-Process Minecraft.Windows | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$h = $p.MainWindowHandle
[C3]::SwitchToThisWindow($h, $true)
Start-Sleep -Milliseconds 700
$fgOk = ([C3]::GetForegroundWindow() -eq $h)
$o = New-Object C3+POINT
[C3]::ClientToScreen($h,[ref]$o) | Out-Null
$sx = $o.X + $args[0]
$sy = $o.Y + $args[1]
[C3]::SetCursorPos($sx,$sy) | Out-Null
Start-Sleep -Milliseconds 500
[C3]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 250
[C3]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
Write-Output ("fg=$fgOk clicked $sx,$sy")
