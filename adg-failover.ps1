# AdGuard DNS - Failover watchdog (sortie de secours A PALIERS)
# Tourne en SYSTEM toutes les 2 min.
#  Palier 0 : AdGuard perso OK   -> config stricte (perso DoH + EnableAutoDoh=2)
#  Palier 1 : AdGuard perso KO   -> bascule AdGuard FAMILY (94.140.14.15 / 94.140.15.16)
#                                   qui BLOQUE TOUJOURS le contenu adulte.
#  Palier 2 : Family KO aussi    -> dernier recours DNS public non filtre (internet preserve).
#  ANTI-BYPASS : si AUCUN internet (test TCP independant du DNS), on NE bascule PAS
#                (evite l'astuce deconnexion/reconnexion Wi-Fi qui menait au DNS non filtre).
#  AdGuard perso revient -> restaure automatiquement la config stricte.

$L1   = "$env:ProgramData\AdGuardAutoLink"
$L2   = "$env:ProgramData\Microsoft\Windows\AGDNS"
$FLAG = "$L1\failover-active.flag"
$CNT  = "$L1\failcount.txt"
$LOG  = "$L1\failover.log"
$REG  = "HKLM:\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters"
$DOH        = "https://d.adguard-dns.com/dns-query/499cb42d"
$FAMILY_DOH = "https://family.adguard-dns.com/dns-query"
$PERSONAL  = @("94.140.14.49","94.140.14.59")
$FAMILY    = @("94.140.14.15","94.140.15.16")
$PUBLIC    = @("8.8.8.8","8.8.4.4")
$THRESHOLD = 2

function Log($m) { Add-Content $LOG -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" -ErrorAction SilentlyContinue }

# Un resolveur DNS donne repond-il ?
function Test-Resolver($servers) {
    foreach ($s in $servers) {
        for ($i = 0; $i -lt 2; $i++) {
            $r = Resolve-DnsName "www.google.com" -Server $s -Type A -DnsOnly -QuickTimeout -ErrorAction SilentlyContinue
            if ($r) { return $true }
        }
    }
    return $false
}

# Y a-t-il de l'internet DU TOUT ? (connexion TCP 443 vers IP stables, SANS DNS)
function Test-RawInternet {
    foreach ($ip in @("8.8.8.8","1.1.1.1","9.9.9.9")) {
        try {
            $c = New-Object System.Net.Sockets.TcpClient
            $iar = $c.BeginConnect($ip, 443, $null, $null)
            $ok = $iar.AsyncWaitHandle.WaitOne(1500, $false)
            if ($ok -and $c.Connected) { $c.Close(); return $true }
            $c.Close()
        } catch {}
    }
    return $false
}

function Set-AllAdaptersDns($servers) {
    Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
        Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ServerAddresses $servers -ErrorAction SilentlyContinue
    }
}

function Add-Doh($servers, $template, $fallback) {
    foreach ($ip in $servers) {
        Remove-DnsClientDohServerAddress -ServerAddress $ip -ErrorAction SilentlyContinue
        Add-DnsClientDohServerAddress -ServerAddress $ip -DohTemplate $template -AllowFallbackToUdp $fallback -AutoUpgrade $true -ErrorAction SilentlyContinue
    }
}

function CurDns { (Get-DnsClientServerAddress -InterfaceAlias 'Wi-Fi' -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses }

# ---- Auto-resurrection : s'assurer que les gardiens existent --------------------
function Ensure-Task($name, $script, $minutes) {
    $ex = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($ex) {
        if ($ex.State -eq 'Disabled') { Enable-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue | Out-Null; Log "RE-ACTIVATION: tache $name reactivee (etait desactivee)" }
        return
    }
    if (-not (Test-Path $script)) { return }
    $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
    $t = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $minutes)))
    $s = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $p = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -RunLevel Highest -LogonType ServiceAccount
    Register-ScheduledTask -TaskName $name -TaskPath '\' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null
    Log "RESURRECTION: tache $name recreee"
}
Ensure-Task 'AdGuard-Guardian-A' "$L1\guardian.ps1" 2
Ensure-Task 'AdGuard-Guardian-B' "$L2\guardian.ps1" 3

# ---- Logique de failover a paliers ---------------------------------------------
$personalUp = Test-Resolver $PERSONAL

if ($personalUp) {
    Set-Content $CNT -Value "0" -ErrorAction SilentlyContinue
    if (Test-Path $FLAG) {
        # RECUPERATION : AdGuard perso est revenu -> config stricte
        Set-AllAdaptersDns $PERSONAL
        Set-ItemProperty $REG -Name "EnableAutoDoh" -Value 2 -Type DWord -Force -ErrorAction SilentlyContinue
        foreach ($ip in $FAMILY) { Remove-DnsClientDohServerAddress -ServerAddress $ip -ErrorAction SilentlyContinue }
        Add-Doh $PERSONAL $DOH $false
        Clear-DnsClientCache -ErrorAction SilentlyContinue
        Remove-Item $FLAG -Force -ErrorAction SilentlyContinue
        Log "RECOVERED - AdGuard perso de retour : config stricte restauree"
    } else {
        # Enforcement normal (sans spammer si deja bon)
        $needFix = $false
        Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
            $cur = (Get-DnsClientServerAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses
            if (-not ($cur -contains '94.140.14.49')) { $needFix = $true }
        }
        if ($needFix) { Set-AllAdaptersDns $PERSONAL; Log "DNS adaptateur re-applique sur AdGuard perso" }
        $autoDoh = (Get-ItemProperty $REG -Name "EnableAutoDoh" -ErrorAction SilentlyContinue).EnableAutoDoh
        if ($autoDoh -ne 2) { Set-ItemProperty $REG -Name "EnableAutoDoh" -Value 2 -Type DWord -Force -ErrorAction SilentlyContinue; Log "EnableAutoDoh remis a 2" }
        $haveDoh = Get-DnsClientDohServerAddress -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddress -in $PERSONAL }
        if (-not $haveDoh) { Add-Doh $PERSONAL $DOH $false; Log "Entrees DoH perso re-ajoutees" }
    }
} else {
    # AdGuard perso KO
    $net = Test-RawInternet
    if (-not $net) {
        # ANTI-BYPASS : pas d'internet du tout -> NE PAS basculer (sinon deconnexion = DNS non filtre).
        Set-Content $CNT -Value "0" -ErrorAction SilentlyContinue
        $cur0 = CurDns
        if ($cur0 -and ($cur0 -contains '8.8.8.8')) {
            # si on etait reste sur du public non filtre, repingler sur Family (filtre) par securite
            Set-AllAdaptersDns $FAMILY
            Set-Content $FLAG -Value "FAMILY" -Force -ErrorAction SilentlyContinue
            Log "Pas d'internet mais DNS etait public -> repingle sur Family (filtre) par securite"
        }
        Log "AdGuard perso injoignable ET pas d'internet -> aucune bascule (anti-bypass deconnexion)"
        return
    }
    # internet brut OK mais AdGuard perso KO -> compter les echecs consecutifs
    $c = 0
    if (Test-Path $CNT) { $c = [int]((Get-Content $CNT -Raw).Trim()) }
    $c++
    Set-Content $CNT -Value "$c" -ErrorAction SilentlyContinue
    Log "AdGuard perso injoignable (internet OK) - echec $c/$THRESHOLD"
    if ($c -ge $THRESHOLD -and -not (Test-Path $FLAG)) {
        $familyUp = Test-Resolver $FAMILY
        if ($familyUp) {
            # PALIER 1 : AdGuard FAMILY (le contenu adulte reste bloque)
            Set-ItemProperty $REG -Name "EnableAutoDoh" -Value 1 -Type DWord -Force -ErrorAction SilentlyContinue
            Set-AllAdaptersDns $FAMILY
            Add-Doh $FAMILY $FAMILY_DOH $true
            Clear-DnsClientCache -ErrorAction SilentlyContinue
            Set-Content $FLAG -Value "FAMILY" -Force -ErrorAction SilentlyContinue
            Log "FAILOVER PALIER 1 -> AdGuard FAMILY 94.140.14.15 / 94.140.15.16 (adulte TOUJOURS bloque)"
        } else {
            # PALIER 2 : dernier recours, DNS public non filtre (Family aussi injoignable)
            Set-ItemProperty $REG -Name "EnableAutoDoh" -Value 1 -Type DWord -Force -ErrorAction SilentlyContinue
            Set-AllAdaptersDns $PUBLIC
            Clear-DnsClientCache -ErrorAction SilentlyContinue
            Set-Content $FLAG -Value "PUBLIC" -Force -ErrorAction SilentlyContinue
            Log "FAILOVER PALIER 2 -> DNS public non filtre (Family injoignable aussi ; internet preserve)"
        }
    }
}
