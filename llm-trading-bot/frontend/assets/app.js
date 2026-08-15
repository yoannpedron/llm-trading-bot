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
  logFilter: 'all',
  data: null,
  timer: null,
  settingsAutoOpened: false,
  logs: [],
};

const $ = (id) => document.getElementById(id);

// ── État du panneau graphique ─────────────────────────────────────────
// Déclarés ici, et non près des fonctions qui s'en servent : le démarrage en
// fin de fichier appelle refresh(), donc renderPositions(), qui lit
// chartSymbol pour resurligner la ligne active. Une déclaration placée plus
// bas tomberait dans la zone morte temporelle du « let » et ferait échouer le
// tout premier rendu avec une ReferenceError.
// État du portefeuille, déclaré ici pour la même raison que ci-dessous :
// renderPositions et renderTrades s'exécutent au premier rendu, avant la fin
// du fichier.
let ongletPortefeuille = 'open';
let nbPositions = 0;
let nbOrdres = 0;

let chartSymbol = null;
let chartRange = '1y';

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

// ── Points de base et prix ────────────────────────────────────────────────
// Les valeurs venant de l'API étaient interpolées telles quelles dans les
// gabarits, si bien que JavaScript les rendait avec le point décimal anglais :
// « 6.04 bps » et « +0.0625 % » voisinaient avec « 99,43 $US ». Trois
// conventions sur une même page, sur un projet qui ne produit que des chiffres.
const fmtBps = (value, digits = 2) => (value == null || Number.isNaN(value) ? '—' : `${fmtNum(value, digits)} bps`);

const fmtSignedBps = (value, digits = 2) => (value == null || Number.isNaN(value)
  ? '—'
  : `${value >= 0 ? '+' : ''}${fmtNum(value, digits)} bps`);

// Un prix se lit comme un montant : « 495,91 $US », pas « 495,91 USD ». Le
// tableau des positions affichait le code brut juste sous un KPI en symbole,
// ce qui donnait l'impression de deux devises différentes.
const fmtPrice = (value, currency = 'USD') => fmtMoney(value, currency);

/**
 * Message d'attente d'une mesure.
 *
 * Un « — » ne dit pas si la valeur manque parce que le bot est cassé, parce
 * qu'il n'a pas encore assez tourné, ou parce que la mesure ne s'applique pas.
 * Le projet passe ses trois premières semaines à collecter : pendant tout ce
 * temps la page doit annoncer « je collecte », pas « je suis vide ».
 *
 * L'échéance est estimée sur le rythme RÉEL de collecte quand on en a un —
 * jamais déduite du nombre d'actifs, qui donnerait un chiffre trop optimiste :
 * le dégroupage sériel ne retient qu'une observation par actif tous les 3 jours.
 */
function attente({ n = 0, requis, quoi = 'décisions échues', premierAt = null }) {
  if (!requis) return 'En attente de données.';
  const manque = requis - n;
  if (manque <= 0) return null;

  let phrase = `${n} / ${requis} ${quoi}`;

  if (premierAt && n >= 3) {
    const jours = Math.max(1, (Date.now() - new Date(premierAt).getTime()) / 86400000);
    const parJour = n / jours;
    if (parJour > 0) {
      const date = new Date(Date.now() + Math.ceil(manque / parJour) * 86400000);
      phrase += ` — vers le ${date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;
    }
  } else if (n === 0) {
    phrase += ' — la collecte démarre au premier cycle en séance';
  }
  return phrase;
}

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

let lastData = null;

function render(data) {
  lastData = data;
  // Premier rendu réussi : on retire le voile de chargement. Avant lui, tous
  // les emplacements affichent « — », ce qui est indiscernable d'un tableau
  // de bord en panne. Le voile dit « ça arrive » pendant les ~700 ms d'appel.
  document.body.classList.remove('chargement');
  const m = data.measurement || {};
  renderVerdict(m.sprt);
  renderKpis(data.account, m.shadow);
  // Un rafraîchissement ne doit pas ramener de force la courbe d'équity
  // alors que l'utilisateur consulte le cours d'une action.
  if (!chartSymbol) renderChart(data.equityCurve, data.account, data.serverTime);
  renderPositions(data.positions, data.account.currency);
  renderStatus(data.status, data.calendar);
  renderProgress(data.status);
  renderRanking(data.status?.lastRanking);
  renderRankMetrics(m.shadow?.rangs);
  renderVerdictEta(m.sprt, m.shadow);
  renderShadow(m.shadow);
  renderCalibration(m.shadow?.calibration);
  renderAdvisory(m.shadow?.advisory);
  renderCosts(m.spreads, m.execution);
  // Le journal n'a plus de section propre : ses décisions alimentent les
  // lignes du classement, dépliables une par une.
  indexerJournal(data.journal);
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
    // « — » ne dit pas si le bot est cassé, s'il n'a pas assez tourné, ou si
    // la mesure ne s'applique pas encore. Le projet passe ses trois premières
    // semaines à collecter : la page doit annoncer « je collecte ».
    $('shadow-meta').textContent = shadow?.pendingResolution
      ? `${shadow.pendingResolution} décision(s) en attente d'échéance`
      : attente({ n: 0, requis: 30 });
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
      <td class="num ${s.hitRate > 0.5 ? 'up' : s.hitRate < 0.5 ? 'down' : 'muted'}">${fmtNum(s.hitRate * 100, 1)} %</td>
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
    // 30 observations : en dessous, la fréquence réalisée est dominée par sa
    // propre variance et on lirait du bruit comme un biais.
    $('calib-meta').textContent = attente({ n: calib?.n ?? 0, requis: 30, quoi: 'prévisions résolues' }) ?? '—';
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
      : `pente ${k} — ${k < 0.8 ? `écarts exagérés ${fmtNum(1 / k, 1)}×` : k > 1.25 ? 'écarts trop timides' : 'échelle juste'}`
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
    $('advisory-meta').textContent = attente({ n: 0, requis: 20, quoi: 'décisions du modèle' }) ?? '—';
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
    $('cost-spread').innerHTML = `${fmtBps(overall.medianOfMedians)} `
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
    $('cost-roundtrip').textContent = rt ? `${fmtBps(rt.totalBps)} — ${fmtMoney(rt.total, 'USD')}` : '—';
    $('cost-breakeven').textContent = rt ? `${fmtPct(rt.breakEvenPct, 4)} pour être à l'équilibre` : '—';
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
      `<span class="${cls}">${fmtSignedBps(med)}</span> ` +
      `<span class="muted">sur ${execution.measurable} ordre${execution.measurable > 1 ? "s" : ""} mesurable${execution.measurable > 1 ? "s" : ""}</span>`;
    // Le nombre de fills écartés doit accompagner le taux : une « amélioration
    // de prix » calculée après avoir jeté la moitié des échantillons ne se lit
    // pas comme un taux sur tous les ordres.
    $('cost-improvement').innerHTML = `${fmtNum(execution.priceImprovementRate * 100, 0)} % des ordres`
      + (execution.excluded
        ? ` <span class="muted" title="Cotation de référence inutilisable">(${execution.excluded} ordre${execution.excluded > 1 ? 's' : ''} écarté${execution.excluded > 1 ? 's' : ''})</span>`
        : '');
  } else {
    $('cost-execution').textContent = execution?.note ? 'aucun ordre mesurable' : '—';
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
  nbPositions = positions.length;
  majCompteurPortefeuille();

  if (!positions.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="7">Aucune position ouverte.</td></tr>';
    return;
  }

  tbody.innerHTML = positions
    .map(
      // Ligne cliquable : elle bascule le graphique du capital vers le cours
      // de cette action. Le panneau est réutilisé plutôt que dupliqué — la page
      // est déjà longue.
      // La classe `active` est réappliquée ICI, et pas seulement au clic : le
      // tableau est reconstruit à chaque rafraîchissement, ce qui effaçait le
      // surlignage de la ligne dont on consulte justement le cours.
      (p) => `<tr class="position-row${chartSymbol === p.symbol ? ' active' : ''}" data-symbol="${esc(p.symbol)}" tabindex="0" role="button" aria-pressed="${chartSymbol === p.symbol}" aria-label="Voir le cours de ${esc(p.symbol)}" title="Voir le cours de ${esc(p.symbol)}">
        <td class="sym">${esc(p.symbol)}</td>
        <td class="num">${fmtNum(p.quantity, 4)}</td>
        <td class="num">${fmtPrice(p.avgPrice, p.currency || 'USD')}</td>
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
  // 150 tickers d'affilée forment un mur illisible, même dans un repli. On
  // annonce le compte et les premiers ; la liste complète reste accessible en
  // survol, et de toute façon le classement du jour la montre en entier.
  const univers = status.symbols || [];
  const apercu = univers.slice(0, 8).join(', ');
  $('st-symbols').textContent = univers.length
    ? (univers.length > 8 ? `${univers.length} actifs — ${apercu}…` : apercu)
    : '—';
  $('st-symbols').title = univers.join(', ');
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
    // ── Le lancement est ASYNCHRONE ─────────────────────────────────────
    // Le serveur répond 202 immédiatement et le cycle continue derrière. Une
    // version précédente attendait la fin : avec dix actifs la requête durait
    // une minute et personne ne le remarquait, mais à 150 actifs en séance
    // elle dure une vingtaine de minutes. Le navigateur — ou tout proxy sur le
    // trajet — coupait bien avant, et le dashboard annonçait « le cycle a
    // échoué » alors qu'il se déroulait normalement. C'est le pire message
    // possible, puisqu'il pousse à relancer par-dessus.
    //
    // La progression se lit désormais dans l'état du moteur, rafraîchi comme
    // le reste de la page.
    const started = await adminFetch('/api/cycle', { method: 'POST' });
    if (started.started === false) {
      showAlert(`Cycle non lancé : ${esc(started.reason)}.`);
    } else {
      showAlert(null);
      // Cadence resserrée pendant le cycle : la barre de progression n'a
      // d'intérêt que si elle bouge.
      startProgressWatch();
    }
    await refresh();
  } catch (err) {
    // Message explicite sur le cas le plus fréquent : le jeton admin n'a pas
    // été saisi dans Réglages, et « 401 » seul n'aide personne.
    const message = /401|jeton|token/i.test(err.message)
      ? 'Jeton administrateur manquant ou invalide — ouvre Réglages et saisis-le.'
      : err.message;
    showAlert(`Impossible de lancer le cycle : ${esc(message)}.`);
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

let lastJournal = null;

/**
 * Décisions du dernier cycle, indexées par symbole.
 *
 * Le classement dit QUI a gagné ; le journal dit POURQUOI. Les tenir dans deux
 * sections séparées obligeait à lire deux listes des mêmes actifs en parallèle.
 * Cet index permet de rendre le raisonnement sous la ligne concernée.
 *
 * On garde la décision la PLUS RÉCENTE par symbole : le journal contient
 * plusieurs cycles, et c'est celle du classement affiché qui nous intéresse.
 */
let journalParSymbole = new Map();

function indexerJournal(entries) {
  journalParSymbole = new Map();
  for (const e of entries || []) {
    if (!e?.symbol) continue;
    const connue = journalParSymbole.get(e.symbol);
    if (!connue || new Date(e.timestamp) > new Date(connue.timestamp)) {
      journalParSymbole.set(e.symbol, e);
    }
  }
}

/**
 * Raisonnement du modèle pour UNE décision.
 *
 * Le journal était une section à part, empilant les entrées de tous les actifs.
 * C'était une seconde liste des mêmes symboles que le classement, à lire en
 * parallèle : pour savoir pourquoi NVDA était premier, il fallait quitter le
 * classement, chercher NVDA dans le journal, puis revenir. Les deux vues
 * décrivaient le même cycle sans jamais se rejoindre.
 *
 * Le raisonnement est désormais rendu à la demande, sous la ligne du classement
 * à laquelle il appartient — un seul endroit, un seul ordre de lecture.
 */
function journalBodyHtml(e) {
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

      // ── Entrée repliée par défaut ─────────────────────────────────────
      // Dépliée, une entrée mesure 467 px : à 150 actifs × 3 cycles le journal
      // atteindrait 200 écrans par jour et deviendrait inconsultable. Fermée,
      // elle en fait 40 et tient la ligne : symbole, action, écart, résumé.
      // Rien n'est perdu, tout est à un clic.
      const gist = (e.justification || e.technicalRationale || '').slice(0, 120);
      const ecart = e.forecast?.edge != null
        ? `${e.forecast.edge >= 0 ? '+' : ''}${Math.round(e.forecast.edge * 100)} pts`
        : `${confidence} %`;


  return `        <div class="entry-head">
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
        }`;
}


const TRADES_PAGE = 25;
let tradesLimit = TRADES_PAGE;
let lastTrades = null;

/**
 * Historique des ordres.
 *
 * Le bot vise 3 positions et vend peu, donc la table grandit lentement — mais
 * elle ne décroît jamais. Sur un an elle atteindrait plusieurs centaines de
 * lignes, toutes rendues d'un coup. On en montre 25, avec un bouton pour la
 * suite : c'est un historique, il se consulte, il ne se surveille pas.
 */
function renderTrades(trades, currency) {
  if (trades) lastTrades = trades;
  const tbody = $('trades-table').querySelector('tbody');
  nbOrdres = trades.length;
  majCompteurPortefeuille();

  if (!trades.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="8">Aucun ordre passé.</td></tr>';
    return;
  }

  tbody.innerHTML = trades
    .slice(0, tradesLimit)
    .map(
      (t) => `<tr>
        <td class="muted">${esc(fmtDate(t.timestamp))}</td>
        <td><span class="tag ${t.side === 'BUY' ? 'tag-buy' : 'tag-sell'}">${esc(t.side)}</span></td>
        <td class="sym">${esc(t.symbol)}</td>
        <td class="num">${fmtNum(t.quantity, 4)}</td>
        <td class="num">${fmtPrice(t.price, t.currency || 'USD')}</td>
        <td class="num">${fmtMoney(t.notional, currency)}</td>
        <td class="num ${signClass(t.realizedPnl)}">${t.side === 'SELL' ? fmtMoney(t.realizedPnl, currency) : '—'}</td>
        <td class="muted">${esc(t.source || 'llm')}</td>
      </tr>`,
    )
    .join('');

  if (trades.length > tradesLimit) {
    tbody.insertAdjacentHTML(
      'beforeend',
      `<tr><td colspan="8"><button class="load-more" id="trades-more">Voir ${Math.min(TRADES_PAGE, trades.length - tradesLimit)} ordres de plus (${trades.length - tradesLimit} restants)</button></td></tr>`,
    );
    $('trades-more').addEventListener('click', () => {
      tradesLimit += TRADES_PAGE;
      renderTrades(lastTrades, currency);
    });
  }
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

/* ═══════════════════════════════════════════════════════════════════════
   LE CLASSEMENT DU JOUR

   Depuis le passage au rang, le bot ne compare plus chaque action à un seuil :
   il les classe entre elles et prend les meilleures. Cette décision n'était
   visible nulle part, si bien qu'un HOLD ne disait pas si l'action avait été
   mal notée ou simplement battue par une autre.
   ═══════════════════════════════════════════════════════════════════════ */

let rankingView = 'top';
let rankingFilter = '';
let lastRanking = null;

function renderRanking(ranking) {
  lastRanking = ranking;
  const body = $('ranking-body');

  if (!ranking || !ranking.classement?.length) {
    $('ranking-meta').textContent = 'aucun classement';
    $('ranking-abstention').hidden = true;
    $('disp-value').textContent = '—';
    $('disp-fill').style.width = '0%';
    // Sans cette ligne le marqueur reste à gauche à 0 %, et son étiquette —
    // centrée par translateX(-50%) — sortait de la carte : on lisait « uil ».
    $('disp-threshold').style.left = '25%';
    $('disp-fill').classList.remove('below');
    // La note aussi doit repartir à zéro : elle affirmait « le modèle
    // différencie les actifs » sous un panneau qui annonce « aucun classement ».
    $('disp-note').textContent = 'La dispersion sera mesurée au premier classement : c’est elle '
      + 'qui décide si le bot a le droit d’agir.';
    // Sans classement, les boutons de vue restaient cliquables sans rien
    // produire — une commande qui ne répond pas fait croire à une panne. On
    // les masque tant qu'il n'y a rien à trier.
    $('ranking-views').hidden = true;
    $('ranking-search-wrap').hidden = true;
    body.innerHTML = '<p class="empty-block">Aucun classement — le bot n’a pas encore analysé l’univers en séance. '
      + 'Le premier arrivera au prochain cycle en séance.</p>';
    return;
  }

  $('ranking-views').hidden = false;

  const rows = ranking.classement;
  const retenus = rows.filter((r) => r.retenu).length;
  $('ranking-meta').textContent = `${rows.length} actifs classés · ${retenus} retenu(s) · ${fmtDate(ranking.at)}`;

  // ── Dispersion ────────────────────────────────────────────────────────
  // L'échelle va jusqu'à 4× le seuil : au-delà, la valeur exacte n'importe
  // plus, seul compte le fait d'être largement au-dessus.
  const seuil = ranking.seuilDispersion ?? 0.03;
  const disp = ranking.dispersion ?? 0;
  const echelle = seuil * 4;
  $('disp-value').textContent = `${fmtNum(disp * 100, 1)} pts`;
  const fill = $('disp-fill');
  fill.style.width = `${Math.min(100, (disp / echelle) * 100)}%`;
  fill.classList.toggle('below', disp < seuil);
  $('disp-threshold').style.left = `${(seuil / echelle) * 100}%`;
  $('disp-note').textContent = disp < seuil
    ? `Sous le seuil de ${(seuil * 100).toFixed(0)} points : le modèle note tout le monde pareil, le classement ne porte aucune information.`
    : `Au-dessus du seuil de ${(seuil * 100).toFixed(0)} points : le modèle différencie les actifs, le classement est exploitable.`;

  // ── Abstention expliquée ──────────────────────────────────────────────
  // Un cycle sans achat et un cycle bloqué se ressemblaient à l'écran.
  const abst = $('ranking-abstention');
  if (ranking.raisonAbstention) {
    abst.hidden = false;
    abst.innerHTML = `<strong>Aucun achat ce cycle.</strong> ${esc(ranking.raisonAbstention)}.`;
  } else if (retenus === 0) {
    abst.hidden = false;
    abst.innerHTML = '<strong>Aucun achat ce cycle.</strong> Le classement a fonctionné, mais aucun actif ne dépasse la médiane transversale.';
  } else {
    abst.hidden = true;
  }

  renderRankingBody(rows, ranking);
}

function renderRankingBody(rows, ranking) {
  const body = $('ranking-body');
  const q = rankingFilter.trim().toUpperCase();
  const filtered = q
    ? rows.filter((r) => r.symbol.includes(q) || (r.secteur || '').toUpperCase().includes(q))
    : rows;

  $('ranking-search-wrap').hidden = rankingView === 'top';

  if (!filtered.length) {
    body.innerHTML = '<p class="empty-block">Aucun actif ne correspond.</p>';
    return;
  }

  if (rankingView === 'heat') { body.innerHTML = heatmapHtml(filtered); return; }
  if (rankingView === 'sector') { body.innerHTML = sectorHtml(filtered); return; }

  // « Podium » : les retenus, plus quelques suivants. Voir QUI a été battu et
  // de combien est aussi informatif que voir les gagnants.
  const visible = rankingView === 'top'
    ? filtered.slice(0, Math.max(10, (ranking?.maxRetenus ?? 3) + 7))
    : filtered;

  body.innerHTML = rowsHtml(visible, ranking)
    + (rankingView === 'top' && filtered.length > visible.length
      ? `<p class="dispersion-note">… et ${filtered.length - visible.length} autres. Bascule sur « Tout » pour les voir.</p>`
      : '');
}

// `sansSecteur` : dans la vue par secteur, le nom est déjà en titre de groupe.
// Le répéter sur chaque ligne ajoute 150 mentions inutiles.
function rowsHtml(rows, ranking, sansSecteur = false) {
  const mediane = ranking?.mediane;
  let medianePlacee = false;
  const out = [];

  for (const r of rows) {
    // Une seule ligne de séparation, au moment du passage sous la médiane :
    // au-dessus l'achat est possible, en dessous il ne l'est jamais.
    if (!medianePlacee && mediane != null && r.ecart <= mediane) {
      out.push('<div class="rank-median">médiane transversale — en dessous, aucun achat possible</div>');
      medianePlacee = true;
    }
    const cls = r.retenu ? ' picked' : (r.detenu ? ' held' : '');
    const tag = r.retenu
      ? '<span class="rank-tag picked">retenu</span>'
      : (r.detenu ? '<span class="rank-tag held">détenu</span>' : '<span class="rank-tag">écarté</span>');
    // Chaque ligne porte le raisonnement du modèle sur cet actif, déplié à la
    // demande. Le corps n'est PAS construit ici : 150 raisonnements complets
    // représenteraient 70 000 px de DOM pour un panneau dont on ouvre une ligne.
    const aDecision = journalParSymbole.has(r.symbol);
    out.push(`<details class="rank-item" data-symbol="${esc(r.symbol)}">`
      + `<summary class="rank-row${cls}">`
      + `<span class="rank-pos">${r.rang}</span>`
      + `<span class="rank-sym">${esc(r.symbol)}${sansSecteur ? '' : `<span class="rank-sector">${esc(r.secteur || '')}</span>`}</span>`
      + `<span class="rank-edge">${r.ecart >= 0 ? '+' : ''}${(r.ecart * 100).toFixed(0)} pts</span>`
      + `${tag}`
      + `<span class="rank-chevron"${aDecision ? '' : ' hidden'}>›</span>`
      + `</summary>`
      + `<div class="rank-detail"></div></details>`);
  }
  return out.join('');
}

function sectorHtml(rows) {
  const groups = new Map();
  for (const r of rows) {
    const s = r.secteur || 'Hors référentiel';
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(r);
  }
  // Les secteurs dont le meilleur actif est le mieux classé passent devant :
  // on veut voir tout de suite d'où viennent les candidats du jour.
  const ordered = [...groups.entries()].sort((a, b) => a[1][0].rang - b[1][0].rang);

  return ordered.map(([secteur, items]) => {
    const retenus = items.filter((i) => i.retenu).length;
    const moyen = items.reduce((a, i) => a + i.ecart, 0) / items.length;
    return `<div class="sector-group">`
      + `<div class="sector-head">`
      + `<span><strong>${esc(secteur)}</strong> · ${items.length} actifs${retenus ? ` · ${retenus} retenu(s)` : ''}</span>`
      + `<span>écart moyen ${moyen >= 0 ? '+' : ''}${(moyen * 100).toFixed(0)} pts</span>`
      + `</div>${rowsHtml(items.slice(0, 6), null, true)}`
      + (items.length > 6 ? `<p class="dispersion-note">… ${items.length - 6} autres dans ce secteur</p>` : '')
      + `</div>`;
  }).join('');
}

function heatmapHtml(rows) {
  // Couleur par rang fractionnaire, PAS par écart brut : c'est l'ordre qui
  // décide, et une échelle de couleur sur l'écart ferait croire que le niveau
  // des probabilités compte. Vert = haut de classement, rouge = bas.
  return `<div class="heatmap">${rows.map((r) => {
    const f = r.rangFractionnaire ?? 0;
    const couleur = f >= 0.5
      ? `rgba(47, 191, 113, ${(0.15 + (f - 0.5) * 1.4).toFixed(2)})`
      : `rgba(242, 85, 90, ${(0.15 + (0.5 - f) * 1.4).toFixed(2)})`;
    const titre = `${r.symbol} — rang ${r.rang}/${r.total}, écart ${(r.ecart * 100).toFixed(0)} pts${r.retenu ? ' — RETENU' : ''}`;
    return `<div class="heat-cell${r.retenu ? ' picked' : ''}" style="background:${couleur}" title="${esc(titre)}">${esc(r.symbol)}</div>`;
  }).join('')}</div>`;
}

/* ═══════════════════════════════════════════════════════════════════════
   RANG → RÉSULTAT

   Le graphique décisif : si cette courbe monte, la sélection par classement
   repose sur quelque chose de réel. Si elle est plate, tout le mécanisme du
   classement ne sert à rien — et il vaut mieux le savoir tôt.
   ═══════════════════════════════════════════════════════════════════════ */

function renderRankMetrics(rangs) {
  const meta = $('rankic-meta');
  const chart = $('rankic-chart');
  const stats = $('rankic-stats');
  const verdict = $('rankic-verdict');

  const ic = rangs?.rankIC;
  const rce = rangs?.rce;

  if (!rce || rce.note || !rce.tranches?.length) {
    meta.textContent = rce?.note ? 'pas assez de données' : '—';
    // Masqué plutôt que vidé : une zone graphique vide de 190 px laisse croire
    // à un rendu raté, alors qu'il n'y a simplement rien à tracer.
    chart.hidden = true;
    chart.innerHTML = '';
    stats.innerHTML = '';
    verdict.textContent = rce?.note
      || 'Il faut une vingtaine de décisions échues pour tracer cette courbe.';
    return;
  }

  meta.textContent = `${rce.n} décisions · ${ic?.jours ?? 0} jours`;
  chart.hidden = false;

  // Échelle symétrique autour de zéro : sinon une barre négative minuscule
  // paraîtrait aussi grande qu'une positive énorme.
  // Échelle symétrique autour de zéro : sinon une barre négative minuscule
  // paraîtrait aussi grande qu'une positive énorme.
  const max = Math.max(...rce.tranches.map((t) => Math.abs(t.resultatMoyen))) || 1;
  chart.innerHTML = rce.tranches.map((t) => {
    const h = Math.max(2, (Math.abs(t.resultatMoyen) / max) * 100);
    const neg = t.resultatMoyen < 0;
    const valeur = (t.resultatMoyen >= 0 ? '+' : '') + fmtNum(t.resultatMoyen * 100, 2) + ' %';
    // La valeur est placée du côté de la barre : au-dessus si positive,
    // en dessous si négative, pour que l'œil suive la progression.
    return `<div class="bucket" title="${esc(t.tranche)} — ${t.n} décisions">`
      + `<div class="bucket-pos">${neg ? '' : `<div style="width:100%"><div class="bucket-value above">${valeur}</div><div class="bucket-bar" style="height:${h.toFixed(0)}px"></div></div>`}</div>`
      + '<div class="bucket-zero"></div>'
      + `<div class="bucket-neg">${neg ? `<div style="width:100%"><div class="bucket-bar neg" style="height:${h.toFixed(0)}px"></div><div class="bucket-value">${valeur}</div></div>` : ''}</div>`
      + `<span class="bucket-label">${esc(t.tranche)}</span></div>`;
  }).join('');

  const cases = [];
  if (ic?.icMoyen != null) {
    cases.push(`<div class="rank-stat">Corrélation de rang<strong>${fmtNum(ic.icMoyen * 100, 1)} %</strong></div>`);
    cases.push(`<div class="rank-stat">Significativité (t)<strong>${ic.tStat ?? '—'}</strong></div>`);
  }
  cases.push(`<div class="rank-stat">Écart haut–bas<strong>${fmtPct(rce.ecartHautBas * 100)}</strong></div>`);
  if (ic?.ampleur) {
    // Le chiffre qui corrige l'illusion : 150 actifs corrélés ne sont pas
    // 150 paris indépendants.
    cases.push(`<div class="rank-stat">Paris indépendants<strong>${ic.ampleur.actifsEffectifs ?? '—'}</strong></div>`);
  }
  stats.innerHTML = cases.join('');

  verdict.textContent = [ic?.verdict, rce.verdict].filter(Boolean).join(' ');
}

/* ═══════════════════════════════════════════════════════════════════════
   PROGRESSION — du cycle en cours, et vers le verdict
   ═══════════════════════════════════════════════════════════════════════ */

function renderProgress(status) {
  const row = $('st-progress-row');
  const p = status?.progress;
  if (!p) { row.hidden = true; return; }

  row.hidden = false;
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  $('st-progress-fill').style.width = `${pct}%`;
  $('st-progress-label').textContent = p.symbol
    ? `${p.done}/${p.total} — ${p.symbol}`
    : `${p.phase} (${p.done}/${p.total})`;
}

/**
 * Combien de temps avant de savoir ?
 *
 * Le SPRT donne un nombre d'observations requises mais pas de date. Or c'est la
 * date que l'on veut : sans elle, « 41 observations » ne dit pas si l'attente
 * est de trois jours ou de trois mois, et le dashboard paraît figé.
 *
 * Le rythme est ESTIMÉ sur les données réelles — observations accumulées
 * divisées par jours écoulés — plutôt que déduit du nombre d'actifs. Les deux
 * diffèrent beaucoup : le dégroupage sériel ne retient qu'une observation par
 * actif tous les 3 jours, et les jours fériés ne comptent pas.
 */
function renderVerdictEta(sprt, shadow) {
  const box = $('verdict-eta');
  const n = sprt?.samples ?? sprt?.n ?? 0;
  const cible = sprt?.maxSamples ?? null;

  if (!cible || !n || n >= cible) { box.hidden = true; return; }

  const premier = shadow?.premiereDecisionAt ?? null;
  const joursEcoules = premier
    ? Math.max(1, (Date.now() - new Date(premier).getTime()) / 86400000)
    : null;

  const pct = Math.round((n / cible) * 100);
  let phrase = `<strong>${n} observations sur ${cible}</strong> — ${pct} % du chemin vers un verdict.`;

  if (joursEcoules && n >= 5) {
    const parJour = n / joursEcoules;
    const joursRestants = Math.ceil((cible - n) / parJour);
    const date = new Date(Date.now() + joursRestants * 86400000);
    phrase += ` Au rythme observé (${fmtNum(parJour, 1)}/jour), verdict attendu vers le `
      + `<strong>${date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}</strong>.`;
  } else {
    phrase += ' Le rythme sera estimé après quelques jours de collecte.';
  }

  box.hidden = false;
  box.innerHTML = phrase;
}

/* ── Contrôles ────────────────────────────────────────────────────────── */

$('ranking-views').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-view]');
  if (!button) return;
  rankingView = button.dataset.view;
  for (const chip of $('ranking-views').querySelectorAll('.chip')) {
    chip.classList.toggle('chip-active', chip === button);
  }
  if (lastRanking) renderRankingBody(lastRanking.classement, lastRanking);
});

$('ranking-search').addEventListener('input', (event) => {
  rankingFilter = event.target.value;
  if (lastRanking) renderRankingBody(lastRanking.classement, lastRanking);
});


/**
 * Rafraîchissement resserré pendant un cycle.
 *
 * Le dashboard interroge le serveur toutes les 30 s par défaut, ce qui suffit
 * quand rien ne bouge. Pendant un cycle de vingt minutes, une barre qui avance
 * par sauts d'une demi-minute n'informe pas : on repasse à 3 s tant que le
 * moteur tourne, puis on rend la main au rythme normal.
 *
 * Le minuteur s'arrête aussi sur erreur réseau — sans quoi un serveur devenu
 * injoignable serait interrogé toutes les trois secondes indéfiniment.
 */
let progressTimer = null;

function startProgressWatch() {
  if (progressTimer) return;
  progressTimer = setInterval(async () => {
    try {
      const res = await fetch(`${state.apiUrl}/api/status`);
      if (!res.ok) throw new Error(String(res.status));
      const status = await res.json();
      renderProgress(status);
      renderRanking(status.lastRanking);
      if (!status.isRunning) {
        stopProgressWatch();
        refresh();
      }
    } catch {
      stopProgressWatch();
    }
  }, 3000);
}

function stopProgressWatch() {
  if (!progressTimer) return;
  clearInterval(progressTimer);
  progressTimer = null;
}


/* ═══════════════════════════════════════════════════════════════════════
   ONGLETS
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * L'onglet actif vit dans le fragment d'URL.
 *
 * Deux bénéfices pour trois lignes : un rafraîchissement ne ramène plus de
 * force sur « Aujourd'hui » — ce qui était pénible en pleine lecture des
 * mesures — et la page peut être mise en favori directement sur l'onglet
 * voulu.
 */
function activerOnglet(nom, ecrireUrl = true) {
  const valide = nom === 'mesures' ? 'mesures' : 'aujourdhui';
  for (const tab of $('tabs').querySelectorAll('.tab')) {
    const actif = tab.dataset.tab === valide;
    tab.classList.toggle('tab-active', actif);
    tab.setAttribute('aria-selected', String(actif));
  }
  $('tab-aujourdhui').hidden = valide !== 'aujourdhui';
  $('tab-mesures').hidden = valide !== 'mesures';
  if (ecrireUrl) history.replaceState(null, '', `#${valide}`);
}

activerOnglet(location.hash.replace('#', ''), false);
window.addEventListener('hashchange', () => activerOnglet(location.hash.replace('#', ''), false));

$('tabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (!button) return;
  activerOnglet(button.dataset.tab);
});

/* ═══════════════════════════════════════════════════════════════════════
   GRAPHIQUE D'UNE ACTION

   Le même panneau sert à deux choses : la courbe d'équity par défaut, le cours
   d'une action dès qu'on clique sur une position. Réutiliser l'emplacement
   plutôt qu'en ajouter un évite d'allonger encore une page déjà longue.
   ═══════════════════════════════════════════════════════════════════════ */


async function showSymbolChart(symbol, range = chartRange) {
  chartSymbol = symbol;
  chartRange = range;

  $('chart-title').textContent = symbol;
  $('chart-ranges').hidden = false;
  $('chart-back').hidden = false;
  $('chart-range').textContent = 'chargement…';
  for (const chip of $('chart-ranges').querySelectorAll('[data-range]')) {
    chip.classList.toggle('chip-active', chip.dataset.range === range);
  }
  for (const row of document.querySelectorAll('.position-row')) {
    const actif = row.dataset.symbol === symbol;
    row.classList.toggle('active', actif);
    // aria-pressed doit suivre la classe : un lecteur d'écran annonce sinon
    // « non pressé » sur la ligne qu'on vient justement d'activer.
    row.setAttribute('aria-pressed', String(actif));
  }

  try {
    const res = await fetch(`${state.apiUrl}/api/market/${encodeURIComponent(symbol)}?range=${range}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Le symbole a pu changer pendant la requête — un clic rapide sur une
    // autre position. Sans ce test, la réponse lente écrase la récente.
    if (chartSymbol !== symbol || chartRange !== range) return;
    drawSeries(data);
  } catch (err) {
    $('chart').innerHTML = `<p class="chart-empty">Cours indisponible : ${esc(err.message)}.</p>`;
    $('chart-range').textContent = '—';
  }
}

function showEquityChart() {
  chartSymbol = null;
  $('chart-title').textContent = 'Évolution du capital';
  $('chart-ranges').hidden = true;
  $('chart-back').hidden = true;
  for (const row of document.querySelectorAll('.position-row')) {
    row.classList.remove('active');
    row.setAttribute('aria-pressed', 'false');
  }
  if (lastData) renderChart(lastData.equityCurve, lastData.account, lastData.serverTime);
}

/**
 * Tracé d'une série de cours.
 *
 * Volontairement distinct de `renderChart` : la courbe d'équity impose une
 * fenêtre minimale de 2 % pour ne pas dramatiser quelques centimes de bruit sur
 * un capital de 100 $. Un cours d'action n'a pas ce problème — sa variation
 * réelle est l'information — et lui appliquer le même plancher écraserait un
 * mouvement de 1 % qui, lui, compte.
 */
function drawSeries(data) {
  const host = $('chart');
  const points = (data.candles || []).filter((c) => Number.isFinite(c.c));

  if (points.length < 2) {
    host.innerHTML = '<p class="chart-empty">Pas de cotation sur cette période.</p>';
    $('chart-range').textContent = '—';
    return;
  }

  const W = 1000;
  const H = 260;
  const PAD = { top: 16, right: 56, bottom: 24, left: 12 };

  const values = points.map((p) => p.c);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // Marge de 4 % de l'amplitude en haut et en bas, pour que la courbe ne colle
  // jamais aux bords. Sur une série parfaitement plate on retombe sur ±1 %.
  const marge = (max - min) * 0.04 || max * 0.01;
  const lo = min - marge;
  const hi = max + marge;

  const x = (i) => PAD.left + (i / (points.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);

  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.c).toFixed(1)}`).join(' ');
  const premier = points[0].c;
  const dernier = points[points.length - 1].c;
  const hausse = dernier >= premier;
  const couleur = hausse ? 'var(--up)' : 'var(--down)';

  // Nombre de décimales adapté au prix : deux suffisent au-dessus de 10 $,
  // mais un titre à 3,20 $ mérite trois décimales pour que les graduations ne
  // soient pas toutes identiques.
  const dec = max >= 10 ? 2 : 3;
  const graduations = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = lo + f * (hi - lo);
    return `<line x1="${PAD.left}" y1="${y(v).toFixed(1)}" x2="${W - PAD.right}" y2="${y(v).toFixed(1)}" class="grid-line"/>`
      + `<text x="${W - PAD.right + 6}" y="${(y(v) + 3.5).toFixed(1)}" class="axis-label">${fmtNum(v, dec)}</text>`;
  }).join('');

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${graduations}
    <path d="${d} L${x(points.length - 1).toFixed(1)},${H - PAD.bottom} L${PAD.left},${H - PAD.bottom} Z"
          fill="${couleur}" opacity="0.10"/>
    <path d="${d}" fill="none" stroke="${couleur}" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <circle cx="${x(points.length - 1).toFixed(1)}" cy="${y(dernier).toFixed(1)}" r="3.5" fill="${couleur}"/>
  </svg>`;

  const variation = ((dernier - premier) / premier) * 100;
  $('chart-range').textContent = `${points.length} points · ${fmtPrice(dernier, data.currency || 'USD')} · `
    + `${fmtPct(variation)} sur la période`;
}

$('chart-ranges').addEventListener('click', (event) => {
  const bouton = event.target.closest('[data-range]');
  if (bouton && chartSymbol) { showSymbolChart(chartSymbol, bouton.dataset.range); return; }
  if (event.target.closest('#chart-back')) showEquityChart();
});

// Clic sur une position : le graphique bascule sur le cours de l'action.
// Entrée et Espace déclenchent la ligne comme un bouton. Sans ça, les lignes
// annoncées « role=button » aux lecteurs d'écran ne répondaient qu'à la souris —
// promettre une interaction qu'on ne fournit pas est pire que ne rien annoncer.
$('positions-table').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('.position-row');
  if (!row) return;
  event.preventDefault();
  row.click();
});

$('positions-table').addEventListener('click', (event) => {
  const row = event.target.closest('.position-row');
  if (!row) return;
  // Re-cliquer sur la ligne active revient au capital : c'est le geste
  // attendu, et ça évite d'obliger à viser le petit bouton « ← Capital ».
  if (chartSymbol === row.dataset.symbol) showEquityChart();
  else showSymbolChart(row.dataset.symbol);
  document.getElementById('chart').scrollIntoView({ behavior: 'smooth', block: 'center' });
});


/**
 * Le raisonnement est construit à l'ouverture, pas au rendu de la liste.
 *
 * Sur 150 actifs, produire les 150 corps d'un coup représenterait environ
 * 70 000 px de DOM pour un panneau dont on déplie une ligne à la fois — c'est
 * exactement le défaut qui rendait l'ancien journal inutilisable.
 */
$('ranking-body').addEventListener('toggle', (event) => {
  const item = event.target.closest('details.rank-item');
  if (!item || !item.open) return;

  // Une seule ligne ouverte à la fois. Un raisonnement déplié fait ~380 px :
  // en laisser plusieurs ouverts repousse le classement hors de l'écran et
  // ramène le mur que la fusion du journal venait de supprimer.
  for (const autre of $('ranking-body').querySelectorAll('details.rank-item[open]')) {
    if (autre !== item) autre.open = false;
  }

  const hote = item.querySelector('.rank-detail');
  if (hote.dataset.rempli === '1') return;

  const decision = journalParSymbole.get(item.dataset.symbol);
  hote.innerHTML = decision
    ? journalBodyHtml(decision)
    : '<p class="empty-block">Aucun raisonnement enregistré pour cet actif sur le dernier cycle — '
      + 'il a pu être écarté avant l\'appel au modèle (marché fermé, cotation absente).</p>';
  hote.dataset.rempli = '1';
}, true);


/* ═══════════════════════════════════════════════════════════════════════
   PORTEFEUILLE — deux onglets dans une seule carte

   Positions ouvertes et ordres passés décrivent le même objet à deux moments :
   ce qu'on tient, et comment on y est arrivé. Séparés en deux cartes, il
   fallait faire défiler de l'une à l'autre pour relier un P&L latent à l'ordre
   qui l'a créé.
   ═══════════════════════════════════════════════════════════════════════ */


/**
 * Un seul compteur pour les deux onglets.
 *
 * Il annonce ce que montre l'onglet affiché ET rappelle le volume de l'autre :
 * sans ce rappel, rien n'indique qu'un historique existe derrière le second
 * onglet, et un onglet dont on ignore le contenu ne se clique pas.
 */
function majCompteurPortefeuille() {
  const el = $('positions-count');
  if (!el) return;
  const pos = `${nbPositions} position${nbPositions > 1 ? 's' : ''}`;
  const ord = `${nbOrdres} ordre${nbOrdres > 1 ? 's' : ''}`;
  el.textContent = ongletPortefeuille === 'open'
    ? `${pos} ouverte${nbPositions > 1 ? 's' : ''} · ${ord} au total`
    : `${ord} · ${pos} ouverte${nbPositions > 1 ? 's' : ''}`;
}

$('portfolio-tabs').addEventListener('click', (event) => {
  const bouton = event.target.closest('button[data-pf]');
  if (!bouton) return;
  ongletPortefeuille = bouton.dataset.pf;
  for (const chip of $('portfolio-tabs').querySelectorAll('.chip')) {
    const actif = chip === bouton;
    chip.classList.toggle('chip-active', actif);
    chip.setAttribute('aria-selected', String(actif));
  }
  $('pf-open').hidden = ongletPortefeuille !== 'open';
  $('pf-past').hidden = ongletPortefeuille !== 'past';
  majCompteurPortefeuille();
});
