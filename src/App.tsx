import { useEffect, type ReactNode } from 'react'
import { Route, Switch, useRoute } from 'wouter'
import { AdminPage } from './components/admin/AdminPage.tsx'
import { ChatRoomPage } from './components/chat/ChatRoom.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { MyIdPage } from './components/me/MyIdPage.tsx'
import { ConsentScreen } from './components/onboarding/ConsentScreen.tsx'
import { ProfileSetup } from './components/onboarding/ProfileSetup.tsx'
import { RoomList } from './components/rooms/RoomList.tsx'
import { Spinner } from './components/ui/Spinner.tsx'
import { useAppHeight } from './hooks/useAppHeight.ts'
import { AuthProvider, useAuth, type Profile } from './hooks/useAuth.tsx'
import { installTelemetry } from './lib/telemetry-browser.ts'

/** Consent → nickname/avatar (anonymous sign-in) → the screen that was asked for. */
function Onboarded({ children }: { children: (profile: Profile) => ReactNode }) {
  const { state, hasConsent } = useAuth()
  if (state.status === 'loading') return <Spinner label="Starting" />
  if (!hasConsent) return <ConsentScreen />
  if (state.status === 'signed_out' || !state.profile) return <ProfileSetup />
  return <>{children(state.profile)}</>
}

function Routes() {
  const [isAdmin] = useRoute('/admin')
  return (
    <div className={`app-shell ${isAdmin ? 'app-shell--wide' : ''}`}>
      <ErrorBoundary>
        <Switch>
          <Route path="/admin">
            <AdminPage />
          </Route>
          <Route path="/me">
            <MyIdPage />
          </Route>
          <Route path="/r/:slug">
            {(params) => <Onboarded>{(profile) => <ChatRoomPage slug={params.slug} me={profile} />}</Onboarded>}
          </Route>
          <Route>
            <Onboarded>{() => <RoomList />}</Onboarded>
          </Route>
        </Switch>
      </ErrorBoundary>
    </div>
  )
}

export function App() {
  useAppHeight()
  useEffect(() => installTelemetry(), [])
  return (
    <AuthProvider>
      <Routes />
    </AuthProvider>
  )
}
