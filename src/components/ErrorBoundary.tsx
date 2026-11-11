import { Component, type ErrorInfo, type ReactNode } from 'react'
import { telemetry } from '../lib/telemetry-browser.ts'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  failed: boolean
}

/**
 * If a screen crashes while rendering, show a way back instead of a blank
 * page — and record the crash as a client event, so it shows up in /admin.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const where = info.componentStack?.split('\n').find((line) => line.trim().length > 0)
    telemetry.log('render_crash', { error: error.message.slice(0, 200), component: where?.trim().slice(0, 120) ?? null })
    void telemetry.flush()
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="font-display text-2xl font-bold">Something broke on this screen</h1>
        <p className="max-w-[30ch] text-muted">It has been reported automatically. Reloading usually fixes it.</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </main>
    )
  }
}
