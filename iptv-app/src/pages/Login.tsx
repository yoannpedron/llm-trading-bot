import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { envCreds, useSession } from '../store/session'
import { useUi } from '../store/ui'
import { useEffect } from 'react'

export default function Login() {
  const nav = useNavigate()
  const { mode, creds, setLive, setMock } = useSession()
  const setBackdrop = useUi((s) => s.setBackdrop)
  const [form, setForm] = useState(creds ?? envCreds())
  useEffect(() => setBackdrop(undefined), [setBackdrop])
  const f = (k: keyof typeof form) => ({ value: form[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value }) })
  return (
    <div className="mx-auto max-w-md px-8 pt-28">
      <h1 className="mb-6 text-2xl font-bold">Source Xtream Codes</h1>
      <form
        onSubmit={(e) => { e.preventDefault(); setLive({ ...form, url: form.url.replace(/\/+$/, '') }); nav('/') }}
        className="space-y-3"
      >
        <label className="block text-sm"><span className="text-white/60">URL serveur</span><input {...f('url')} placeholder="http://host:port" className="mt-1 w-full rounded bg-white/10 px-3 py-2 outline-none focus:bg-white/15" /></label>
        <label className="block text-sm"><span className="text-white/60">Utilisateur</span><input {...f('username')} className="mt-1 w-full rounded bg-white/10 px-3 py-2 outline-none focus:bg-white/15" /></label>
        <label className="block text-sm"><span className="text-white/60">Mot de passe</span><input {...f('password')} type="password" className="mt-1 w-full rounded bg-white/10 px-3 py-2 outline-none focus:bg-white/15" /></label>
        <div className="flex gap-3 pt-2">
          <button type="submit" className="rounded-full bg-white px-6 py-2 font-semibold text-black">Charger le catalogue complet</button>
          <button type="button" onClick={() => { setMock(); nav('/') }} className={`rounded-full px-6 py-2 ${mode === 'mock' ? 'bg-white/25' : 'bg-white/10'}`}>Mode démo (échantillon)</button>
        </div>
      </form>
      <p className="mt-6 text-xs text-white/40">
        Le catalogue complet (300k+ entrées) est téléchargé une fois puis analysé dans un Web Worker. En dev les appels passent par le proxy Vite pour éviter le CORS.
      </p>
    </div>
  )
}
