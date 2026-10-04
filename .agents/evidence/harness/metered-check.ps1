# Reports what Windows says about this PC's connection cost, using the companion's own probe script
# (windows-companion/src/main/network.ts COST_SCRIPT), so what is reported here is exactly what the
# companion would see. Read-only: nothing is changed.
$ErrorActionPreference = 'SilentlyContinue'
$p = [Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]::GetInternetConnectionProfile()
if ($null -eq $p) { Write-Output 'none'; exit }
$c = $p.GetConnectionCost()
Write-Output ('cost line : {0}|{1}|{2}|{3}' -f $c.NetworkCostType, $c.Roaming, $c.OverDataLimit, $p.IsWwanConnectionProfile)
Write-Output ('profile   : {0}' -f $p.ProfileName)
$cost = "$($c.NetworkCostType)".ToLower()
$verdict = if ($c.Roaming -or $c.OverDataLimit -or $p.IsWwanConnectionProfile) { 'metered' }
           elseif ($cost -eq 'fixed' -or $cost -eq 'variable') { 'metered' }
           elseif ($cost -eq 'unrestricted') { 'unmetered' }
           else { 'unknown' }
Write-Output ('VERDICT   : {0}  (what classifyCost() in windows-companion/src/main/network.ts would return)' -f $verdict)
