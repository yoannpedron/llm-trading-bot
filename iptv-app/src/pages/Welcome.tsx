import LangSetup from '../components/LangSetup'

/** First launch: country → languages → done. No provider category ever shown. */
export default function Welcome() {
  return (
    <div className="mx-auto max-w-4xl px-6 pb-24 pt-24 md:px-12">
      <p className="text-[11px] uppercase tracking-[.2em] text-white/40">Bienvenue</p>
      <h1 className="mt-1 font-display text-4xl font-black tracking-tight">D'où regardes-tu ?</h1>
      <div className="mt-8"><LangSetup onboarding /></div>
    </div>
  )
}
