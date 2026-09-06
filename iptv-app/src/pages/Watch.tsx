import { useEffect } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useCatalog } from '../store/catalog'
import { useUi } from '../store/ui'
import { useSession } from '../store/session'
import Player from '../components/Player'

export default function Watch() {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const item = useCatalog((s) => s.item(id))
  const client = useCatalog((s) => s.client)
  const mode = useSession((s) => s.mode)
  const setBackdrop = useUi((s) => s.setBackdrop)
  useEffect(() => { setBackdrop(undefined) }, [setBackdrop])

  if (!item) return <p className="p-24">Introuvable.</p>

  let src: string | undefined
  if (client) {
    const ep = params.get('ep')
    if (item.kind === 'live') src = client.liveUrl(item.streamId)
    else if (ep) src = client.episodeUrl(ep, params.get('ext') ?? 'mp4')
    else if (item.id.startsWith('movie:')) src = client.movieUrl(item.streamId, item.ext)
  }

  return (
    <div className="mx-auto max-w-6xl px-8 pt-20">
      <div className="mb-4 flex items-baseline gap-4">
        <h1 className="text-2xl font-bold">{item.title}</h1>
        <span className="text-sm text-white/50">{[item.year, item.lang, item.quality].filter(Boolean).join(' · ')}</span>
        {item.kind !== 'live' && <Link to={`/details/${item.id}`} className="ml-auto text-sm text-white/60 hover:text-white">Détails →</Link>}
      </div>
      {src ? (
        <Player src={src} title={item.title} />
      ) : (
        <div className="flex aspect-video items-center justify-center rounded-xl bg-white/5 text-center text-white/60">
          {mode === 'mock' ? (
            <p>Mode démo : aucun flux. <Link to="/login" className="underline">Connecte un serveur Xtream</Link> pour lire ce contenu.</p>
          ) : (
            <p>Choisis un épisode depuis la page <Link to={`/details/${item.id}`} className="underline">détails</Link>.</p>
          )}
        </div>
      )}
      <p className="mt-3 break-all font-mono text-[11px] text-white/30">{src}</p>
    </div>
  )
}
