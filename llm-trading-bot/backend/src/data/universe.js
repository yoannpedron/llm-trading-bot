/**
 * Univers élargi — 150 grandes capitalisations américaines.
 *
 * ── Pourquoi 150 et pas 10 ────────────────────────────────────────────────
 * Avec 10 actifs, « le meilleur du jour » est le moins mauvais d'un très petit
 * tas. Le classement transversal, qui est devenu le cœur de la stratégie, n'a
 * de sens que si le premier décile est un vrai premier décile.
 *
 * Deux effets opposés fixent l'optimum :
 *
 *   • plus d'actifs = plus de sélectivité. Prendre les 3 meilleurs sur 150,
 *     c'est le 2e centile ; sur 10, c'est le 30e. L'écart de qualité attendu
 *     entre les deux est considérable.
 *
 *   • plus d'actifs = plus de coût par cycle, et surtout une descente
 *     progressive vers des titres moins liquides, où le spread mange l'écart
 *     que la sélection était censée capturer.
 *
 * Au-delà de ~200 titres américains, on quitte les grandes capitalisations et
 * le second effet domine. En dessous de ~100, le premier n'a pas la place de
 * jouer. 150 est au milieu de cette fenêtre.
 *
 * ── Le vrai gain n'est pas celui qu'on croit ──────────────────────────────
 * L'ampleur EFFECTIVE ne suit pas le nombre d'actifs. La correction de Buckle
 * — appliquée dans `rankMetrics.js` sur la corrélation mesurée — donne
 * N/(1+(N−1)ρ) : à ρ = 0,3, cent cinquante titres valent trois paris et demi,
 * pas cent cinquante.
 *
 * L'expansion ne multiplie donc pas l'information par 15. Ce qu'elle apporte
 * est ailleurs, et reste décisif :
 *
 *   • la SÉLECTIVITÉ, qui n'est pas soumise à la correction de corrélation ;
 *   • la diversité SECTORIELLE, qui abaisse ρ elle-même — c'est la seule
 *     manière d'augmenter réellement l'ampleur effective.
 *
 * D'où le classement par secteur ci-dessous : il n'est pas décoratif. Un
 * univers de 150 semi-conducteurs aurait un ρ proche de 0,7 et une ampleur
 * effective inférieure à celle de 10 titres bien répartis.
 */

/**
 * Symboles par secteur GICS. Le secteur sert à deux choses : diagnostiquer la
 * corrélation résiduelle, et vérifier qu'aucun secteur n'écrase les autres.
 */
export const UNIVERSE_BY_SECTOR = {
  'Technologie': [
    'AAPL', 'MSFT', 'NVDA', 'AVGO', 'AMD', 'CRM', 'ORCL', 'ADBE', 'CSCO', 'ACN',
    'INTC', 'QCOM', 'TXN', 'IBM', 'NOW', 'INTU', 'AMAT', 'MU', 'LRCX', 'ADI',
    'KLAC', 'PANW', 'SNPS', 'CDNS', 'CRWD', 'MRVL', 'FTNT', 'ANET', 'DELL', 'HPQ',
  ],
  'Communication': [
    'GOOGL', 'META', 'NFLX', 'DIS', 'CMCSA', 'TMUS', 'VZ', 'T', 'EA', 'WBD',
  ],
  'Consommation discrétionnaire': [
    'AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'LOW', 'SBUX', 'TJX', 'BKNG', 'ABNB',
    'GM', 'F', 'CMG', 'MAR', 'ORLY', 'DHI', 'LEN', 'ROST', 'YUM', 'LVS',
  ],
  'Consommation de base': [
    'WMT', 'PG', 'COST', 'KO', 'PEP', 'PM', 'MO', 'MDLZ', 'CL', 'TGT',
    'KMB', 'GIS', 'KHC', 'SYY', 'STZ',
  ],
  'Santé': [
    'LLY', 'UNH', 'JNJ', 'ABBV', 'MRK', 'TMO', 'ABT', 'PFE', 'DHR', 'AMGN',
    'BMY', 'GILD', 'ISRG', 'CVS', 'MDT', 'VRTX', 'REGN', 'CI', 'ELV', 'HCA',
  ],
  'Finance': [
    'BRK.B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS', 'AXP', 'SPGI',
    'BLK', 'C', 'SCHW', 'PGR', 'CB', 'MMC', 'PYPL', 'COF', 'ICE', 'CME',
  ],
  'Industrie': [
    'GE', 'CAT', 'RTX', 'HON', 'UNP', 'BA', 'DE', 'LMT', 'UPS', 'ADP',
    'ETN', 'NOC', 'GD', 'CSX', 'EMR', 'ITW', 'FDX', 'WM', 'PH', 'NSC',
  ],
  'Énergie': [
    'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX', 'WMB', 'OXY', 'VLO',
  ],
  'Services publics': [
    'NEE', 'SO', 'DUK', 'CEG', 'AEP',
  ],
};

/** L'univers à plat, dans l'ordre des secteurs. */
export const UNIVERSE_150 = Object.values(UNIVERSE_BY_SECTOR).flat();

/** Secteur d'un symbole, pour le diagnostic de corrélation. */
export function sectorOf(symbol) {
  for (const [sector, symbols] of Object.entries(UNIVERSE_BY_SECTOR)) {
    if (symbols.includes(symbol)) return sector;
  }
  return null;
}

/**
 * Répartition sectorielle d'un univers donné.
 *
 * Sert au garde-fou de démarrage : un univers où un secteur pèse plus de la
 * moitié n'apporte pas l'ampleur effective qu'on croit avoir achetée en
 * ajoutant des titres.
 */
export function sectorBreakdown(symbols) {
  const counts = new Map();
  let unknown = 0;
  for (const s of symbols) {
    const sector = sectorOf(s);
    if (!sector) { unknown += 1; continue; }
    counts.set(sector, (counts.get(sector) ?? 0) + 1);
  }
  const total = symbols.length || 1;
  const rows = [...counts.entries()]
    .map(([sector, n]) => ({ sector, n, part: n / total }))
    .sort((a, b) => b.n - a.n);
  return { rows, unknown, dominant: rows[0] ?? null };
}
