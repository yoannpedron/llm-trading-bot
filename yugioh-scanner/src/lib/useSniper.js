import { useCallback, useEffect, useRef, useState } from 'react';

import { chime, vibrate } from './feedback.js';
import { recognize, shutdown, warmUp } from './ocr.js';
import { cropVariants, grabFrame } from './preprocess.js';
import { scanCode } from './scanApi.js';
import { reticleRect, toVideoRect } from './viewport.js';

/** Intervalle entre deux lectures. Une douchette de supermarché ne fait pas mieux. */
const SCAN_INTERVAL_MS = 320;

/** Zoom visé au démarrage : le code fait deux millimètres de haut sur la carte. */
const TARGET_ZOOM = 2.5;

/**
 * Variantes de binarisation essayées à chaque tour, dans l'ordre.
 * Otsu suffit sur une carte bien éclairée ; Sauvola sauve les reflets du vernis,
 * qui sont la première cause d'échec sur une inscription aussi petite.
 */
const VARIANTS = [0, 1];

/**
 * Le viseur.
 *
 * Le téléphone est braqué sur une seule inscription — le code d'extension — et
 * ne cherche rien d'autre. Deux garde-fous évitent les fausses alertes :
 *
 * - une correspondance **exacte ou régionale** est acceptée d'emblée : le code
 *   lu existe, il n'y a rien à confirmer ;
 * - une correspondance **approchée** doit sortir deux fois de suite. C'est ce
 *   qui empêche un reflet passager de figer l'écran sur une carte au hasard.
 */
export function useSniper() {
  const videoRef = useRef(null);
  const trackRef = useRef(null);
  const busyRef = useRef(false);
  const pendingRef = useRef(null);
  const abortRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);
  const [torch, setTorch] = useState({ available: false, on: false });
  const [zoom, setZoom] = useState({ available: false, value: 1, min: 1, max: 1, step: 0.1 });

  const [modelReady, setModelReady] = useState(false);
  const [modelProgress, setModelProgress] = useState(0);

  const [reading, setReading] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [failure, setFailure] = useState(null);
  const [crop, setCrop] = useState(null);
  const [result, setResult] = useState(null);
  const [frozenFrame, setFrozenFrame] = useState(null);

  /* --- modèle OCR : chauffé pendant que l'utilisateur vise ---------------- */

  useEffect(() => {
    let alive = true;
    warmUp((progress) => alive && setModelProgress(progress))
      .then(() => alive && setModelReady(true))
      .catch(() => alive && setModelReady(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => () => void shutdown(), []);

  /* --- caméra ------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    let stream = null;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        if (cancelled) return stream.getTracks().forEach((track) => track.stop());

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play().catch(() => {});
        if (cancelled) return;

        const track = stream.getVideoTracks()[0];
        trackRef.current = track;
        const capabilities = track?.getCapabilities?.() ?? {};

        setTorch({ available: Boolean(capabilities.torch), on: false });

        if (capabilities.zoom) {
          const { min = 1, max = 1, step = 0.1 } = capabilities.zoom;
          // Les unités varient d'un appareil à l'autre : certains rendent un
          // multiplicateur (1 à 8), d'autres une échelle arbitraire (100 à 800).
          // On vise donc un multiplicateur quand la borne basse vaut 1, et un
          // quart de la course sinon.
          const target = min <= 1 ? Math.min(max, TARGET_ZOOM) : min + (max - min) * 0.25;
          await track.applyConstraints({ advanced: [{ zoom: target }] }).catch(() => {});
          setZoom({ available: max > min, value: target, min, max, step: step || 0.1 });
        }

        setReady(true);
        setError(null);
      } catch (cause) {
        if (cancelled) return;
        setReady(false);
        setError(
          cause?.name === 'NotAllowedError'
            ? 'Accès à la caméra refusé. Autorisez-la dans les réglages du navigateur, puis rechargez.'
            : `Caméra indisponible : ${cause?.message ?? 'raison inconnue'}`,
        );
      }
    })();

    return () => {
      cancelled = true;
      stream?.getTracks().forEach((track) => track.stop());
      trackRef.current = null;
    };
  }, []);

  const toggleTorch = useCallback(async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setTorch((current) => ({ ...current, on: next }));
    } catch {
      setTorch((current) => ({ ...current, available: false }));
    }
  }, [torch.on]);

  const applyZoom = useCallback(async (value) => {
    const track = trackRef.current;
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ zoom: value }] });
      setZoom((current) => ({ ...current, value }));
    } catch {
      setZoom((current) => ({ ...current, available: false }));
    }
  }, []);

  /* --- boucle de lecture --------------------------------------------------- */

  const readOnce = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;

    busyRef.current = true;
    try {
      const container = { width: video.clientWidth, height: video.clientHeight };
      const rect = toVideoRect(
        reticleRect(container),
        { width: video.videoWidth, height: video.videoHeight },
        container,
      );

      const still = grabFrame(video);
      const variants = cropVariants(still, rect, { scale: 2 });

      for (const index of VARIANTS) {
        const variant = variants[index];
        if (!variant) continue;

        // La vignette de ce qui part au moteur : sans elle, un échec de lecture
        // ne dit pas si le problème vient du cadrage, de la lumière ou du seuil.
        setCrop(variant.canvas.toDataURL('image/png'));

        const { text, confidence } = await recognize('setCode', variant.canvas);
        const trimmed = text.trim();
        // On affiche aussi les lectures vides : « rien » et « quelque chose
        // d'illisible » n'appellent pas le même geste de la part de l'utilisateur.
        setReading(trimmed || `rien lu (${variant.label}, conf. ${Math.round(confidence)})`);
        if (!trimmed) continue;

        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        // Une panne de résolution — index absent, API injoignable — doit se voir.
        // Avalée, elle se manifeste seulement par un viseur qui ne verrouille
        // jamais, ce qui n'oriente vers rien.
        const resolved = await scanCode(trimmed, controller.signal).catch((cause) => {
          if (cause.name !== 'AbortError') setFailure(cause.message);
          return null;
        });
        if (!resolved) continue;
        setFailure(null);
        if (resolved.status === 'no_code' || resolved.status === 'no_match') continue;

        // Un code exact ou régional existe : rien à confirmer. Un approché doit
        // sortir deux fois — un reflet ne se reproduit pas à l'identique.
        const certain = resolved.method === 'exact' || resolved.method === 'region';
        if (certain || pendingRef.current === resolved.matchedCode) {
          setFrozenFrame(still.toDataURL('image/jpeg', 0.9));
          setResult(resolved);
          pendingRef.current = null;
          // Le bip de la douchette : on sait que c'est lu sans quitter la carte
          // des yeux. Les deux échouent en silence là où ils ne sont pas offerts.
          chime();
          vibrate();
          return;
        }

        pendingRef.current = resolved.matchedCode;
        return;
      }

      setAttempts((count) => count + 1);
    } catch (cause) {
      // Sans ce filet, une exception ici remonte dans la boucle et l'arrête
      // définitivement — le viseur reste affiché mais ne lit plus rien, sans
      // que rien ne l'indique.
      if (cause?.name !== 'AbortError') setFailure(cause?.message ?? String(cause));
    } finally {
      busyRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!ready || result) return undefined;

    let stopped = false;
    let timer = 0;

    const tick = async () => {
      if (!stopped && !busyRef.current) await readOnce();
      if (!stopped) timer = setTimeout(tick, SCAN_INTERVAL_MS);
    };

    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [ready, result, readOnce]);

  /** Relance la visée : l'image se dégèle et la boucle repart. */
  const rescan = useCallback(() => {
    abortRef.current?.abort();
    pendingRef.current = null;
    setResult(null);
    setFrozenFrame(null);
    setReading('');
    setAttempts(0);
    setFailure(null);
  }, []);

  return {
    videoRef,
    ready,
    error,
    torch,
    toggleTorch,
    zoom,
    applyZoom,
    modelReady,
    modelProgress,
    reading,
    attempts,
    failure,
    crop,
    result,
    frozenFrame,
    rescan,
  };
}
