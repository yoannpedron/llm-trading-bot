#Requires -RunAsAdministrator
# ============================================================================
#  RECUPERATION D'URGENCE - retire COMPLETEMENT le systeme AdGuard Fortress
#  A LANCER EN MODE SANS ECHEC (sinon les gardiens ressuscitent tout)
#  Usage normal : reboot en Mode sans echec, puis lancer ce script en admin.
#  Pour forcer hors mode sans echec (deconseille) : -Force
# ============================================================================
param([switch]$Force)
$ErrorActionPreference = 'Continue'

$L1 = "$env:ProgramData\AdGuardAutoLink"
$L2 = "$env:ProgramData\Microsoft\Windows\AGDNS"

Write-Host "============================================" -ForegroundColor Red
Write-Host "  RECUPERATION D'URGENCE - AdGuard Fortress " -ForegroundColor Red
Write-Host "============================================" -ForegroundColor Red

# --- Verifier le Mode sans echec ------------------------------------------------
$bootMode = (Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).BootupState
$inSafeMode = $bootMode -match "safe|fail-safe"
if (-not $inSafeMode -and -not $Force) {
    Write-Host ""
    Write-Host "  ATTENTION : tu n'es PAS en Mode sans echec (boot = '$bootMode')." -ForegroundColor Yellow
    Write-Host "  Les taches gardiennes tournent et vont TOUT recreer dans les 2-3 min." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  Procedure correcte :" -ForegroundColor White
    Write-Host "   1. Parametres > Systeme > Recuperation > Demarrage avance > Redemarrer" -ForegroundColor Gray
    Write-Host "      (ou maintenir Maj en cliquant Redemarrer)" -ForegroundColor Gray
    Write-Host "   2. Depannage > Options avancees > Parametres > Redemarrer > touche 4" -ForegroundColor Gray
    Write-Host "   3. Relancer ce script en admin." -ForegroundColor Gray
    Write-Host ""
    Write-Host "  Pour forcer quand meme (race contre les gardiens) : -Force" -ForegroundColor DarkGray
    Read-Host "Appuie sur Entree pour quitter"
    exit 1
}

# --- 1. Stopper + supprimer toutes les taches -----------------------------------
Write-Host "[1] Suppression des taches..." -ForegroundColor Cyan
foreach ($t in @("AdGuard-AutoLinkIp","AdGuard-Failover","AdGuard-Guardian-A","AdGuard-Guardian-B","AdGuardWatchdog","DNS-AdGuard-499","DNS-DoH-Persist")) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "    supprime : $t" -ForegroundColor Green
    }
}

# --- 2. Prendre possession + supprimer les fichiers -----------------------------
Write-Host "[2] Suppression des fichiers (prise de possession)..." -ForegroundColor Cyan
foreach ($d in @($L1, $L2)) {
    if (Test-Path $d) {
        takeown /f $d /r /a /d O 2>$null | Out-Null
        icacls $d /reset /t /c /q 2>$null | Out-Null
        icacls $d /grant "*S-1-5-32-544:(OI)(CI)F" /t /c /q 2>$null | Out-Null
        Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "    supprime : $d" -ForegroundColor Green
    }
}
foreach ($f in @("$env:SystemRoot\System32\dns-watchdog-499.ps1","$env:SystemRoot\System32\dns-doh-persist.ps1")) {
    if (Test-Path $f) { takeown /f $f /a 2>$null | Out-Null; Remove-Item $f -Force -ErrorAction SilentlyContinue }
}

# --- 3. Restaurer le DNS normal (DHCP) ------------------------------------------
Write-Host "[3] Restauration DNS DHCP..." -ForegroundColor Cyan
Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
    Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ResetServerAddresses -ErrorAction SilentlyContinue
    Write-Host "    DNS reinitialise sur $($_.Name)" -ForegroundColor Green
}

# --- 4. Desactiver DoH + nettoyer templates -------------------------------------
Write-Host "[4] Desactivation DoH..." -ForegroundColor Cyan
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters' -Name "EnableAutoDoh" -Value 0 -Type DWord -Force -ErrorAction SilentlyContinue
Get-DnsClientDohServerAddress -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddress -match '94.140' } | ForEach-Object {
    Remove-DnsClientDohServerAddress -ServerAddress $_.ServerAddress -ErrorAction SilentlyContinue
}

# --- 5. Reactiver IPv6 sur Wi-Fi ------------------------------------------------
Write-Host "[5] Reactivation IPv6..." -ForegroundColor Cyan
Enable-NetAdapterBinding -Name "Wi-Fi" -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue
Remove-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters" -Name "DisabledComponents" -ErrorAction SilentlyContinue

# --- 6. Nettoyer le fichier hosts -----------------------------------------------
Write-Host "[6] Nettoyage du fichier hosts..." -ForegroundColor Cyan
$hostsFile = "$env:SystemRoot\System32\drivers\etc\hosts"
$h = Get-Content $hostsFile -Raw -ErrorAction SilentlyContinue
if ($h) {
    $h = $h -replace "(?m)^.*# ADGUARD-BOOTSTRAP.*(\r?\n)?", ""
    Set-Content $hostsFile -Value $h.TrimEnd() -Encoding ASCII -ErrorAction SilentlyContinue
}

# --- 7. Flush -------------------------------------------------------------------
Clear-DnsClientCache -ErrorAction SilentlyContinue
ipconfig /flushdns | Out-Null

Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "  SUPPRESSION COMPLETE TERMINEE             " -ForegroundColor Green
Write-Host "  Redemarre en mode normal." -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Read-Host "Appuie sur Entree"
