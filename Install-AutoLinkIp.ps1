#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Installe un service de mise a jour automatique de l'IP liee AdGuard DNS.
    Gere le probleme de bootstrap : si le DNS est casse (IP non liee + DoH strict),
    utilise des mecanismes alternatifs pour atteindre le serveur AdGuard.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$DEVICE_ID   = "499cb42d"
$TASK_NAME   = "AdGuard-AutoLinkIp"
$CONFIG_DIR  = "$env:ProgramData\AdGuardAutoLink"
$CONFIG_FILE = "$CONFIG_DIR\config.json"
$SCRIPT_FILE = "$CONFIG_DIR\update-linkip.ps1"
$LOG_FILE    = "$CONFIG_DIR\linkip.log"
$STATE_FILE  = "$CONFIG_DIR\last-ip.txt"
$HOSTS_FILE  = "$env:SystemRoot\System32\drivers\etc\hosts"

# IPs de bootstrap codees en dur (resolues a l'avance, a rafraichir si besoin)
# Ces IPs permettent d'atteindre les services meme si le DNS est casse
$BOOTSTRAP_IPS = @{
    "linkip.adguard-dns.com" = @("94.140.14.49")
    "api.ipify.org"          = @("104.18.114.97", "104.18.115.97")
    "icanhazip.com"          = @("104.18.46.123", "104.18.47.123")
    "api4.my-ip.io"          = @("147.75.109.82")
}

$DNS_FALLBACKS = @("8.8.8.8", "1.1.1.1", "94.140.14.14")  # DNS publics en fallback

# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "   AdGuard DNS - Auto Link IP Installer      " -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# ── Creer le dossier de config ────────────────────────────────────────────────
if (-not (Test-Path $CONFIG_DIR)) { New-Item -Path $CONFIG_DIR -ItemType Directory -Force | Out-Null }

# ── Demander le LinkIp URL (token du device) ──────────────────────────────────
Write-Host "  Le lien de liaison IP se trouve sur :" -ForegroundColor White
Write-Host "  adguard-dns.com -> votre device -> 'Lier votre IP' -> copier le lien" -ForegroundColor Gray
Write-Host ""

$existingConfig = $null
if (Test-Path $CONFIG_FILE) {
    $existingConfig = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
    Write-Host "  Config existante trouvee : $($existingConfig.linkip_url.Substring(0,60))..." -ForegroundColor Green
    $keep = Read-Host "  Garder ce lien ? [O/n]"
    if ($keep -ne 'n' -and $keep -ne 'N') {
        $LINKIP_URL = $existingConfig.linkip_url
    }
}

if (-not $LINKIP_URL) {
    $LINKIP_URL = Read-Host "  Collez votre lien de liaison IP (https://linkip.adguard-dns.com/...)"
    if ([string]::IsNullOrWhiteSpace($LINKIP_URL)) {
        Write-Host "  Lien vide. Abandon." -ForegroundColor Red
        Read-Host "Press Enter"; exit 1
    }
}

# Sauvegarder la config
@{ linkip_url = $LINKIP_URL; device_id = $DEVICE_ID } | ConvertTo-Json | Set-Content $CONFIG_FILE -Encoding UTF8
Write-Host "  Config sauvegardee." -ForegroundColor Green

# ── Resoudre les IPs de bootstrap maintenant (pendant que le DNS fonctionne) ──
Write-Host ""
Write-Host "[*] Resolution des IPs de bootstrap..." -ForegroundColor Cyan

foreach ($host in $BOOTSTRAP_IPS.Keys.Clone()) {
    $resolved = (Resolve-DnsName $host -Type A -ErrorAction SilentlyContinue).IPAddress
    if ($resolved) {
        $BOOTSTRAP_IPS[$host] = @($resolved | Select-Object -First 3)
        Write-Host "    $host -> $($resolved -join ', ')" -ForegroundColor Green
    } else {
        Write-Host "    $host -> (utilise IPs codees en dur)" -ForegroundColor Yellow
    }
}

# Mettre a jour les IPs de bootstrap dans le config
$config = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
$bootstrapObj = @{}
foreach ($k in $BOOTSTRAP_IPS.Keys) { $bootstrapObj[$k] = $BOOTSTRAP_IPS[$k] }
$config | Add-Member -NotePropertyName "bootstrap_ips" -NotePropertyValue $bootstrapObj -Force
$config | ConvertTo-Json -Depth 5 | Set-Content $CONFIG_FILE -Encoding UTF8

# ── Ecrire le script de mise a jour d'IP ──────────────────────────────────────
Write-Host ""
Write-Host "[*] Creation du script de mise a jour..." -ForegroundColor Cyan

$updateScript = @'
# AdGuard DNS - Auto Link IP - Script de mise a jour
# Tourne en SYSTEM toutes les 10 minutes
# Gere le bootstrap DNS : fonctionne meme si le DNS est casse

$CONFIG_DIR  = "$env:ProgramData\AdGuardAutoLink"
$CONFIG_FILE = "$CONFIG_DIR\config.json"
$LOG_FILE    = "$CONFIG_DIR\linkip.log"
$STATE_FILE  = "$CONFIG_DIR\last-ip.txt"
$HOSTS_FILE  = "$env:SystemRoot\System32\drivers\etc\hosts"

function Write-Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content $LOG_FILE -Value $line -ErrorAction SilentlyContinue
}

# Charger la config
if (-not (Test-Path $CONFIG_FILE)) { Write-Log "CONFIG MANQUANTE - abandon"; exit 1 }
$config = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
$LINKIP_URL = $config.linkip_url

# ── ETAPE 1 : Injecter les IPs de bootstrap dans hosts ───────────────────────
# Garantit que les hostnames critiques sont resolvables meme sans DNS
function Update-BootstrapHosts {
    $hosts = Get-Content $HOSTS_FILE -Raw -ErrorAction SilentlyContinue
    $hosts = $hosts -replace "(?m)^[^\r\n]*# ADGUARD-BOOTSTRAP[^\r\n]*(\r?\n)?", ""
    $add = "`r`n# ADGUARD-BOOTSTRAP - ne pas supprimer`r`n"

    # Rafraichir les IPs en utilisant des DNS de secours si le DNS principal est casse
    $fallbackDns = @("8.8.8.8", "1.1.1.1")
    $bootstrapHosts = @("linkip.adguard-dns.com", "api.ipify.org", "icanhazip.com")

    foreach ($h in $bootstrapHosts) {
        $ips = $null
        # Essayer DNS principal (forcer tableau + filtrer A pour eviter le bug scalaire)
        $ips = @((Resolve-DnsName $h -Type A -ErrorAction SilentlyContinue | Where-Object { $_.Type -eq 'A' }).IPAddress)
        # Fallback sur DNS publics
        if (-not $ips) {
            foreach ($dns in $fallbackDns) {
                $ips = @((Resolve-DnsName $h -Server $dns -Type A -ErrorAction SilentlyContinue | Where-Object { $_.Type -eq 'A' }).IPAddress)
                if ($ips) { break }
            }
        }
        # Fallback sur IPs sauvegardees dans la config
        if (-not $ips -and $config.bootstrap_ips.$h) {
            $ips = @($config.bootstrap_ips.$h)
        }
        if ($ips) {
            $add += "$($ips[0]) $h # ADGUARD-BOOTSTRAP`r`n"
            Write-Log "BOOTSTRAP: $h -> $($ips[0])"
        }
    }
    Set-Content $HOSTS_FILE -Value ($hosts.TrimEnd() + $add) -Encoding ASCII -ErrorAction SilentlyContinue
}

Update-BootstrapHosts

# ── ETAPE 2 : Obtenir l'IP publique actuelle ──────────────────────────────────
function Get-PublicIP {
    $methods = @(
        { (Invoke-WebRequest 'https://api.ipify.org'    -UseBasicParsing -TimeoutSec 8).Content.Trim() },
        { (Invoke-WebRequest 'https://icanhazip.com'    -UseBasicParsing -TimeoutSec 8).Content.Trim() },
        { (Invoke-WebRequest 'https://api4.my-ip.io/ip' -UseBasicParsing -TimeoutSec 8).Content.Trim() }
    )
    foreach ($m in $methods) {
        try {
            $ip = & $m
            if ($ip -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$') { return $ip }
        } catch {}
    }
    # Dernier recours : nslookup inverse sur myip.opendns.com
    try {
        $ip = @((Resolve-DnsName "myip.opendns.com" -Server "208.67.222.222" -Type A -ErrorAction Stop | Where-Object { $_.Type -eq 'A' }).IPAddress)[0]
        if ($ip -match '^\d+\.\d+\.\d+\.\d+$') { return $ip }
    } catch {}
    return $null
}

$currentIp = Get-PublicIP
if (-not $currentIp) {
    Write-Log "ERREUR: impossible de determiner l'IP publique"
    exit 1
}

# ── ETAPE 3 : Comparer avec la derniere IP connue ─────────────────────────────
$lastIp = if (Test-Path $STATE_FILE) { Get-Content $STATE_FILE -Raw | ForEach-Object { $_.Trim() } } else { "" }

if ($currentIp -eq $lastIp) {
    Write-Log "IP inchangee ($currentIp) - rien a faire"
    exit 0
}

Write-Log "IP changee : $lastIp -> $currentIp - mise a jour en cours..."

# ── ETAPE 4 : Mettre a jour l'IP liee ────────────────────────────────────────
$success = $false

# Methode 1 : URL de liaison directe
try {
    $r = Invoke-WebRequest -Uri $LINKIP_URL -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
    if ($r.StatusCode -eq 200) {
        Write-Log "IP liee via linkip URL : $currentIp - $($r.Content)"
        $success = $true
    }
} catch {
    Write-Log "Methode linkip URL echouee : $_"
}

# Methode 2 : API AdGuard (si cle API dispo)
if (-not $success -and $config.api_key) {
    try {
        $headers = @{ Authorization = "Bearer $($config.api_key)" }
        $body    = @{ ip = $currentIp } | ConvertTo-Json
        $r = Invoke-RestMethod -Uri "https://api.adguard-dns.com/oapi/v1/devices/$($config.device_id)/link_ip" `
            -Method Post -Headers $headers -Body $body -ContentType "application/json" -TimeoutSec 15 -ErrorAction Stop
        Write-Log "IP liee via API AdGuard : $currentIp"
        $success = $true
    } catch {
        Write-Log "Methode API echouee : $_"
    }
}

if ($success) {
    # Sauvegarder la nouvelle IP
    Set-Content $STATE_FILE -Value $currentIp -Encoding ASCII
    Write-Log "Succes - IP $currentIp sauvegardee"

    # Vider le cache DNS pour que les nouveaux filtres s'appliquent immediatement
    Clear-DnsClientCache -ErrorAction SilentlyContinue
    Write-Log "Cache DNS vide"
} else {
    Write-Log "ECHEC total de la mise a jour IP - tous les systemes de secours ont echoue"
}
'@

Set-Content $SCRIPT_FILE -Value $updateScript -Encoding UTF8
Write-Host "    Script cree : $SCRIPT_FILE" -ForegroundColor Green

# ── Installer la tache planifiee ──────────────────────────────────────────────
Write-Host ""
Write-Host "[*] Installation de la tache planifiee ($TASK_NAME)..." -ForegroundColor Cyan

Unregister-ScheduledTask -TaskName $TASK_NAME -TaskPath "\" -Confirm:$false -ErrorAction SilentlyContinue

$action   = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$SCRIPT_FILE`""

$triggers = @(
    $(New-ScheduledTaskTrigger -AtStartup),
    $(New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes 10))
)

$settings  = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 3) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\SYSTEM" `
    -RunLevel Highest -LogonType ServiceAccount

Register-ScheduledTask -TaskName $TASK_NAME -TaskPath "\" `
    -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "    Tache '$TASK_NAME' installee (SYSTEM, toutes les 10 min)" -ForegroundColor Green

# ── Premier run immediat ───────────────────────────────────────────────────────
Write-Host ""
Write-Host "[*] Execution immediate du premier run..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $TASK_NAME -TaskPath "\" -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5

# Verifier le resultat
if (Test-Path $STATE_FILE) {
    $linkedIp = Get-Content $STATE_FILE -Raw
    Write-Host "    IP liee : $linkedIp" -ForegroundColor Green
}
if (Test-Path $LOG_FILE) {
    Write-Host ""
    Write-Host "    Derniers logs :" -ForegroundColor Gray
    Get-Content $LOG_FILE -Tail 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
}

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host "  Installation terminee !                    " -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Tache : $TASK_NAME (toutes les 10 min)" -ForegroundColor White
Write-Host "  Logs  : $LOG_FILE" -ForegroundColor White
Write-Host "  Config: $CONFIG_FILE" -ForegroundColor White
Write-Host ""
Write-Host "  Mecanismes de secours actifs :" -ForegroundColor White
Write-Host "  1. Bootstrap hosts (IPs codees en dur si DNS casse)" -ForegroundColor Gray
Write-Host "  2. DNS fallback sur 8.8.8.8 / 1.1.1.1" -ForegroundColor Gray
Write-Host "  3. Detection IP via 3 services differents + OpenDNS" -ForegroundColor Gray
Write-Host "  4. Liaison via linkip URL ou API AdGuard" -ForegroundColor Gray
Write-Host ""
Write-Host "Press Enter..."
Read-Host
