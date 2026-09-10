import { useSearchParams } from 'react-router-dom'
import Player from '../components/Player'

/** Player bench: /lab?src=<any mp4 / m3u8 url>. Useful to check tracks, quality levels and subtitles on a known stream. */
export default function Lab() {
  const [p] = useSearchParams()
  const src = p.get('src') ?? ''
  return (
    <div className="mx-auto max-w-5xl px-6 pb-24 pt-24">
      <h1 className="mb-4 font-display text-2xl font-bold">Banc d'essai lecteur</h1>
      {src ? <Player src={src} title={src.split('/').pop() ?? src} live={p.get('live') === '1'} /> : <p className="text-white/50">Ajoute ?src=… à l'URL.</p>}
    </div>
  )
}
