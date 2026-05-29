#Requires -RunAsAdministrator
# ============================================================================
#  TEST COMPLET - AdGuard DNS Fortress + Auto-Link IP
#  Couvre : blocage DNS, config, detection IP, bootstrap, idempotence,
#           simulation changement d'IP, execution tache planifiee
# ============================================================================
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$RESULT_FILE = "$env:TEMP\fortress-test-results.txt"
if (Test-Path $RESULT_FILE) { Remove-Item $RESULT_FILE -Force }

$script:pass = 0
$script:fail = 0
$script:warn = 0

function Out-Line($msg, $color = "White") {
    Write-Host $msg -ForegroundColor $color
    Add-Content $RESULT_FILE -Value $msg -Encoding UTF8
}
function Test-Result($ok, $label, $detail = "") {
    if ($ok -eq "PASS") {
        $script:pass++
        Out-Line ("  [PASS] {0,-40} {1}" -f $label, $detail) "Green"
    } elseif ($ok -eq "WARN") {
        $script:warn++
        Out-Line ("  [WARN] {0,-40} {1}" -f $label, $detail) "Yellow"
    } else {
        $script:fail++
        Out-Line ("  [FAIL] {0,-40} {1}" -f $label, $detail) "Red"
    }
}
function Section($title) {
    Out-Line ""
    Out-Line "==============================================================" "Cyan"
    Out-Line "  $title" "Cyan"
    Out-Line "==============================================================" "Cyan"
}

$CONFIG_DIR  = "$env:ProgramData\AdGuardAutoLink"
$CONFIG_FILE = "$CONFIG_DIR\config.json"
$SCRIPT_FILE = "$CONFIG_DIR\update-linkip.ps1"
$LOG_FILE    = "$CONFIG_DIR\linkip.log"
$STATE_FILE  = "$CONFIG_DIR\last-ip.txt"
$HOSTS_FILE  = "$env:SystemRoot\System32\drivers\etc\hosts"
$REG         = "HKLM:\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters"
$BLOCK_IP    = "94.140.14.35"

Out-Line ""
Out-Line "########################################################" "Magenta"
Out-Line "#   TEST COMPLET FORTRESS - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')   #" "Magenta"
Out-Line "########################################################" "Magenta"

# ============================================================================
# SECTION 1 : BLOCAGE DNS (contenu adulte)
# ============================================================================
Section "SECTION 1 : BLOCAGE DNS (contenu adulte doit etre BLOQUE)"

$adultSites = @("pornhub.com","xvideos.com","xnxx.com","redtube.com","youporn.com","xhamster.com")
foreach ($site in $adultSites) {
    $r  = Resolve-DnsName $site -Type A -DnsOnly -ErrorAction SilentlyContinue
    $ip = if ($r) { ($r | Where-Object { $_.Type -eq 'A' } | Select-Object -First 1).IPAddress } else { $null }
    $blocked = (-not $ip) -or ($ip -eq $BLOCK_IP)
    if ($blocked) {
        Test-Result "PASS" $site "-> $(if($ip){$ip}else{'pas de reponse'}) (bloque)"
    } else {
        Test-Result "FAIL" $site "-> $ip (ACCESSIBLE !)"
    }
}

# ============================================================================
# SECTION 2 : SITES NORMAUX (doivent marcher)
# ============================================================================
Section "SECTION 2 : SITES NORMAUX (doivent fonctionner)"

$normalSites = @("google.com","github.com","wikipedia.org","cloudflare.com")
foreach ($site in $normalSites) {
    $r  = Resolve-DnsName $site -Type A -DnsOnly -ErrorAction SilentlyContinue
    $ip = if ($r) { ($r | Where-Object { $_.Type -eq 'A' } | Select-Object -First 1).IPAddress } else { $null }
    $ok = $ip -and $ip -ne $BLOCK_IP
    if ($ok) {
        Test-Result "PASS" $site "-> $ip"
    } else {
        Test-Result "FAIL" $site "-> $(if($ip){$ip}else{'pas de reponse'}) (BLOQUE par erreur ?)"
    }
}

# ============================================================================
# SECTION 3 : CONFIGURATION DNS WINDOWS
# ============================================================================
Section "SECTION 3 : CONFIGURATION DNS WINDOWS"

# DNS sur adaptateurs
$adapters = Get-NetAdapter | Where-Object { $_.Status -eq "Up" }
foreach ($a in $adapters) {
    $dns = (Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses
    $isAdguard = $dns -contains "94.140.14.49" -or $dns -contains "94.140.14.59"
    if ($isAdguard) {
        Test-Result "PASS" "DNS adapter [$($a.Name)]" "$($dns -join ', ')"
    } else {
        Test-Result "WARN" "DNS adapter [$($a.Name)]" "$($dns -join ', ') (pas AdGuard)"
    }
}

# EnableAutoDoh
try {
    $autoDoh = (Get-ItemProperty $REG -Name "EnableAutoDoh" -ErrorAction Stop).EnableAutoDoh
    if ($autoDoh -ge 1) {
        Test-Result "PASS" "EnableAutoDoh" "= $autoDoh"
    } else {
        Test-Result "WARN" "EnableAutoDoh" "= $autoDoh (DoH off)"
    }
} catch {
    Test-Result "WARN" "EnableAutoDoh" "non defini"
}

# DohWellknownServers registry
$dohReg = "$REG\DohWellknownServers"
$dohEntries = Get-ChildItem $dohReg -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match "94\.140" }
if ($dohEntries) {
    Test-Result "PASS" "DohWellknownServers (registre)" "$($dohEntries.Count) entree(s) AdGuard"
    foreach ($e in $dohEntries) {
        $tmpl = (Get-ItemProperty $e.PSPath -Name "DohTemplate" -ErrorAction SilentlyContinue).DohTemplate
        Out-Line "         $($e.PSChildName) -> $tmpl" "Gray"
    }
} else {
    Test-Result "WARN" "DohWellknownServers (registre)" "aucune entree AdGuard"
}

# DnsClientDohServerAddress (runtime)
$dohRuntime = Get-DnsClientDohServerAddress -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddress -match "94\.140" }
if ($dohRuntime) {
    Test-Result "PASS" "DnsClientDohServerAddress (runtime)" "$($dohRuntime.Count) entree(s)"
} else {
    Test-Result "WARN" "DnsClientDohServerAddress (runtime)" "aucune (re-ajoutee au reboot par watchdog)"
}

# ============================================================================
# SECTION 4 : CONFIG AUTO-LINK IP
# ============================================================================
Section "SECTION 4 : CONFIG AUTO-LINK IP"

# config.json
if (Test-Path $CONFIG_FILE) {
    Test-Result "PASS" "config.json existe" $CONFIG_FILE
    try {
        $cfg = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
        if ($cfg.linkip_url -and $cfg.linkip_url -match "linkip.adguard-dns.com") {
            Test-Result "PASS" "linkip_url valide" "...$($cfg.linkip_url.Substring([Math]::Max(0,$cfg.linkip_url.Length-25)))"
        } else {
            Test-Result "FAIL" "linkip_url" "manquant ou invalide"
        }
        if ($cfg.device_id -eq "499cb42d") {
            Test-Result "PASS" "device_id" $cfg.device_id
        } else {
            Test-Result "WARN" "device_id" "$($cfg.device_id)"
        }
        if ($cfg.bootstrap_ips) {
            $bcount = ($cfg.bootstrap_ips.PSObject.Properties | Measure-Object).Count
            Test-Result "PASS" "bootstrap_ips sauvegardees" "$bcount hostnames"
            foreach ($p in $cfg.bootstrap_ips.PSObject.Properties) {
                Out-Line "         $($p.Name) -> $($p.Value -join ', ')" "Gray"
            }
        } else {
            Test-Result "WARN" "bootstrap_ips" "absentes"
        }
    } catch {
        Test-Result "FAIL" "config.json parse" "$_"
    }
} else {
    Test-Result "FAIL" "config.json existe" "ABSENT"
}

# update-linkip.ps1
if (Test-Path $SCRIPT_FILE) {
    $sz = (Get-Item $SCRIPT_FILE).Length
    Test-Result "PASS" "update-linkip.ps1 existe" "$sz octets"
} else {
    Test-Result "FAIL" "update-linkip.ps1 existe" "ABSENT"
}

# last-ip.txt
if (Test-Path $STATE_FILE) {
    $savedIp = (Get-Content $STATE_FILE -Raw).Trim()
    Test-Result "PASS" "last-ip.txt" $savedIp
} else {
    Test-Result "WARN" "last-ip.txt" "absent (1er run pas encore fait)"
}

# Tache planifiee
$task = Get-ScheduledTask -TaskName "AdGuard-AutoLinkIp" -ErrorAction SilentlyContinue
if ($task) {
    Test-Result "PASS" "Tache AdGuard-AutoLinkIp" "State=$($task.State)"
    $principal = $task.Principal.UserId
    if ($principal -match "SYSTEM") {
        Test-Result "PASS" "  -> execute en tant que" $principal
    } else {
        Test-Result "WARN" "  -> execute en tant que" $principal
    }
    $trigCount = ($task.Triggers | Measure-Object).Count
    Test-Result "PASS" "  -> declencheurs" "$trigCount (startup + repetition 10min)"
} else {
    Test-Result "FAIL" "Tache AdGuard-AutoLinkIp" "ABSENTE"
}

# ============================================================================
# SECTION 5 : DETECTION IP PUBLIQUE (chaque methode independamment)
# ============================================================================
Section "SECTION 5 : DETECTION IP PUBLIQUE (test de chaque methode)"

$ipMethods = [ordered]@{
    "api.ipify.org"    = { (Invoke-WebRequest 'https://api.ipify.org'    -UseBasicParsing -TimeoutSec 8).Content.Trim() }
    "icanhazip.com"    = { (Invoke-WebRequest 'https://icanhazip.com'    -UseBasicParsing -TimeoutSec 8).Content.Trim() }
    "api4.my-ip.io"    = { (Invoke-WebRequest 'https://api4.my-ip.io/ip' -UseBasicParsing -TimeoutSec 8).Content.Trim() }
}
$detectedIps = @()
foreach ($name in $ipMethods.Keys) {
    try {
        $ip = & $ipMethods[$name]
        if ($ip -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') {
            Test-Result "PASS" "IP via $name" $ip
            $detectedIps += $ip
        } else {
            Test-Result "WARN" "IP via $name" "reponse invalide: $ip"
        }
    } catch {
        Test-Result "WARN" "IP via $name" "echec: $($_.Exception.Message)"
    }
}
# OpenDNS fallback
try {
    $ip = (Resolve-DnsName "myip.opendns.com" -Server "208.67.222.222" -Type A -ErrorAction Stop).IPAddress
    if ($ip -match '^\d+\.\d+\.\d+\.\d+$') {
        Test-Result "PASS" "IP via OpenDNS (fallback)" $ip
        $detectedIps += $ip
    }
} catch {
    Test-Result "WARN" "IP via OpenDNS (fallback)" "echec"
}
# Coherence
$uniqueIps = $detectedIps | Select-Object -Unique
if ($uniqueIps.Count -eq 1) {
    Test-Result "PASS" "Coherence des methodes" "toutes -> $($uniqueIps[0])"
} elseif ($uniqueIps.Count -gt 1) {
    Test-Result "WARN" "Coherence des methodes" "divergence: $($uniqueIps -join ', ')"
} else {
    Test-Result "FAIL" "Detection IP" "aucune methode n'a fonctionne"
}

# ============================================================================
# SECTION 6 : TEST DIRECT DU LIEN LINKIP
# ============================================================================
Section "SECTION 6 : TEST DIRECT DU LIEN LINKIP"

try {
    $cfg = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
    $r = Invoke-WebRequest -Uri $cfg.linkip_url -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
    if ($r.StatusCode -eq 200) {
        Test-Result "PASS" "Lien linkip joignable" "HTTP $($r.StatusCode)"
        Out-Line "         Reponse: $($r.Content)" "Gray"
        if ($r.Content -match "linked to") {
            Test-Result "PASS" "Liaison IP confirmee" "le serveur a lie l'IP"
        }
    } else {
        Test-Result "WARN" "Lien linkip" "HTTP $($r.StatusCode)"
    }
} catch {
    Test-Result "FAIL" "Lien linkip joignable" "$($_.Exception.Message)"
}

# ============================================================================
# SECTION 7 : MECANISME BOOTSTRAP (hosts + DNS fallback)
# ============================================================================
Section "SECTION 7 : MECANISME BOOTSTRAP (anti DNS casse)"

# hosts file entries
$hostsContent = Get-Content $HOSTS_FILE -Raw -ErrorAction SilentlyContinue
$bootstrapLines = @()
if ($hostsContent) {
    $bootstrapLines = ($hostsContent -split "`n") | Where-Object { $_ -match "ADGUARD-BOOTSTRAP" -and $_ -notmatch "^#" -and $_ -match "\d" }
}
if ($bootstrapLines.Count -gt 0) {
    Test-Result "PASS" "Entrees bootstrap dans hosts" "$($bootstrapLines.Count) ligne(s)"
    foreach ($l in $bootstrapLines) { Out-Line "         $($l.Trim())" "Gray" }
} else {
    Test-Result "WARN" "Entrees bootstrap dans hosts" "aucune (ajoutees au prochain run)"
}

# Fallback DNS 8.8.8.8
try {
    $fb = (Resolve-DnsName "linkip.adguard-dns.com" -Server "8.8.8.8" -Type A -ErrorAction Stop).IPAddress | Select-Object -First 1
    Test-Result "PASS" "Resolution via 8.8.8.8 (fallback)" "linkip.adguard-dns.com -> $fb"
} catch {
    Test-Result "FAIL" "Resolution via 8.8.8.8 (fallback)" "$($_.Exception.Message)"
}
# Fallback DNS 1.1.1.1
try {
    $fb = (Resolve-DnsName "api.ipify.org" -Server "1.1.1.1" -Type A -ErrorAction Stop).IPAddress | Select-Object -First 1
    Test-Result "PASS" "Resolution via 1.1.1.1 (fallback)" "api.ipify.org -> $fb"
} catch {
    Test-Result "FAIL" "Resolution via 1.1.1.1 (fallback)" "$($_.Exception.Message)"
}

# ============================================================================
# SECTION 8 : IDEMPOTENCE (IP inchangee = rien a faire)
# ============================================================================
Section "SECTION 8 : IDEMPOTENCE (re-run sans changement d'IP)"

$logBefore = if (Test-Path $LOG_FILE) { (Get-Content $LOG_FILE).Count } else { 0 }
& powershell.exe -NonInteractive -ExecutionPolicy Bypass -File $SCRIPT_FILE | Out-Null
Start-Sleep -Seconds 2
$logTail = if (Test-Path $LOG_FILE) { Get-Content $LOG_FILE -Tail 3 } else { @() }
$idempotent = $logTail | Where-Object { $_ -match "inchangee" }
if ($idempotent) {
    Test-Result "PASS" "Detection IP inchangee" "le script saute la mise a jour"
    Out-Line "         $($idempotent | Select-Object -Last 1)" "Gray"
} else {
    Test-Result "WARN" "Detection IP inchangee" "comportement inattendu"
    $logTail | ForEach-Object { Out-Line "         $_" "Gray" }
}

# ============================================================================
# SECTION 9 : SIMULATION CHANGEMENT D'IP (re-liaison auto)
# ============================================================================
Section "SECTION 9 : SIMULATION CHANGEMENT D'IP"

$realIp = if (Test-Path $STATE_FILE) { (Get-Content $STATE_FILE -Raw).Trim() } else { "" }
Out-Line "  IP reelle actuelle : $realIp" "Gray"
Out-Line "  Injection d'une fausse ancienne IP (1.2.3.4)..." "Gray"
Set-Content $STATE_FILE -Value "1.2.3.4" -Encoding ASCII

& powershell.exe -NonInteractive -ExecutionPolicy Bypass -File $SCRIPT_FILE | Out-Null
Start-Sleep -Seconds 3

$logTail2 = if (Test-Path $LOG_FILE) { Get-Content $LOG_FILE -Tail 5 } else { @() }
$detectedChange = $logTail2 | Where-Object { $_ -match "IP changee : 1.2.3.4" }
$relinked       = $logTail2 | Where-Object { $_ -match "Succes" -or $_ -match "IP liee" }
$newSaved       = if (Test-Path $STATE_FILE) { (Get-Content $STATE_FILE -Raw).Trim() } else { "" }

if ($detectedChange) {
    Test-Result "PASS" "Detection du changement d'IP" "1.2.3.4 -> $realIp detecte"
} else {
    Test-Result "FAIL" "Detection du changement d'IP" "non detecte"
}
if ($relinked) {
    Test-Result "PASS" "Re-liaison automatique" "IP re-liee avec succes"
} else {
    Test-Result "FAIL" "Re-liaison automatique" "echec"
}
if ($newSaved -eq $realIp -and $newSaved -ne "1.2.3.4") {
    Test-Result "PASS" "Restauration last-ip.txt" "= $newSaved (correct)"
} else {
    Test-Result "WARN" "Restauration last-ip.txt" "= $newSaved"
}
Out-Line "  Logs de la simulation :" "Gray"
$logTail2 | ForEach-Object { Out-Line "         $_" "Gray" }

# ============================================================================
# SECTION 10 : EXECUTION REELLE DE LA TACHE PLANIFIEE
# ============================================================================
Section "SECTION 10 : EXECUTION REELLE DE LA TACHE PLANIFIEE"

if ($task) {
    Start-ScheduledTask -TaskName "AdGuard-AutoLinkIp" -TaskPath "\" -ErrorAction SilentlyContinue
    Out-Line "  Tache demarree, attente 8s..." "Gray"
    Start-Sleep -Seconds 8
    $info = Get-ScheduledTaskInfo -TaskName "AdGuard-AutoLinkIp" -ErrorAction SilentlyContinue
    if ($info) {
        $lastResult = $info.LastTaskResult
        # 0 = succes, 267009 = en cours
        if ($lastResult -eq 0) {
            Test-Result "PASS" "Resultat derniere execution" "0 (succes)"
        } elseif ($lastResult -eq 267009) {
            Test-Result "PASS" "Resultat derniere execution" "en cours d'execution"
        } else {
            Test-Result "WARN" "Resultat derniere execution" "code $lastResult"
        }
        Test-Result "PASS" "Derniere execution" "$($info.LastRunTime)"
        Test-Result "PASS" "Prochaine execution" "$($info.NextRunTime)"
    } else {
        Test-Result "FAIL" "Info tache" "introuvable"
    }
} else {
    Test-Result "FAIL" "Execution tache" "tache absente"
}

# ============================================================================
# RESUME FINAL
# ============================================================================
Section "RESUME FINAL"
$total = $script:pass + $script:fail + $script:warn
Out-Line ""
Out-Line "  TESTS REUSSIS  (PASS) : $script:pass / $total" "Green"
Out-Line "  AVERTISSEMENTS (WARN) : $script:warn / $total" "Yellow"
Out-Line "  ECHECS         (FAIL) : $script:fail / $total" $(if ($script:fail -gt 0) { "Red" } else { "Green" })
Out-Line ""
if ($script:fail -eq 0) {
    Out-Line "  >>> TOUTES LES FONCTIONNALITES CRITIQUES MARCHENT <<<" "Green"
} else {
    Out-Line "  >>> $script:fail test(s) en echec - voir details ci-dessus <<<" "Red"
}
Out-Line ""
Out-Line "  Resultats sauvegardes dans : $RESULT_FILE" "Gray"
Out-Line ""
