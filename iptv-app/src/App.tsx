import { useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useSession } from './store/session'
import { useCatalog } from './store/catalog'
import Backdrop from './components/Backdrop'
import Navbar from './components/Navbar'
import Loader from './components/Loader'
import Home from './pages/Home'
import Browse from './pages/Browse'
import Details from './pages/Details'
import Watch from './pages/Watch'
import Login from './pages/Login'
import Search from './pages/Search'

export default function App() {
  const { mode, creds, includeAdult } = useSession()
  const { status, load } = useCatalog()

  useEffect(() => { void load(mode, creds, includeAdult) }, [mode, creds, includeAdult, load])

  return (
    <div className="relative min-h-full">
      <Backdrop />
      <Navbar />
      {status !== 'ready' ? (
        <Loader />
      ) : (
        <main className="relative z-10">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/movies" element={<Browse kind="movie" />} />
            <Route path="/series" element={<Browse kind="series" />} />
            <Route path="/live" element={<Browse kind="live" />} />
            <Route path="/search" element={<Search />} />
            <Route path="/details/:id" element={<Details />} />
            <Route path="/watch/:id" element={<Watch />} />
            <Route path="/login" element={<Login />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      )}
    </div>
  )
}
