#Requires -RunAsAdministrator
# Test du durcissement : fichiers/ACL, resurrection des taches, resurrection
# mutuelle, et bascule de secours (failover) reelle simulee par pare-feu.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$L1 = "$env:ProgramData\AdGuardAutoLink"
$L2 = "$env:ProgramData\Microsoft\Windows\AGDNS"
$RES = "$env:TEMP\hardening-test.txt"
if (Test-Path $RES) { Remove-Item $RES -Force }
$pass = 0; $fail = 0

function Out-Line($m, $c = "White") { Write-Host $m -ForegroundColor $c; Add-Content $RES -Value $m -Encoding UTF8 }
function Check($ok, $label, $detail = "") {
    if ($ok) { $script:pass++; Out-Line ("  [PASS] {0,-42} {1}" -f $label, $detail) "Green" }
    else     { $script:fail++; Out-Line ("  [FAIL] {0,-42} {1}" -f $label, $detail) "Red" }
}
function WifiDns { (Get-DnsClientServerAddress -InterfaceAlias 'Wi-Fi' -AddressFamily IPv4 -EA SilentlyContinue).ServerAddresses }
function Get-Ip($site, $server) {
    $r = if ($server) { Resolve-DnsName $site -Server $server -Type A -DnsOnly -QuickTimeout -EA SilentlyContinue }
         else { Resolve-DnsName $site -Type A -DnsOnly -QuickTimeout -EA SilentlyContinue }
    if ($r) { ($r | Where-Object { $_.Type -eq 'A' } | Select-Object -First 1).IPAddress } else { $null }
}

Out-Line "######## TEST DURCISSEMENT $(Get-Date -Format 'HH:mm:ss') ########" "Magenta"

# === A. FICHIERS + ACL =========================================================
Out-Line ""; Out-Line "=== A. Fichiers deployes + ACL ===" "Cyan"
foreach ($f in @('failover.ps1','guardian.ps1','update-linkip.ps1','restore.dat','config.json')) {
    Check (Test-Path "$L1\$f") "L1\$f"
}
foreach ($f in @('failover.ps1','guardian.ps1','update-linkip.ps1','restore.dat','config.json')) {
    Check (Test-Path "$L2\$f") "L2\$f"
}
$acl = (icacls $L1 2>$null) -join "`n"
Check ($acl -match "Administ.*\(RX\)|Administ.*\(OI\)\(CI\)\(RX\)") "ACL L1 : Administrators en RX (pas Full)"
Check ($acl -match "SYST.*\(F\)|SYST.*\(OI\)\(CI\)\(F\)") "ACL L1 : SYSTEM en Full"

# === B. TACHES ACTIVES =========================================================
Out-Line ""; Out-Line "=== B. Taches actives ===" "Cyan"
foreach ($t in @("AdGuard-AutoLinkIp","AdGuard-Failover","AdGuard-Guardian-A","AdGuard-Guardian-B")) {
    $task = Get-ScheduledTask -TaskName $t -EA SilentlyContinue
    Check ($null -ne $task) "Tache $t" $(if($task){"[$($task.State)]"}else{"ABSENTE"})
}

# === C. RESURRECTION : tache + script supprimes =================================
Out-Line ""; Out-Line "=== C. Resurrection (suppression tache Failover + script L1) ===" "Cyan"
Unregister-ScheduledTask -TaskName "AdGuard-Failover" -Confirm:$false -EA SilentlyContinue
# simuler un admin determine qui prend possession pour supprimer
takeown /f "$L1\failover.ps1" /a 2>$null | Out-Null
icacls "$L1\failover.ps1" /grant "*S-1-5-32-544:(F)" 2>$null | Out-Null
Remove-Item "$L1\failover.ps1" -Force -EA SilentlyContinue
Out-Line "    Supprime : tache AdGuard-Failover + L1\failover.ps1" "Gray"
Out-Line "    Declenchement de Guardian-A..." "Gray"
Start-ScheduledTask -TaskName "AdGuard-Guardian-A" -EA SilentlyContinue
Start-Sleep -Seconds 10
Check ($null -ne (Get-ScheduledTask -TaskName "AdGuard-Failover" -EA SilentlyContinue)) "Tache AdGuard-Failover recreee par le gardien"
Check (Test-Path "$L1\failover.ps1") "Script L1\failover.ps1 restaure (depuis L2)"

# === D. RESURRECTION MUTUELLE : suppression des 2 gardiens ======================
Out-Line ""; Out-Line "=== D. Resurrection mutuelle (suppression Guardian-A + Guardian-B) ===" "Cyan"
Unregister-ScheduledTask -TaskName "AdGuard-Guardian-A" -Confirm:$false -EA SilentlyContinue
Unregister-ScheduledTask -TaskName "AdGuard-Guardian-B" -Confirm:$false -EA SilentlyContinue
Out-Line "    Supprime : Guardian-A + Guardian-B. Declenchement de Failover..." "Gray"
Start-ScheduledTask -TaskName "AdGuard-Failover" -EA SilentlyContinue
Start-Sleep -Seconds 12
Check ($null -ne (Get-ScheduledTask -TaskName "AdGuard-Guardian-A" -EA SilentlyContinue)) "Guardian-A ressuscite par Failover"
Check ($null -ne (Get-ScheduledTask -TaskName "AdGuard-Guardian-B" -EA SilentlyContinue)) "Guardian-B ressuscite par Failover"

# === E. RESTAURATION depuis restore.dat (suppression dans L1 ET L2) ============
Out-Line ""; Out-Line "=== E. Restauration depuis restore.dat (suppression L1+L2) ===" "Cyan"
foreach ($loc in @($L1, $L2)) {
    takeown /f "$loc\update-linkip.ps1" /a 2>$null | Out-Null
    icacls "$loc\update-linkip.ps1" /grant "*S-1-5-32-544:(F)" 2>$null | Out-Null
    Remove-Item "$loc\update-linkip.ps1" -Force -EA SilentlyContinue
}
$goneBoth = -not (Test-Path "$L1\update-linkip.ps1") -and -not (Test-Path "$L2\update-linkip.ps1")
Out-Line "    update-linkip.ps1 supprime dans L1 ET L2 : $goneBoth" "Gray"
Start-ScheduledTask -TaskName "AdGuard-Guardian-A" -EA SilentlyContinue
Start-Sleep -Seconds 10
Check (Test-Path "$L1\update-linkip.ps1") "update-linkip.ps1 reconstruit depuis restore.dat"

# === F. FAILOVER REEL (simule par pare-feu) ====================================
Out-Line ""; Out-Line "=== F. Sortie de secours reelle (blocage AdGuard par pare-feu) ===" "Cyan"
$ruleName = "ZZZ-TEST-BlockAdGuard"
try {
    Out-Line "    DNS Wi-Fi avant : $((WifiDns) -join ', ')" "Gray"
    # Bloquer AdGuard en sortie (simule une panne du resolveur)
    New-NetFirewallRule -DisplayName $ruleName -Direction Outbound -Action Block `
        -RemoteAddress @("94.140.14.49","94.140.14.59") -EA SilentlyContinue | Out-Null
    Out-Line "    Pare-feu : AdGuard 94.140.14.49/59 bloque en sortie" "Gray"

    # 2 passages de failover -> doit basculer
    Start-ScheduledTask -TaskName "AdGuard-Failover" -EA SilentlyContinue; Start-Sleep -Seconds 12
    Start-ScheduledTask -TaskName "AdGuard-Failover" -EA SilentlyContinue; Start-Sleep -Seconds 12

    $flagOn = Test-Path "$L1\failover-active.flag"
    $dnsNow = WifiDns
    Check $flagOn "Drapeau failover-active cree apres panne"
    Check ($dnsNow -contains "8.8.8.8") "DNS bascule sur 8.8.8.8" "($($dnsNow -join ', '))"
    $g = Get-Ip "google.com"
    Check ($null -ne $g) "Internet preserve pendant la panne" "google.com -> $g"

    # Lever la panne
    Remove-NetFirewallRule -DisplayName $ruleName -EA SilentlyContinue
    Out-Line "    Pare-feu : blocage AdGuard leve" "Gray"
    Start-ScheduledTask -TaskName "AdGuard-Failover" -EA SilentlyContinue; Start-Sleep -Seconds 12

    $flagOff = -not (Test-Path "$L1\failover-active.flag")
    $dnsBack = WifiDns
    Check $flagOff "Drapeau failover retire apres recuperation"
    Check ($dnsBack -contains "94.140.14.49") "DNS restaure sur AdGuard" "($($dnsBack -join ', '))"
    Start-Sleep -Seconds 2
    Clear-DnsClientCache -EA SilentlyContinue
    $porn = Get-Ip "pornhub.com"
    Check ($porn -eq "94.140.14.35" -or $null -eq $porn) "Blocage adulte retabli apres recuperation" "pornhub -> $(if($porn){$porn}else{'bloque'})"
}
finally {
    # SECURITE : toujours retirer la regle de pare-feu
    Remove-NetFirewallRule -DisplayName $ruleName -EA SilentlyContinue
    Out-Line "    (nettoyage pare-feu garanti)" "Gray"
}

# === G. ETAT FINAL SAIN ========================================================
Out-Line ""; Out-Line "=== G. Etat final ===" "Cyan"
$allTasks = @("AdGuard-AutoLinkIp","AdGuard-Failover","AdGuard-Guardian-A","AdGuard-Guardian-B")
$missing = $allTasks | Where-Object { -not (Get-ScheduledTask -TaskName $_ -EA SilentlyContinue) }
Check ($missing.Count -eq 0) "Les 4 taches sont presentes" $(if($missing){"manquantes: $($missing -join ', ')"})
Check (-not (Test-Path "$L1\failover-active.flag")) "Pas en mode failover (sain)"
Check ((WifiDns) -contains "94.140.14.49") "DNS final = AdGuard"
# re-verrouiller proprement (per-file : (OI)(CI) sur un fichier via /t laisse une DACL vide en FR)
try {
    Add-Type -ErrorAction Stop -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class PrivT {
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr h, uint a, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool LookupPrivilegeValue(string h, string n, out long l);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr t, bool d, ref TP np, int len, IntPtr p, IntPtr r);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [StructLayout(LayoutKind.Sequential, Pack=1)] struct TP { public int Count; public long Luid; public int Attr; }
  public static bool Enable(string p){ IntPtr t; long l; TP tp;
    if(!OpenProcessToken(GetCurrentProcess(),0x28,out t)) return false;
    if(!LookupPrivilegeValue(null,p,out l)) return false;
    tp.Count=1; tp.Luid=l; tp.Attr=0x2; return AdjustTokenPrivileges(t,false,ref tp,0,IntPtr.Zero,IntPtr.Zero); }
}
"@
    [PrivT]::Enable("SeRestorePrivilege") | Out-Null
} catch {}
function Harden($dir) {
    & icacls $dir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)RX" /c /q 2>$null | Out-Null
    Get-ChildItem $dir -Recurse -Force -EA SilentlyContinue | ForEach-Object {
        if ($_.PSIsContainer) { & icacls $_.FullName /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)RX" /c /q 2>$null | Out-Null }
        else { & icacls $_.FullName /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:RX" /c /q 2>$null | Out-Null }
    }
    & icacls $dir /setowner "NT AUTHORITY\SYSTEM" /t /c /q 2>$null | Out-Null
}
Harden $L1
Harden $L2

Out-Line ""
Out-Line "######## RESULTAT : $pass PASS / $fail FAIL ########" $(if($fail -eq 0){"Green"}else{"Red"})
