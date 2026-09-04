import { useCallback, useEffect, useRef, useState } from 'react';

import { recognize, shutdown, warmUp } from './ocr.js';
import { extractSetCode, extractTitle } from './parse.js';
import { cropAndPreprocess, grabFrame } from './preprocess.js';
import { FrameWatcher, frameSignature } from './motion.js';
import { identifyCard } from './ygoprodeck.js';
import { ZONES, cardFrame, zoneRect } from './zones.js';

/** Cadence de la boucle de veille. Onze images par seconde suffisent largement
 *  pour détecter qu'une carte vient d'être posée, et coûtent une empreinte de
 *  384 octets à chaque tour — rien à voir avec un OCR. */
const LOOP_MS = 90;

/** Délai avant de retenter une carte que l'OCR n'a pas su lire. Sans lui, on
 *  s'acharnerait dix fois par seconde sur une carte floue ; avec lui, la
 *  reconnaissance repart d'elle-même dès que la mise au point s'améliore. */
const RETRY_MS = 850;

const CONSTRAINTS = (deviceId) => ({
  audio: false,
  video: deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    : {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
});

function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * Toute la mécanique du scan : caméra, veille, OCR, identification.
 *
 * Le composant qui l'utilise n'a plus qu'à brancher `videoRef` et afficher
 * l'état. Deux garde-fous portent la réactivité :
 *
 * - un jeton d'exécution (`tokenRef`) invalide le résultat d'un scan dès qu'un
 *   plus récent démarre, donc une carte retirée du cadre n'écrase jamais celle
 *   qui vient d'arriver ;
 * - l'ancienne carte reste affichée pendant la recherche de la nouvelle : la
 *   bascule se fait d'un bloc, sans écran vide entre les deux.
 */
export function useCardScanner({ active = true, autoScan = true, sensitivity } = {}) {
  const videoRef = useRef(null);
  const watcherRef = useRef(null);
  const streamRef = useRef(null);
  const busyRef = useRef(false);
  const tokenRef = useRef(0);
  const cooldownRef = useRef(0);
  const identifyRef = useRef(null);
  const signatureRef = useRef(null);

  const [deviceId, setDeviceId] = useState(null);
  const [devices, setDevices] = useState([]);
  const [cameraError, setCameraError] = useState(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [torch, setTorch] = useState({ available: false, on: false });

  const [modelProgress, setModelProgress] = useState(0);
  const [modelReady, setModelReady] = useState(false);

  const [frameState, setFrameState] = useState('idle');
  const [scanning, setScanning] = useState(false);
  const [reading, setReading] = useState({ title: '', setCode: null, rawTitle: '', rawCode: '' });
  const [crops, setCrops] = useState({ title: null, setCode: null });
  const [result, setResult] = useState(null);
  const [misses, setMisses] = useState(0);

  /* --- modèle OCR : on le chauffe pendant que l'utilisateur vise ---------- */

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

  /* --- caméra ------------------------------------------------------------ */

  useEffect(() => {
    let cancelled = false;
    let stream = null;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS(deviceId));
        if (cancelled) return stopStream(stream);

        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;

        video.srcObject = stream;
        await video.play().catch(() => {});
        if (cancelled) return;

        setCameraReady(true);
        setCameraError(null);

        // La lampe n'existe que sur les caméras arrière de téléphone.
        const track = stream.getVideoTracks()[0];
        const capabilities = track?.getCapabilities?.() ?? {};
        setTorch({ available: Boolean(capabilities.torch), on: false });

        // Les libellés ne sont lisibles qu'une fois l'autorisation accordée.
        const all = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) setDevices(all.filter((device) => device.kind === 'videoinput'));
      } catch (error) {
        if (!cancelled) {
          setCameraReady(false);
          setCameraError(
            error?.name === 'NotAllowedError'
              ? 'Accès à la caméra refusé. Autorisez-la dans les réglages du navigateur, puis rechargez.'
              : `Caméra indisponible : ${error?.message ?? 'raison inconnue'}`,
          );
        }
      }
    })();

    return () => {
      cancelled = true;
      stopStream(stream);
      streamRef.current = null;
    };
  }, [deviceId]);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torch.on;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      setTorch((current) => ({ ...current, on: next }));
    } catch {
      setTorch((current) => ({ ...current, available: false }));
    }
  }, [torch.on]);

  const switchCamera = useCallback(() => {
    if (devices.length < 2) return;
    const index = devices.findIndex((device) => device.deviceId === deviceId);
    setDeviceId(devices[(index + 1) % devices.length].deviceId);
    setCameraReady(false);
  }, [devices, deviceId]);

  /* --- un scan ----------------------------------------------------------- */

  const runScan = useCallback(async (signature) => {
    const video = videoRef.current;
    if (!video) return;

    busyRef.current = true;
    const token = (tokenRef.current += 1);
    setScanning(true);

    try {
      // On fige l'image : les deux zones doivent venir de la même prise, sinon
      // un titre et un code de deux cartes différentes pourraient se croiser.
      const still = grabFrame(video);
      const titleCrop = cropAndPreprocess(still, zoneRect(ZONES.title, still.width, still.height));
      const codeCrop = cropAndPreprocess(
        still,
        zoneRect(ZONES.setCode, still.width, still.height),
      );

      setCrops({
        title: titleCrop.canvas.toDataURL('image/png'),
        setCode: codeCrop.canvas.toDataURL('image/png'),
      });

      // Deux workers distincts : les deux zones sont lues en parallèle, donc le
      // scan coûte le temps de la plus lente et non la somme des deux.
      const [titleOcr, codeOcr] = await Promise.all([
        recognize('title', titleCrop.canvas),
        recognize('setCode', codeCrop.canvas),
      ]);
      if (token !== tokenRef.current) return;

      const setCode = extractSetCode(codeOcr.text);
      const title = extractTitle(titleOcr.text);
      setReading({ title, setCode, rawTitle: titleOcr.text.trim(), rawCode: codeOcr.text.trim() });

      if (!setCode && title.length < 4) {
        cooldownRef.current = Date.now() + RETRY_MS;
        setMisses((count) => count + 1);
        return;
      }

      identifyRef.current?.abort();
      const controller = new AbortController();
      identifyRef.current = controller;

      const found = await identifyCard({ setCode, title }, controller.signal);
      if (token !== tokenRef.current) return;

      if (found) {
        watcherRef.current?.accept(signature);
        setMisses(0);
        setResult({ ...found, setCode, readTitle: title, at: Date.now() });
      } else {
        cooldownRef.current = Date.now() + RETRY_MS;
        setMisses((count) => count + 1);
      }
    } catch (error) {
      if (error?.name !== 'AbortError') cooldownRef.current = Date.now() + RETRY_MS;
    } finally {
      if (token === tokenRef.current) setScanning(false);
      busyRef.current = false;
    }
  }, []);

  /* --- boucle de veille --------------------------------------------------- */

  useEffect(() => {
    // Onglet en arrière-plan : on coupe la veille. Le flux reste ouvert, donc
    // le retour est immédiat, mais plus une image n'est analysée -- inutile de
    // faire chauffer le téléphone pendant qu'on consulte l'historique.
    if (!cameraReady || !active) return undefined;

    watcherRef.current = new FrameWatcher(sensitivity);
    let timer = 0;
    let stopped = false;

    const tick = () => {
      const video = videoRef.current;
      if (!stopped && video && video.readyState >= 2 && video.videoWidth > 0) {
        const frame = cardFrame(video.videoWidth, video.videoHeight);
        const { signature, sharpness } = frameSignature(video, frame);
        const status = watcherRef.current.update(signature, sharpness);
        setFrameState(status.state);
        signatureRef.current = signature;

        if (
          autoScan &&
          status.shouldScan &&
          !busyRef.current &&
          Date.now() >= cooldownRef.current
        ) {
          runScan(signature);
        }
      }
      if (!stopped) timer = setTimeout(tick, LOOP_MS);
    };

    tick();

    return () => {
      stopped = true;
      clearTimeout(timer);
      identifyRef.current?.abort();
    };
  }, [cameraReady, active, autoScan, sensitivity, runScan]);

  /** Déclenche une lecture immédiate — le bouton du mode manuel. */
  const capture = useCallback(() => {
    if (busyRef.current || !signatureRef.current) return;
    cooldownRef.current = 0;
    runScan(signatureRef.current);
  }, [runScan]);

  /** Force un nouveau scan de la carte actuellement dans le cadre. */
  const rescan = useCallback(() => {
    cooldownRef.current = 0;
    setMisses(0);
    watcherRef.current?.reset();
  }, []);

  /** Efface le résultat et repart en visée. */
  const clear = useCallback(() => {
    tokenRef.current += 1;
    identifyRef.current?.abort();
    setResult(null);
    setReading({ title: '', setCode: null, rawTitle: '', rawCode: '' });
    setCrops({ title: null, setCode: null });
    rescan();
  }, [rescan]);

  return {
    videoRef,
    cameraReady,
    cameraError,
    devices,
    switchCamera,
    torch,
    toggleTorch,
    modelReady,
    modelProgress,
    frameState,
    scanning,
    reading,
    crops,
    result,
    misses,
    capture,
    rescan,
    clear,
  };
}
