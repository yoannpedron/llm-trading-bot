# AdGuard DNS - Guardian (auto-reparation / persistance)
# Tourne en SYSTEM (2 taches A et B depuis 2 emplacements).
# - Recree toute tache supprimee
# - Restaure tout script efface (miroir L1<->L2 + restore.dat base64)
# - Re-verrouille les fichiers (ACL SYSTEM) si une alteration est detectee
# NE TOUCHE PAS au DNS : l'autorite DNS est failover.ps1 (pour ne pas casser la bascule)

$L1  = "$env:ProgramData\AdGuardAutoLink"
$L2  = "$env:ProgramData\Microsoft\Windows\AGDNS"
$LOG = "$L1\guardian.log"

function Log($m) { Add-Content $LOG -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" -ErrorAction SilentlyContinue }

foreach ($d in @($L1, $L2)) { if (-not (Test-Path $d)) { New-Item -Path $d -ItemType Directory -Force | Out-Null } }

$changed = $false

# ---- 1. Restauration des fichiers scripts -------------------------------------
$files = @('failover.ps1', 'guardian.ps1', 'update-linkip.ps1')

# Charger restore.dat (fusion des 2 emplacements)
$map = @{}
foreach ($dp in @("$L1\restore.dat", "$L2\restore.dat")) {
    if (Test-Path $dp) {
        try {
            $j = Get-Content $dp -Raw | ConvertFrom-Json
            foreach ($p in $j.PSObject.Properties) { if (-not $map.ContainsKey($p.Name)) { $map[$p.Name] = $p.Value } }
        } catch {}
    }
}

foreach ($f in $files) {
    $p1 = "$L1\$f"; $p2 = "$L2\$f"
    $e1 = Test-Path $p1; $e2 = Test-Path $p2
    if ($e1 -and -not $e2) { Copy-Item $p1 $p2 -Force -ErrorAction SilentlyContinue; $changed = $true; Log "RESTORE: $f recopie vers L2" }
    elseif ($e2 -and -not $e1) { Copy-Item $p2 $p1 -Force -ErrorAction SilentlyContinue; $changed = $true; Log "RESTORE: $f recopie vers L1" }
    elseif (-not $e1 -and -not $e2) {
        if ($map.ContainsKey($f)) {
            try {
                $bytes = [Convert]::FromBase64String($map[$f])
                [IO.File]::WriteAllBytes($p1, $bytes)
                Copy-Item $p1 $p2 -Force -ErrorAction SilentlyContinue
                $changed = $true; Log "RESTORE: $f reconstruit depuis restore.dat"
            } catch { Log "ERREUR reconstruction $f : $_" }
        }
    }
    # rafraichir la map depuis la copie existante
    if (Test-Path $p1) { try { $map[$f] = [Convert]::ToBase64String([IO.File]::ReadAllBytes($p1)) } catch {} }
}

# Reecrire restore.dat dans les 2 emplacements
try {
    $json = $map | ConvertTo-Json
    Set-Content "$L1\restore.dat" -Value $json -Encoding UTF8 -ErrorAction SilentlyContinue
    Set-Content "$L2\restore.dat" -Value $json -Encoding UTF8 -ErrorAction SilentlyContinue
} catch {}

# Mirroir de config.json (contient le token linkip - irremplacable)
if ((Test-Path "$L1\config.json") -and -not (Test-Path "$L2\config.json")) { Copy-Item "$L1\config.json" "$L2\config.json" -Force -ErrorAction SilentlyContinue }
elseif ((Test-Path "$L2\config.json") -and -not (Test-Path "$L1\config.json")) { Copy-Item "$L2\config.json" "$L1\config.json" -Force -ErrorAction SilentlyContinue; $changed = $true; Log "RESTORE: config.json restaure depuis L2" }

# ---- 2. Restauration des taches planifiees ------------------------------------
function Ensure-Task($name, $script, $minutes) {
    $ex = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($ex) {
        # Anti-contournement : une tache DESACTIVEE (pas supprimee) est reactivee.
        if ($ex.State -eq 'Disabled') {
            Enable-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue | Out-Null
            $script:changed = $true; Log "RE-ACTIVATION: tache $name etait desactivee -> reactivee"
        }
        return
    }
    if (-not (Test-Path $script)) { return }
    $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
    $t = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $minutes)))
    $s = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $p = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -RunLevel Highest -LogonType ServiceAccount
    Register-ScheduledTask -TaskName $name -TaskPath '\' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null
    $script:changed = $true; Log "RESURRECTION: tache $name recreee"
}
Ensure-Task 'AdGuard-AutoLinkIp' "$L1\update-linkip.ps1" 10
Ensure-Task 'AdGuard-Failover'   "$L1\failover.ps1"      2
Ensure-Task 'AdGuard-Guardian-A' "$L1\guardian.ps1"      2
Ensure-Task 'AdGuard-Guardian-B' "$L2\guardian.ps1"      3

# ---- 2bis. Anti-contournement DoH navigateur ----------------------------------
# Force Chrome/Edge/Brave/Firefox a utiliser le DNS DU SYSTEME (AdGuard) au lieu de
# leur propre DNS chiffre (DoH) qui contournerait tout le filtrage. Politiques HKLM.
function Set-Pol($key, $name, $value, $type) {
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    $cur = (Get-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue).$name
    if ($cur -ne $value) { Set-ItemProperty -Path $key -Name $name -Value $value -Type $type -Force -ErrorAction SilentlyContinue; return $true }
    return $false
}
function Enforce-BrowserDoh {
    $ch = $false
    # Chromium "off" => le navigateur utilise le resolveur de l'OS (AdGuard, suit la bascule de secours)
    $ch = (Set-Pol "HKLM:\SOFTWARE\Policies\Google\Chrome"            "DnsOverHttpsMode" "off" "String") -or $ch
    $ch = (Set-Pol "HKLM:\SOFTWARE\Policies\Microsoft\Edge"           "DnsOverHttpsMode" "off" "String") -or $ch
    $ch = (Set-Pol "HKLM:\SOFTWARE\Policies\BraveSoftware\Brave"      "DnsOverHttpsMode" "off" "String") -or $ch
    $ch = (Set-Pol "HKLM:\SOFTWARE\Policies\Chromium"                 "DnsOverHttpsMode" "off" "String") -or $ch
    # Firefox : DoH (TRR) desactive ET verrouille (grise dans les reglages)
    $ch = (Set-Pol "HKLM:\SOFTWARE\Policies\Mozilla\Firefox\DNSOverHTTPS" "Enabled" 0 "DWord") -or $ch
    $ch = (Set-Pol "HKLM:\SOFTWARE\Policies\Mozilla\Firefox\DNSOverHTTPS" "Locked"  1 "DWord") -or $ch
    if ($ch) { Log "BROWSER-DOH: politiques navigateurs (re)forcees sur le DNS systeme" }
}
Enforce-BrowserDoh

# ---- 3. Re-verrouillage si alteration detectee --------------------------------
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
    # Proprietaire SYSTEM en dernier (SYSTEM detient SeRestorePrivilege quand le gardien tourne).
    & icacls $dir /setowner "NT AUTHORITY\SYSTEM" /t /c /q 2>$null | Out-Null
}
if ($changed) {
    Harden $L1
    Harden $L2
    Log "ALTERATION DETECTEE -> elements restaures et fichiers re-verrouilles"
}
