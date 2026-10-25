# 读取当前前台窗口（进程名 / 标题 / 位置），输出一行 JSON
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$h = [FgWin]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][FgWin]::GetWindowText($h, $sb, 512)
$r = New-Object FgWin+RECT
[void][FgWin]::GetWindowRect($h, [ref]$r)
$pid = 0
[void][FgWin]::GetWindowThreadProcessId($h, [ref]$pid)
$proc = ''
try { $proc = (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch { $proc = '' }
[pscustomobject]@{
  title = $sb.ToString()
  process = $proc
  x = $r.Left
  y = $r.Top
  w = ($r.Right - $r.Left)
  h = ($r.Bottom - $r.Top)
} | ConvertTo-Json -Compress
