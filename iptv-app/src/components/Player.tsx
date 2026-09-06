import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'

interface Props { src: string; title: string; autoPlay?: boolean; startAt?: number; onProgress?: (t: number, d: number) => void; onEnded?: () => void }

/** hls.js for .m3u8 (live), native <video> for progressive files. */
export default function Player({ src, title, autoPlay = true, startAt, onProgress, onEnded }: Props) {
  const ref = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const video = ref.current
    if (!video) return
    setError(undefined)
    const isHls = /\.m3u8(\?|$)/.test(src)
    let hls: Hls | undefined
    if (isHls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 60 })
      hls.loadSource(src)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) setError(`Flux indisponible (${d.type})`) })
    } else {
      video.src = src
    }
    const onErr = () => setError('Lecture impossible : format non supporté par le navigateur ou flux hors ligne')
    let last = 0
    const onTime = () => { if (!onProgress || !video.duration || !isFinite(video.duration)) return; const n = Date.now(); if (n - last > 5000) { last = n; onProgress(video.currentTime, video.duration) } }
    const onMeta = () => { if (startAt && startAt > 5 && isFinite(video.duration)) video.currentTime = startAt }
    const onEnd = () => onEnded?.()
    video.addEventListener('error', onErr); video.addEventListener('timeupdate', onTime); video.addEventListener('loadedmetadata', onMeta); video.addEventListener('ended', onEnd)
    if (autoPlay) video.play().catch(() => undefined)
    return () => { hls?.destroy(); video.removeEventListener('error', onErr); video.removeEventListener('timeupdate', onTime); video.removeEventListener('loadedmetadata', onMeta); video.removeEventListener('ended', onEnd); video.removeAttribute('src'); video.load() }
  }, [src, autoPlay, startAt, onProgress, onEnded])

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black shadow-2xl">
      <video ref={ref} controls playsInline className="h-full w-full" title={title} />
      {error && (
        <div className="absolute inset-x-0 bottom-14 mx-auto w-fit rounded bg-red-600/90 px-3 py-1 text-sm">{error}</div>
      )}
    </div>
  )
}
