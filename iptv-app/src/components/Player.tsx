import { useCallback, useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { usePlayerPrefs } from '../store/playerPrefs'

interface Props { src: string; title: string; autoPlay?: boolean; startAt?: number; onProgress?: (t: number, d: number) => void; onEnded?: () => void; onError?: () => void; muted?: boolean; live?: boolean }
interface Track { id: number; label: string; lang?: string }
type Menu = 'none' | 'settings' | 'audio' | 'subs' | 'speed' | 'quality' | 'subsize'

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
const fmt = (s: number) => { if (!isFinite(s) || s < 0) s = 0; const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60); return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(x).padStart(2, '0') }
const langName = (code?: string) => { if (!code) return ''; try { return new Intl.DisplayNames([navigator.language], { type: 'language' }).of(code.slice(0, 2)) ?? code } catch { return code } }

/** SRT → WebVTT so any downloaded subtitle file can be loaded into a <track>. */
function srtToVtt(txt: string): string {
  return 'WEBVTT\n\n' + txt.replace(/\r/g, '').replace(/^﻿/, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2').replace(/^\d+\n(?=\d{2}:)/gm, '')
}

/**
 * Full player: custom controls, audio tracks and subtitles (HLS via hls.js, embedded tracks for
 * progressive files, external SRT/VTT files), playback speed, quality levels, subtitle size and delay,
 * fullscreen, picture-in-picture, keyboard shortcuts. Preferences persist across sessions.
 */
export default function Player({ src, title, autoPlay = true, startAt, onProgress, onEnded, onError, muted, live }: Props) {
  const ref = useRef<HTMLVideoElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const hlsRef = useRef<Hls>(null)
  const prefs = usePlayerPrefs()
  const [error, setError] = useState<string>()
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0), [d, setD] = useState(0), [buf, setBuf] = useState(0)
  const [vol, setVol] = useState(prefs.volume), [isMuted, setMuted] = useState(!!muted || prefs.muted)
  const [speed, setSpeed] = useState(prefs.speed)
  const [audio, setAudio] = useState<Track[]>([]), [audioId, setAudioId] = useState(-1)
  const [subs, setSubs] = useState<Track[]>([]), [subId, setSubId] = useState(-1)
  const [levels, setLevels] = useState<{ id: number; label: string }[]>([]), [level, setLevel] = useState(-1)
  const [menu, setMenu] = useState<Menu>('none')
  const [shown, setShown] = useState(true)
  const [fs, setFs] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(null)
  const extTrack = useRef<HTMLTrackElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  /* ---- source ---- */
  useEffect(() => {
    const video = ref.current
    if (!video) return
    setError(undefined); setAudio([]); setSubs([]); setLevels([]); setLevel(-1); setAudioId(-1); setSubId(-1)
    const isHls = /\.m3u8(\?|#|$)/.test(src) || src.endsWith('#.m3u8')
    let hls: Hls | undefined
    if (isHls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: !!live, backBufferLength: live ? 30 : 90, capLevelToPlayerSize: true })
      hlsRef.current = hls
      hls.loadSource(src); hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setLevels(hls!.levels.map((l, i) => ({ id: i, label: l.height ? `${l.height}p${l.bitrate ? ' · ' + Math.round(l.bitrate / 1000) + ' kb/s' : ''}` : `${Math.round(l.bitrate / 1000)} kb/s` })))
        setAudio(hls!.audioTracks.map((a, i) => ({ id: i, label: a.name || langName(a.lang) || `Piste ${i + 1}`, lang: a.lang })))
        setSubs(hls!.subtitleTracks.map((s, i) => ({ id: i, label: s.name || langName(s.lang) || `Sous-titres ${i + 1}`, lang: s.lang })))
        // preferred languages from the profile / last choice
        const pa = hls!.audioTracks.findIndex((a) => a.lang && prefs.audioLang && a.lang.startsWith(prefs.audioLang)); if (pa >= 0) hls!.audioTrack = pa
        const ps = prefs.subLang ? hls!.subtitleTracks.findIndex((s) => s.lang && s.lang.startsWith(prefs.subLang!)) : -1; hls!.subtitleTrack = ps
      })
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_, e) => setAudioId(e.id))
      hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (_, e) => setSubId(e.id))
      hls.on(Hls.Events.LEVEL_SWITCHED, (_, e) => { if (hls!.autoLevelEnabled) setLevel(-1); else setLevel(e.level) })
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && data.details !== Hls.ErrorDetails.MANIFEST_LOAD_ERROR) { hls!.startLoad(); return }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls!.recoverMediaError(); return }
        setError(`Flux indisponible (${data.details})`); onError?.()
      })
    } else {
      video.src = src
    }
    const onErr = () => { setError('Lecture impossible : format non supporté par le navigateur ou flux hors ligne'); onError?.() }
    let last = 0
    const onTime = () => { setT(video.currentTime); if (!onProgress || !video.duration || !isFinite(video.duration)) return; const n = Date.now(); if (n - last > 5000) { last = n; onProgress(video.currentTime, video.duration) } }
    const onMeta = () => {
      setD(video.duration)
      if (startAt && startAt > 5 && isFinite(video.duration)) video.currentTime = startAt
      // embedded tracks (mkv / mp4 in browsers that expose them)
      const at = (video as unknown as { audioTracks?: { length: number; [i: number]: { label: string; language: string; enabled: boolean } } }).audioTracks
      if (at && at.length > 1 && !hls) { const list: Track[] = []; for (let i = 0; i < at.length; i++) list.push({ id: i, label: at[i].label || langName(at[i].language) || `Piste ${i + 1}`, lang: at[i].language }); setAudio(list); for (let i = 0; i < at.length; i++) if (at[i].enabled) setAudioId(i) }
      if (!hls) refreshTextTracks()
    }
    const refreshTextTracks = () => { const tt = video.textTracks; const list: Track[] = []; for (let i = 0; i < tt.length; i++) { if (tt[i].kind === 'subtitles' || tt[i].kind === 'captions') list.push({ id: i, label: tt[i].label || langName(tt[i].language) || `Sous-titres ${i + 1}`, lang: tt[i].language }) } setSubs(list) }
    const onProg = () => { try { const b = video.buffered; if (b.length) setBuf(b.end(b.length - 1)) } catch { /* ignore */ } }
    const onPlay = () => setPlaying(true), onPause = () => setPlaying(false), onEnd = () => onEnded?.()
    const onWait = () => setWaiting(true), onCan = () => setWaiting(false)
    video.addEventListener('error', onErr); video.addEventListener('timeupdate', onTime); video.addEventListener('loadedmetadata', onMeta); video.addEventListener('ended', onEnd)
    video.addEventListener('progress', onProg); video.addEventListener('play', onPlay); video.addEventListener('pause', onPause); video.addEventListener('waiting', onWait); video.addEventListener('playing', onCan); video.addEventListener('durationchange', () => setD(video.duration))
    video.textTracks.addEventListener?.('addtrack', refreshTextTracks)
    video.playbackRate = prefs.speed; video.volume = prefs.volume; video.muted = !!muted || prefs.muted
    if (autoPlay) video.play().catch(() => undefined)
    return () => {
      hls?.destroy(); hlsRef.current = null
      video.removeEventListener('error', onErr); video.removeEventListener('timeupdate', onTime); video.removeEventListener('loadedmetadata', onMeta); video.removeEventListener('ended', onEnd)
      video.removeEventListener('progress', onProg); video.removeEventListener('play', onPlay); video.removeEventListener('pause', onPause); video.removeEventListener('waiting', onWait); video.removeEventListener('playing', onCan)
      video.textTracks.removeEventListener?.('addtrack', refreshTextTracks)
      video.removeAttribute('src'); video.load()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, autoPlay, startAt, onProgress, onEnded, onError, live])

  /* ---- subtitle size is CSS; cues move up while the control bar is visible so they never overlap it ---- */
  useEffect(() => { box.current?.style.setProperty('--cue-size', `${prefs.subSize}%`) }, [prefs.subSize])
  useEffect(() => {
    const v = ref.current; if (!v) return
    const lift = shown || !playing
    const apply = () => { const tt = v.textTracks; for (let i = 0; i < tt.length; i++) { const cues = tt[i].cues; if (!cues) continue; for (let c = 0; c < cues.length; c++) { const cue = cues[c] as VTTCue; if ('line' in cue) { cue.snapToLines = true; cue.line = lift ? -4 : -1 } } } }
    apply(); const id = setTimeout(apply, 300); return () => clearTimeout(id)
  }, [shown, playing, subId, subs.length])

  /* ---- actions ---- */
  const video = () => ref.current!
  const toggle = useCallback(() => { const v = video(); if (v.paused) v.play().catch(() => undefined); else v.pause() }, [])
  const seek = (to: number) => { const v = video(); if (isFinite(v.duration)) v.currentTime = Math.max(0, Math.min(v.duration, to)) }
  const setVolume = (x: number) => { const v = video(); v.volume = x; v.muted = x === 0; setVol(x); setMuted(x === 0); prefs.set({ volume: x, muted: x === 0 }) }
  const toggleMute = () => { const v = video(); v.muted = !v.muted; setMuted(v.muted); prefs.set({ muted: v.muted }) }
  const pickSpeed = (s: number) => { video().playbackRate = s; setSpeed(s); prefs.set({ speed: s }); setMenu('none') }
  const pickAudio = (id: number) => {
    const h = hlsRef.current
    if (h) { h.audioTrack = id; prefs.set({ audioLang: h.audioTracks[id]?.lang }) }
    else { const at = (video() as unknown as { audioTracks?: { length: number; [i: number]: { enabled: boolean; language: string } } }).audioTracks; if (at) { for (let i = 0; i < at.length; i++) at[i].enabled = i === id; prefs.set({ audioLang: at[id]?.language }) } }
    setAudioId(id); setMenu('none')
  }
  const pickSub = (id: number) => {
    const h = hlsRef.current
    if (h) { h.subtitleTrack = id; prefs.set({ subLang: id < 0 ? undefined : h.subtitleTracks[id]?.lang }) }
    const tt = video().textTracks; for (let i = 0; i < tt.length; i++) tt[i].mode = i === id && !h ? 'showing' : h ? tt[i].mode : 'disabled'
    if (!h) prefs.set({ subLang: id < 0 ? undefined : tt[id]?.language })
    setSubId(id); setMenu('none')
  }
  const pickLevel = (id: number) => { const h = hlsRef.current; if (h) { h.currentLevel = id; setLevel(id) } setMenu('none') }
  const loadSubFile = async (f: File) => {
    const txt = await f.text()
    const vtt = /^WEBVTT/.test(txt.trim()) ? txt : srtToVtt(txt)
    const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }))
    const v = video()
    let tr = extTrack.current
    if (!tr) { tr = document.createElement('track'); tr.kind = 'subtitles'; tr.label = f.name.replace(/\.(srt|vtt)$/i, ''); tr.srclang = 'xx'; v.appendChild(tr); extTrack.current = tr } else tr.label = f.name
    tr.src = url; tr.default = true
    setTimeout(() => { const tt = v.textTracks; for (let i = 0; i < tt.length; i++) { const on = tt[i].label === tr!.label; tt[i].mode = on ? 'showing' : 'disabled'; if (on) setSubId(i) } setSubs((s) => s.some((x) => x.label === tr!.label) ? s : [...s, { id: tt.length - 1, label: tr!.label }]) }, 50)
    setMenu('none')
  }
  const applySubDelay = (ms: number) => {
    prefs.set({ subDelay: ms })
    const tt = video().textTracks
    for (let i = 0; i < tt.length; i++) { const cues = tt[i].cues; if (!cues) continue; const shift = (ms - lastDelay.current) / 1000; for (let c = 0; c < cues.length; c++) { cues[c].startTime += shift; cues[c].endTime += shift } }
    lastDelay.current = ms
  }
  const lastDelay = useRef(0)
  const toggleFs = () => { const el = box.current!; if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined); else el.requestFullscreen?.().catch(() => undefined) }
  const pip = () => { const v = video() as HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> }; if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => undefined); else v.requestPictureInPicture?.().catch(() => undefined) }
  useEffect(() => { const f = () => setFs(!!document.fullscreenElement); document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f) }, [])

  /* ---- controls visibility ---- */
  const poke = useCallback(() => { setShown(true); if (hideTimer.current) clearTimeout(hideTimer.current); hideTimer.current = setTimeout(() => { if (menu === 'none') setShown(false) }, 2800) }, [menu])
  useEffect(() => { poke(); return () => { if (hideTimer.current) clearTimeout(hideTimer.current) } }, [poke, playing])

  /* ---- keyboard ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      const v = ref.current; if (!v) return
      const k = e.key.toLowerCase()
      if (k === ' ' || k === 'k') { e.preventDefault(); toggle() }
      else if (k === 'arrowright') { seek(v.currentTime + (e.shiftKey ? 60 : 10)); poke() }
      else if (k === 'arrowleft') { seek(v.currentTime - (e.shiftKey ? 60 : 10)); poke() }
      else if (k === 'arrowup') { e.preventDefault(); setVolume(Math.min(1, v.volume + 0.05)); poke() }
      else if (k === 'arrowdown') { e.preventDefault(); setVolume(Math.max(0, v.volume - 0.05)); poke() }
      else if (k === 'm') toggleMute()
      else if (k === 'f') toggleFs()
      else if (k === 'p') pip()
      else if (k === 'c') pickSub(subId >= 0 ? -1 : 0)
      else if (k === 'a' && audio.length > 1) pickAudio((audioId + 1) % audio.length)
      else if (k === '>' || k === '.') pickSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)])
      else if (k === '<' || k === ',') pickSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)])
      else if (/^[0-9]$/.test(k) && isFinite(v.duration)) seek(v.duration * (+k / 10))
      else if (k === 'escape') setMenu('none')
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toggle, poke, subId, audio.length, audioId, speed])

  const isLive = live || !isFinite(d) || d === Infinity
  const pct = d && isFinite(d) ? (t / d) * 100 : 0
  const bufPct = d && isFinite(d) ? (buf / d) * 100 : 0
  const item = (label: string, on: boolean, onClick: () => void, sub?: string) => (
    <button key={label + sub} onClick={onClick} className={`flex w-full items-center justify-between gap-6 px-3.5 py-2 text-left text-[13px] hover:bg-white/10 ${on ? 'text-white' : 'text-white/75'}`}>
      <span>{label}{sub && <span className="ml-2 text-[11px] text-white/40">{sub}</span>}</span>{on && <span className="text-amber-400">✓</span>}
    </button>
  )
  const back = (title: string) => <button onClick={() => setMenu('settings')} className="flex w-full items-center gap-2 border-b border-white/10 px-3.5 py-2 text-left text-[13px] font-semibold">‹ {title}</button>

  return (
    <div ref={box} onMouseMove={poke} onClick={() => { if (menu !== 'none') setMenu('none') }} className={`player group relative aspect-video w-full overflow-hidden rounded-xl bg-black shadow-2xl ${shown || !playing ? '' : 'cursor-none'}`} style={{ ['--cue-size' as string]: `${prefs.subSize}%` }}>
      <video ref={ref} playsInline muted={isMuted} className="h-full w-full" title={title} onClick={toggle} onDoubleClick={toggleFs} />
      {waiting && !error && <div className="pointer-events-none absolute inset-0 grid place-items-center"><div className="h-10 w-10 animate-spin rounded-full border-2 border-white/20 border-t-white" /></div>}
      {error && <div className="absolute inset-x-0 bottom-20 mx-auto w-fit rounded bg-red-600/90 px-3 py-1 text-sm">{error}</div>}

      {/* controls */}
      <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent px-4 pb-3 pt-10 transition-opacity duration-300 ${shown || !playing ? 'opacity-100' : 'opacity-0'}`} onClick={(e) => e.stopPropagation()}>
        {/* seek bar */}
        {!isLive && (
          <div className="group/seek relative mb-2 h-1.5 w-full cursor-pointer rounded-full bg-white/20" onClick={(e) => { const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * d) }}>
            <div className="absolute inset-y-0 left-0 rounded-full bg-white/30" style={{ width: `${bufPct}%` }} />
            <div className="absolute inset-y-0 left-0 rounded-full bg-red-500" style={{ width: `${pct}%` }} />
            <div className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500 opacity-0 transition group-hover/seek:opacity-100" style={{ left: `${pct}%` }} />
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <Btn onClick={toggle} label={playing ? 'Pause' : 'Lecture'}>{playing ? <I d="M6 4h4v16H6zM14 4h4v16h-4z" /> : <I d="M7 4l13 8-13 8z" />}</Btn>
          {!isLive && <Btn onClick={() => seek(t - 10)} label="-10 s"><I d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z" /></Btn>}
          {!isLive && <Btn onClick={() => seek(t + 10)} label="+10 s"><I d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" /></Btn>}
          <div className="group/vol flex items-center">
            <Btn onClick={toggleMute} label={isMuted ? 'Son' : 'Muet'}>{isMuted || vol === 0 ? <I d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" /> : <I d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />}</Btn>
            <input type="range" min={0} max={1} step={0.02} value={isMuted ? 0 : vol} onChange={(e) => setVolume(+e.target.value)} aria-label="Volume" className="w-0 accent-white opacity-0 transition-all group-hover/vol:w-20 group-hover/vol:opacity-100" />
          </div>
          <span className="ml-1 text-[12.5px] tabular-nums text-white/85">{isLive ? <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />DIRECT</span> : `${fmt(t)} / ${fmt(d)}`}</span>
          <span className="ml-3 hidden truncate text-[12.5px] text-white/60 md:inline">{title}</span>
          <div className="ml-auto flex items-center gap-1.5">
            {subs.length > 0 && <Btn onClick={() => setMenu(menu === 'subs' ? 'none' : 'subs')} label="Sous-titres" active={subId >= 0}><I d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z" /></Btn>}
            {audio.length > 1 && <Btn onClick={() => setMenu(menu === 'audio' ? 'none' : 'audio')} label="Audio"><I d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z" /></Btn>}
            {speed !== 1 && <button onClick={() => setMenu('speed')} className="rounded bg-white/15 px-1.5 text-[11px] font-semibold">{speed}×</button>}
            <Btn onClick={() => setMenu(menu === 'none' ? 'settings' : 'none')} label="Réglages"><I d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 018.4 12 3.6 3.6 0 0112 8.4a3.6 3.6 0 013.6 3.6 3.6 3.6 0 01-3.6 3.6z" /></Btn>
            <Btn onClick={pip} label="Picture-in-picture"><I d="M19 11h-8v6h8v-6zm4 8V5c0-1.1-.9-2-2-2H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z" /></Btn>
            <Btn onClick={toggleFs} label={fs ? 'Quitter le plein écran' : 'Plein écran'}>{fs ? <I d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" /> : <I d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />}</Btn>
          </div>
        </div>
      </div>

      {/* menus */}
      {menu !== 'none' && (
        <div onClick={(e) => e.stopPropagation()} className="absolute bottom-16 right-4 z-20 w-64 overflow-hidden rounded-lg bg-[#141416]/95 py-1 shadow-2xl ring-1 ring-white/10 backdrop-blur">
          {menu === 'settings' && (
            <>
              {item('Vitesse', false, () => setMenu('speed'), `${speed}×`)}
              {audio.length > 1 && item('Audio', false, () => setMenu('audio'), audio[audioId]?.label)}
              {item('Sous-titres', false, () => setMenu('subs'), subId >= 0 ? subs.find((s) => s.id === subId)?.label ?? 'Activés' : 'Désactivés')}
              {levels.length > 1 && item('Qualité', false, () => setMenu('quality'), level < 0 ? 'Auto' : levels[level]?.label)}
              {item('Taille des sous-titres', false, () => setMenu('subsize'), `${prefs.subSize} %`)}
            </>
          )}
          {menu === 'speed' && <>{back('Vitesse')}{SPEEDS.map((s) => item(s === 1 ? 'Normale' : `${s}×`, s === speed, () => pickSpeed(s)))}</>}
          {menu === 'audio' && <>{back('Audio')}{audio.map((a) => item(a.label, a.id === audioId, () => pickAudio(a.id)))}</>}
          {menu === 'quality' && <>{back('Qualité')}{item('Auto', level < 0, () => pickLevel(-1))}{levels.map((l) => item(l.label, l.id === level, () => pickLevel(l.id)))}</>}
          {menu === 'subs' && (
            <>
              {back('Sous-titres')}
              {item('Désactivés', subId < 0, () => pickSub(-1))}
              {subs.map((s) => item(s.label, s.id === subId, () => pickSub(s.id)))}
              <button onClick={() => fileInput.current?.click()} className="w-full border-t border-white/10 px-3.5 py-2 text-left text-[13px] text-white/75 hover:bg-white/10">Charger un fichier .srt / .vtt…</button>
              <input ref={fileInput} type="file" accept=".srt,.vtt,text/vtt" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadSubFile(f) }} />
              <div className="flex items-center justify-between border-t border-white/10 px-3.5 py-2 text-[12px] text-white/70">
                <span>Décalage</span>
                <span className="flex items-center gap-1"><button onClick={() => applySubDelay(prefs.subDelay - 250)} className="rounded bg-white/10 px-2">−</button><span className="w-14 text-center tabular-nums">{prefs.subDelay > 0 ? '+' : ''}{(prefs.subDelay / 1000).toFixed(2)} s</span><button onClick={() => applySubDelay(prefs.subDelay + 250)} className="rounded bg-white/10 px-2">+</button></span>
              </div>
            </>
          )}
          {menu === 'subsize' && <>{back('Taille des sous-titres')}{[75, 100, 125, 150, 200].map((s) => item(`${s} %`, s === prefs.subSize, () => { prefs.set({ subSize: s }); setMenu('none') }))}</>}
        </div>
      )}
    </div>
  )
}

function Btn({ children, onClick, label, active }: { children: React.ReactNode; onClick: () => void; label: string; active?: boolean }) {
  return <button onClick={onClick} aria-label={label} title={label} className={`grid h-9 w-9 place-items-center rounded-md hover:bg-white/15 ${active ? 'text-amber-400' : 'text-white'}`}>{children}</button>
}
const I = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" className="h-[22px] w-[22px] fill-current"><path d={d} /></svg>
