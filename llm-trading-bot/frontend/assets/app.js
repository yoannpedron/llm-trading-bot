/* ─────────────────────────────────────────────────────────────
   Dashboard LLM Trading Bot — vanilla JS, aucune dépendance.
   Lecture seule : l'interface n'envoie jamais d'ordre, elle
   interroge uniquement GET /api/dashboard.
   ───────────────────────────────────────────────────────────── */

const STORAGE_KEY = 'llm-trading-bot:settings';

/** URL du back-end injectable au build (Netlify) ou éditable dans l'UI. */
const DEFAULT_API_URL = window.__API_URL__ || '';

const state = {
  apiUrl: '',
  adminToken: '',
  refreshInterval: 30000,
  journalFilter: 'all',
  data: null,
  timer: null,
  settingsAutoOpened: false,
};

const $ = (id) => document.getElementById(id);

// ── Utilitaires de formatage ─────────────────────────────────

const fmtMoney = (value, currency = 'EUR') => {
  if (value == null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
};

const fmtNum = (value, digits = 2) => {
  if (value == null || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
};

const fmtPct = (value, digits = 2) => (value == null || Number.isNaN(value) ? '—' : `${value >= 0 ? '+' : ''}${fmtNum(value, digits)} %`);

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};

const relativeTime = (iso) => {
  if (!iso) return 'jamais';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '—';
  const min = Math.round(diff / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
};

const signClass = (value) => (value > 0 ? 'up' : value < 0 ? 'down' : 'muted');

/** Échappement systématique : les titres d'actualité viennent de sources tierces. */
const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** N'accepte que des liens http(s) : neutralise les URL `javascript:` d'un flux RSS piégé. */
const safeUrl = (url) => {
  try {
    const parsed = new URL(url, window.location.href);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
};

// ── Réglages ─────────────────────────────────────────────────

function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    stored = {};
  }
  state.apiUrl = (stored.apiUrl || DEFAULT_API_URL || '').replace(/\/+$/, '');
  state.adminToken = stored.adminToken || '';
  state.refreshInterval = Number(stored.refreshInterval ?? 30000);

  $('api-url').value = state.apiUrl;
  $('admin-token').value = state.adminToken;
  $('refresh-interval').value = String(state.refreshInterval);
}

function saveSettings() {
  state.apiUrl = $('api-url').value.trim().replace(/\/+$/, '');
  state.adminToken = $('admin-token').value.trim();
  state.refreshInterval = Number($('refresh-interval').value);
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ apiUrl: state.apiUrl, adminToken: state.adminToken, refreshInterval: state.refreshInterval }),
  );
  if (state.apiUrl) toggleSettings(false);
  applyAdminMode();
  scheduleRefresh();
  refresh();
}

/** Vrai si le jeton admin est renseigné : débloque la gestion des clés. */
const isAdmin = () => Boolean(state.adminToken);

/** Appel authentifié vers une route d'écriture du back-end. */
async function adminFetch(path, options = {}) {
  const res = await fetch(`${state.apiUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': state.adminToken,
      ...(options.headers || {}),
    },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

function toggleSettings(force) {
  const panel = $('settings');
  const open = force ?? panel.hidden;
  panel.hidden = !open;
  $('btn-settings').setAttribute('aria-expanded', String(open));
  return open;
}

function scheduleRefresh() {
  clearInterval(state.timer);
  if (state.refreshInterval > 0) state.timer = setInterval(refresh, state.refreshInterval);
}

// ── Connexion ────────────────────────────────────────────────

function setConnection(status, text) {
  const el = $('conn-status');
  el.className = `conn conn-${status}`;
  $('conn-text').textContent = text;
}

function showAlert(html) {
  const el = $('alert');
  if (!html) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML = html;
}

async function refresh() {
  if (!state.apiUrl) {
    setConnection('err', 'Back-end non configuré');
    showAlert(
      'Aucune URL de back-end enregistrée. Saisis l\'adresse de ton API ci-dessus ' +
        '(ex. <code>http://localhost:8099</code> en local, ou <code>https://mon-bot.onrender.com</code> une fois hébergé), puis clique sur Enregistrer.',
    );
    // Une seule ouverture automatique : si l'utilisateur referme le panneau,
    // le rafraîchissement périodique ne doit pas le lui rouvrir en boucle.
    if (!state.settingsAutoOpened) {
      state.settingsAutoOpened = true;
      toggleSettings(true);
      $('api-url').focus();
    }
    return;
  }

  const btn = $('btn-refresh');
  btn.disabled = true;
  setConnection('idle', 'Chargement…');

  try {
    const res = await fetch(`${state.apiUrl}/api/dashboard`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    state.data = await res.json();
    render(state.data);
    setConnection('ok', `Connecté · ${new Date().toLocaleTimeString('fr-FR')}`);
    showAlert(null);
  } catch (err) {
    setConnection('err', 'Hors ligne');
    const mixed = window.location.protocol === 'https:' && state.apiUrl.startsWith('http://');
    showAlert(
      `Impossible de joindre <code>${esc(state.apiUrl)}</code> — ${esc(err.message)}.` +
        (mixed
          ? ' <strong>Cause probable :</strong> cette page est en HTTPS et ton API en HTTP ; le navigateur bloque la requête. Sers ton back-end en HTTPS.'
          : ' Vérifie que le back-end tourne et que <code>CORS_ORIGINS</code> autorise ce domaine.'),
    );
  } finally {
    btn.disabled = false;
  }
}

// ── Rendu ────────────────────────────────────────────────────

function render(data) {
  renderKpis(data.account);
  renderChart(data.equityCurve, data.account);
  renderPositions(data.positions, data.account.currency);
  renderStatus(data.status, data.account);
  renderJournal(data.journal);
  renderTrades(data.trades, data.account.currency);
  renderCapacityPanel(data.status.capacity);
  $('last-update').textContent = fmtDate(data.serverTime);

  // La liste détaillée des clés n'est accessible qu'avec le jeton admin.
  if (isAdmin()) loadKeys().catch((err) => setKeysFeedback('err', `Clés inaccessibles : ${err.message}`));
}

function renderKpis(account) {
  const cur = account.currency;
  $('kpi-equity').textContent = fmtMoney(account.equity, cur);

  const delta = $('kpi-pnl');
  delta.textContent = `${fmtMoney(account.totalPnl, cur)} (${fmtPct(account.totalPnlPct)}) depuis ${fmtMoney(account.initialCapital, cur)}`;
  delta.className = `kpi-delta ${signClass(account.totalPnl)}`;

  $('kpi-cash').textContent = fmtMoney(account.cash, cur);
  $('kpi-invested').textContent = `${fmtMoney(account.positionsValue, cur)} investis`;

  const realized = $('kpi-realized');
  realized.textContent = fmtMoney(account.realizedPnl, cur);
  realized.className = `kpi-value ${signClass(account.realizedPnl)}`;
  $('kpi-fees').textContent = `${fmtMoney(account.feesPaid, cur)} de frais`;

  $('kpi-positions').textContent = account.positionsCount ?? 0;
  const unrealized = $('kpi-unrealized');
  unrealized.textContent = `${fmtMoney(account.unrealizedPnl, cur)} latents`;
  unrealized.className = `kpi-sub ${signClass(account.unrealizedPnl)}`;

  const badge = $('mode-badge');
  badge.textContent = account.isLive ? 'Trading réel' : 'Paper trading';
  badge.className = `badge ${account.isLive ? 'badge-live' : 'badge-paper'}`;
}

/** Courbe d'équity en SVG pur : pas de librairie, pas de CDN. */
function renderChart(curve, account) {
  const host = $('chart');
  const points = (curve || []).filter((p) => Number.isFinite(p.equity));

  if (points.length < 2) {
    host.innerHTML = '<p class="chart-empty">Pas encore assez d\'historique pour tracer la courbe.</p>';
    $('chart-range').textContent = '—';
    return;
  }

  const W = 1000;
  const H = 260;
  const PAD = { top: 16, right: 56, bottom: 24, left: 12 };

  const values = points.map((p) => p.equity);
  const baseline = account.initialCapital;
  const min = Math.min(...values, baseline);
  const max = Math.max(...values, baseline);
  const span = max - min || Math.max(max * 0.02, 1);
  const lo = min - span * 0.12;
  const hi = max + span * 0.12;

  const x = (i) => PAD.left + (i / (points.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${y(lo).toFixed(1)} L${x(0).toFixed(1)},${y(lo).toFixed(1)} Z`;

  const isUp = values[values.length - 1] >= baseline;
  const stroke = isUp ? 'var(--up)' : 'var(--down)';
  const fill = isUp ? 'var(--up-soft)' : 'var(--down-soft)';

  const ticks = 4;
  const gridLines = Array.from({ length: ticks + 1 }, (_, i) => {
    const value = lo + ((hi - lo) * i) / ticks;
    const yy = y(value).toFixed(1);
    return `<line class="grid-line" x1="${PAD.left}" y1="${yy}" x2="${W - PAD.right}" y2="${yy}" />
            <text class="axis-label" x="${W - PAD.right + 8}" y="${Number(yy) + 3}">${fmtNum(value, 0)}</text>`;
  }).join('');

  const baselineY = y(baseline).toFixed(1);

  host.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      ${gridLines}
      <line class="grid-line" x1="${PAD.left}" y1="${baselineY}" x2="${W - PAD.right}" y2="${baselineY}"
            stroke="var(--text-faint)" stroke-dasharray="4 4" />
      <path d="${area}" fill="${fill}" />
      <path d="${line}" fill="none" stroke="${stroke}" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      <circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(values[values.length - 1]).toFixed(1)}"
              r="3.5" fill="${stroke}" />
    </svg>`;

  $('chart-range').textContent = `${points.length} points · du ${fmtDate(points[0].t)} au ${fmtDate(points[points.length - 1].t)}`;
}

function renderPositions(positions, currency) {
  const tbody = $('positions-table').querySelector('tbody');
  $('positions-count').textContent = `${positions.length} ligne${positions.length > 1 ? 's' : ''}`;

  if (!positions.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="7">Aucune position ouverte.</td></tr>';
    return;
  }

  tbody.innerHTML = positions
    .map(
      (p) => `<tr>
        <td class="sym">${esc(p.symbol)}</td>
        <td class="num">${fmtNum(p.quantity, 4)}</td>
        <td class="num">${fmtNum(p.avgPrice, 2)} ${esc(p.currency || '')}</td>
        <td class="num">${fmtNum(p.lastPrice, 2)}</td>
        <td class="num">${fmtMoney(p.marketValue, currency)}</td>
        <td class="num ${signClass(p.unrealizedPnl)}">${fmtMoney(p.unrealizedPnl, currency)} <span class="muted">(${fmtPct(p.unrealizedPnlPct)})</span></td>
        <td class="num mono muted">${p.stopPrice ? fmtNum(p.stopPrice, 2) : '—'} / ${p.takeProfitPrice ? fmtNum(p.takeProfitPrice, 2) : '—'}</td>
      </tr>`,
    )
    .join('');
}

function renderStatus(status, account) {
  const running = status.isRunning ? 'Cycle en cours' : status.paused ? 'En pause' : 'En veille';
  $('st-state').innerHTML = `<span class="pill ${status.paused ? 'pill-skip' : 'pill-exec'}">${esc(running)}</span>`;

  $('engine-actions').hidden = !isAdmin();
  $('btn-run-cycle').disabled = Boolean(status.isRunning);
  $('btn-run-cycle').textContent = status.isRunning ? 'Cycle en cours…' : 'Lancer un cycle maintenant';
  $('btn-toggle-pause').textContent = status.paused ? 'Reprendre' : 'Mettre en pause';
  $('st-last').textContent = `${fmtDate(status.lastCycleAt)} (${relativeTime(status.lastCycleAt)})`;
  $('st-count').textContent = status.cycleCount ?? 0;
  $('st-model').textContent = `${status.llmProvider} · ${status.model}`;

  renderCapacity(status.capacity);
  $('st-symbols').textContent = (status.symbols || []).join(', ') || '—';
  $('st-cron').textContent = `${status.cron} · ${status.interval}`;
  $('st-broker').textContent = `${status.broker}${status.isLive ? ' (réel)' : ' (simulé)'}`;

  const breaker = status.risk?.circuitBreakerTrippedAt;
  $('st-breaker').innerHTML = breaker
    ? `<span class="pill pill-risk">Déclenché ${esc(fmtDate(breaker))}</span>`
    : `<span class="pill pill-exec">Inactif</span>`;

  // `account` sert de garde-fou visuel si le broker réel est activé.
  if (account.isLive) document.body.dataset.live = 'true';
}

/**
 * Capacité du pool de clés Gemini.
 * Chaque compte Google gratuit apporte son propre quota journalier : ce bloc
 * traduit « j'ai N clés » en « je peux faire X cycles par jour ».
 */
function renderCapacity(capacity) {
  if (!capacity) {
    $('st-keys').textContent = '—';
    $('st-quota').textContent = '—';
    $('st-cycles').textContent = '—';
    return;
  }

  const unlimited = !Number.isFinite(capacity.totalPerDay);
  const noKeys = capacity.keys === 0;

  $('st-keys').innerHTML = noKeys
    ? '<span class="pill pill-risk">aucune clé</span>'
    : `<span class="pill ${capacity.keysExhausted >= capacity.keys ? 'pill-risk' : 'pill-exec'}">${capacity.keys} clé${capacity.keys > 1 ? 's' : ''}</span>` +
      (capacity.keysExhausted ? ` <span class="muted">${capacity.keysExhausted} épuisée(s)</span>` : '');

  if (unlimited) {
    $('st-quota').textContent = 'illimité';
  } else {
    const exhausted = capacity.remaining <= 0;
    $('st-quota').innerHTML =
      `<span class="pill ${exhausted ? 'pill-risk' : 'pill-exec'}">${capacity.used} / ${capacity.totalPerDay} appels</span>`;
  }

  $('st-cycles').innerHTML = unlimited
    ? 'illimité'
    : `${capacity.cyclesPerDay} <span class="muted">(${capacity.callsPerCycle} appel${capacity.callsPerCycle > 1 ? 's' : ''}/cycle · cron conseillé <code>${esc(capacity.recommendedCron)}</code>)</span>`;
}

// ── Contrôles du moteur ──────────────────────────────────────

async function runCycleNow() {
  const button = $('btn-run-cycle');
  button.disabled = true;
  button.textContent = 'Cycle en cours…';
  setKeysFeedback(null);

  try {
    // Un cycle interroge le LLM sur chaque actif : ça peut prendre 30-60 s
    // (news + Gemini + cooldown entre actifs). Le bouton reste désactivé
    // jusqu'à la fin plutôt que de faire croire à une réponse immédiate.
    const summary = await adminFetch('/api/cycle', { method: 'POST' });
    await refresh();
    if (summary.skipped) {
      showAlert(`Cycle non lancé : ${esc(summary.reason)}.`);
    } else if (summary.error) {
      showAlert(`Le cycle a échoué : ${esc(summary.error)}.`);
    } else {
      showAlert(null);
    }
  } catch (err) {
    showAlert(`Impossible de lancer le cycle : ${esc(err.message)}.`);
  } finally {
    button.disabled = false;
    button.textContent = 'Lancer un cycle maintenant';
  }
}

async function togglePause() {
  const button = $('btn-toggle-pause');
  const wasPaused = button.textContent.trim() === 'Reprendre';
  button.disabled = true;
  try {
    await adminFetch(wasPaused ? '/api/resume' : '/api/pause', { method: 'POST' });
    await refresh();
  } catch (err) {
    showAlert(`Action impossible : ${esc(err.message)}.`);
  } finally {
    button.disabled = false;
  }
}

// ── Panneau des clés API ─────────────────────────────────────

function setKeysFeedback(kind, html) {
  const el = $('keys-feedback');
  if (!html) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.className = `keys-feedback ${kind}`;
  el.innerHTML = html;
}

/**
 * Jauge globale : combien d'appels LLM ont été consommés sur la capacité totale,
 * et ce que cette capacité permet concrètement en nombre de cycles.
 */
function renderCapacityPanel(capacity) {
  const fill = $('capacity-fill');
  const bar = fill.parentElement;

  if (!capacity) {
    $('keys-summary').textContent = '—';
    $('capacity-detail').textContent = '—';
    fill.style.width = '0%';
    return;
  }

  const unlimited = !Number.isFinite(capacity.totalPerDay);
  const pct = unlimited ? 0 : Math.min(100, Math.round((capacity.used / Math.max(capacity.totalPerDay, 1)) * 100));

  fill.style.width = `${unlimited ? 100 : pct}%`;
  bar.classList.toggle('is-full', !unlimited && capacity.remaining <= 0);
  bar.classList.toggle('is-warn', !unlimited && capacity.remaining > 0 && pct >= 75);

  $('keys-summary').textContent = capacity.keys === 0
    ? 'aucune clé'
    : `${capacity.keys} clé${capacity.keys > 1 ? 's' : ''}${capacity.keysExhausted ? ` · ${capacity.keysExhausted} épuisée(s)` : ''}`;

  if (capacity.keys === 0) {
    $('capacity-detail').innerHTML =
      '<strong>Aucune clé configurée.</strong> Le bot tourne sur son moteur heuristique de secours. ' +
      'Ajoute une clé Gemini ci-dessous pour activer les décisions par IA.';
    return;
  }

  if (unlimited) {
    $('capacity-detail').innerHTML = '<strong>Quota illimité</strong> (clé payante) — aucune contrainte de fréquence.';
    return;
  }

  const exhausted = capacity.remaining <= 0;
  const head = exhausted
    ? '<strong>Quota dépassé pour aujourd\'hui.</strong> Le bot bascule sur son moteur heuristique jusqu\'au reset. '
    : `<strong>${capacity.used}</strong> / ${capacity.totalPerDay} appels utilisés — <strong>${capacity.remaining}</strong> restants. `;

  $('capacity-detail').innerHTML =
    `${head}Avec ${capacity.callsPerCycle} appel${capacity.callsPerCycle > 1 ? 's' : ''} par cycle, ` +
    `cela permet <strong>${capacity.cyclesPerDay} cycles/jour</strong> → cron conseillé <code>${esc(capacity.recommendedCron)}</code>. ` +
    `<span class="muted">Reset à ${esc(capacity.resetsAt)}.</span>`;
}

function renderKeysTable(keys, perKeyLimit) {
  const tbody = $('keys-table').querySelector('tbody');

  if (!keys.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="7">Aucune clé dans le pool. Ajoute-en une ci-dessous.</td></tr>';
    return;
  }

  tbody.innerHTML = keys
    .map((k) => {
      const limit = perKeyLimit > 0 ? perKeyLimit : null;
      const pct = limit ? Math.min(100, Math.round((k.calls / limit) * 100)) : 0;
      const gaugeClass = k.exhausted || pct >= 100 ? 'full' : pct >= 75 ? 'warn' : '';

      const gauge = limit
        ? `<div class="key-gauge">
             <div class="key-gauge-bar ${gaugeClass}"><span style="width:${pct}%"></span></div>
             <span class="key-gauge-text">${k.calls}/${limit}</span>
           </div>`
        : '<span class="muted">illimité</span>';

      const status = k.exhausted
        ? `<span class="pill pill-risk">épuisée</span>`
        : `<span class="pill pill-exec">${k.remaining ?? '∞'} restants</span>`;

      // Une clé venant du .env ne peut être retirée que du .env.
      const action = k.source === 'store'
        ? `<button class="btn-icon" data-remove-key="${esc(k.id)}" type="button" title="Retirer cette clé">Retirer</button>`
        : '<span class="muted" title="Définie dans le fichier .env du back-end">—</span>';

      return `<tr>
        <td class="sym">${esc(k.label)}</td>
        <td class="mono muted">${esc(k.masked)}</td>
        <td class="muted">${k.source === 'env' ? '.env' : 'ajoutée'}</td>
        <td class="num">${k.calls}</td>
        <td>${gauge}</td>
        <td>${status}</td>
        <td>${action}</td>
      </tr>`;
    })
    .join('');
}

async function loadKeys() {
  const payload = await adminFetch('/api/llm/keys');
  renderKeysTable(payload.keys, payload.capacity.perKeyLimit);
  renderCapacityPanel(payload.capacity);
  return payload;
}

/** Affiche/masque les contrôles d'administration selon la présence du jeton. */
function applyAdminMode() {
  const admin = isAdmin();
  $('add-key-form').hidden = !admin;
  $('btn-check-keys').hidden = !admin;

  if (!admin) {
    $('keys-table').querySelector('tbody').innerHTML =
      '<tr class="empty"><td colspan="7">Renseigne ton jeton administrateur dans Réglages pour gérer tes clés.</td></tr>';
    setKeysFeedback(null);
  }
}

async function addKey(event) {
  event.preventDefault();
  const input = $('new-key');
  const key = input.value.trim();
  if (!key) return;

  const button = $('btn-add-key');
  button.disabled = true;
  setKeysFeedback('warn', 'Vérification de la clé auprès de Google…');

  try {
    const payload = await adminFetch('/api/llm/keys', {
      method: 'POST',
      body: JSON.stringify({ key, label: $('new-key-label').value.trim() || null }),
    });

    input.value = '';
    $('new-key-label').value = '';
    renderKeysTable(payload.keys, payload.capacity.perKeyLimit);
    renderCapacityPanel(payload.capacity);

    const c = payload.capacity;
    const gain = Number.isFinite(c.totalPerDay)
      ? ` Capacité totale : <strong>${c.totalPerDay} appels/jour</strong> → ${c.cyclesPerDay} cycles/jour (cron conseillé <code>${esc(c.recommendedCron)}</code>).`
      : '';

    if (payload.probe?.state === 'quota_atteint') {
      setKeysFeedback('warn', `Clé ${esc(payload.added.masked)} ajoutée, mais son <strong>quota est déjà dépassé aujourd'hui</strong> — elle sera utilisable au prochain reset.${gain}`);
    } else if (payload.probe?.state === 'injoignable') {
      setKeysFeedback('warn', `Clé ${esc(payload.added.masked)} ajoutée sans avoir pu être testée : ${esc(payload.probe.message)}${gain}`);
    } else {
      setKeysFeedback('ok', `✓ Clé ${esc(payload.added.masked)} validée et ajoutée.${gain}`);
    }
  } catch (err) {
    setKeysFeedback('err', `Ajout refusé : ${esc(err.message)}`);
  } finally {
    button.disabled = false;
  }
}

async function removeKey(id) {
  setKeysFeedback('warn', 'Suppression…');
  try {
    const payload = await adminFetch(`/api/llm/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    renderKeysTable(payload.keys, payload.capacity.perKeyLimit);
    renderCapacityPanel(payload.capacity);
    setKeysFeedback('ok', `Clé retirée. Capacité restante : ${payload.capacity.cyclesPerDay} cycles/jour.`);
  } catch (err) {
    setKeysFeedback('err', `Suppression impossible : ${esc(err.message)}`);
  }
}

async function checkKeys() {
  const button = $('btn-check-keys');
  button.disabled = true;
  setKeysFeedback('warn', 'Test de toutes les clés auprès de Google…');

  try {
    const payload = await adminFetch('/api/llm/keys/check', { method: 'POST' });
    renderKeysTable(payload.keys, payload.capacity.perKeyLimit);
    renderCapacityPanel(payload.capacity);

    const lines = payload.results
      .map((r) => `<li><span class="mono">${esc(r.masked)}</span> — ${esc(r.message)}</li>`)
      .join('');
    const anyBad = payload.results.some((r) => r.ok !== true);
    setKeysFeedback(anyBad ? 'warn' : 'ok', `Résultat du test :<ul class="headlines">${lines}</ul>`);
  } catch (err) {
    setKeysFeedback('err', `Test impossible : ${esc(err.message)}`);
  } finally {
    button.disabled = false;
  }
}

const SENTIMENT_CLASS = { POSITIF: 'pill-pos', NEGATIF: 'pill-neg', NEUTRE: 'pill-neu', INDISPONIBLE: 'pill-skip' };

function renderJournal(entries) {
  const host = $('journal');
  const filtered = (entries || []).filter((e) => {
    if (state.journalFilter === 'all') return true;
    if (state.journalFilter === 'executed') return e.executed;
    return e.action === state.journalFilter;
  });

  if (!filtered.length) {
    host.innerHTML = '<p class="empty-block">Aucune décision ne correspond à ce filtre.</p>';
    return;
  }

  host.innerHTML = filtered
    .map((e) => {
      const tag = e.action === 'BUY' ? 'tag-buy' : e.action === 'SELL' ? 'tag-sell' : 'tag-hold';
      const confidence = Math.round((e.confidence ?? 0) * 100);
      const sentimentClass = SENTIMENT_CLASS[e.newsSentiment] || 'pill-skip';

      const headlines = (e.headlines || [])
        .map((h) => {
          const url = safeUrl(h.url);
          const title = esc(h.title);
          const label = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title;
          return `<li>${label} <span class="src">— ${esc(h.source || '')}</span></li>`;
        })
        .join('');

      const flags = (e.riskFlags || []).length
        ? `<div class="entry-block"><h4>Risques identifiés</h4><p>${esc(e.riskFlags.join(' · '))}</p></div>`
        : '';

      return `<article class="entry">
        <div class="entry-head">
          <span class="entry-sym">${esc(e.symbol)}</span>
          <span class="tag ${tag}">${esc(e.action)}</span>
          <span class="pill ${e.executed ? 'pill-exec' : 'pill-skip'}">${e.executed ? 'Exécuté' : 'Non exécuté'}</span>
          <span class="pill ${sentimentClass}">Presse : ${esc(e.newsSentiment || 'n/d')}</span>
          ${e.source === 'risk-manager' ? '<span class="pill pill-risk">Gestion du risque</span>' : ''}
          <span class="confidence">Confiance
            <span class="confidence-bar"><span style="width:${confidence}%"></span></span>${confidence} %
          </span>
          <span class="entry-time">${esc(fmtDate(e.timestamp))}</span>
        </div>

        <p class="entry-quote">${esc(e.justification)}</p>

        <div class="entry-grid">
          <div class="entry-block"><h4>Lecture technique</h4><p>${esc(e.technicalRationale)}</p></div>
          <div class="entry-block"><h4>Lecture des actualités</h4><p>${esc(e.newsRationale)}</p></div>
          ${flags}
        </div>

        ${headlines ? `<ul class="headlines">${headlines}</ul>` : ''}

        <div class="entry-meta">
          ${e.price != null ? `<span><b>Cours</b> ${fmtNum(e.price, 2)} ${esc(e.currency || '')}</span>` : ''}
          ${e.riskDecision ? `<span><b>Risque</b> ${esc(e.riskDecision)}</span>` : ''}
          ${e.newsCount != null ? `<span><b>Articles</b> ${e.newsCount}${e.newsProvider ? ` (${esc(e.newsProvider)})` : ''}</span>` : ''}
          ${e.model ? `<span><b>Modèle</b> ${esc(e.model)}</span>` : ''}
        </div>

        ${
          e.indicators
            ? `<details class="raw"><summary>Données techniques du moment</summary><pre>${esc(JSON.stringify(e.indicators, null, 2))}</pre></details>`
            : ''
        }
      </article>`;
    })
    .join('');
}

function renderTrades(trades, currency) {
  const tbody = $('trades-table').querySelector('tbody');
  $('trades-count').textContent = `${trades.length} ordre${trades.length > 1 ? 's' : ''}`;

  if (!trades.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="9">Aucun ordre passé.</td></tr>';
    return;
  }

  tbody.innerHTML = trades
    .map(
      (t) => `<tr>
        <td class="muted">${esc(fmtDate(t.timestamp))}</td>
        <td><span class="tag ${t.side === 'BUY' ? 'tag-buy' : 'tag-sell'}">${esc(t.side)}</span></td>
        <td class="sym">${esc(t.symbol)}</td>
        <td class="num">${fmtNum(t.quantity, 4)}</td>
        <td class="num">${fmtNum(t.price, 2)} ${esc(t.currency || '')}</td>
        <td class="num">${fmtMoney(t.notional, currency)}</td>
        <td class="num muted">${fmtMoney(t.fee, currency)}</td>
        <td class="num ${signClass(t.realizedPnl)}">${t.side === 'SELL' ? fmtMoney(t.realizedPnl, currency) : '—'}</td>
        <td class="muted">${esc(t.source || 'llm')}</td>
      </tr>`,
    )
    .join('');
}

// ── Événements ───────────────────────────────────────────────

$('btn-refresh').addEventListener('click', refresh);
$('btn-save').addEventListener('click', saveSettings);
$('add-key-form').addEventListener('submit', addKey);
$('btn-run-cycle').addEventListener('click', runCycleNow);
$('btn-toggle-pause').addEventListener('click', togglePause);
$('btn-check-keys').addEventListener('click', checkKeys);

$('keys-table').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-key]');
  if (button) removeKey(button.dataset.removeKey);
});

$('btn-settings').addEventListener('click', () => toggleSettings());

$('journal-filters').addEventListener('click', (event) => {
  const button = event.target.closest('.chip');
  if (!button) return;
  state.journalFilter = button.dataset.filter;
  document.querySelectorAll('#journal-filters .chip').forEach((c) => c.classList.toggle('chip-active', c === button));
  if (state.data) renderJournal(state.data.journal);
});

for (const id of ['api-url', 'admin-token']) {
  $(id).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveSettings();
  });
}

// Économise les requêtes quand l'onglet est en arrière-plan.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearInterval(state.timer);
  else {
    scheduleRefresh();
    refresh();
  }
});

loadSettings();
applyAdminMode();
scheduleRefresh();
refresh();
