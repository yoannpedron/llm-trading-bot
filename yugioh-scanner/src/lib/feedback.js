/**
 * Retours sensoriels à l'identification.
 *
 * Rien n'est préchargé : le contexte audio n'est créé qu'au premier bip, car
 * un contexte ouvert avant toute interaction est suspendu par le navigateur et
 * resterait muet. Chaque appel est entouré d'un `try` — un appareil sans audio
 * ni vibreur ne doit jamais faire tomber le scan.
 */

let audio = null;

/** Petit accord montant : deux notes courtes, discrètes. */
export function chime() {
  try {
    audio ??= new (window.AudioContext ?? window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();

    [
      { frequency: 740, at: 0 },
      { frequency: 1108, at: 0.09 },
    ].forEach(({ frequency, at }) => {
      const start = audio.currentTime + at;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();

      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.07, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);

      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.18);
    });
  } catch {
    // Audio indisponible : on continue sans.
  }
}

export function vibrate(pattern = [14, 38, 22]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Pas de vibreur : sans conséquence.
  }
}
