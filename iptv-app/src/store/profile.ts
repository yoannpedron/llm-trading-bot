import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type UiLang = 'fr' | 'en' | 'ar' | 'de' | 'es' | 'pl' | 'tr' | 'it' | 'pt' | 'nl'

import { LANGS } from '../parser/langs'
/** Provider prefix -> TMDB locale used for metadata, and ISO 639-1 for original-language hubs. */
export const PREFIX_INFO = LANGS

export const UI_LANGS: Record<UiLang, { name: string; locale: string; dir: 'ltr' | 'rtl' }> = {
  fr: { name: 'Français', locale: 'fr-FR', dir: 'ltr' }, en: { name: 'English', locale: 'en-US', dir: 'ltr' }, ar: { name: 'العربية', locale: 'ar-SA', dir: 'rtl' },
  de: { name: 'Deutsch', locale: 'de-DE', dir: 'ltr' }, es: { name: 'Español', locale: 'es-ES', dir: 'ltr' }, pl: { name: 'Polski', locale: 'pl-PL', dir: 'ltr' }, tr: { name: 'Türkçe', locale: 'tr-TR', dir: 'ltr' },
  it: { name: 'Italiano', locale: 'it-IT', dir: 'ltr' }, pt: { name: 'Português', locale: 'pt-BR', dir: 'ltr' }, nl: { name: 'Nederlands', locale: 'nl-NL', dir: 'ltr' },
}
export const REGIONS = ['FR', 'BE', 'CH', 'CA', 'GB', 'US', 'DE', 'ES', 'IT', 'PL', 'NL', 'SE', 'MA', 'DZ', 'TN', 'SA', 'AE', 'EG', 'TR', 'IN', 'BR', 'MX']

interface Profile {
  uiLang: UiLang
  /** Provider prefixes, in preference order (first = preferred audio version) */
  contentLangs: string[]
  region: string
  /** country picked at first launch (drives ui language, content languages, cinema releases) */
  country?: string
  onboarded: boolean
  /** Kids mode: animation & family rows only, adult never shown */
  kids: boolean
  set: (p: Partial<Profile>) => void
}

export const useProfile = create<Profile>()(persist((set) => ({
  uiLang: 'fr', contentLangs: ['FR', 'EN', 'AR'], region: 'FR', onboarded: false, kids: false,
  set: (p) => set(p),
}), { name: 'iptv-profile' }))

/** TMDB locale for metadata = UI language. */
export const tmdbLocale = () => UI_LANGS[useProfile.getState().uiLang].locale
