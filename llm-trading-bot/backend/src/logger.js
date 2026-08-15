const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

/** Tampon circulaire des derniers logs, exposé au dashboard via /api/logs. */
const ring = [];
const RING_SIZE = 300;

function emit(level, scope, message, meta) {
  if (LEVELS[level] < threshold) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta !== undefined ? { meta } : {}),
  };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();

  // ── La sortie standard peut disparaître, et le log ne doit pas tuer le bot ──
  //
  // Observé pour de bon : le serveur lancé avec sa sortie dirigée vers un `head`
  // a vu le tuyau se fermer au bout de 60 lignes. Chaque `console.log` suivant a
  // levé EPIPE ; le gestionnaire d'exception non capturée a voulu journaliser
  // l'erreur — via ce même `emit` — qui a levé EPIPE à son tour. Récursion
  // infinie, 100 % d'un cœur pendant six minutes, cycle bloqué, aucune décision
  // enregistrée. Le processus était vivant et répondait à /api/health, ce qui
  // rendait la panne d'autant plus difficile à voir.
  //
  // Le cas n'est pas un artefact de développement : en production la sortie
  // casse quand journald redémarre, quand un terminal attaché se ferme, ou
  // quand un `docker logs` est interrompu. Le bot doit alors continuer à
  // trader, pas partir en vrille.
  //
  // Le tampon circulaire ci-dessus a DÉJÀ reçu l'entrée : /api/logs et le
  // dashboard restent complets même si plus rien ne sort sur la console. On
  // perd l'affichage, jamais la trace.
  if (stdoutBroken) return;

  const line = `[${entry.ts}] ${level.toUpperCase().padEnd(5)} ${scope.padEnd(12)} ${message}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  try {
    meta === undefined ? out(line) : out(line, typeof meta === 'string' ? meta : JSON.stringify(meta));
  } catch (err) {
    // Une sortie cassée ne se répare pas : on cesse définitivement d'écrire
    // plutôt que de retenter à chaque ligne. Surtout, on n'essaie PAS de
    // signaler l'incident par la sortie qui vient de tomber.
    if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') stdoutBroken = true;
    // Toute autre erreur d'écriture est avalée pour la même raison : rien de ce
    // qui se passe ici ne justifie d'interrompre un cycle de trading.
  }
}

/** Une fois vrai, plus aucune écriture n'est tentée. */
let stdoutBroken = false;

/**
 * La console casse-t-elle ? Exposé pour que /api/health puisse le signaler :
 * un bot dont les logs ne sortent plus fonctionne, mais on doit le savoir.
 */
export const isStdoutBroken = () => stdoutBroken;

export function createLogger(scope) {
  return {
    debug: (msg, meta) => emit('debug', scope, msg, meta),
    info: (msg, meta) => emit('info', scope, msg, meta),
    warn: (msg, meta) => emit('warn', scope, msg, meta),
    error: (msg, meta) => emit('error', scope, msg, meta),
  };
}

export const getRecentLogs = (limit = 100) => ring.slice(-limit);
