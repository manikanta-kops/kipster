// Served only by the development server; not an input to production builds.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CoreSettingsPanel } from '../src/features/settings/CoreSettingsPanel'
import '../src/styles/app.css'
const query = new QueryClient()
export function Harness() {
  const [open, setOpen] = useState(false)
  const callerId = new URLSearchParams(location.search).get('caller') ?? 'owner'
  return (
    <QueryClientProvider client={query}>
      <button onClick={() => setOpen(true)}>Open settings</button>
      {open && (
        <CoreSettingsPanel
          endpoint={`${location.origin}/test-core`}
          scope={{ installationId: 'installation', callerId }}
          organizationId="org"
          close={() => setOpen(false)}
        />
      )}
    </QueryClientProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Harness />)
