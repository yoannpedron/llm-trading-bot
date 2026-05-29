#Requires -RunAsAdministrator
# Deploie la sortie de secours (failover) + la persistance auto-reparante (guardian)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$SRC = $PSScriptRoot
$L1  = "$env:ProgramData\AdGuardAutoLink"
$L2  = "$env:ProgramData\Microsoft\Windows\AGDNS"
$RES = "$env:TEMP\hardening-install.txt"
if (Test-Path $RES) { Remove-Item $RES -Force }

function Out-Line($m, $c = "White") { Write-Host $m -ForegroundColor $c; Add-Content $RES -Value $m -Encoding UTF8 }

Out-Line "=== INSTALLATION DURCISSEMENT $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ===" "Cyan"

# --- 0. Creer les dossiers ------------------------------------------------------
foreach ($d in @($L1, $L2)) { if (-not (Test-Path $d)) { New-Item -Path $d -ItemType Directory -Force | Out-Null } }

# --- 1. Supprimer l'ancien watchdog qui se battrait contre le failover ----------
Out-Line "[1] Suppression des anciens watchdog conflictuels..." "Cyan"
foreach ($t in @("AdGuardWatchdog", "DNS-AdGuard-499", "DNS-DoH-Persist", "DNS-Fortress-Watchdog", "AdGuardDNS_Enforcer")) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
        Out-Line "    supprime : $t" "Gray"
    }
}
foreach ($f in @("$env:SystemRoot\System32\dns-watchdog-499.ps1", "$env:SystemRoot\System32\dns-doh-persist.ps1")) {
    if (Test-Path $f) {
        takeown /f $f /a 2>$null | Out-Null
        icacls $f /grant "*S-1-5-32-544:(F)" 2>$null | Out-Null
        Remove-Item $f -Force -ErrorAction SilentlyContinue
        Out-Line "    fichier supprime : $f" "Gray"
    }
}

# --- 2. Deployer les scripts dans L1 et L2 --------------------------------------
Out-Line "[2] Deploiement des scripts (2 emplacements miroir)..." "Cyan"
Copy-Item "$SRC\adg-failover.ps1" "$L1\failover.ps1" -Force
Copy-Item "$SRC\adg-failover.ps1" "$L2\failover.ps1" -Force
Copy-Item "$SRC\adg-guardian.ps1" "$L1\guardian.ps1" -Force
Copy-Item "$SRC\adg-guardian.ps1" "$L2\guardian.ps1" -Force
if (Test-Path "$L1\update-linkip.ps1") { Copy-Item "$L1\update-linkip.ps1" "$L2\update-linkip.ps1" -Force }
if (Test-Path "$L1\config.json")       { Copy-Item "$L1\config.json"       "$L2\config.json"       -Force }
Out-Line "    failover.ps1, guardian.ps1, update-linkip.ps1 -> L1 + L2" "Green"

# --- 3. Construire restore.dat (base64) -----------------------------------------
Out-Line "[3] Construction de restore.dat (sauvegarde base64)..." "Cyan"
$map = @{}
foreach ($f in @('failover.ps1', 'guardian.ps1', 'update-linkip.ps1')) {
    $p = "$L1\$f"
    if (Test-Path $p) { $map[$f] = [Convert]::ToBase64String([IO.File]::ReadAllBytes($p)) }
}
$json = $map | ConvertTo-Json
Set-Content "$L1\restore.dat" -Value $json -Encoding UTF8
Set-Content "$L2\restore.dat" -Value $json -Encoding UTF8
Out-Line "    restore.dat ecrit ($($map.Keys.Count) scripts) dans L1 + L2" "Green"

# --- 4. Enregistrer les taches --------------------------------------------------
Out-Line "[4] Enregistrement des taches planifiees..." "Cyan"
function Register-AdgTask($name, $script, $minutes) {
    $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
    $t = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $minutes)))
    $s = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $p = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -RunLevel Highest -LogonType ServiceAccount
    Register-ScheduledTask -TaskName $name -TaskPath '\' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null
    Out-Line "    tache : $name ($minutes min) -> $script" "Green"
}
Register-AdgTask 'AdGuard-AutoLinkIp' "$L1\update-linkip.ps1" 10
Register-AdgTask 'AdGuard-Failover'   "$L1\failover.ps1"      2
Register-AdgTask 'AdGuard-Guardian-A' "$L1\guardian.ps1"      2
Register-AdgTask 'AdGuard-Guardian-B' "$L2\guardian.ps1"      3

# --- 5. Premier run failover (enforcement) + guardian ---------------------------
Out-Line "[5] Premier run failover + guardian..." "Cyan"
& powershell.exe -NonInteractive -ExecutionPolicy Bypass -File "$L1\failover.ps1" | Out-Null
& powershell.exe -NonInteractive -ExecutionPolicy Bypass -File "$L1\guardian.ps1" | Out-Null
Start-Sleep -Seconds 2

# --- 6. Verrouillage ACL --------------------------------------------------------
Out-Line "[6] Verrouillage des fichiers (ACL SYSTEM)..." "Cyan"
function Harden($dir) {
    # SIDs locale-independants : *S-1-5-18=SYSTEM, *S-1-5-32-544=Administrators
    # (les noms anglais "BUILTIN\Administrators" echouent en erreur 1332 sur Windows FR)
    # Dossier : heritage coupe + ACE HERITABLES (OI)(CI) pour la descendance.
    & icacls $dir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)RX" /c /q 2>$null | Out-Null
    # Enfants : sur Windows FR, (OI)(CI) sur un FICHIER via /t laisse une DACL vide.
    #   -> fichiers = F/RX simples (sans flag d'heritage) ; sous-dossiers = (OI)(CI).
    Get-ChildItem $dir -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.PSIsContainer) {
            & icacls $_.FullName /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)RX" /c /q 2>$null | Out-Null
        } else {
            & icacls $_.FullName /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:RX" /c /q 2>$null | Out-Null
        }
    }
    # Proprietaire SYSTEM en dernier.
    & icacls $dir /setowner "NT AUTHORITY\SYSTEM" /t /c /q 2>$null | Out-Null
}
Harden $L1
Harden $L2
Out-Line "    L1 + L2 verrouilles (SYSTEM=Full, Administrators=Lecture/Execution)" "Green"

# --- 7. Resume ------------------------------------------------------------------
Out-Line ""
Out-Line "=== RESUME ===" "Cyan"
Out-Line "Taches actives :" "White"
Get-ScheduledTask | Where-Object { $_.TaskName -match "AdGuard" } | ForEach-Object {
    Out-Line ("  {0,-22} [{1}] as {2}" -f $_.TaskName, $_.State, $_.Principal.UserId) "Gray"
}
Out-Line "Fichiers L1 :" "White"
Get-ChildItem $L1 -ErrorAction SilentlyContinue | ForEach-Object { Out-Line "  $($_.Name)" "Gray" }
Out-Line "Fichiers L2 :" "White"
Get-ChildItem $L2 -ErrorAction SilentlyContinue | ForEach-Object { Out-Line "  $($_.Name)" "Gray" }
Out-Line "Failover actif ? $(if(Test-Path "$L1\failover-active.flag"){'OUI'}else{'NON (sain)'})" "White"
Out-Line "EnableAutoDoh = $((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters' -Name EnableAutoDoh -EA SilentlyContinue).EnableAutoDoh)" "White"
Out-Line "Failover log :" "White"
if (Test-Path "$L1\failover.log") { Get-Content "$L1\failover.log" -Tail 4 | ForEach-Object { Out-Line "  $_" "Gray" } }
Out-Line ""
Out-Line "=== INSTALLATION DURCISSEMENT TERMINEE ===" "Green"
