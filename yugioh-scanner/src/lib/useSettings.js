import { useCallback, useEffect, useMemo, useState } from 'react';

import { DEFAULTS, loadSettings, saveSettings, sensitivityOf } from './settings.js';

/**
 * Réglages persistants.
 *
 * L'option « animations » ne se contente pas d'être lue par les composants :
 * elle pose un attribut sur la racine du document, ce qui permet à une seule
 * règle CSS de neutraliser toutes les animations d'un coup, y compris celles
 * déclarées en `@keyframes` hors de React.
 */
export function useSettings() {
  const [settings, setSettings] = useState(() => loadSettings());

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    document.documentElement.dataset.motion = settings.animations ? 'on' : 'off';
  }, [settings.animations]);

  const update = useCallback((key, value) => {
    setSettings((current) => ({ ...current, [key]: value }));
  }, []);

  const reset = useCallback(() => setSettings({ ...DEFAULTS }), []);

  const sensitivity = useMemo(() => sensitivityOf(settings), [settings.sensitivity]);

  return { settings, update, reset, sensitivity };
}
