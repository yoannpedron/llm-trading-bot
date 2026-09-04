/**
 * Saisie manuelle du code, de bout en bout dans le navigateur.
 *
 * Deux parcours, qui n'ont pas les mêmes pièges :
 *
 *  - **avec caméra** : le formulaire s'ouvre par un bouton, et la boucle de
 *    lecture doit s'arrêter pendant la frappe. Sans cela elle verrouille sur
 *    la carte visée et démonte le champ au milieu d'un mot — c'est ce que ce
 *    script a trouvé la première fois ;
 *  - **sans caméra** : le formulaire est le seul chemin, il doit être ouvert
 *    d'office.
 *
 *     SP=/tmp/ygo node scripts/harness/manual-entry.mjs
 *
 * Suppose l'application bâtie et servie sur 127.0.0.1:4173 — voir
 * « Test navigateur hors ligne » dans scripts/README.md.
 */
import { chromium, devices } from 'playwright';

const SP = process.env.SP ?? '/tmp';
const URL = process.env.URL ?? 'http://127.0.0.1:4173/';
const CHROMIUM = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// Les erreurs de réseau sont attendues hors ligne : les visuels des cartes
// viennent de YGOPRODeck. Elles ne disent rien de l'application.
const EXTERNAL = /ygoprodeck|fonts\.(googleapis|gstatic)|ERR_|net::|Failed to load resource/i;

async function parcours({ nom, camera }) {
  const args = ['--use-fake-ui-for-media-stream'];
  if (camera) {
    args.push(
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${SP}/sniper.mjpeg`,
      '--autoplay-policy=no-user-gesture-required',
    );
  }

  const browser = await chromium.launch({ executablePath: CHROMIUM, args });
  const context = await browser.newContext({
    ...devices['iPhone 13'],
    permissions: camera ? ['camera'] : [],
  });
  const page = await context.newPage();

  const erreurs = [];
  page.on('pageerror', (cause) => !EXTERNAL.test(cause.message) && erreurs.push(cause.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !EXTERNAL.test(message.text())) erreurs.push(message.text());
  });

  const dit = (texte) => console.log(`  ${nom.padEnd(12)} ${texte}`);

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  const bouton = page.getByRole('button', { name: /saisir le code/i });
  const ouvertDOffice = (await bouton.count()) === 0;
  if (!ouvertDOffice) await bouton.click();
  dit(`formulaire ${ouvertDOffice ? 'ouvert d’office' : 'ouvert au bouton'}`);

  const champ = page.getByLabel('Code d’extension');
  await champ.waitFor({ timeout: 10000 });

  // Frappe caractère par caractère : c'est ainsi qu'on démasque une boucle de
  // lecture laissée en marche, qui démonte le champ entre deux touches.
  await champ.pressSequentially('lob-fr0', { delay: 90 });
  await page.waitForTimeout(2500);

  const saisi = await champ.inputValue();
  if (saisi !== 'LOB-FR0') throw new Error(`champ altéré pendant la frappe : « ${saisi} »`);
  dit(`champ intact après la frappe (« ${saisi} », mis en majuscules)`);

  const propositions = await page.locator('form ul li button').allInnerTexts();
  dit(`propositions : ${JSON.stringify(propositions.map((t) => t.split('\n')[0]))}`);
  if (propositions.length === 0) throw new Error('aucune proposition');
  if (!propositions[0].includes('-FR')) throw new Error('la région tapée n’est pas conservée');

  await page.screenshot({ path: `${SP}/manual-${nom}-saisie.png` });

  await page.locator('form ul li button').first().click();
  await page.waitForSelector('.ygo-card', { timeout: 20000 });
  await page.waitForTimeout(600);

  const code = (await page.locator('section p.font-mono').first().innerText()).trim();
  const carte = await page.locator('section h2').first().innerText();
  const raretes = await page.getByRole('button', { name: /rare|common|secret/i }).count();
  const valider = await page.getByRole('button', { name: /^Valider$/ }).count();
  dit(`résultat : ${code} « ${carte} » — ${raretes} rareté(s), ${valider} bouton Valider`);
  await page.screenshot({ path: `${SP}/manual-${nom}-resultat.png` });

  // Enchaînement : valider, puis retour AU FORMULAIRE et non au viseur. Qui
  // saisit un code en saisit dix ; repasser par le bouton à chaque carte
  // rendrait la saisie manuelle inutilisable pour une pile de cartes.
  await page.getByRole('button', { name: /^Valider$/ }).click();
  await page.waitForTimeout(400);
  const collection = await page.getByRole('button', { name: /^Collection/ }).innerText();
  dit(`collection : « ${collection.replace(/\s+/g, ' ')} »`);
  if (!/\d/.test(collection)) throw new Error('la carte validée n’apparaît pas dans la collection');

  await page.getByRole('button', { name: /carte suivante/i }).click();
  await page.waitForTimeout(1200);

  const champDeNouveau = page.getByLabel('Code d’extension');
  if ((await champDeNouveau.count()) === 0) {
    throw new Error('après validation, on retombe sur le viseur au lieu du formulaire');
  }
  if ((await champDeNouveau.inputValue()) !== '') {
    throw new Error('le champ garde le code précédent');
  }
  dit('après validation : formulaire rouvert, champ vide');

  // Et le viseur reste joignable depuis le formulaire.
  const retour = page.getByRole('button', { name: /revenir au viseur/i });
  if (camera) {
    if ((await retour.count()) === 0) throw new Error('impossible de revenir au viseur');
    await retour.click();
    await page.waitForTimeout(800);
    dit('retour au viseur possible');
  }

  dit(erreurs.length ? `ERREURS : ${erreurs[0]}` : 'aucune erreur console');
  await browser.close();
  return erreurs.length === 0;
}

console.log('Saisie manuelle du code\n');
const resultats = [];
for (const cas of [
  { nom: 'avec-camera', camera: true },
  { nom: 'sans-camera', camera: false },
]) {
  try {
    resultats.push(await parcours(cas));
  } catch (cause) {
    console.log(`  ${cas.nom.padEnd(12)} ÉCHEC : ${cause.message}`);
    resultats.push(false);
  }
}
console.log(`\n${resultats.every(Boolean) ? 'les deux parcours aboutissent' : 'AU MOINS UN PARCOURS ÉCHOUE'}`);
process.exitCode = resultats.every(Boolean) ? 0 : 1;
