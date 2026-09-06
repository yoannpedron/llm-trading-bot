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
import MyList from './pages/MyList'
import Collection from './pages/Collection'
import Settings from './pages/Settings'
import Live from './pages/Live'
import Sport from './pages/Sport'
import { UI_LANGS, useProfile } from './store/profile'
import { useSettings } from './store/settings'

export default function App() {
  const { mode, creds, includeAdult } = useSession()
  const { status, load } = useCatalog()
  const { uiLang, onboarded } = useProfile()
  useEffect(() => { document.documentElement.lang = uiLang; document.documentElement.dir = UI_LANGS[uiLang].dir }, [uiLang])

  useEffect(() => { void load(mode, creds, includeAdult) }, [mode, creds, includeAdult, load])
  const hours = useSettings((s) => s.autoRefreshHours)
  useEffect(() => { if (!hours) return; const t = setInterval(() => void load(mode, creds, includeAdult), hours * 3600e3); return () => clearInterval(t) }, [hours, mode, creds, includeAdult, load])

  return (
    <div className="relative min-h-full">
      <Backdrop />
      <Navbar />
      {status !== 'ready' ? (
        <Loader />
      ) : (
        <main className="relative z-10">
          <Routes>
            <Route path="/" element={onboarded ? <Home /> : <Settings onboarding />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/profile" element={<Settings />} />
            <Route path="/movies" element={<Browse kind="movie" />} />
            <Route path="/series" element={<Browse kind="series" />} />
            <Route path="/live" element={<Live />} />
            <Route path="/sport" element={<Sport />} />
            <Route path="/search" element={<Search />} />
            <Route path="/list" element={<MyList />} />
            <Route path="/collection/:id" element={<Collection />} />
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
