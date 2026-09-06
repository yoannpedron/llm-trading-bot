import { useCatalog } from '../store/catalog'
import { useSession } from '../store/session'
import { Link } from 'react-router-dom'

export default function Loader() {
  const { status, progress, error } = useCatalog()
  const setMock = useSession((s) => s.setMock)
  return (
    <div className="relative z-10 flex min-h-screen flex-col items-center justify-center gap-4 text-center">
      {status === 'error' ? (
        <>
          <p className="text-lg text-red-400">Erreur : {error}</p>
          <div className="flex gap-3">
            <Link to="/login" className="rounded-full bg-white px-5 py-2 text-black">Changer les identifiants</Link>
            <button onClick={setMock} className="rounded-full bg-white/10 px-5 py-2">Mode démo</button>
          </div>
        </>
      ) : (
        <>
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-white" />
          <p className="text-white/70">{progress || 'Chargement…'}</p>
        </>
      )}
    </div>
  )
}
