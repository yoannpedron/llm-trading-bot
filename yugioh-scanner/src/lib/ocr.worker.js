/**
 * Le moteur de lecture, dans son propre fil d'exécution.
 *
 * PP-OCRv6 tourne sur ONNX Runtime : WebGPU quand le navigateur l'offre
 * (Chrome et Edge sur Android et ordinateur), WebAssembly sinon. Une passe
 * prend de 200 à 400 ms sur ordinateur en WebAssembly ; sur la page, ce temps
 * gèlerait le viseur et le bouton de torche. Le moteur vit donc ici, et la
 * page ne fait que lui passer des images.
 *
 * Protocole, dans les deux sens :
 *
 *     → { type: 'init', base }              base : URL du dossier des modèles
 *     ← { type: 'progress', fraction }       téléchargement, dans [0, 1]
 *     ← { type: 'ready', provider, ms }      moteur prêt ; provider : webgpu | wasm
 *     ← { type: 'error', message }
 *     → { type: 'lire', id, bitmap }         ImageBitmap, transféré
 *     ← { type: 'lu', id, text, lines, ms }  lines : [{ text, confidence }]
 *     ← { type: 'echec', id, message }
 */

import * as ort from 'onnxruntime-web';
import { PaddleOcrService } from 'ppu-paddle-ocr/web';

import { chargerModeles } from './modeles.js';

let service = null;
let initialisation = null;

/** Le nom du fournisseur réellement retenu par ONNX Runtime, si on peut le lire. */
function fournisseur(instance) {
  const sessions = [instance?.detectionSession, instance?.recognitionSession];
  for (const session of sessions) {
    const noms = session?.handler?.sessionOptions?.executionProviders;
    if (Array.isArray(noms) && noms.length) {
      const premier = noms[0];
      return typeof premier === 'string' ? premier : premier?.name ?? 'wasm';
    }
  }
  return typeof navigator !== 'undefined' && navigator.gpu ? 'webgpu' : 'wasm';
}

async function initialiser(base) {
  // ONNX Runtime va chercher son propre WebAssembly à côté des modèles. Doit
  // être posé AVANT la première session ; la bibliothèque ne le remplit que
  // s'il est vide, et pointerait sinon vers jsDelivr.
  ort.env.wasm.wasmPaths = base;

  const debut = performance.now();
  const modeles = await chargerModeles(base, (fraction) => {
    self.postMessage({ type: 'progress', fraction });
  });

  const instance = new PaddleOcrService({
    model: modeles,
    // Deux lignes tout au plus dans la fenêtre de visée : inutile de regrouper
    // les boîtes, chaque ligne part telle quelle au reconnaisseur.
    recognition: { strategy: 'per-line' },
  });
  await instance.initialize();

  // Première inférence à vide : ONNX Runtime compile ses noyaux (WebGPU) ou
  // instancie ses modules (WebAssembly) au premier appel, ce qui coûtait
  // 600 ms à la première vraie lecture. Autant le payer ici, pendant que
  // l'utilisateur cadre encore.
  const chauffe = new OffscreenCanvas(320, 64);
  const contexte = chauffe.getContext('2d');
  contexte.fillStyle = '#c8c8c8';
  contexte.fillRect(0, 0, 320, 64);
  contexte.fillStyle = '#202020';
  contexte.font = '40px sans-serif';
  contexte.fillText('LOB-FR001', 12, 48);
  await instance.recognize(chauffe, { flatten: true }).catch(() => {});

  service = instance;
  self.postMessage({
    type: 'ready',
    provider: fournisseur(instance),
    ms: Math.round(performance.now() - debut),
  });
}

async function lire(id, bitmap) {
  try {
    if (!service) await initialisation;

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();

    const debut = performance.now();
    const resultat = await service.recognize(canvas, { flatten: true });
    const lines = (resultat.results ?? [])
      .map((ligne) => ({ text: String(ligne.text ?? ''), confidence: Number(ligne.confidence ?? 0) }))
      .filter((ligne) => ligne.text.trim());

    self.postMessage({
      type: 'lu',
      id,
      text: lines.map((ligne) => ligne.text).join('\n'),
      lines,
      ms: Math.round(performance.now() - debut),
    });
  } catch (cause) {
    self.postMessage({ type: 'echec', id, message: cause?.message ?? String(cause) });
  }
}

self.onmessage = (event) => {
  const message = event.data ?? {};
  if (message.type === 'init') {
    initialisation ??= initialiser(message.base).catch((cause) => {
      self.postMessage({ type: 'error', message: cause?.message ?? String(cause) });
      throw cause;
    });
    return;
  }
  if (message.type === 'lire') {
    lire(message.id, message.bitmap);
  }
};
