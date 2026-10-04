# Drives Windows' native folder picker through UI Automation for the Airwave companion.
# Never sends keystrokes: the folder path goes in through ValuePattern and the confirm
# button is Invoke()d, so nothing depends on which window has focus.
#
# Usage (Windows PowerShell 5.1):
#   powershell -NoProfile -File uia-folder-picker.ps1 -ProcessId 12345 `
#       -DialogTitle "Choose a music folder" -FolderPath "C:\np-prove\music" -ConfirmButton "Add folder"
#
# Machine paths come from the environment (NP_SCRATCH / NP_CLONE) as the brief requires;
# nothing here is committed with a hard-coded path.
param(
  [Parameter(Mandatory = $true)][int]$ProcessId_,
  [Parameter(Mandatory = $true)][string]$DialogTitle,
  [Parameter(Mandatory = $true)][string]$FolderPath,
  [Parameter(Mandatory = $true)][string]$ConfirmButton,
  [int]$TimeoutSeconds = 20,
  # Which executable may own the dialog. Electron's showOpenDialog(parentWindow, ...) is hosted by
  # whichever process in the app's tree owns that window, which is NOT always the pid a launcher
  # handed back - so requiring one pid reports "no window titled ..." while the dialog is plainly on
  # screen. The name is the meaningful check: this dialog may belong to this app and no other.
  [string]$ExpectedProcessName = ''
)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$ErrorActionPreference = 'Stop'
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)

function Test-Owner([int]$ownerPid) {
  if ($ownerPid -eq $ProcessId_) { return $true }
  if ([string]::IsNullOrEmpty($ExpectedProcessName)) { return $false }
  try {
    $p = Get-Process -Id $ownerPid -ErrorAction Stop
    return [string]::Equals($p.ProcessName, $ExpectedProcessName, [StringComparison]::OrdinalIgnoreCase)
  } catch { return $false }
}

function Find-Dialog {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  # Electron calls showOpenDialog(parentWindow, ...), so the shell dialog is an OWNED window: it
  # hangs off the companion's top-level window as a descendant, not off the desktop root as a
  # sibling. Searching only TreeScope::Children of the root misses it entirely - which is why an
  # earlier version of this script reported "no window titled ..." while the dialog was plainly on
  # screen. Look for the shell dialog class anywhere under the root, then check title and owner.
  $classCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')
  foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $classCond)) {
    if ($w.Current.Name -eq $DialogTitle -and (Test-Owner $w.Current.ProcessId)) { return $w }
  }
  return $null
}

$dialog = $null
while ((Get-Date) -lt $deadline -and -not $dialog) {
  $dialog = Find-Dialog
  if (-not $dialog) { Start-Sleep -Milliseconds 300 }
}
if (-not $dialog) {
  Write-Output ("FAIL no window titled '{0}' owned by pid {1}" -f $DialogTitle, $ProcessId_)
  exit 2
}
Write-Output ("OK dialog found: '{0}' pid {1}" -f $dialog.Current.Name, $dialog.Current.ProcessId)

# The folder edit box: an Edit control, preferring one named Folder: / Address / path-ish.
$editCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Edit)
$edits = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
Write-Output ("INFO {0} Edit controls: {1}" -f $edits.Count, (($edits | ForEach-Object { $_.Current.Name }) -join ' | '))

$target = $null
foreach ($e in $edits) {
  $p = $e.Current
  if ($p.Name -match '^(Folder|Address|File name|Path)') { $target = $e; break }
}
if (-not $target -and $edits.Count -gt 0) { $target = $edits[0] }
if (-not $target) { Write-Output 'FAIL no Edit control in the dialog'; exit 3 }

$vp = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
$vp.SetValue($FolderPath)
Write-Output ("OK folder set to {0}" -f $FolderPath)
Start-Sleep -Milliseconds 400

function Invoke-Confirm {
  $btnCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
  $btns = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
  foreach ($b in $btns) {
    if ($b.Current.Name -eq $ConfirmButton) {
      $ip = $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $ip.Invoke()
      return $true
    }
  }
  Write-Output ("FAIL confirm button '{0}' not found; buttons: {1}" -f $ConfirmButton,
    (($btns | ForEach-Object { $_.Current.Name }) -join ' | '))
  return $false
}

if (-not (Invoke-Confirm)) { exit 4 }

# A shell folder picker navigates into the folder rather than accepting it; an empty
# Folder: box with the confirm button accepts. Try at most twice, then stop.
Start-Sleep -Milliseconds 800
if (Find-Dialog) {
  Write-Output 'INFO dialog still open after first confirm - navigating into folder then confirming again'
  $edits2 = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants, $editCond)
  foreach ($e in $edits2) {
    if ($e.Current.Name -match '^(Folder|Address|Path)') {
      try {
        $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('')
      } catch {}
    }
  }
  if (-not (Invoke-Confirm)) { exit 5 }
  Start-Sleep -Milliseconds 800
}

if (Find-Dialog) { Write-Output 'FAIL dialog still open after two confirms'; exit 6 }
Write-Output 'OK dialog closed - folder chosen'
exit 0