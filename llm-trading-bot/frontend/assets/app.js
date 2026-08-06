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
  logFilter: 'all',
  data: null,
  timer: null,
  settingsAutoOpened: false,
  logs: [],
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

  // Réseau et rendu sont séparés : confondre les deux produirait un message
  // trompeur (« back-end injoignable ») alors que l'API a parfaitement répondu
  // et que le défaut est dans l'affichage.
  let payload;
  try {
    const res = await fetch(`${state.apiUrl}/api/dashboard`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    payload = await res.json();
  } catch (err) {
    setConnection('err', 'Hors ligne');
    const mixed = window.location.protocol === 'https:' && state.apiUrl.startsWith('http://');
    showAlert(
      `Impossible de joindre <code>${esc(state.apiUrl)}</code> — ${esc(err.message)}.` +
        (mixed
          ? ' <strong>Cause probable :</strong> cette page est en HTTPS et ton API en HTTP ; le navigateur bloque la requête. Sers ton back-end en HTTPS.'
          : ' Vérifie que le back-end tourne et que <code>CORS_ORIGINS</code> autorise ce domaine.'),
    );
    btn.disabled = false;
    return;
  }

  state.data = payload;

  try {
    render(payload);
    setConnection('ok', `Connecté · ${new Date().toLocaleTimeString('fr-FR')}`);
    showAlert(null);
  } catch (err) {
    // Les données sont là, c'est l'affichage qui a échoué. On le dit, et on
    // renvoie vers le diagnostic plutôt que vers la configuration réseau.
    setConnection('err', 'Erreur d\'affichage');
    showAlert(
      `Données reçues mais affichage en échec : <code>${esc(err.message)}</code>. ` +
        'Ouvre <strong>Diagnostic</strong> et copie le rapport.',
    );
    console.error('Erreur de rendu :', err);
  } finally {
    btn.disabled = false;
  }
}

// ── Rendu ────────────────────────────────────────────────────

function render(data) {
  const m = data.measurement || {};
  renderVerdict(m.sprt);
  renderKpis(data.account, m.shadow);
  renderChart(data.equityCurve, data.account, data.serverTime);
  renderPositions(data.positions, data.account.currency);
  renderStatus(data.status, data.calendar);
  renderShadow(m.shadow);
  renderCalibration(m.shadow?.calibration);
  renderAdvisory(m.shadow?.advisory);
  renderCosts(m.spreads, m.execution);
  renderJournal(data.journal);
  renderTrades(data.trades, data.account.currency);
  renderCapacityPanel(data.status.capacity);
  $('last-update').textContent = fmtDate(data.serverTime);

  // Le panneau de diagnostic suit le rythme du dashboard quand il est ouvert :
  // des logs figés seraient trompeurs pendant qu'on cherche un problème.
  if (!$('debug-panel').hidden) {
    renderDebug(data);
    loadLogs();
  }

  // La liste détaillée des clés n'est accessible qu'avec le jeton admin.
  if (isAdmin()) loadKeys().catch((err) => setKeysFeedback('err', `Clés inaccessibles : ${err.message}`));
}

/**
 * Le verdict séquentiel — l'élément le plus important de la page.
 *
 * Sur un compte de 100 $, le P&L n'apprend rien : quelques dollars de variation
 * sont indiscernables du bruit. Ce que le projet produit réellement, c'est une
 * réponse statistique à « le modèle bat-il le hasard ? ». Elle mérite le haut
 * de la page, pas une note de bas de tableau.
 */
const VERDICT_STYLES = {
  VALIDE: { cls: 'verdict-valid', label: '✓ VALIDÉ' },
  ARRETER: { cls: 'verdict-stop', label: '✕ ARRÊTER' },
  TRONQUE: { cls: 'verdict-truncated', label: '⊘ TRONQUÉ' },
  CONTINUER: { cls: 'verdict-continue', label: '↻ CONTINUER' },
  DONNEES_INSUFFISANTES: { cls: 'verdict-unknown', label: '⋯ EN COURS' },
};

function renderVerdict(sprt) {
  const panel = $('verdict');
  const style = VERDICT_STYLES[sprt?.status] || VERDICT_STYLES.DONNEES_INSUFFISANTES;

  panel.className = `verdict ${style.cls}`;
  $('verdict-badge').textContent = style.label;

  if (!sprt || sprt.error) {
    $('verdict-reason').textContent = sprt?.error
      ? `Verdict indisponible : ${sprt.error}`
      : 'En attente de données.';
    $('verdict-meta').textContent = '—';
    $('verdict-fill').style.width = '0%';
    $('verdict-progress-label').textContent = '—';
    $('verdict-caveat').hidden = true;
    return;
  }

  $('verdict-reason').textContent = sprt.reason || '—';
  $('verdict-meta').textContent =
    `${sprt.n ?? 0} observations · horizon ${sprt.horizon ?? 3} j` +
    (sprt.observedSharpe != null ? ` · Sharpe observé ${sprt.observedSharpe}` : '');

  const pct = Math.round((sprt.progress ?? 0) * 100);
  $('verdict-fill').style.width = `${pct}%`;

  if (sprt.status === 'DONNEES_INSUFFISANTES') {
    $('verdict-progress-label').textContent = `${sprt.n ?? 0} / ${sprt.hypotheses?.maxSamples ? 30 : 30} minimum`;
  } else if (sprt.samplesRemaining != null) {
    $('verdict-progress-label').textContent = `${sprt.samplesRemaining} observations avant troncature`;
  } else {
    $('verdict-progress-label').textContent = 'décision rendue';
  }

  const caveat = $('verdict-caveat');
  if (sprt.caveat) {
    caveat.hidden = false;
    caveat.textContent = sprt.caveat;
  } else {
    caveat.hidden = true;
  }
}

/** Qualité de prédiction, segmentée pour savoir ce qui sert vraiment. */
function renderShadow(shadow) {
  const tbody = $('shadow-table').querySelector('tbody');

  if (!shadow || shadow.error || !shadow.samples) {
    $('shadow-meta').textContent = shadow?.pendingResolution
      ? `${shadow.pendingResolution} en attente de résolution`
      : '—';
    // La note du serveur distingue « rien d'enregistré » de « enregistré mais
    // pas encore échu » — deux situations très différentes pour qui se demande
    // si le bot fonctionne.
    tbody.innerHTML = `<tr class="empty"><td colspan="6">${
      esc(shadow?.error || shadow?.note || 'Aucune décision résolue. Les premiers scores arrivent 3 séances après le premier cycle.')
    }</td></tr>`;
    return;
  }

  $('shadow-meta').textContent =
    `${shadow.samples} décisions · ${shadow.pendingResolution ?? 0} en attente`;

  const rows = [
    ['Toutes décisions', shadow.overall],
    ['— Achats', shadow.byAction?.BUY],
    ['— Ventes', shadow.byAction?.SELL],
    ['— Abstentions', shadow.byAction?.HOLD],
    ['Confiance ≥ 0,6', shadow.byConfidence?.haute],
    ['Confiance < 0,6', shadow.byConfidence?.basse],
    ['Avec actualités', shadow.byNews?.avecActus],
    ['Sans actualités', shadow.byNews?.sansActus],
    ['Phase PreTOM', shadow.byCalendar?.preTom],
    ['Phase TOM', shadow.byCalendar?.tom],
  ].filter(([, s]) => s && s.n > 0);

  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="6">Pas encore assez de décisions résolues.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map(([label, s]) => `<tr>
      <td>${esc(label)}</td>
      <td class="num">${s.n}</td>
      <td class="num ${s.hitRate > 0.5 ? 'up' : s.hitRate < 0.5 ? 'down' : 'muted'}">${(s.hitRate * 100).toFixed(1)} %</td>
      <td class="num ${signClass(s.meanScorePct)}">${s.meanScorePct >= 0 ? '+' : ''}${s.meanScorePct} %</td>
      <td class="num muted">${s.meanExcessPct == null ? '—' : `${s.meanExcessPct >= 0 ? '+' : ''}${s.meanExcessPct} %`}</td>
      <td class="num muted">${s.sharpePerDecision ?? '—'}</td>
    </tr>`)
    .join('');
}

/**
 * Fiabilité des probabilités annoncées.
 *
 * Deux échecs distincts à ne pas confondre, et c'est tout l'intérêt de la
 * décomposition : une confiance MAL CALIBRÉE reste rattrapable (le classement
 * est bon, l'échelle est fausse), une confiance NON INFORMATIVE ne l'est pas.
 */
function renderCalibration(calib) {
  const tbody = $('calib-table').querySelector('tbody');
  const set = (id, value, cls) => {
    const el = $(id);
    el.textContent = value;
    el.className = cls ?? '';
  };

  if (!calib || calib.brier == null) {
    $('calib-meta').textContent = calib?.n ? `${calib.n} observations` : '—';
    ['calib-verdict', 'calib-bias', 'calib-brier', 'calib-skill'].forEach((id) => set(id, '—', 'muted'));
    tbody.innerHTML = `<tr class="empty"><td colspan="5">${
      esc(calib?.note ?? 'Aucune prévision résolue pour le moment.')
    }</td></tr>`;
    return;
  }

  $('calib-meta').textContent = `${calib.n} prévisions résolues`;

  // Le verdict est déjà rédigé côté serveur : on ne fait que le colorer.
  const bad = /NON INFORMATIVE|NUISIBLE/.test(calib.verdict);
  const meh = /MAL CALIBRÉE/.test(calib.verdict);
  set('calib-verdict', calib.verdict, bad ? 'down' : meh ? 'warn-text' : 'up');

  // On affiche la PENTE, pas le biais moyen. Le biais moyen s'annule quand la
  // surconfiance est symétrique (0,87 pour 0,77 réalisé d'un côté, 0,12 pour
  // 0,21 de l'autre) et afficherait « équilibré » sur un modèle qui exagère de
  // 10 points aux deux bouts. La pente, elle, voit la dilatation d'échelle.
  const k = calib.penteDeCalibration;
  set(
    'calib-bias',
    k == null
      ? '—'
      : `pente ${k} — ${k < 0.8 ? `écarts exagérés ${(1 / k).toFixed(1)}×` : k > 1.25 ? 'écarts trop timides' : 'échelle juste'}`
        + ` · biais moyen ${calib.biaisMoyen > 0 ? '+' : ''}${calib.biaisMoyen}`,
    k == null ? 'muted' : k < 0.8 || k > 1.25 ? 'down' : 'up',
  );

  set('calib-brier', `${calib.brier} (ECE ${calib.ece})`, 'muted');

  // Le score d'habileté se compare à 0, pas à 1 : son plafond dépend de la
  // séparation atteignable, pas d'une note absolue.
  const skill = calib.scoreHabilete;
  set(
    'calib-skill',
    skill == null ? '—' : `${skill} ${skill > 0 ? '(informative)' : '(sans valeur)'}`,
    skill == null ? 'muted' : skill > 0 ? 'up' : 'down',
  );

  tbody.innerHTML = calib.bins
    .map((b) => `<tr>
      <td>${esc(b.range)}</td>
      <td class="num">${b.n}</td>
      <td class="num muted">${b.annonce}</td>
      <td class="num">${b.realise}</td>
      <td class="num ${Math.abs(b.ecart) > 0.1 ? 'down' : 'up'}">${b.ecart > 0 ? '+' : ''}${b.ecart}</td>
    </tr>`)
    .join('');
}

/** Écart entre l'avis du modèle et le seuil appliqué. */
function renderAdvisory(advisory) {
  const set = (id, value, cls) => {
    const el = $(id);
    el.textContent = value;
    el.className = cls ?? '';
  };
  const note = $('adv-note');

  if (!advisory) {
    $('advisory-meta').textContent = '—';
    ['adv-rate', 'adv-held', 'adv-pushed'].forEach((id) => set(id, '—', 'muted'));
    note.hidden = true;
    return;
  }

  $('advisory-meta').textContent = `${advisory.n} décisions comparées`;
  set('adv-rate', `${(advisory.tauxDeConflit * 100).toFixed(0)} %`, advisory.tauxDeConflit > 0.3 ? 'warn-text' : 'muted');

  const fmtSide = ({ n, scoreMoyenPct }) => (n
    ? `${n} fois · score moyen ${scoreMoyenPct == null ? '—' : `${scoreMoyenPct >= 0 ? '+' : ''}${scoreMoyenPct} %`}`
    : 'jamais');

  // Le score moyen répond à la question qui compte : qui avait raison ?
  set('adv-held', fmtSide(advisory.freinePar), signClass(advisory.freinePar.scoreMoyenPct));
  set('adv-pushed', fmtSide(advisory.retenuPar), signClass(advisory.retenuPar.scoreMoyenPct));

  note.hidden = !advisory.note;
  if (advisory.note) note.textContent = advisory.note;
}

/** Coûts de transaction réels, mesurés et non estimés. */
function renderCosts(spreads, execution) {
  const overall = spreads?.overall;

  if (overall) {
    $('cost-meta').textContent = `${overall.totalSamples} mesures en séance`;

    // Les actifs dont le flux ne donne pas de cotation plausible sont exclus de
    // l'agrégat. Le dire sur la carte, pas seulement dans l'API : un « spread
    // médian » calculé sur 8 actifs au lieu de 11 doit s'annoncer, sinon le
    // chiffre paraît porter sur tout l'univers.
    const exclus = overall.excludedSymbols || [];
    $('cost-spread').innerHTML = `${overall.medianOfMedians} bps `
      + `<span class="muted">(flux ${esc(spreads.feed)}, ${overall.symbolsMeasured} actifs)</span>`
      + (exclus.length
        ? `<br><span class="warn-text" title="Cotations invraisemblables sur ce flux : ces actifs ne participent pas au calcul">`
          + `${exclus.length} écarté${exclus.length > 1 ? 's' : ''} — ${esc(exclus.join(', '))}</span>`
        : '');

    // Coût d'un aller-retour sur une position type, au spread médian du
    // PORTEFEUILLE — calculé côté serveur. La version précédente prenait
    // `Object.values(symbols)[0]`, donc un actif au hasard selon l'ordre des
    // clés, et affichait son coût comme s'il était général.
    const rt = overall.roundTrip;
    $('cost-roundtrip').textContent = rt ? `${rt.totalBps} bps — ${fmtMoney(rt.total, 'USD')}` : '—';
    $('cost-breakeven').textContent = rt ? `+${rt.breakEvenPct} % pour être à l'équilibre` : '—';
  } else {
    $('cost-meta').textContent = '—';
    $('cost-spread').textContent = 'aucune mesure en séance';
    $('cost-roundtrip').textContent = '—';
    $('cost-breakeven').textContent = '—';
  }

  if (execution?.measurable) {
    const med = execution.vsExpectedSide.medianBps;
    const cls = med < -0.5 ? 'up' : med > 0.5 ? 'down' : 'muted';
    $('cost-execution').innerHTML =
      `<span class="${cls}">${med >= 0 ? '+' : ''}${med} bps</span> ` +
      `<span class="muted">sur ${execution.measurable} fills</span>`;
    // Le nombre de fills écartés doit accompagner le taux : une « amélioration
    // de prix » calculée après avoir jeté la moitié des échantillons ne se lit
    // pas comme un taux sur tous les ordres.
    $('cost-improvement').innerHTML = `${(execution.priceImprovementRate * 100).toFixed(0)} % des ordres`
      + (execution.excluded
        ? ` <span class="muted" title="Cotation de référence inutilisable">(${execution.excluded} fill${execution.excluded > 1 ? 's' : ''} écarté${execution.excluded > 1 ? 's' : ''})</span>`
        : '');
  } else {
    $('cost-execution').textContent = execution?.note ? 'aucun fill mesurable' : '—';
    $('cost-improvement').textContent = '—';
  }
}

function renderKpis(account, shadow) {
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

  const unrealized = $('kpi-unrealized');
  unrealized.textContent = `${fmtMoney(account.unrealizedPnl, cur)} latents`;
  unrealized.className = `kpi-sub ${signClass(account.unrealizedPnl)}`;

  $('kpi-positions').textContent = account.positionsCount ?? 0;
  // Le nombre de décisions scorées compte davantage que le nombre de trades :
  // c'est lui qui fait avancer le verdict statistique.
  // « Aucune décision mesurée » tout court laissait croire que le bot
  // n'enregistrait rien, alors qu'il accumule et attend l'échéance.
  $('kpi-decisions').textContent = shadow?.samples
    ? `${shadow.samples} décisions mesurées`
    : shadow?.pendingResolution
      ? `${shadow.pendingResolution} en attente d'échéance`
      : 'aucune décision enregistrée';

  const badge = $('mode-badge');
  badge.textContent = account.isLive ? 'Trading réel' : 'Paper trading';
  badge.className = `badge ${account.isLive ? 'badge-live' : 'badge-paper'}`;
}

/** Courbe d'équity en SVG pur : pas de librairie, pas de CDN. */
function renderChart(curve, account, serverTime) {
  const host = $('chart');
  const recorded = (curve || []).filter((p) => Number.isFinite(p.equity));

  // ── Le dernier point doit être l'équity EN DIRECT ──────────────────────
  // La courbe est un historique échantillonné ; `account.equity` est la valeur
  // courante. Les deux divergeaient, et le résultat était contradictoire à
  // l'écran : le KPI annonçait « 100,05 $ (+0,05 %) » en vert pendant que la
  // courbe plongeait en rouge vers son plus bas, parce que le dernier point
  // enregistré datait de quelques minutes (99,89 $). Deux chiffres justes, une
  // lecture fausse.
  const points = [...recorded];
  const last = points[points.length - 1];
  if (Number.isFinite(account?.equity) && last && Math.abs(account.equity - last.equity) > 1e-9) {
    points.push({ t: serverTime ?? new Date().toISOString(), equity: account.equity });
  }

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

  // ── Amplitude plancher : ne pas dramatiser le bruit ────────────────────
  // Sans plancher, l'échelle se resserre sur l'amplitude réelle — 16 centimes
  // observés — et transforme du bruit en falaise. La courbe donnait l'image
  // d'un krach pour une variation de 0,05 %.
  //
  // Ce n'est pas cosmétique : le projet repose sur le fait qu'un P&L de
  // quelques dollars sur 100 $ est indiscernable du hasard. Un graphique qui le
  // met en scène raconte exactement le contraire de ce que dit le verdict
  // statistique juste au-dessus. On impose donc une fenêtre d'au moins 2 % du
  // capital initial : une variation insignifiante s'affiche alors comme plate,
  // ce qu'elle est.
  const observed = max - min;
  const floor = baseline * 0.02;
  const span = Math.max(observed, floor);
  const center = (max + min) / 2;
  const lo = center - span * 0.62;
  const hi = center + span * 0.62;

  const x = (i) => PAD.left + (i / (points.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${y(lo).toFixed(1)} L${x(0).toFixed(1)},${y(lo).toFixed(1)} Z`;

  const isUp = values[values.length - 1] >= baseline;
  const stroke = isUp ? 'var(--up)' : 'var(--down)';
  const fill = isUp ? 'var(--up-soft)' : 'var(--down-soft)';

  const ticks = 4;
  const step = (hi - lo) / ticks;
  // Précision des libellés déduite de l'écart entre deux graduations. Elle était
  // figée à 0 décimale, si bien que les cinq libellés affichaient « 100 » sur
  // une fenêtre de 16 centimes : un axe qui ne graduait rien.
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  const gridLines = Array.from({ length: ticks + 1 }, (_, i) => {
    const value = lo + step * i;
    const yy = y(value).toFixed(1);
    return `<line class="grid-line" x1="${PAD.left}" y1="${yy}" x2="${W - PAD.right}" y2="${yy}" />
            <text class="axis-label" x="${W - PAD.right + 8}" y="${Number(yy) + 3}">${fmtNum(value, decimals)}</text>`;
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

function renderStatus(status, calendar) {
  const running = status.isRunning ? 'Cycle en cours' : status.paused ? 'En pause' : 'En veille';
  $('st-state').innerHTML = `<span class="pill ${status.paused ? 'pill-skip' : 'pill-exec'}">${esc(running)}</span>`;

  $('engine-actions').hidden = !isAdmin();
  $('btn-run-cycle').disabled = Boolean(status.isRunning);
  $('btn-run-cycle').textContent = status.isRunning ? 'Cycle en cours…' : 'Lancer un cycle';
  $('btn-toggle-pause').textContent = status.paused ? 'Reprendre' : 'Mettre en pause';
  $('st-last').textContent = `${fmtDate(status.lastCycleAt)} (${relativeTime(status.lastCycleAt)})`;
  $('st-count').textContent = status.cycleCount ?? 0;
  $('st-model').textContent = `${status.llmProvider} · ${status.model}`;
  $('st-symbols').textContent = (status.symbols || []).join(', ') || '—';
  $('st-cron').textContent = `${status.cron} · ${status.interval}`;
  $('st-broker').textContent = `${status.broker}${status.isLive ? ' ⚠️ RÉEL' : ' (paper)'}`;

  // Marché ouvert ou fermé : la première chose à vérifier quand « il ne se
  // passe rien ». Le bot n'analyse pas hors séance, par économie de quota.
  const open = status.marketOpen;
  $('st-market').innerHTML = open == null
    ? '<span class="muted">inconnu</span>'
    : `<span class="pill ${open ? 'pill-exec' : 'pill-skip'}">${open ? 'ouvert' : 'fermé'}</span>`;

  $('st-calendar').innerHTML = calendar
    ? `${esc(calendar.label)} — <span class="muted">${esc(calendar.phase)}</span>`
    : '—';

  renderCapacity(status.capacity);

  const breaker = status.risk?.circuitBreakerTrippedAt;
  $('st-breaker').innerHTML = breaker
    ? `<span class="pill pill-risk">Déclenché ${esc(fmtDate(breaker))}</span>`
    : `<span class="pill pill-exec">Inactif — seuil mensuel</span>`;

  if (status.isLive) document.body.dataset.live = 'true';
}

/**
 * Capacité du pool de clés Gemini.
 * Chaque compte Google gratuit apporte son propre quota journalier : ce bloc
 * traduit « j'ai N clés » en « je peux faire X cycles par jour ».
 */
/** Quota condensé dans la liste d'état. Le détail vit dans la carte des clés. */
function renderCapacity(capacity) {
  const el = $('st-quota');
  if (!el) return;

  if (!capacity || capacity.error) {
    el.textContent = capacity?.error ? `erreur : ${capacity.error}` : '—';
    return;
  }

  if (!Number.isFinite(capacity.totalPerDay)) {
    el.textContent = 'illimité';
    return;
  }

  if (capacity.keys === 0) {
    el.innerHTML = '<span class="pill pill-risk">aucune clé</span>';
    return;
  }

  const exhausted = capacity.remaining <= 0;
  el.innerHTML =
    `<span class="pill ${exhausted ? 'pill-risk' : 'pill-exec'}">${capacity.used} / ${capacity.totalPerDay}</span> ` +
    `<span class="muted">${capacity.keys} clé${capacity.keys > 1 ? 's' : ''} · ${capacity.cyclesPerDay} cycles/j</span>`;
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

// ── Panneau de diagnostic ────────────────────────────────────
//
// Sa raison d'être : quand le bot semble inactif, la question « est-il vivant
// et que fait-il ? » doit trouver sa réponse en un coup d'œil, sans avoir à
// lire des logs serveur. Et le bouton de copie produit un rapport texte
// autonome, collable directement dans une conversation.

function toggleDebug(force) {
  const panel = $('debug-panel');
  const open = force ?? panel.hidden;
  panel.hidden = !open;
  if (open) {
    if (state.data) renderDebug(state.data);
    loadLogs();
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  return open;
}

/** Tuiles de santé : l'essentiel de l'état en un balayage visuel. */
function renderDebug(data) {
  const s = data.status || {};
  const m = data.measurement || {};
  const cap = s.capacity || {};

  // Un cycle qui n'a pas tourné depuis longtemps alors que le marché est
  // ouvert est le symptôme le plus révélateur d'un blocage.
  const lastCycleAge = s.lastCycleAt ? (Date.now() - Date.parse(s.lastCycleAt)) / 60000 : null;
  const cycleLevel = s.lastCycleAt == null ? 'warn' : lastCycleAge > 300 && s.marketOpen ? 'err' : 'ok';

  const tiles = [
    ['Back-end', state.apiUrl || 'non configuré', state.apiUrl ? 'ok' : 'err'],
    ['Marché', s.marketOpen == null ? 'inconnu' : s.marketOpen ? 'ouvert' : 'fermé', s.marketOpen ? 'ok' : 'warn'],
    [
      s.marketOpen ? 'Clôture prévue' : 'Réouverture',
      s.marketOpen ? fmtDate(s.nextMarketClose) : fmtDate(s.nextMarketOpen),
      'ok',
    ],
    ['Moteur', s.isRunning ? 'cycle en cours' : s.paused ? 'EN PAUSE' : 'en veille', s.paused ? 'warn' : 'ok'],
    ['Dernier cycle', s.lastCycleAt ? relativeTime(s.lastCycleAt) : 'jamais', cycleLevel],
    ['Cycles', String(s.cycleCount ?? 0), 'ok'],
    ['Broker', `${s.broker ?? '?'}${s.isLive ? ' RÉEL' : ' paper'}`, s.isLive ? 'err' : 'ok'],
    ['Modèle', s.model ?? '?', 'ok'],
    [
      'Quota IA',
      Number.isFinite(cap.totalPerDay) ? `${cap.used}/${cap.totalPerDay}` : 'illimité',
      cap.remaining === 0 ? 'err' : cap.keysExhausted ? 'warn' : 'ok',
    ],
    ['Clés', `${cap.keys ?? 0}${cap.keysExhausted ? ` (${cap.keysExhausted} épuisée)` : ''}`, cap.keys ? 'ok' : 'err'],
    ['Verdict SPRT', m.sprt?.status ?? 'indisponible', m.sprt?.status === 'ARRETER' ? 'err' : 'ok'],
    ['Décisions mesurées', String(m.shadow?.samples ?? 0), m.shadow?.samples ? 'ok' : 'warn'],
    ['En attente', String(m.shadow?.pendingResolution ?? 0), 'ok'],
    // Les deux compteurs sont distincts : la calibration de l'échelle consomme
    // des observations sans produire de preuve. Sans cette tuile, on croirait
    // le test bloqué alors qu'il traverse encore sa période de chauffe.
    [
      'Preuves SPRT',
      m.sprt ? `${m.sprt.nEff ?? 0} (échelle ${m.sprt.nWarmup ?? 0}/${m.sprt.hypotheses?.warmupSamples ?? '?'})` : '—',
      (m.sprt?.nEff ?? 0) > 0 ? 'ok' : 'warn',
    ],
    [
      'Calibration',
      // Pente et non biais moyen : ce dernier s'annule sur une surconfiance
      // symétrique et afficherait « sain » à tort.
      m.shadow?.calibration?.brier != null
        ? `Brier ${m.shadow.calibration.brier} · pente ${m.shadow.calibration.penteDeCalibration ?? '—'}`
        : 'pas encore mesurable',
      m.shadow?.calibration?.scoreHabilete == null
        ? 'warn'
        : m.shadow.calibration.scoreHabilete > 0 ? 'ok' : 'err',
    ],
    [
      'Divergence d\'avis',
      m.shadow?.advisory
        ? `${(m.shadow.advisory.tauxDeConflit * 100).toFixed(0)} % · freine ${m.shadow.advisory.freinePar.n}× / pousse ${m.shadow.advisory.retenuPar.n}×`
        : '—',
      'ok',
    ],
    ['Positions', String(data.positions?.length ?? 0), 'ok'],
    ['Phase calendaire', data.calendar?.label ?? '—', 'ok'],
    ['Jeton admin', isAdmin() ? 'fourni' : 'absent', isAdmin() ? 'ok' : 'warn'],
  ];

  $('debug-health').innerHTML = tiles
    .map(([label, value, level]) => `<dl class="debug-tile ${level}">
      <dt>${esc(label)}</dt><dd>${esc(String(value))}</dd>
    </dl>`)
    .join('');

  $('debug-raw').textContent = JSON.stringify(data, null, 2);
}

async function loadLogs() {
  const view = $('log-view');
  try {
    const res = await fetch(`${state.apiUrl}/api/logs?limit=200`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.logs = await res.json();
    renderLogs();
  } catch (err) {
    view.innerHTML = `<p class="empty-block">Logs inaccessibles : ${esc(err.message)}</p>`;
  }
}

function renderLogs() {
  const view = $('log-view');
  const logs = (state.logs || []).filter((l) => state.logFilter === 'all' || l.level === state.logFilter);

  if (!logs.length) {
    view.innerHTML = '<p class="empty-block">Aucune ligne pour ce filtre.</p>';
    return;
  }

  // Le plus récent en haut : c'est ce qu'on cherche quand on diagnostique.
  view.innerHTML = [...logs]
    .reverse()
    .map((l) => `<div class="log-line log-${esc(l.level)}">
      <span class="log-time">${esc((l.ts || '').slice(11, 19))}</span>
      <span class="log-level">${esc(l.level.toUpperCase())}</span>
      <span class="log-scope">${esc(l.scope || '')}</span>
      <span class="log-msg">${esc(l.message)}${l.meta ? ` <span class="muted">${esc(typeof l.meta === 'string' ? l.meta : JSON.stringify(l.meta))}</span>` : ''}</span>
    </div>`)
    .join('');
}

/**
 * Copie un rapport de diagnostic autonome.
 *
 * Le serveur produit déjà l'essentiel via /api/diagnostic. On y ajoute ce que
 * lui seul ignore : l'URL configurée côté navigateur, l'heure locale, et les
 * éventuelles erreurs de la console — précisément les informations qui
 * manquent quand on cherche pourquoi le dashboard reste vide.
 */
async function copyDiagnostic() {
  const btn = $('btn-copy-diag');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Récupération…';

  try {
    const res = await fetch(`${state.apiUrl}/api/diagnostic`, { headers: { Accept: 'text/plain' } });
    const serverPart = res.ok ? await res.text() : `[Diagnostic serveur indisponible : HTTP ${res.status}]`;

    const clientPart = [
      '',
      '── CÔTÉ NAVIGATEUR ──',
      `URL du dashboard   : ${window.location.href}`,
      `URL du back-end    : ${state.apiUrl || 'non configurée'}`,
      `Jeton admin        : ${isAdmin() ? 'fourni' : 'absent'}`,
      `Rafraîchissement   : ${state.refreshInterval ? `${state.refreshInterval / 1000} s` : 'manuel'}`,
      `Heure locale       : ${new Date().toString()}`,
      `Dernier chargement : ${state.data ? fmtDate(state.data.serverTime) : 'aucun'}`,
      `Connexion          : ${$('conn-text').textContent}`,
      `Alerte affichée    : ${$('alert').hidden ? 'aucune' : $('alert').textContent.trim()}`,
    ].join('\n');

    const full = `${serverPart}\n${clientPart}`;

    try {
      await writeToClipboard(full);
      btn.textContent = '✓ Copié';
      setKeysFeedback('ok', `Diagnostic copié (${full.length} caractères). Colle-le dans la conversation.`);
      hideDiagnosticFallback();
    } catch (clipError) {
      // Le presse-papier est refusé dans plusieurs cas légitimes : page non
      // sécurisée, iframe, fenêtre sans focus. Un outil de diagnostic incapable
      // de livrer son diagnostic ne sert à rien : on affiche le texte,
      // présélectionné, pour une copie manuelle.
      showDiagnosticFallback(full);
      btn.textContent = '⇣ Affiché';
      setKeysFeedback(
        'warn',
        `Copie automatique refusée (${esc(clipError.message)}). Le rapport est affiché ci-dessous, déjà sélectionné : ` +
          'un Ctrl+C suffit.',
      );
    }
  } catch (err) {
    btn.textContent = '✗ Échec';
    setKeysFeedback('err', `Diagnostic indisponible : ${esc(err.message)}. Vérifie que le back-end répond.`);
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = original;
    }, 2500);
  }
}

/**
 * Affiche le rapport dans une zone de texte présélectionnée.
 * Dernier recours quand le presse-papier est refusé par le navigateur.
 */
function showDiagnosticFallback(text) {
  let area = $('diag-fallback');
  if (!area) {
    area = document.createElement('textarea');
    area.id = 'diag-fallback';
    area.className = 'diag-fallback';
    area.readOnly = true;
    area.spellcheck = false;
    $('debug-panel').appendChild(area);
  }
  area.hidden = false;
  area.value = text;
  area.focus();
  area.select();
}

function hideDiagnosticFallback() {
  const area = $('diag-fallback');
  if (area) area.hidden = true;
}

/** L'API Clipboard exige un contexte sécurisé : on prévoit le repli. */
async function writeToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(area);
  if (!ok) throw new Error('le navigateur a refusé la copie');
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

      // « n/d » n'apporte rien et fait croire à une panne. Ces deux champs ne
      // sont renseignés que par les sorties mécaniques (stop touché) et les
      // cycles marché fermé — pour les décisions du LLM, le schéma ne les
      // produit plus depuis le passage aux prévisions.
      const block = (title, value) => (value && value !== 'n/d'
        ? `<div class="entry-block"><h4>${title}</h4><p>${esc(value)}</p></div>`
        : '');

      // ── Le pré-mortem : ce que le modèle juge lui-même fragile ───────────
      // Il était produit à chaque décision et jeté. C'est pourtant la partie la
      // plus instructive du raisonnement : elle dit par quel mécanisme le
      // modèle pense pouvoir se tromper, formulé AVANT qu'il chiffre sa
      // prévision — donc avant toute rationalisation.
      const preMortem = e.preMortem
        ? `<div class="entry-block entry-premortem">
             <h4>Ce qui pourrait invalider cette lecture</h4>
             <p>${esc(e.preMortem.scenario)}</p>
             ${e.preMortem.weakestSignal && e.preMortem.weakestSignal !== 'n/d'
    ? `<p class="premortem-weak"><b>Signal le plus fragile :</b> ${esc(e.preMortem.weakestSignal)}</p>` : ''}
           </div>`
        : '';

      // ── La répartition, plutôt qu'une confiance sortie de nulle part ─────
      const f = e.forecast;
      const forecastBar = f
        ? `<div class="forecast">
             <span class="forecast-seg forecast-up" style="width:${Math.round(f.pUp * 100)}%"
                   title="${Math.round(f.pUp * 100)} scénarios sur 100 : surperformance">${Math.round(f.pUp * 100)}</span>
             <span class="forecast-seg forecast-flat" style="width:${Math.round(f.pFlat * 100)}%"
                   title="${Math.round(f.pFlat * 100)} sur 100 : écart indiscernable">${Math.round(f.pFlat * 100)}</span>
             <span class="forecast-seg forecast-down" style="width:${Math.round(f.pDown * 100)}%"
                   title="${Math.round(f.pDown * 100)} sur 100 : sous-performance">${Math.round(f.pDown * 100)}</span>
           </div>
           <span class="forecast-edge ${signClass(f.edge)}">écart ${f.edge >= 0 ? '+' : ''}${Math.round(f.edge * 100)} pts</span>`
        : '';

      // Divergence entre l'avis du modèle et ce que le seuil a décidé.
      const conflict = e.advisoryConflict && e.advisedAction
        ? `<span class="pill pill-conflict" title="Le seuil a tranché autrement que le modèle">modèle : ${esc(e.advisedAction)}</span>`
        : '';

      return `<article class="entry">
        <div class="entry-head">
          <span class="entry-sym">${esc(e.symbol)}</span>
          <span class="tag ${tag}">${esc(e.action)}</span>
          <span class="pill ${e.executed ? 'pill-exec' : 'pill-skip'}">${e.executed ? 'Exécuté' : 'Non exécuté'}</span>
          <span class="pill ${sentimentClass}">Presse : ${esc(e.newsSentiment || 'n/d')}</span>
          ${e.source === 'risk-manager' ? '<span class="pill pill-risk">Gestion du risque</span>' : ''}
          ${conflict}
          ${forecastBar || `<span class="confidence">Confiance
            <span class="confidence-bar"><span style="width:${confidence}%"></span></span>${confidence} %
          </span>`}
          <span class="entry-time">${esc(fmtDate(e.timestamp))}</span>
        </div>

        <p class="entry-quote">${esc(e.justification)}</p>

        ${e.riskDecision ? `<p class="entry-outcome ${
    /autorisé|autorisée/.test(e.riskDecision) ? 'outcome-act'
      : /refus|bloqué/.test(e.riskDecision) ? 'outcome-block' : 'outcome-hold'
  }">
          <b>Ce qui a été fait :</b> ${esc(e.riskDecision)}
        </p>` : ''}

        <div class="entry-grid">
          ${preMortem}
          ${block('Lecture technique', e.technicalRationale)}
          ${block('Lecture des actualités', e.newsRationale)}
          ${flags}
        </div>

        ${headlines ? `<ul class="headlines">${headlines}</ul>` : ''}

        <div class="entry-meta">
          ${e.price != null ? `<span><b>Cours</b> ${fmtNum(e.price, 2)} ${esc(e.currency || '')}</span>` : ''}
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
    tbody.innerHTML = '<tr class="empty"><td colspan="8">Aucun ordre passé.</td></tr>';
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

$('btn-debug').addEventListener('click', () => toggleDebug());
$('btn-close-debug').addEventListener('click', () => toggleDebug(false));
$('btn-copy-diag').addEventListener('click', copyDiagnostic);

$('log-filters').addEventListener('click', (event) => {
  const button = event.target.closest('.chip');
  if (!button) return;
  state.logFilter = button.dataset.log;
  document.querySelectorAll('#log-filters .chip').forEach((c) => c.classList.toggle('chip-active', c === button));
  renderLogs();
});

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
