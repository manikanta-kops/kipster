import { useContext, useEffect, useRef, useState } from 'react'
import {
  backendURL,
  localBackendURL,
  readBackendConnection,
  saveBackendConnection,
} from '../../data/backend-connection'
import { TextClient } from '../../data/text'
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
  const [discovering, setDiscovering] = useState(
    !initial.endpoint && !initial.error,
  )
  const [editing, setEditing] = useState(!endpoint && !discovering)
  const [draft, setDraft] = useState(endpoint || localBackendURL)
  const [error, setError] = useState(initial.error)
  const address = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (initial.endpoint || initial.error) return
    const abort = new AbortController()
    // Show setup even if the webview delays rejecting an aborted request.
    const timeout = window.setTimeout(() => {
      abort.abort()
      setEditing(true)
      setDiscovering(false)
    }, 3000)
    void (async () => {
      try {
        // Discovery stays on this address even if a local service redirects.
        await new TextClient(localBackendURL).bootstrap(abort.signal, 'error')
        if (abort.signal.aborted) return
        saveBackendConnection(localBackendURL)
        setEndpoint(localBackendURL)
      } catch {
        if (!abort.signal.aborted) setEditing(true)
      } finally {
        window.clearTimeout(timeout)
        if (!abort.signal.aborted) setDiscovering(false)
      }
    })()
    return () => {
      window.clearTimeout(timeout)
      abort.abort()
    }
  }, [initial])
  useEffect(() => {
    if (editing) address.current?.focus()
  }, [editing])
  if (discovering)
    return (
      <main className="workspace-state" aria-busy="true">
        <div className="state-card mat thick lifted">
          <h1>Connecting to Kipster</h1>
          <p>Looking for Kipster on this computer…</p>
        </div>
      </main>
    )
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
