import { useMyList } from '../store/mylist'
import { useCatalog } from '../store/catalog'
import VirtualGrid from '../components/VirtualGrid'

export default function MyList() {
  const ids = useMyList((s) => s.ids)
  const item = useCatalog((s) => s.item)
  const items = ids.map(item).filter((x): x is NonNullable<typeof x> => !!x)
  return (
    <div className="flex h-screen flex-col pt-20">
      <h1 className="px-6 font-display text-3xl font-extrabold tracking-tight md:px-12">Ma liste</h1>
      <p className="px-6 pb-3 text-sm text-white/40 md:px-12">{items.length} titre{items.length > 1 ? 's' : ''} · enregistrés sur cet appareil</p>
      <div className="min-h-0 flex-1">
        {items.length ? <VirtualGrid items={items} /> : <div className="px-6 py-20 text-center text-white/40 md:px-12"><p className="mb-1 font-display text-xl font-bold text-white">Rien pour l'instant</p>Appuie sur + sur un film ou une série pour le retrouver ici.</div>}
      </div>
    </div>
  )
}
