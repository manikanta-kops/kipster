import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HistoryWindow } from '../src/features/chat/HistoryWindow'
import { useAppearance } from '../src/app/appearance'
import { CoreSettingsPanel } from '../src/features/settings/CoreSettingsPanel'
import { ApplicationUpdates } from '../src/data/application-updates'
import type { Platform } from '../src/platform/platform'

export function History() {
  const [items, setItems] = useState(
    Array.from({ length: 250 }, (_, index) => ({
      id: index + 1,
      text: `Message ${index + 1}`,
    })),
  )
  return (
    <>
      <button
        onClick={() =>
          setItems((previous) => [
            ...previous,
            { id: previous.length + 1, text: `Message ${previous.length + 1}` },
          ])
        }
      >
        Append message
      </button>
      <button
        onClick={() =>
          setItems((previous) =>
            previous.map((item, index) =>
              index === previous.length - 1
                ? { ...item, text: item.text + ' streamed' }
                : item,
            ),
          )
        }
      >
        Stream tail
      </button>
      <div className="thread-scroll" style={{ height: 350, overflow: 'auto' }}>
        <HistoryWindow
          items={items}
          render={(item) => (
            <p
              data-testid="history-message"
              key={item.id}
              style={{ height: 30 }}
            >
              {item.text}
            </p>
          )}
        />
      </div>
    </>
  )
}

const queries = new QueryClient()
const updates = new ApplicationUpdates()
Object.assign(window, { testApplicationUpdates: updates })
export function Settings({ platform }: { platform: Platform }) {
  const appearance = useAppearance(platform)
  const [open, setOpen] = useState(false)
  return (
    <QueryClientProvider client={queries}>
      <button onClick={() => setOpen(true)}>Open settings</button>
      <button onClick={() => updates.publish({ kind: 'changed' })}>
        Changed
      </button>
      <button
        onClick={() => updates.publish({ kind: 'connection', message: '' })}
      >
        Reconnected
      </button>
      {open && (
        <CoreSettingsPanel
          appearance={appearance}
          endpoint="http://127.0.0.1:43128"
          scope={{ installationId: 'installation', callerId: 'owner' }}
          organizationId="org"
          updates={updates}
          close={() => setOpen(false)}
        />
      )}
    </QueryClientProvider>
  )
}
