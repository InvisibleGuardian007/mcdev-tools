import fs from 'fs'; import os from 'os'; import path from 'path'; import { spawn } from 'child_process';
const x = Number(process.argv[2] || 423), y = Number(process.argv[3] || 500);
const script = `$ErrorActionPreference='Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class C2 {
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
}
"@
$p = Get-Process Minecraft.Windows | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$h = $p.MainWindowHandle
[ C2 ]::ShowWindow($h,9) | Out-Null
[C2]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 600
$o = New-Object C2+POINT
[C2]::ClientToScreen($h,[ref]$o) | Out-Null
$sx=$o.X+${x}
$sy=$o.Y+${y}
[C2]::SetCursorPos($sx,$sy) | Out-Null
Start-Sleep -Milliseconds 500
[C2]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 400
[C2]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
Start-Sleep -Milliseconds 300
Write-Output "clicked $sx,$sy"
`;
const p = path.join(os.tmpdir(), 'c2.ps1');
fs.writeFileSync(p, '\uFEFF' + script, 'utf8');
const c = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p]);
c.stdout.on('data', d => process.stdout.write(String(d)));
c.on('close', () => { try { fs.unlinkSync(p); } catch {} });
