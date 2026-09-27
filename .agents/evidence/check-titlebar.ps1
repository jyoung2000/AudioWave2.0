# Does the installed companion still have a REAL Windows title bar?
#
# `Menu.setApplicationMenu(null)` removes the File/Edit/View/Window MENU. The user's request also
# said "window bar", and the two are different things: a frameless window (frame:false /
# titleBarStyle:'hidden') would delete the OS title bar and its minimize/maximize/close buttons.
# That is a redesign, not a fix, so the title bar was left alone — but "I left it alone" is a claim
# about behaviour, and the only honest way to settle it is to read the real window styles off a
# live window.
#
# These are the documented Win32 window styles. A frameless Chromium window has none of them.
#   WS_CAPTION   0x00C00000  title bar + border           <- must be set
#   WS_SYSMENU   0x00080000  system menu + the close (X)  <- must be set
#   WS_THICKFRAME0x00040000  resizable border
#   WS_MINIMIZEBOX 0x00020000 the minimize button        <- must be set
#   WS_MAXIMIZEBOX 0x00010000 the maximize button        <- must be set
#
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File .agents/evidence/check-titlebar.ps1
$ErrorActionPreference = 'Stop'

$exe = Join-Path $env:LOCALAPPDATA 'Programs\Now Playing Companion\Now Playing Companion.exe'
if (-not (Test-Path $exe)) { throw "not installed: $exe" }

Get-Process 'Now Playing Companion' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process $exe
Start-Sleep -Seconds 22

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr GetSystemMenu(IntPtr hWnd, [MarshalAs(UnmanagedType.Bool)] bool bRevert);
  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int nIndex);
}
"@

$proc = Get-Process 'Now Playing Companion' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw 'no main window appeared' }

$h   = $proc.MainWindowHandle
$sty = [Win]::GetWindowLong($h, -16)   # GWL_STYLE
$ex  = [Win]::GetWindowLong($h, -20)   # GWL_EXSTYLE
# GetSystemMenu returns NULL when the window has NO system menu — which is what a frameless
# Chromium window has. bRevert=false so this reads the menu rather than resetting it.
$hasSystemMenu = [Win]::GetSystemMenu($h, $false) -ne [IntPtr]::Zero

$expect = [ordered]@{
  WS_CAPTION     = 0x00C00000
  WS_SYSMENU     = 0x00080000
  WS_THICKFRAME  = 0x00040000
  WS_MINIMIZEBOX = 0x00020000
  WS_MAXIMIZEBOX = 0x00010000
}

$result = [ordered]@{
  pid            = $proc.Id
  title          = $proc.MainWindowTitle
  style          = ('0x{0:X8}' -f $sty)
  exstyle        = ('0x{0:X8}' -f $ex)
  hasSystemMenu  = $hasSystemMenu
  screen         = '{0}x{1}' -f [Win]::GetSystemMetrics(0), [Win]::GetSystemMetrics(1)
  styles         = [ordered]@{}
}
$fail = 0
foreach ($k in $expect.Keys) {
  $set = ($sty -band $expect[$k]) -ne 0
  $result.styles[$k] = $set
  if (-not $set) { $fail++ }
}

$result.verdict = if ($fail -eq 0 -and $hasSystemMenu) {
  'NATIVE TITLE BAR PRESENT: minimize, maximize and close all exist'
} else {
  "FRAMELESS OR DEGRADED: $fail expected style(s) missing, hasSystemMenu=$hasSystemMenu"
}
$result | ConvertTo-Json -Depth 4

$out = 'C:\Users\jalon\AudioWave2.0\.agents\evidence\05-installer\installed-titlebar-check.json'
$result | ConvertTo-Json -Depth 4 | Set-Content -Path $out -Encoding UTF8
"WROTE $out"

Get-Process 'Now Playing Companion' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if ($fail -ne 0 -or -not $hasSystemMenu) { exit 1 }
