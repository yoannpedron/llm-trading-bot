#Requires -RunAsAdministrator
<#
.SYNOPSIS
    DNS Fortress - Verrouille le DNS AdGuard DoH sur Windows de façon persistante.
.DESCRIPTION
    Configure DoH natif Windows 11, verrouille les clés de registre par ACL (SYSTEM-only write),
    et installe une tâche planifiée "watchdog" qui réapplique les DNS toutes les 15 minutes.
    Ne bloque PAS le port 53 : localhost et les environnements de dev restent fonctionnels.
.NOTES
    Nécessite Windows 10 21H1+ ou Windows 11. Doit être exécuté en tant qu'Administrateur.
    Certaines restrictions nécessitent SYSTEM pour être annulées (via l'Uninstall fourni).
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ─────────────────────────────────────────────
# CONSTANTES
# ─────────────────────────────────────────────
$DOH_TEMPLATE  = "https://d.adguard-dns.com/dns-query/cdd465ed"
$DNS_IPV4      = @("94.140.14.49", "94.140.14.59")
$DNS_IPV6      = @("2a10:50c0:c000::cdd4:65ed", "2a10:50c0:c000::1:cdd4:65ed")
$LINKIP_URL    = "https://linkip.adguard-dns.com/linkip/cdd465ed/jtTCH020Ci4z8swwFWxBt0lBXQJMmnzBSyUIR0dglrZ"
$TASK_NAME     = "DNS-Fortress-Watchdog"
$TASK_PATH     = "\Microsoft\Windows\DNS Fortress\"

$REG_DNSCACHE  = "HKLM:\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters"
$REG_DOH_KNOWN = "$REG_DNSCACHE\DohWellknownServers"
$REG_POLICY    = "HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\DNSClient"

# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────
function Write-Step([string]$msg) {
    Write-Host "`n[*] $msg" -ForegroundColor Cyan
}
function Write-Ok([string]$msg) {
    Write-Host "    [OK] $msg" -ForegroundColor Green
}
function Write-Warn([string]$msg) {
    Write-Host "    [!]  $msg" -ForegroundColor Yellow
}

function Assert-WindowsVersion {
    $build = [System.Environment]::OSVersion.Version.Build
    if ($build -lt 19041) {
        throw "Windows 10 build 19041 (20H1) minimum requis. Build actuel : $build"
    }
}

# ─────────────────────────────────────────────
# ÉTAPE 1 : DNS sur tous les adaptateurs actifs
# ─────────────────────────────────────────────
function Set-DnsOnAdapters {
    Write-Step "Application des serveurs DNS sur tous les adaptateurs actifs"

    $adapters = Get-NetAdapter | Where-Object { $_.Status -eq "Up" }
    if (-not $adapters) { Write-Warn "Aucun adaptateur actif trouvé."; return }

    foreach ($adapter in $adapters) {
        $idx = $adapter.ifIndex
        $name = $adapter.Name

        # IPv4
        Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses $DNS_IPV4
        Write-Ok "IPv4 DNS défini sur '$name'"

        # IPv6
        try {
            Set-DnsClientServerAddress -InterfaceIndex $idx -ServerAddresses $DNS_IPV6
            Write-Ok "IPv6 DNS défini sur '$name'"
        } catch {
            Write-Warn "IPv6 non disponible sur '$name' (ignoré)"
        }
    }
}

# ─────────────────────────────────────────────
# ÉTAPE 2 : Registre DoH Windows natif
# ─────────────────────────────────────────────
function Set-DoHRegistry {
    Write-Step "Configuration du DNS-over-HTTPS dans le registre"

    # Activer AutoDoH en mode strict (2 = DoH obligatoire, pas de fallback UDP/TCP)
    if (-not (Test-Path $REG_DNSCACHE)) { New-Item -Path $REG_DNSCACHE -Force | Out-Null }
    Set-ItemProperty -Path $REG_DNSCACHE -Name "EnableAutoDoh" -Value 2 -Type DWord
    Write-Ok "EnableAutoDoh = 2 (DoH strict)"

    # Enregistrer les serveurs DoH comme "connus" de Windows
    if (-not (Test-Path $REG_DOH_KNOWN)) { New-Item -Path $REG_DOH_KNOWN -Force | Out-Null }
    foreach ($ip in $DNS_IPV4) {
        New-Item -Path "$REG_DOH_KNOWN\$ip" -Force | Out-Null
        Set-ItemProperty -Path "$REG_DOH_KNOWN\$ip" -Name "DohTemplate" -Value $DOH_TEMPLATE -Type String
        Set-ItemProperty -Path "$REG_DOH_KNOWN\$ip" -Name "AutoUpgrade"  -Value 1           -Type DWord
        Set-ItemProperty -Path "$REG_DOH_KNOWN\$ip" -Name "AllowFallbackToUdp" -Value 0     -Type DWord
        Write-Ok "DoH enregistré pour $ip"
    }

    # Appliquer DoH sur les adaptateurs actifs via cmdlet (Windows 11+)
    $adapters = Get-NetAdapter | Where-Object { $_.Status -eq "Up" }
    foreach ($adapter in $adapters) {
        foreach ($ip in $DNS_IPV4) {
            try {
                Set-DnsClientDohServerAddress -ServerAddress $ip `
                    -DohTemplate $DOH_TEMPLATE -AutoUpgrade $true -AllowFallbackToUdp $false
                Write-Ok "DoH activé sur adaptateur pour $ip"
            } catch {
                Write-Warn "Set-DnsClientDohServerAddress non disponible (Windows 10 ?). Registre suffisant."
            }
        }
    }

    # Vider le cache DNS
    Clear-DnsClientCache
    Write-Ok "Cache DNS vidé"
}

# ─────────────────────────────────────────────
# ÉTAPE 3 : Stratégie de groupe locale (GPO via registre)
# ─────────────────────────────────────────────
function Set-GPOPolicies {
    Write-Step "Application des stratégies de groupe DNS"

    if (-not (Test-Path $REG_POLICY)) { New-Item -Path $REG_POLICY -Force | Out-Null }

    # Forcer les serveurs DNS (contourne les paramètres de l'adaptateur UI)
    Set-ItemProperty -Path $REG_POLICY -Name "EnableAutoDoh"          -Value 2           -Type DWord
    Set-ItemProperty -Path $REG_POLICY -Name "DoHPolicy"              -Value 3           -Type DWord  # 3 = DoH uniquement
    Set-ItemProperty -Path $REG_POLICY -Name "NameServer"             -Value ($DNS_IPV4 -join ",") -Type String
    Set-ItemProperty -Path $REG_POLICY -Name "DoHTemplate"            -Value $DOH_TEMPLATE -Type String

    Write-Ok "GPO DNS : DoH strict + serveurs forcés"

    # Empêcher la modification des DNS via l'interface réseau (désactive le champ dans les propriétés adaptateur)
    $ncpaPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Network Connections"
    if (-not (Test-Path $ncpaPath)) { New-Item -Path $ncpaPath -Force | Out-Null }
    Set-ItemProperty -Path $ncpaPath -Name "NC_SetIPMetrics" -Value 0 -Type DWord
    Write-Ok "Modification des propriétés réseau restreinte"
}

# ─────────────────────────────────────────────
# ÉTAPE 4 : Tâche planifiée Watchdog (SYSTEM, toutes les 15 min)
# ─────────────────────────────────────────────
function Install-WatchdogTask {
    Write-Step "Installation de la tâche Watchdog (SYSTEM, toutes les 15 minutes)"

    # Script embarqué dans la tâche (re-applique DNS + ping linkip)
    $watchdogScript = @"
`$dns = @('94.140.14.49','94.140.14.59')
`$doh = 'https://d.adguard-dns.com/dns-query/cdd465ed'
`$linkip = 'https://linkip.adguard-dns.com/linkip/cdd465ed/jtTCH020Ci4z8swwFWxBt0lBXQJMmnzBSyUIR0dglrZ'

# Re-appliquer DNS sur tous les adaptateurs actifs
Get-NetAdapter | Where-Object { `$_.Status -eq 'Up' } | ForEach-Object {
    Set-DnsClientServerAddress -InterfaceIndex `$_.ifIndex -ServerAddresses `$dns -ErrorAction SilentlyContinue
}

# S'assurer que EnableAutoDoh reste à 2
Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters' ``
    -Name 'EnableAutoDoh' -Value 2 -Type DWord -ErrorAction SilentlyContinue

# Mettre à jour l'IP liée chez AdGuard (sans erreur si offline)
try { Invoke-WebRequest -Uri `$linkip -UseBasicParsing -TimeoutSec 10 | Out-Null } catch {}

Clear-DnsClientCache -ErrorAction SilentlyContinue
"@

    # Sauvegarder le script watchdog dans System32 (protégé par défaut)
    $watchdogPath = "$env:SystemRoot\System32\dns-fortress-watchdog.ps1"
    Set-Content -Path $watchdogPath -Value $watchdogScript -Encoding UTF8
    Write-Ok "Script watchdog : $watchdogPath"

    # Créer la tâche planifiée
    $action  = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdogPath`""

    $triggers = @(
        $(New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Minutes 15) -Once -At (Get-Date)),
        $(New-ScheduledTaskTrigger -AtStartup),
        $(New-ScheduledTaskTrigger -AtLogOn)
    )

    $settings = New-ScheduledTaskSettingsSet `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -Hidden `
        -RunOnlyIfNetworkAvailable `
        -StartWhenAvailable

    $principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" -RunLevel Highest -LogonType ServiceAccount

    # Supprimer l'ancienne tâche si elle existe
    Get-ScheduledTask -TaskName $TASK_NAME -TaskPath $TASK_PATH -ErrorAction SilentlyContinue |
        Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue

    Register-ScheduledTask `
        -TaskName  $TASK_NAME `
        -TaskPath  $TASK_PATH `
        -Action    $action `
        -Trigger   $triggers `
        -Settings  $settings `
        -Principal $principal `
        -Force | Out-Null

    Write-Ok "Tâche '$TASK_NAME' enregistrée (SYSTEM, toutes les 15 min + démarrage + ouverture session)"

    # Restreindre les permissions sur la tâche planifiée (retirer Delete/Write pour Administrators)
    $taskSddl = "D:(A;;0x1200a9;;;SY)(A;;0x1200a9;;;BA)(A;;FR;;;AU)"  # SYSTEM=Full, Admins=Read+Execute, Users=Read
    $schTaskPath = "$env:SystemRoot\System32\Tasks\Microsoft\Windows\DNS Fortress\$TASK_NAME"
    if (Test-Path $schTaskPath) {
        try {
            icacls $schTaskPath /inheritance:r /grant:r "NT AUTHORITY\SYSTEM:(F)" "BUILTIN\Administrators:(R)" 2>&1 | Out-Null
            Write-Ok "Permissions de la tâche restreintes (Admins = lecture seule)"
        } catch {
            Write-Warn "Restriction ACL de la tâche échouée (non bloquant)"
        }
    }
}

# ─────────────────────────────────────────────
# ÉTAPE 5 : Verrouillage des clés de registre par ACL
# ─────────────────────────────────────────────
function Lock-RegistryKeys {
    Write-Step "Verrouillage des clés de registre (DENY Write pour Administrators)"

    $keysToLock = @(
        $REG_DNSCACHE,
        $REG_DOH_KNOWN,
        $REG_POLICY
    )

    foreach ($keyPath in $keysToLock) {
        if (-not (Test-Path $keyPath)) { continue }

        try {
            # Ouvrir la clé avec les droits nécessaires
            $regKeyPath = $keyPath -replace "HKLM:\\", ""
            $hive = [Microsoft.Win32.Registry]::LocalMachine
            $key  = $hive.OpenSubKey($regKeyPath, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
                        [System.Security.AccessControl.RegistryRights]::ChangePermissions)

            if ($null -eq $key) { Write-Warn "Impossible d'ouvrir $keyPath pour modification ACL"; continue }

            $acl = $key.GetAccessControl()

            # Règle DENY : Administrators ne peuvent pas écrire/supprimer/modifier les permissions
            $denyRule = New-Object System.Security.AccessControl.RegistryAccessRule(
                "BUILTIN\Administrators",
                [System.Security.AccessControl.RegistryRights]"SetValue,CreateSubKey,DeleteValue,Delete,ChangePermissions,TakeOwnership",
                [System.Security.AccessControl.InheritanceFlags]"ContainerInherit,ObjectInherit",
                [System.Security.AccessControl.PropagationFlags]"None",
                [System.Security.AccessControl.AccessControlType]"Deny"
            )

            $acl.AddAccessRule($denyRule)
            $key.SetAccessControl($acl)
            $key.Close()

            Write-Ok "Clé verrouillée : $keyPath"
        } catch {
            Write-Warn "Verrouillage échoué pour $keyPath : $_"
        }
    }
}

# ─────────────────────────────────────────────
# ÉTAPE 6 : Premier ping linkip immédiat
# ─────────────────────────────────────────────
function Invoke-LinkIpUpdate {
    Write-Step "Mise à jour de l'IP liée chez AdGuard DNS"
    try {
        Invoke-WebRequest -Uri $LINKIP_URL -UseBasicParsing -TimeoutSec 15 | Out-Null
        Write-Ok "IP mise à jour avec succès"
    } catch {
        Write-Warn "Mise à jour IP échouée (vérifiez la connexion internet) : $_"
    }
}

# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
Write-Host "`n╔══════════════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "║         DNS FORTRESS - INSTALLATION          ║" -ForegroundColor Magenta
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Magenta

Assert-WindowsVersion

Set-DnsOnAdapters
Set-DoHRegistry
Set-GPOPolicies
Install-WatchdogTask
Lock-RegistryKeys
Invoke-LinkIpUpdate

# Redémarrer le service DNS pour appliquer les changements
Write-Step "Redémarrage du service DNS Client"
Restart-Service -Name "Dnscache" -Force -ErrorAction SilentlyContinue
Write-Ok "Service DNS Client redémarré"

Write-Host "`n╔══════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║  FORTERESSE INSTALLÉE - Résumé des couches  ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host @"

  [1] DNS AdGuard appliqué sur tous les adaptateurs réseau actifs
  [2] DoH natif Windows activé en mode STRICT (pas de fallback UDP)
  [3] GPO locale : DoH forcé, modification UI réseau restreinte
  [4] Watchdog SYSTEM : réapplique les DNS toutes les 15 min + au démarrage
  [5] Clés de registre DNS verrouillées (DENY Write pour Administrators)
  [6] IP liée mise à jour chez AdGuard DNS

  PORT 53 : NON bloqué (dev local intact)
  Pour désinstaller : .\Uninstall-Fortress.ps1 (admin requis + étapes manuelles)

"@ -ForegroundColor White
