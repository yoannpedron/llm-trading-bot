import { useProfile, type UiLang } from './store/profile'

const T: Record<string, Partial<Record<UiLang, string>>> = {
  home: { fr: 'Accueil', en: 'Home', ar: 'الرئيسية', de: 'Start', es: 'Inicio', pl: 'Start', tr: 'Ana sayfa' },
  movies: { fr: 'Films', en: 'Movies', ar: 'أفلام', de: 'Filme', es: 'Películas', pl: 'Filmy', tr: 'Filmler' },
  series: { fr: 'Séries', en: 'Series', ar: 'مسلسلات', de: 'Serien', es: 'Series', pl: 'Seriale', tr: 'Diziler' },
  live: { fr: 'Live TV', en: 'Live TV', ar: 'بث مباشر', de: 'Live TV', es: 'TV en vivo', pl: 'TV na żywo', tr: 'Canlı TV' },
  mylist: { fr: 'Ma liste', en: 'My list', ar: 'قائمتي', de: 'Meine Liste', es: 'Mi lista', pl: 'Moja lista', tr: 'Listem' },
  search: { fr: 'Rechercher…', en: 'Search…', ar: 'بحث…', de: 'Suchen…', es: 'Buscar…', pl: 'Szukaj…', tr: 'Ara…' },
  play: { fr: 'Lecture', en: 'Play', ar: 'تشغيل', de: 'Abspielen', es: 'Reproducir', pl: 'Odtwórz', tr: 'Oynat' },
  info: { fr: 'Infos', en: 'Info', ar: 'معلومات', de: 'Infos', es: 'Info', pl: 'Info', tr: 'Bilgi' },
  profile: { fr: 'Profil', en: 'Profile', ar: 'الملف', de: 'Profil', es: 'Perfil', pl: 'Profil', tr: 'Profil' },
  top10movies: { fr: 'Top 10 films cette semaine', en: 'Top 10 movies this week', ar: 'أفضل 10 أفلام هذا الأسبوع', de: 'Top 10 Filme der Woche', es: 'Top 10 películas de la semana', pl: 'Top 10 filmów tygodnia', tr: 'Bu haftanın en iyi 10 filmi' },
  top10series: { fr: 'Top 10 séries cette semaine', en: 'Top 10 series this week', ar: 'أفضل 10 مسلسلات هذا الأسبوع', de: 'Top 10 Serien der Woche', es: 'Top 10 series de la semana', pl: 'Top 10 seriali tygodnia', tr: 'Bu haftanın en iyi 10 dizisi' },
  nowplaying: { fr: 'Dernières sorties cinéma disponibles', en: 'Latest cinema releases available', ar: 'أحدث إصدارات السينما المتاحة', de: 'Neue Kinofilme verfügbar', es: 'Últimos estrenos disponibles', pl: 'Najnowsze premiery kinowe', tr: 'Mevcut son vizyon filmleri' },
  fresh: { fr: 'Ajoutés cette semaine sur le serveur', en: 'Added this week on the server', ar: 'أضيفت هذا الأسبوع', de: 'Diese Woche hinzugefügt', es: 'Añadidos esta semana', pl: 'Dodane w tym tygodniu', tr: 'Bu hafta eklenenler' },
  fourk: { fr: 'Disponibles en 4K', en: 'Available in 4K', ar: 'متاح بجودة 4K', de: 'In 4K verfügbar', es: 'Disponibles en 4K', pl: 'Dostępne w 4K', tr: '4K olarak mevcut' },
  sagas: { fr: 'Sagas complètes sur le serveur', en: 'Complete sagas on the server', ar: 'سلاسل كاملة', de: 'Komplette Reihen', es: 'Sagas completas', pl: 'Kompletne serie', tr: 'Tam seriler' },
  masters: { fr: 'Chefs-d’œuvre', en: 'Masterpieces', ar: 'روائع', de: 'Meisterwerke', es: 'Obras maestras', pl: 'Arcydzieła', tr: 'Başyapıtlar' },
  gems: { fr: 'Pépites méconnues', en: 'Hidden gems', ar: 'كنوز خفية', de: 'Geheimtipps', es: 'Joyas ocultas', pl: 'Ukryte perełki', tr: 'Gizli hazineler' },
  onair: { fr: 'Nouveaux épisodes cette semaine', en: 'New episodes this week', ar: 'حلقات جديدة هذا الأسبوع', de: 'Neue Folgen diese Woche', es: 'Nuevos episodios esta semana', pl: 'Nowe odcinki w tym tygodniu', tr: 'Bu haftaki yeni bölümler' },
  inyourlang: { fr: 'Dans vos langues', en: 'In your languages', ar: 'بلغاتك', de: 'In deinen Sprachen', es: 'En tus idiomas', pl: 'W twoich językach', tr: 'Dillerinizde' },
  directedby: { fr: 'Réalisés par', en: 'Directed by', ar: 'من إخراج', de: 'Regie:', es: 'Dirigidas por', pl: 'W reżyserii', tr: 'Yönetmen:' },
}

export function t(key: string, lang: UiLang = useProfile.getState().uiLang): string {
  return T[key]?.[lang] ?? T[key]?.fr ?? key
}
export function useT() { const lang = useProfile((s) => s.uiLang); return (k: string) => t(k, lang) }
