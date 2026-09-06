import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type UiLang = 'fr' | 'en' | 'ar' | 'de' | 'es' | 'pl' | 'tr'

/** Provider prefix -> TMDB locale used for metadata, and ISO 639-1 for original-language hubs. */
export const PREFIX_INFO: Record<string, { name: string; locale: string; iso: string; flag: string }> = {
  FR: { name: 'Français', locale: 'fr-FR', iso: 'fr', flag: '🇫🇷' }, QFR: { name: 'Français (QC)', locale: 'fr-CA', iso: 'fr', flag: '🇨🇦' },
  EN: { name: 'English', locale: 'en-US', iso: 'en', flag: '🇬🇧' }, ENG: { name: 'English', locale: 'en-US', iso: 'en', flag: '🇬🇧' },
  AR: { name: 'العربية', locale: 'ar-SA', iso: 'ar', flag: '🇸🇦' }, DE: { name: 'Deutsch', locale: 'de-DE', iso: 'de', flag: '🇩🇪' },
  PL: { name: 'Polski', locale: 'pl-PL', iso: 'pl', flag: '🇵🇱' }, ES: { name: 'Español', locale: 'es-ES', iso: 'es', flag: '🇪🇸' },
  LAT: { name: 'Español (LatAm)', locale: 'es-MX', iso: 'es', flag: '🇲🇽' }, IN: { name: 'हिन्दी', locale: 'hi-IN', iso: 'hi', flag: '🇮🇳' },
  TM: { name: 'தமிழ்', locale: 'ta-IN', iso: 'ta', flag: '🇮🇳' }, NL: { name: 'Nederlands', locale: 'nl-NL', iso: 'nl', flag: '🇳🇱' },
  SE: { name: 'Svenska', locale: 'sv-SE', iso: 'sv', flag: '🇸🇪' }, SC: { name: 'Nordique', locale: 'sv-SE', iso: 'sv', flag: '🇸🇪' },
  DK: { name: 'Dansk', locale: 'da-DK', iso: 'da', flag: '🇩🇰' }, TR: { name: 'Türkçe', locale: 'tr-TR', iso: 'tr', flag: '🇹🇷' },
  IT: { name: 'Italiano', locale: 'it-IT', iso: 'it', flag: '🇮🇹' }, PT: { name: 'Português', locale: 'pt-PT', iso: 'pt', flag: '🇵🇹' },
  BR: { name: 'Português (BR)', locale: 'pt-BR', iso: 'pt', flag: '🇧🇷' }, RU: { name: 'Русский', locale: 'ru-RU', iso: 'ru', flag: '🇷🇺' },
  GR: { name: 'Ελληνικά', locale: 'el-GR', iso: 'el', flag: '🇬🇷' }, IR: { name: 'فارسی', locale: 'fa-IR', iso: 'fa', flag: '🇮🇷' },
  AL: { name: 'Shqip', locale: 'sq-AL', iso: 'sq', flag: '🇦🇱' }, BG: { name: 'Български', locale: 'bg-BG', iso: 'bg', flag: '🇧🇬' },
  RO: { name: 'Română', locale: 'ro-RO', iso: 'ro', flag: '🇷🇴' }, HU: { name: 'Magyar', locale: 'hu-HU', iso: 'hu', flag: '🇭🇺' },
  EX: { name: 'Ex-Yougoslavie', locale: 'hr-HR', iso: 'hr', flag: '🇭🇷' }, JP: { name: '日本語', locale: 'ja-JP', iso: 'ja', flag: '🇯🇵' },
  KR: { name: '한국어', locale: 'ko-KR', iso: 'ko', flag: '🇰🇷' }, CN: { name: '中文', locale: 'zh-CN', iso: 'zh', flag: '🇨🇳' },
  '4K': { name: '4K (multi)', locale: 'en-US', iso: 'en', flag: '🎞️' }, NF: { name: 'Netflix (multi)', locale: 'en-US', iso: 'en', flag: '🎞️' },
}

export const UI_LANGS: Record<UiLang, { name: string; locale: string; dir: 'ltr' | 'rtl' }> = {
  fr: { name: 'Français', locale: 'fr-FR', dir: 'ltr' }, en: { name: 'English', locale: 'en-US', dir: 'ltr' }, ar: { name: 'العربية', locale: 'ar-SA', dir: 'rtl' },
  de: { name: 'Deutsch', locale: 'de-DE', dir: 'ltr' }, es: { name: 'Español', locale: 'es-ES', dir: 'ltr' }, pl: { name: 'Polski', locale: 'pl-PL', dir: 'ltr' }, tr: { name: 'Türkçe', locale: 'tr-TR', dir: 'ltr' },
}
export const REGIONS = ['FR', 'BE', 'CH', 'CA', 'GB', 'US', 'DE', 'ES', 'IT', 'PL', 'NL', 'SE', 'MA', 'DZ', 'TN', 'SA', 'AE', 'EG', 'TR', 'IN', 'BR', 'MX']

interface Profile {
  uiLang: UiLang
  /** Provider prefixes, in preference order (first = preferred audio version) */
  contentLangs: string[]
  region: string
  onboarded: boolean
  set: (p: Partial<Profile>) => void
}

export const useProfile = create<Profile>()(persist((set) => ({
  uiLang: 'fr', contentLangs: ['FR', 'EN', 'AR'], region: 'FR', onboarded: false,
  set: (p) => set(p),
}), { name: 'iptv-profile' }))

/** TMDB locale for metadata = UI language. */
export const tmdbLocale = () => UI_LANGS[useProfile.getState().uiLang].locale
