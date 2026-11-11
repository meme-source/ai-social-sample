import { useEffect } from 'react'

/**
 * On iPhone the keyboard covers the page instead of shrinking it. Track the
 * *visible* area and size the app to it, so the message box stays above the
 * keyboard. Sets --app-height and --app-top on <html>.
 */
export function useAppHeight(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    const root = document.documentElement
    let frame = 0
    const update = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        root.style.setProperty('--app-height', `${Math.round(viewport?.height ?? window.innerHeight)}px`)
        root.style.setProperty('--app-top', `${Math.round(viewport?.offsetTop ?? 0)}px`)
      })
    }
    update()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      cancelAnimationFrame(frame)
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])
}
