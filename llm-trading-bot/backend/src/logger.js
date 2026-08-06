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

  const line = `[${entry.ts}] ${level.toUpperCase().padEnd(5)} ${scope.padEnd(12)} ${message}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  meta === undefined ? out(line) : out(line, typeof meta === 'string' ? meta : JSON.stringify(meta));
}

export function createLogger(scope) {
  return {
    debug: (msg, meta) => emit('debug', scope, msg, meta),
    info: (msg, meta) => emit('info', scope, msg, meta),
    warn: (msg, meta) => emit('warn', scope, msg, meta),
    error: (msg, meta) => emit('error', scope, msg, meta),
  };
}

export const getRecentLogs = (limit = 100) => ring.slice(-limit);
