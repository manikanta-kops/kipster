import type {
  IdentityFile as FileRecord,
  IdentityBackups,
} from '@kipster/core/protocol'
import { check, incompatible, list, record } from '../../data/response.ts'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Directory } from '../../data/core-settings'

const files = ['AGENTS.md', 'soul.md', 'identity.md']
async function request(
  endpoint: string,
  path: string,
  signal: AbortSignal,
  expectedSha256?: string,
) {
  const response = await fetch(endpoint + path, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    cache: 'no-store',
    ...(expectedSha256
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: 1, expectedSha256 }),
        }
      : {}),
  })
  if (!response.ok)
    throw new Error(
      response.status === 409
        ? 'The file changed. Refresh it before restoring a backup.'
        : 'Identity files are unavailable. Try again.',
    )
  const value: unknown = await response.json().catch(() => incompatible())
  check(record(value))
  return value
}
function fileRecord(value: Record<string, unknown>): FileRecord {
  check(typeof value.content === 'string' && typeof value.sha256 === 'string')
  return value as FileRecord
}
export function IdentityFiles({
  endpoint,
  directory,
}: {
  endpoint: string
  directory: Directory
}) {
  const agents = directory.agents.filter((agent) =>
    ['active', 'archived'].includes(agent.lifecycle),
  )
  const [chosen, setChosen] = useState('')
  const [file, setFile] = useState('identity.md')
  const agent = agents.find((agent) => agent.id === chosen) ?? agents[0]
  if (!agent) return <p>No kip identities are available.</p>
  return (
    <>
      <label className="setting-row">
        <span>Kip</span>
        <select
          value={agent.id}
          onChange={(event) => setChosen(event.target.value)}
        >
          {agents.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {item.lifecycle === 'archived' ? ' (archived)' : ''}
              {agents.filter((other) => other.name === item.name).length > 1
                ? ` · ${item.id.slice(0, 8)}`
                : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="setting-row">
        <span>Identity file</span>
        <select value={file} onChange={(event) => setFile(event.target.value)}>
          {files.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <IdentityFile
        key={`${endpoint}:${agent.id}:${file}`}
        endpoint={endpoint}
        agentId={agent.id}
        file={file}
        readOnly={agent.lifecycle === 'archived'}
      />
    </>
  )
}
function IdentityFile({
  endpoint,
  agentId,
  file,
  readOnly,
}: {
  endpoint: string
  agentId: string
  file: string
  readOnly: boolean
}) {
  const queries = useQueryClient()
  const path = `/v1/agents/${encodeURIComponent(agentId)}/identity/${encodeURIComponent(file)}`
  const key = ['identity-file', endpoint, agentId, file]
  const current = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      fileRecord(await request(endpoint, path, signal)),
  })
  const backups = useQuery({
    queryKey: [...key, 'backups'],
    queryFn: async ({ signal }) => {
      const value = await request(endpoint, path + '/backups', signal)
      return list(value.backups, (backup) => {
        check(
          record(backup) &&
            typeof backup.id === 'string' &&
            typeof backup.createdAt === 'string' &&
            typeof backup.size === 'number',
        )
        return backup as IdentityBackups['backups'][number]
      })
    },
  })
  const [backupId, setBackupId] = useState('')
  const preview = useQuery({
    queryKey: [...key, 'backup', backupId],
    enabled: !!backupId,
    queryFn: async ({ signal }) =>
      fileRecord(
        await request(
          endpoint,
          `${path}/backups/${encodeURIComponent(backupId)}`,
          signal,
        ),
      ),
  })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const error = current.error || backups.error || preview.error
  return (
    <section className="identity-files" aria-label="Identity file contents">
      {readOnly && <p>Archived identities are read-only.</p>}
      {error && <p role="alert">{error.message}</p>}
      <button
        onClick={() => {
          setNotice('')
          void queries.invalidateQueries({ queryKey: key })
        }}
      >
        Refresh files
      </button>
      <h4>Current {file}</h4>
      {current.data ? (
        <pre>{current.data.content || '(empty file)'}</pre>
      ) : (
        <p>Loading file…</p>
      )}
      <label className="setting-row">
        <span>Backups</span>
        <select
          value={backupId}
          onChange={(event) => {
            setBackupId(event.target.value)
            setNotice('')
          }}
        >
          <option value="">Choose a backup</option>
          {backups.data?.map((backup) => (
            <option key={backup.id} value={backup.id}>
              {new Date(backup.createdAt).toLocaleString()} · {backup.size}{' '}
              bytes
            </option>
          ))}
        </select>
      </label>
      {preview.data && backupId && (
        <>
          <h4>Backup preview</h4>
          <pre>{preview.data.content || '(empty file)'}</pre>
          <p>
            Restoring replaces this file with the selected backup. The current
            file is kept as a backup. Restoring does not regenerate its Learned
            section.
          </p>
          {!readOnly && (
            <button
              disabled={busy || !current.data}
              onClick={async () => {
                if (!current.data) return
                setBusy(true)
                setNotice('')
                try {
                  await request(
                    endpoint,
                    `${path}/backups/${encodeURIComponent(backupId)}/restore`,
                    AbortSignal.timeout(20000),
                    current.data.sha256,
                  )
                  setNotice('Backup restored.')
                  setBackupId('')
                  await queries.invalidateQueries({ queryKey: key })
                } catch (error) {
                  setNotice(
                    error instanceof Error ? error.message : 'Restore failed.',
                  )
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? 'Restoring…' : 'Restore this backup'}
            </button>
          )}
        </>
      )}
      {notice && <output>{notice}</output>}
    </section>
  )
}
