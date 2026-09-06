import { AnimatePresence, motion } from 'framer-motion'
import { useUi } from '../store/ui'
import { imgFor, useLite } from '../store/device'

/** Full-screen background. Each new URL fades in over the previous one. */
export default function Backdrop() {
  const raw = useUi((s) => s.backdrop)
  const lite = useLite()
  const backdrop = imgFor(raw, lite, 'backdrop')
  return (
    <div className="fixed inset-0 z-0 overflow-hidden bg-[#08080a]" aria-hidden>
      <AnimatePresence mode="sync">
        {backdrop && (
          <motion.img
            key={backdrop}
            src={backdrop}
            alt=""
            initial={lite ? { opacity: 0 } : { opacity: 0, scale: 1.06 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: lite ? 0.3 : 0.9, ease: [0.2, 0.8, 0.2, 1] }}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
      </AnimatePresence>
      <div className="absolute inset-0 bg-gradient-to-r from-[#08080a] via-[#08080a]/70 to-[#08080a]/20" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#08080a] via-[#08080a]/40 to-transparent" />
    </div>
  )
}
