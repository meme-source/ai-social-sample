/**
 * localStorage / sessionStorage can throw (private mode, blocked site data),
 * so every access goes through these wrappers and degrades to "nothing stored".
 */
interface SafeStore {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

function wrap(pick: () => Storage): SafeStore {
  return {
    get(key) {
      try {
        return pick().getItem(key)
      } catch {
        return null
      }
    },
    set(key, value) {
      try {
        pick().setItem(key, value)
      } catch {
        // storage unavailable: the app still works, it just won't remember
      }
    },
    remove(key) {
      try {
        pick().removeItem(key)
      } catch {
        // same as above
      }
    },
  }
}

export const safeStorage = {
  local: wrap(() => window.localStorage),
  session: wrap(() => window.sessionStorage),
}
