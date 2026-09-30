import { useContext, useEffect, useRef, useState } from 'react'
import {
  backendURL,
  readBackendConnection,
  saveBackendConnection,
} from '../../data/backend-connection'
import { Workspace } from './Workspace'
import { useAppearance } from '../../app/appearance'
import { PlatformContext } from '../../platform/context'

export function ConnectedApp({ demoURL }: { demoURL?: string }) {
  const platform = useContext(PlatformContext)!
  const appearance = useAppearance(platform)
  const [initial] = useState(() => {
    if (demoURL) return { endpoint: demoURL, error: '' }
    try {
      return { endpoint: readBackendConnection(), error: '' }
    } catch (failure) {
      return {
        endpoint: '',
        error:
          failure instanceof Error
            ? failure.message
            : 'The backend address could not be read.',
      }
    }
  })
  const [endpoint, setEndpoint] = useState(initial.endpoint)
  const [editing, setEditing] = useState(!endpoint)
  const [draft, setDraft] = useState(endpoint)
  const [error, setError] = useState(initial.error)
  const address = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing) address.current?.focus()
  }, [editing])
  if (!editing)
    return (
      <Workspace
        appearance={appearance}
        key={endpoint}
        endpoint={endpoint}
        changeConnection={
          demoURL
            ? undefined
            : () => {
                setDraft(endpoint)
                setEditing(true)
              }
        }
      />
    )
  return (
    <main className="workspace-state connection-setup">
      <form
        className="connection-card"
        onSubmit={(event) => {
          event.preventDefault()
          try {
            const next = backendURL(draft)
            saveBackendConnection(next)
            if (endpoint && next !== endpoint) {
              // Tear down the old web context as well as React subscriptions, including
              // any already in-flight uploads/saves. Durable journals stay endpoint-scoped.
              window.location.reload()
              return
            }
            setEndpoint(next)
            setError('')
            setEditing(false)
          } catch (failure) {
            setError(
              failure instanceof Error
                ? failure.message
                : 'The backend address could not be saved.',
            )
          }
        }}
      >
        <h1>Connect to Kipster</h1>
        <p>
          Enter the existing backend address from your host setup. This device
          connects to that installation.
        </p>
        <label htmlFor="backend-url">Backend address</label>
        <input
          ref={address}
          id="backend-url"
          type="url"
          required
          value={draft}
          placeholder="https://your-host.your-network.ts.net"
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          autoCapitalize="none"
        />
        <p>
          Use your private HTTPS address. For a local host, you can use
          http://localhost with its port.
        </p>
        {endpoint && (
          <p>Drafts and unsent messages stay with their original connection.</p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="recovery-actions">
          <button className="primary-button" type="submit">
            Connect
          </button>
          {endpoint && (
            <button
              type="button"
              onClick={() => {
                setError('')
                setEditing(false)
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </main>
  )
}
