/**
 * Language codes as providers write them in stream / category prefixes (`FR|`, `|DE|`, `[AR]`…),
 * with aliases and the tags that are not languages at all (`NF|`, `4K|`).
 * Detection cascade: title prefix → category prefix → unknown (kept, shown when the user allows it).
 */
export interface LangInfo { name: string; locale: string; iso: string; flag: string }

export const LANGS: Record<string, LangInfo> = {
  FR: { name: 'Français', locale: 'fr-FR', iso: 'fr', flag: '🇫🇷' }, QFR: { name: 'Français (QC)', locale: 'fr-CA', iso: 'fr', flag: '🇨🇦' },
  EN: { name: 'English', locale: 'en-US', iso: 'en', flag: '🇬🇧' },
  AR: { name: 'العربية', locale: 'ar-SA', iso: 'ar', flag: '🇸🇦' }, DE: { name: 'Deutsch', locale: 'de-DE', iso: 'de', flag: '🇩🇪' },
  PL: { name: 'Polski', locale: 'pl-PL', iso: 'pl', flag: '🇵🇱' }, ES: { name: 'Español', locale: 'es-ES', iso: 'es', flag: '🇪🇸' },
  LAT: { name: 'Español (LatAm)', locale: 'es-MX', iso: 'es', flag: '🇲🇽' }, IN: { name: 'हिन्दी', locale: 'hi-IN', iso: 'hi', flag: '🇮🇳' },
  TM: { name: 'தமிழ்', locale: 'ta-IN', iso: 'ta', flag: '🇮🇳' }, TE: { name: 'తెలుగు', locale: 'te-IN', iso: 'te', flag: '🇮🇳' }, ML: { name: 'മലയാളം', locale: 'ml-IN', iso: 'ml', flag: '🇮🇳' },
  PB: { name: 'ਪੰਜਾਬੀ', locale: 'pa-IN', iso: 'pa', flag: '🇮🇳' }, BN: { name: 'বাংলা', locale: 'bn-BD', iso: 'bn', flag: '🇧🇩' }, UR: { name: 'اردو', locale: 'ur-PK', iso: 'ur', flag: '🇵🇰' },
  NL: { name: 'Nederlands', locale: 'nl-NL', iso: 'nl', flag: '🇳🇱' },
  SE: { name: 'Svenska', locale: 'sv-SE', iso: 'sv', flag: '🇸🇪' }, SC: { name: 'Nordique', locale: 'sv-SE', iso: 'sv', flag: '🇸🇪' },
  DK: { name: 'Dansk', locale: 'da-DK', iso: 'da', flag: '🇩🇰' }, NO: { name: 'Norsk', locale: 'nb-NO', iso: 'no', flag: '🇳🇴' }, FI: { name: 'Suomi', locale: 'fi-FI', iso: 'fi', flag: '🇫🇮' },
  TR: { name: 'Türkçe', locale: 'tr-TR', iso: 'tr', flag: '🇹🇷' },
  IT: { name: 'Italiano', locale: 'it-IT', iso: 'it', flag: '🇮🇹' }, PT: { name: 'Português', locale: 'pt-PT', iso: 'pt', flag: '🇵🇹' },
  BR: { name: 'Português (BR)', locale: 'pt-BR', iso: 'pt', flag: '🇧🇷' }, RU: { name: 'Русский', locale: 'ru-RU', iso: 'ru', flag: '🇷🇺' }, UA: { name: 'Українська', locale: 'uk-UA', iso: 'uk', flag: '🇺🇦' },
  GR: { name: 'Ελληνικά', locale: 'el-GR', iso: 'el', flag: '🇬🇷' }, IR: { name: 'فارسی', locale: 'fa-IR', iso: 'fa', flag: '🇮🇷' },
  AL: { name: 'Shqip', locale: 'sq-AL', iso: 'sq', flag: '🇦🇱' }, BG: { name: 'Български', locale: 'bg-BG', iso: 'bg', flag: '🇧🇬' },
  RO: { name: 'Română', locale: 'ro-RO', iso: 'ro', flag: '🇷🇴' }, HU: { name: 'Magyar', locale: 'hu-HU', iso: 'hu', flag: '🇭🇺' }, CZ: { name: 'Čeština', locale: 'cs-CZ', iso: 'cs', flag: '🇨🇿' },
  EX: { name: 'Ex-Yougoslavie', locale: 'hr-HR', iso: 'hr', flag: '🇭🇷' }, JP: { name: '日本語', locale: 'ja-JP', iso: 'ja', flag: '🇯🇵' },
  KR: { name: '한국어', locale: 'ko-KR', iso: 'ko', flag: '🇰🇷' }, CN: { name: '中文', locale: 'zh-CN', iso: 'zh', flag: '🇨🇳' },
  VN: { name: 'Tiếng Việt', locale: 'vi-VN', iso: 'vi', flag: '🇻🇳' }, TH: { name: 'ไทย', locale: 'th-TH', iso: 'th', flag: '🇹🇭' }, ID: { name: 'Indonesia', locale: 'id-ID', iso: 'id', flag: '🇮🇩' },
  PH: { name: 'Filipino', locale: 'fil-PH', iso: 'tl', flag: '🇵🇭' }, SO: { name: 'Soomaali', locale: 'so-SO', iso: 'so', flag: '🇸🇴' }, HE: { name: 'עברית', locale: 'he-IL', iso: 'he', flag: '🇮🇱' },
  KU: { name: 'Kurdî', locale: 'ku-TR', iso: 'ku', flag: '🏳️' }, AF: { name: 'Afrikaans', locale: 'af-ZA', iso: 'af', flag: '🇿🇦' },
}
/** provider spellings → canonical code */
const ALIAS: Record<string, string> = {
  ENG: 'EN', UK: 'EN', US: 'EN', USA: 'EN', GB: 'EN', AU: 'EN', CA: 'EN', FRA: 'FR', FRE: 'FR', VF: 'FR', VFF: 'FR', VFQ: 'QFR', GER: 'DE', DEU: 'DE', AT: 'DE', CH: 'DE', ARA: 'AR', ARB: 'AR', MA: 'AR', DZ: 'AR', TN: 'AR', EG: 'AR', SA: 'AR', AE: 'AR', LB: 'AR',
  ESP: 'ES', SPA: 'ES', MX: 'LAT', LATAM: 'LAT', LATINO: 'LAT', ITA: 'IT', POR: 'PT', PTB: 'BR', PTBR: 'BR', BRA: 'BR', POL: 'PL', PL4K: 'PL', NLD: 'NL', DUT: 'NL', BE: 'NL', BEL: 'NL', SWE: 'SE', SCA: 'SC', NOR: 'NO', DAN: 'DK', FIN: 'FI',
  TUR: 'TR', RUS: 'RU', UKR: 'UA', GRE: 'GR', GRC: 'GR', PER: 'IR', FA: 'IR', ALB: 'AL', BUL: 'BG', ROU: 'RO', HUN: 'HU', CZE: 'CZ', SK: 'CZ', EXYU: 'EX', YU: 'EX', HR: 'EX', SR: 'EX', BA: 'EX', SL: 'EX', SI: 'EX', MK: 'EX',
  IND: 'IN', HI: 'IN', HIN: 'IN', TAM: 'TM', TA: 'TM', TG: 'TE', TL: 'TE', TEL: 'TE', MAL: 'ML', MLM: 'ML', PA: 'PB', PUN: 'PB', BEN: 'BN', BD: 'BN', URD: 'UR', PK: 'UR', JPN: 'JP', JA: 'JP', KOR: 'KR', KO: 'KR', CHN: 'CN', ZH: 'CN', HK: 'CN', TW: 'CN',
  VIE: 'VN', VI: 'VN', THA: 'TH', IDN: 'ID', INDO: 'ID', MY: 'ID', FIL: 'PH', TGL: 'PH', SOM: 'SO', HEB: 'HE', IL: 'HE', KUR: 'KU', AFR: 'AF', ZA: 'AF',
}
/** prefixes that are platforms / qualities, never a language */
export const TAG_PREFIXES = new Set(['NF', 'NFX', 'NETFLIX', 'D+', 'DSN', 'DISNEY', 'HBO', 'MAX', 'AMZ', 'AMAZON', 'PRIME', 'APPLE', 'ATV', 'PARA', 'HULU', 'PEACOCK', 'CANAL', 'SKY', 'STARZ', 'CRUNCHY', '4K', 'UHD', 'HD', 'FHD', 'SD', 'HEVC', 'MULTI', 'VIP', 'PPV', 'NEW', 'TOP', 'IMDB', 'KIDS', 'XXX', 'ADULT'])

export function canonLang(code?: string): string | undefined {
  if (!code) return undefined
  const c = code.toUpperCase()
  if (LANGS[c]) return c
  const a = ALIAS[c]; return a && LANGS[a] ? a : undefined
}
/** title prefix first, then the category prefix; `undefined` = unidentified */
export function resolveLang(titlePrefix?: string, categoryPrefix?: string): string | undefined {
  return canonLang(titlePrefix) ?? canonLang(categoryPrefix)
}
