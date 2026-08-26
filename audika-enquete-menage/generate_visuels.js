/**
 * Génère les visuels du formulaire dans visuels/ : bandeau d'en-tête + une image par section.
 *
 * Les images sont dessinées en HTML/SVG puis capturées avec Chromium, donc tout se retouche
 * dans ce fichier (couleurs, libellés, icônes) et se régénère en une commande.
 *
 * Logo : si visuels/logo-audika.png existe, il est intégré au bandeau à la place du
 * mot-symbole typographique. Déposer le fichier officiel puis relancer le script.
 *
 * Usage : NODE_PATH=/opt/node22/lib/node_modules node generate_visuels.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HERE = __dirname;
const OUT = path.join(HERE, 'visuels');
const BRAND = '#0B3C5D';
const BRAND_LIGHT = '#14527D';
const ACCENT = '#38A3C9';

const logoPath = path.join(OUT, 'logo-audika.png');
const logo = fs.existsSync(logoPath)
  ? `<img src="data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}" class="logo-img">`
  : `<span class="logo-word">audika</span>`;

/* Icônes en trait, viewBox 24×24 — volontairement géométriques et sans remplissage. */
const ICONS = {
  centre: '<path d="M3 10v10h18V10"/><path d="M2 10l2.2-6h15.6L22 10"/><path d="M9.5 20v-6h5v6"/>',
  menage: '<path d="M8.6 10.4h6.2V20a1 1 0 01-1 1h-4.2a1 1 0 01-1-1z"/><path d="M10.4 10.4V7h2.6v3.4"/><path d="M13 8.3h2.6"/><path d="M17.2 6.1l2.2-1M17.2 8.3h2.2M17.2 10.5l2.2 1"/><path d="M8.6 14.2h6.2"/>',
  vitrerie: '<rect x="3.5" y="3.5" width="17" height="17" rx="1"/><path d="M12 3.5v17M3.5 12h17"/><path d="M6.6 6.6l2.6 2.6M15.2 15.2l2.4 2.4"/>',
  dechets: '<path d="M6 7.5l1 12.5h10l1-12.5"/><path d="M3.8 7.5h16.4"/><path d="M9.5 4.2h5v3.3h-5z"/><path d="M10.3 11v6M13.7 11v6"/>',
  desencombrement: '<rect x="2.8" y="13" width="8" height="8" rx="1"/><rect x="13.2" y="13" width="8" height="8" rx="1"/><rect x="8" y="3.4" width="8" height="8" rx="1"/><path d="M6.8 13v-1.6M17.2 13v-1.6"/>',
  verts: '<path d="M4.5 19.5C4.5 11.5 11 5 19.5 4.5c.5 8.5-6 15-15 15z"/><path d="M4.5 19.5c3-5.5 7.5-9 12.5-11"/>',
  prestataire: '<path d="M3.5 8.5h14l-3.4-3.4"/><path d="M20.5 15.5h-14l3.4 3.4"/>',
  process: '<path d="M3.5 8h17v3.2a2 2 0 000 3.6V18h-17v-3.2a2 2 0 000-3.6z"/><path d="M13 8v2M13 14v2"/><path d="M6.5 13h3.5"/>',
  synthese: '<path d="M4 20h16"/><path d="M7 20v-6.5M12 20V5.5M17 20v-9.5"/>',
};

const SECTIONS = [
  ['section-1-votre-centre', 'centre', 'Votre centre', "Pour rattacher vos réponses au bon site"],
  ['section-2-menage', 'menage', 'Le ménage', 'Nettoyage courant : sols, surfaces, sanitaires, poubelles'],
  ['section-3-vitrerie', 'vitrerie', 'La vitrerie', 'Vitrines, baies vitrées et portes vitrées'],
  ['section-4-dechets', 'dechets', "L'enlèvement des déchets", 'Conteneurs, sacs, cartons et tri'],
  ['section-5-desencombrement', 'desencombrement', 'Le désencombrement', 'Débarras et enlèvement des encombrants'],
  ['section-6-espaces-verts', 'verts', 'Les espaces verts', 'Tonte, taille, désherbage et abords du centre'],
  ['section-7-prestataire', 'prestataire', 'Changement de prestataire', "Ce qui a changé depuis moins d'un an"],
  ['section-8-process', 'process', 'Le process à retenir', 'Une demande, un signalement : un ticket Services Généraux'],
  ['section-9-synthese', 'synthese', 'Synthèse et remarques', 'Votre note globale et vos priorités'],
];

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Segoe UI",Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.banner{width:1500px;height:430px;position:relative;overflow:hidden;
 background:linear-gradient(115deg,${BRAND} 0%,${BRAND_LIGHT} 62%,#1B6архив 100%)}
.banner{background:linear-gradient(115deg,${BRAND} 0%,${BRAND_LIGHT} 62%,#1A6491 100%)}
.waves{position:absolute;right:-120px;top:50%;transform:translateY(-50%);opacity:.16}
.banner .inner{position:relative;padding:64px 80px;height:100%;display:flex;
 flex-direction:column;justify-content:center;gap:18px}
.logo-word{font-size:40px;font-weight:700;letter-spacing:.1em;color:#fff;display:inline-block}
.logo-img{height:56px;display:block}
.banner h1{font-size:56px;line-height:1.1;color:#fff;font-weight:600;max-width:880px}
.banner .sub{font-size:27px;color:#BFE0F0;font-weight:400}
.rule{width:96px;height:5px;background:${ACCENT};border-radius:3px}
.meta{font-size:20px;color:#9FCBE2;letter-spacing:.02em}

.sec{width:1200px;height:300px;display:flex;align-items:center;gap:44px;padding:0 66px;
 background:linear-gradient(100deg,#F2F7FB 0%,#E4EFF6 100%);border-left:14px solid ${BRAND}}
.badge{width:132px;height:132px;flex:0 0 auto;border-radius:50%;background:#fff;
 display:flex;align-items:center;justify-content:center;box-shadow:0 6px 22px rgba(11,60,93,.14)}
.sec .txt{min-width:0}
.sec h2{font-size:46px;color:${BRAND};font-weight:600;line-height:1.15;margin-bottom:14px}
.sec p{font-size:25px;color:#4A6273;line-height:1.35}
`;

const wave = (r, w) => `<circle cx="0" cy="0" r="${r}" fill="none" stroke="#fff" stroke-width="${w}"/>`;

const bannerHTML = `<div class="banner">
  <svg class="waves" width="760" height="760" viewBox="-380 -380 760 760">
    <g transform="translate(0,0)">${[120, 190, 260, 330].map(r => wave(r, 14)).join('')}</g>
  </svg>
  <div class="inner">
    ${logo}
    <div class="rule"></div>
    <h1>Enquête Propreté &amp; Services Généraux</h1>
    <div class="sub">2ᵉ édition — tous les centres Audika</div>
    <div class="meta">5 minutes · vos retours pilotent nos plans d'actions</div>
  </div>
</div>`;

const secHTML = (icon, title, sub) => `<div class="sec">
  <div class="badge">
    <svg width="76" height="76" viewBox="0 0 24 24" fill="none" stroke="${BRAND}"
         stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</svg>
  </div>
  <div class="txt"><h2>${title}</h2><p>${sub}</p></div>
</div>`;

const page_ = body => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
<body>${body}</body></html>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1520, height: 800 }, deviceScaleFactor: 1 });

  await page.setContent(page_(bannerHTML), { waitUntil: 'load' });
  await page.locator('.banner').screenshot({ path: path.join(OUT, 'banniere-formulaire.png') });
  console.log('visuels/banniere-formulaire.png');

  for (const [file, icon, title, sub] of SECTIONS) {
    await page.setContent(page_(secHTML(icon, title, sub)), { waitUntil: 'load' });
    await page.locator('.sec').screenshot({ path: path.join(OUT, `${file}.png`) });
    console.log(`visuels/${file}.png`);
  }
  await browser.close();
})();
