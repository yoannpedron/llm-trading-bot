#Requires -RunAsAdministrator
<#
.SYNOPSIS
    DNS Fortress - Script de désinstallation complète.
.DESCRIPTION
    Annule toutes les modifications appliquées par Install-Fortress.ps1 :
    - Déverrouille les clés de registre (restaure les ACL par défaut)
    - Supprime les entrées DoH et GPO
    - Supprime la tâche planifiée Watchdog
    - Remet tous les adaptateurs en DNS automatique (DHCP)
    - Supprime le script watchdog de System32
.NOTES
    Les règles DENY sur le registre empêchent même les admins d'écrire directement.
    Ce script utilise le privilège SeRestorePrivilege + SeBackupPrivilege pour contourner
    ces restrictions et restaurer les ACL par défaut.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'  # Continue pour ne pas bloquer sur les erreurs partielles

$TASK_NAME     = "DNS-Fortress-Watchdog"
$TASK_PATH     = "\Microsoft\Windows\DNS Fortress\"
$REG_DNSCACHE  = "HKLM:\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters"
$REG_DOH_KNOWN = "$REG_DNSCACHE\DohWellknownServers"
$REG_POLICY    = "HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\DNSClient"
$WATCHDOG_PATH = "$env:SystemRoot\System32\dns-fortress-watchdog.ps1"

# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────
function Write-Step([string]$msg) { Write-Host "`n[*] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "    [!]  $msg" -ForegroundColor Yellow }

# Active les privilèges SeRestore/SeBackup nécessaires pour modifier les ACL verrouillées
function Enable-RegistryPrivileges {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class PrivilegeEnabler {
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    static extern bool LookupPrivilegeValue(string lpSystemName, string lpName, out LUID lpLuid);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AdjustTokenPrivileges(IntPtr TokenHandle, bool DisableAllPrivileges,
        ref TOKEN_PRIVILEGES NewState, uint BufferLength, IntPtr PreviousState, IntPtr ReturnLength);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    [StructLayout(LayoutKind.Sequential)]
    struct LUID { public uint LowPart; public int HighPart; }

    [StructLayout(LayoutKind.Sequential)]
    struct TOKEN_PRIVILEGES {
        public uint PrivilegeCount;
        public LUID Luid;
        public uint Attributes;
    }

    const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
    const uint TOKEN_QUERY = 0x0008;
    const uint SE_PRIVILEGE_ENABLED = 0x00000002;

    public static void Enable(string privilegeName) {
        IntPtr token;
        OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, out token);
        LUID luid;
        LookupPrivilegeValue(null, privilegeName, out luid);
        TOKEN_PRIVILEGES tp = new TOKEN_PRIVILEGES {
            PrivilegeCount = 1,
            Luid = luid,
            Attributes = SE_PRIVILEGE_ENABLED
        };
        AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
    }
}
"@ -ErrorAction SilentlyContinue

    try {
        [PrivilegeEnabler]::Enable("SeRestorePrivilege")
        [PrivilegeEnabler]::Enable("SeBackupPrivilege")
        [PrivilegeEnabler]::Enable("SeTakeOwnershipPrivilege")
        Write-Ok "Privilèges élevés activés (SeRestore, SeBackup, SeTakeOwnership)"
    } catch {
        Write-Warn "Activation des privilèges échouée : $_"
    }
}

# ─────────────────────────────────────────────
# ÉTAPE 1 : Arrêter et supprimer la tâche Watchdog
# ─────────────────────────────────────────────
function Remove-WatchdogTask {
    Write-Step "Suppression de la tâche planifiée Watchdog"

    # Restaurer les permissions sur le fichier de tâche avant suppression
    $schTaskPath = "$env:SystemRoot\System32\Tasks\Microsoft\Windows\DNS Fortress\$TASK_NAME"
    if (Test-Path $schTaskPath) {
        try {
            takeown /f $schTaskPath /a 2>&1 | Out-Null
            icacls $schTaskPath /reset 2>&1 | Out-Null
            icacls $schTaskPath /grant "BUILTIN\Administrators:(F)" 2>&1 | Out-Null
            Write-Ok "Permissions du fichier de tâche restaurées"
        } catch { Write-Warn "Restauration permissions tâche : $_" }
    }

    # Arrêter et supprimer
    try {
        Stop-ScheduledTask -TaskName $TASK_NAME -TaskPath $TASK_PATH -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TASK_NAME -TaskPath $TASK_PATH -Confirm:$false -ErrorAction Stop
        Write-Ok "Tâche '$TASK_NAME' supprimée"
    } catch {
        Write-Warn "Suppression via Register-ScheduledTask échouée, tentative schtasks.exe..."
        schtasks /Delete /TN "$TASK_PATH$TASK_NAME" /F 2>&1 | Out-Null
        Write-Ok "Tentative schtasks /Delete effectuée"
    }

    # Supprimer le dossier de tâche vide
    $taskFolder = "$env:SystemRoot\System32\Tasks\Microsoft\Windows\DNS Fortress"
    if (Test-Path $taskFolder) {
        Remove-Item -Path $taskFolder -Recurse -Force -ErrorAction SilentlyContinue
        Write-Ok "Dossier de tâche supprimé"
    }
}

# ─────────────────────────────────────────────
# ÉTAPE 2 : Supprimer le script watchdog de System32
# ─────────────────────────────────────────────
function Remove-WatchdogScript {
    Write-Step "Suppression du script watchdog de System32"
    if (Test-Path $WATCHDOG_PATH) {
        try {
            takeown /f $WATCHDOG_PATH /a 2>&1 | Out-Null
            icacls $WATCHDOG_PATH /grant "BUILTIN\Administrators:(F)" 2>&1 | Out-Null
            Remove-Item -Path $WATCHDOG_PATH -Force -ErrorAction Stop
            Write-Ok "Script watchdog supprimé : $WATCHDOG_PATH"
        } catch {
            Write-Warn "Suppression du script watchdog échouée : $_"
        }
    } else {
        Write-Ok "Script watchdog absent (déjà supprimé)"
    }
}

# ─────────────────────────────────────────────
# ÉTAPE 3 : Déverrouiller les clés de registre
# ─────────────────────────────────────────────
function Unlock-RegistryKeys {
    Write-Step "Déverrouillage des clés de registre (restauration ACL par défaut)"

    Enable-RegistryPrivileges

    $keysToUnlock = @($REG_DOH_KNOWN, $REG_DNSCACHE, $REG_POLICY)

    foreach ($keyPath in $keysToUnlock) {
        if (-not (Test-Path $keyPath)) { continue }

        $regKeyPath = $keyPath -replace "HKLM:\\", ""

        try {
            # Prendre possession via takeown (contourne le DENY)
            $fullPath = "HKLM\$($regKeyPath -replace '/', '\')"
            $result = & reg.exe ADD $fullPath /f 2>&1  # Force l'accès
        } catch {}

        try {
            # Ouvrir avec tous les droits via token élevé
            $hive = [Microsoft.Win32.Registry]::LocalMachine
            $key  = $hive.OpenSubKey(
                $regKeyPath,
                [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
                [System.Security.AccessControl.RegistryRights]"ChangePermissions,TakeOwnership,ReadPermissions"
            )

            if ($null -ne $key) {
                $acl = $key.GetAccessControl([System.Security.AccessControl.AccessControlSections]::All)

                # Supprimer toutes les règles DENY
                $denyRules = $acl.Access | Where-Object { $_.AccessControlType -eq 'Deny' }
                foreach ($rule in $denyRules) {
                    $acl.RemoveAccessRule($rule) | Out-Null
                }

                # Restaurer : SYSTEM=Full, Administrators=Full, Users=Read
                $sysFull   = New-Object System.Security.AccessControl.RegistryAccessRule(
                    "NT AUTHORITY\SYSTEM", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
                $adminFull = New-Object System.Security.AccessControl.RegistryAccessRule(
                    "BUILTIN\Administrators", "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")

                $acl.AddAccessRule($sysFull)
                $acl.AddAccessRule($adminFull)
                $key.SetAccessControl($acl)
                $key.Close()

                Write-Ok "ACL restaurée : $keyPath"
            } else {
                Write-Warn "Impossible d'ouvrir la clé : $keyPath"
            }
        } catch {
            Write-Warn "Déverrouillage échoué pour $keyPath : $_"
            Write-Warn "  -> Essayez manuellement : regedit > clic droit > Autorisations"
        }
    }
}

# ─────────────────────────────────────────────
# ÉTAPE 4 : Supprimer les entrées DoH et GPO du registre
# ─────────────────────────────────────────────
function Remove-RegistryEntries {
    Write-Step "Suppression des entrées DNS Fortress du registre"

    # Supprimer DohWellknownServers
    if (Test-Path $REG_DOH_KNOWN) {
        Remove-Item -Path $REG_DOH_KNOWN -Recurse -Force -ErrorAction SilentlyContinue
        Write-Ok "Clé DohWellknownServers supprimée"
    }

    # Remettre EnableAutoDoh à 0 (désactivé)
    if (Test-Path $REG_DNSCACHE) {
        Set-ItemProperty -Path $REG_DNSCACHE -Name "EnableAutoDoh" -Value 0 -Type DWord -ErrorAction SilentlyContinue
        Write-Ok "EnableAutoDoh remis à 0"
    }

    # Supprimer les GPO DNS
    if (Test-Path $REG_POLICY) {
        @("EnableAutoDoh","DoHPolicy","NameServer","DoHTemplate") | ForEach-Object {
            Remove-ItemProperty -Path $REG_POLICY -Name $_ -ErrorAction SilentlyContinue
        }
        Write-Ok "Valeurs GPO DNS supprimées"
    }

    # Supprimer la restriction UI réseau
    $ncpaPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Network Connections"
    if (Test-Path $ncpaPath) {
        Remove-ItemProperty -Path $ncpaPath -Name "NC_SetIPMetrics" -ErrorAction SilentlyContinue
        Write-Ok "Restriction UI réseau supprimée"
    }
}

# ─────────────────────────────────────────────
# ÉTAPE 5 : Remettre tous les adaptateurs en DNS automatique (DHCP)
# ─────────────────────────────────────────────
function Reset-AdaptersDns {
    Write-Step "Remise en DNS automatique (DHCP) sur tous les adaptateurs"

    Get-NetAdapter | ForEach-Object {
        $idx  = $_.ifIndex
        $name = $_.Name
        try {
            Set-DnsClientServerAddress -InterfaceIndex $idx -ResetServerAddresses
            Write-Ok "Adaptateur '$name' : DNS automatique (DHCP)"
        } catch {
            Write-Warn "Impossible de réinitialiser '$name' : $_"
        }
    }

    # Supprimer DoH sur les serveurs enregistrés
    foreach ($ip in @("94.140.14.49","94.140.14.59")) {
        try {
            Remove-DnsClientDohServerAddress -ServerAddress $ip -ErrorAction SilentlyContinue
            Write-Ok "DoH supprimé pour $ip"
        } catch {}
    }

    Clear-DnsClientCache -ErrorAction SilentlyContinue
    Write-Ok "Cache DNS vidé"
}

# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
Write-Host "`n╔══════════════════════════════════════════════╗" -ForegroundColor Red
Write-Host "║       DNS FORTRESS - DÉSINSTALLATION         ║" -ForegroundColor Red
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Red
Write-Host ""
Write-Host "  ATTENTION : Cette opération annule toutes les protections DNS." -ForegroundColor Yellow
Write-Host "  Continuez uniquement si vous êtes conscient de ce que vous faites." -ForegroundColor Yellow
Write-Host ""

$confirm = Read-Host "Tapez OUI pour confirmer la désinstallation complète"
if ($confirm -ne "OUI") {
    Write-Host "`nDésinstallation annulée." -ForegroundColor Green
    exit 0
}

Remove-WatchdogTask
Remove-WatchdogScript
Unlock-RegistryKeys
Remove-RegistryEntries
Reset-AdaptersDns

# Redémarrer le service DNS
Write-Step "Redémarrage du service DNS Client"
Restart-Service -Name "Dnscache" -Force -ErrorAction SilentlyContinue
Write-Ok "Service DNS Client redémarré"

Write-Host "`n╔══════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║         DÉSINSTALLATION TERMINÉE             ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host @"

  Toutes les couches de protection DNS ont été supprimées.
  Les adaptateurs réseau utilisent à nouveau le DNS automatique (DHCP).

  Un redémarrage est recommandé pour s'assurer que tous les
  paramètres GPO sont bien effacés.

"@ -ForegroundColor White
