/**
 * The 30 largest markets, each with its interface language, the provider language codes its
 * residents expect (in preference order), and the ISO region used for cinema releases.
 * Multilingual countries list every official language; the user can add or remove any of them.
 */
import type { UiLang } from './profile'

export interface Country { code: string; name: string; flag: string; ui: UiLang; langs: string[] }

export const COUNTRIES: Country[] = [
  { code: 'FR', name: 'France', flag: '🇫🇷', ui: 'fr', langs: ['FR'] },
  { code: 'BE', name: 'Belgique · België', flag: '🇧🇪', ui: 'fr', langs: ['FR', 'NL'] },
  { code: 'CH', name: 'Schweiz · Suisse · Svizzera', flag: '🇨🇭', ui: 'de', langs: ['DE', 'FR', 'IT'] },
  { code: 'CA', name: 'Canada', flag: '🇨🇦', ui: 'en', langs: ['EN', 'QFR', 'FR'] },
  { code: 'LU', name: 'Luxembourg', flag: '🇱🇺', ui: 'fr', langs: ['FR', 'DE'] },
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧', ui: 'en', langs: ['EN'] },
  { code: 'IE', name: 'Ireland', flag: '🇮🇪', ui: 'en', langs: ['EN'] },
  { code: 'US', name: 'United States', flag: '🇺🇸', ui: 'en', langs: ['EN', 'LAT'] },
  { code: 'AU', name: 'Australia', flag: '🇦🇺', ui: 'en', langs: ['EN'] },
  { code: 'DE', name: 'Deutschland', flag: '🇩🇪', ui: 'de', langs: ['DE'] },
  { code: 'AT', name: 'Österreich', flag: '🇦🇹', ui: 'de', langs: ['DE'] },
  { code: 'NL', name: 'Nederland', flag: '🇳🇱', ui: 'nl', langs: ['NL', 'EN'] },
  { code: 'ES', name: 'España', flag: '🇪🇸', ui: 'es', langs: ['ES'] },
  { code: 'MX', name: 'México', flag: '🇲🇽', ui: 'es', langs: ['LAT', 'ES'] },
  { code: 'AR', name: 'Argentina', flag: '🇦🇷', ui: 'es', langs: ['LAT', 'ES'] },
  { code: 'CO', name: 'Colombia', flag: '🇨🇴', ui: 'es', langs: ['LAT', 'ES'] },
  { code: 'IT', name: 'Italia', flag: '🇮🇹', ui: 'it', langs: ['IT'] },
  { code: 'PT', name: 'Portugal', flag: '🇵🇹', ui: 'pt', langs: ['PT', 'BR'] },
  { code: 'BR', name: 'Brasil', flag: '🇧🇷', ui: 'pt', langs: ['BR', 'PT'] },
  { code: 'PL', name: 'Polska', flag: '🇵🇱', ui: 'pl', langs: ['PL'] },
  { code: 'SE', name: 'Sverige', flag: '🇸🇪', ui: 'en', langs: ['SE', 'SC', 'EN'] },
  { code: 'DK', name: 'Danmark', flag: '🇩🇰', ui: 'en', langs: ['DK', 'SC', 'EN'] },
  { code: 'NO', name: 'Norge', flag: '🇳🇴', ui: 'en', langs: ['NO', 'SC', 'EN'] },
  { code: 'TR', name: 'Türkiye', flag: '🇹🇷', ui: 'tr', langs: ['TR'] },
  { code: 'MA', name: 'المغرب · Maroc', flag: '🇲🇦', ui: 'ar', langs: ['AR', 'FR'] },
  { code: 'DZ', name: 'الجزائر · Algérie', flag: '🇩🇿', ui: 'ar', langs: ['AR', 'FR'] },
  { code: 'TN', name: 'تونس · Tunisie', flag: '🇹🇳', ui: 'ar', langs: ['AR', 'FR'] },
  { code: 'EG', name: 'مصر', flag: '🇪🇬', ui: 'ar', langs: ['AR'] },
  { code: 'SA', name: 'السعودية', flag: '🇸🇦', ui: 'ar', langs: ['AR', 'EN'] },
  { code: 'AE', name: 'الإمارات', flag: '🇦🇪', ui: 'ar', langs: ['AR', 'EN', 'IN'] },
  { code: 'IN', name: 'भारत · India', flag: '🇮🇳', ui: 'en', langs: ['IN', 'EN', 'TM', 'TE', 'ML'] },
  { code: 'PK', name: 'پاکستان', flag: '🇵🇰', ui: 'en', langs: ['UR', 'IN', 'EN'] },
  { code: 'RU', name: 'Россия', flag: '🇷🇺', ui: 'en', langs: ['RU'] },
  { code: 'GR', name: 'Ελλάδα', flag: '🇬🇷', ui: 'en', langs: ['GR', 'EN'] },
  { code: 'RO', name: 'România', flag: '🇷🇴', ui: 'en', langs: ['RO', 'EN'] },
  { code: 'IR', name: 'ایران', flag: '🇮🇷', ui: 'en', langs: ['IR'] },
  { code: 'AL', name: 'Shqipëri', flag: '🇦🇱', ui: 'en', langs: ['AL', 'EN'] },
  { code: 'HR', name: 'Hrvatska · Srbija · BiH', flag: '🇭🇷', ui: 'en', langs: ['EX', 'EN'] },
  { code: 'JP', name: '日本', flag: '🇯🇵', ui: 'en', langs: ['JP', 'EN'] },
  { code: 'KR', name: '대한민국', flag: '🇰🇷', ui: 'en', langs: ['KR', 'EN'] },
]
export const countryOf = (code?: string) => COUNTRIES.find((c) => c.code === code)
