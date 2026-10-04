import type {
  IdentityFile as FileRecord,
  IdentityBackups,
} from '@kipster/core/protocol'
import { check, incompatible, list, record } from '../../data/response.ts'
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Icon } from '../../components/Icon'
import { Markdown } from '../chat/Markdown'
import { BarTools, Block, Callout, Row, Segmented } from './ui'
import { useSheet } from './sheet'

const identityFiles = [
  { name: 'AGENTS.md', what: 'How it works' },
  { name: 'soul.md', what: 'Values and voice' },
  { name: 'identity.md', what: 'Who it is' },
]
type Backup = IdentityBackups['backups'][number]

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
const filePath = (agentId: string, file: string) =>
  `/v1/agents/${encodeURIComponent(agentId)}/identity/${encodeURIComponent(file)}`
const fileKey = (endpoint: string, agentId: string, file: string) => [
  'identity-file',
  endpoint,
  agentId,
  file,
]
function useFile(endpoint: string, agentId: string, file: string) {
  return useQuery({
    queryKey: fileKey(endpoint, agentId, file),
    queryFn: async ({ signal }) =>
      fileRecord(await request(endpoint, filePath(agentId, file), signal)),
  })
}
function useBackups(endpoint: string, agentId: string, file: string) {
  return useQuery({
    queryKey: [...fileKey(endpoint, agentId, file), 'backups'],
    queryFn: async ({ signal }) => {
      const value = await request(
        endpoint,
        filePath(agentId, file) + '/backups',
        signal,
      )
      return list(value.backups, (backup) => {
        check(
          record(backup) &&
            typeof backup.id === 'string' &&
            typeof backup.createdAt === 'string' &&
            typeof backup.size === 'number',
        )
        return backup as Backup
      })
    },
  })
}
const byteSize = (size: number) =>
  size < 1024 ? `${size} bytes` : `${(size / 1024).toFixed(1)} KB`
const textSize = (text: string) =>
  byteSize(new TextEncoder().encode(text).length)
const backupTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

/** The three files that make up a kip, each opening a viewer. */
export function IdentityGroup({
  endpoint,
  agentId,
  name,
  admin,
  readOnly,
}: {
  endpoint: string
  agentId: string
  name: string
  /** The main kip, which can change any kip's files. */
  admin?: string
  readOnly: boolean
}) {
  return (
    <Block
      label="Identity"
      foot={
        readOnly
          ? 'Archived identities are read-only.'
          : admin && admin !== name
            ? `${name} maintains these files. To change one, ask ${name} or ${admin}.`
            : `${name} maintains these files. To change one, ask ${name}.`
      }
    >
      {identityFiles.map((file) => (
        <IdentityRow
          key={file.name}
          endpoint={endpoint}
          agentId={agentId}
          file={file.name}
          what={file.what}
        />
      ))}
    </Block>
  )
}
function IdentityRow({
  endpoint,
  agentId,
  file,
  what,
}: {
  endpoint: string
  agentId: string
  file: string
  what: string
}) {
  const { push } = useSheet()
  const current = useFile(endpoint, agentId, file)
  return (
    <Row
      lead={
        <span className="set-tile" aria-hidden="true">
          <Icon name="file" />
        </span>
      }
      label={file}
      sub={
        current.data
          ? `${what} · ${textSize(current.data.content)}`
          : current.isError
            ? `${what} · Unavailable`
            : what
      }
      chevron
      onClick={() => push({ kind: 'file', agentId, file, title: file })}
    />
  )
}

function ViewToggle() {
  const { source, setSource } = useSheet()
  return (
    <Segmented
      label="View"
      value={source ? 'source' : 'preview'}
      options={[
        { value: 'preview', label: 'Preview' },
        { value: 'source', label: 'Source' },
      ]}
      change={(next) => setSource(next === 'source')}
      className="compact"
    />
  )
}
function RefreshFiles({
  endpoint,
  agentId,
  file,
  done,
}: {
  endpoint: string
  agentId: string
  file: string
  done?: () => void
}) {
  const queries = useQueryClient()
  return (
    <button
      type="button"
      className="set-icon-button"
      aria-label="Refresh files"
      title="Refresh files"
      onClick={() => {
        done?.()
        void queries.invalidateQueries({
          queryKey: fileKey(endpoint, agentId, file),
        })
      }}
    >
      <Icon name="refresh" />
    </button>
  )
}
function Document({ text }: { text: string }) {
  const { source } = useSheet()
  if (!text) return <p className="set-empty">Empty file</p>
  return source ? (
    <pre className="set-source">{text}</pre>
  ) : (
    <Markdown text={text} headings className="set-markdown" />
  )
}

export function IdentityFilePage({
  endpoint,
  agentId,
  agentName,
  file,
  readOnly,
}: {
  endpoint: string
  agentId: string
  agentName: string
  file: string
  readOnly: boolean
}) {
  const { push } = useSheet()
  const current = useFile(endpoint, agentId, file)
  const backups = useBackups(endpoint, agentId, file)
  const error = current.error || backups.error
  return (
    <>
      <BarTools>
        <ViewToggle />
        <RefreshFiles endpoint={endpoint} agentId={agentId} file={file} />
      </BarTools>
      {readOnly && <Callout>Archived identities are read-only.</Callout>}
      {error && (
        <Callout tone="danger" alert>
          {error.message}
        </Callout>
      )}
      <Block
        foot={
          current.data
            ? `${agentName} · ${textSize(current.data.content)}`
            : undefined
        }
      >
        <div className="set-document" aria-label={`Current ${file}`}>
          {current.data ? (
            <Document text={current.data.content} />
          ) : (
            <p className="set-empty">Loading file…</p>
          )}
        </div>
      </Block>
      <Block>
        <Row
          label="Backups"
          sub={
            readOnly
              ? 'Saved before each change.'
              : 'Saved before each change. Preview one to restore it.'
          }
          control={
            backups.data && (
              <span className="set-summary">{backups.data.length}</span>
            )
          }
          chevron
          onClick={() =>
            push({ kind: 'backups', agentId, file, title: 'Backups' })
          }
        />
      </Block>
    </>
  )
}

export function BackupsPage({
  endpoint,
  agentId,
  agentName,
  file,
}: {
  endpoint: string
  agentId: string
  agentName: string
  file: string
}) {
  const { push } = useSheet()
  const backups = useBackups(endpoint, agentId, file)
  return (
    <>
      <BarTools>
        <RefreshFiles endpoint={endpoint} agentId={agentId} file={file} />
      </BarTools>
      {backups.error && (
        <Callout tone="danger" alert>
          {backups.error.message}
        </Callout>
      )}
      <Block
        label={`${file} · ${agentName}`}
        foot="Restoring replaces the file. The current version is kept as a backup."
      >
        {!backups.data ? (
          <Row label={<span className="set-muted">Loading backups…</span>} />
        ) : !backups.data.length ? (
          <Row label={<span className="set-muted">No backups yet</span>} />
        ) : (
          backups.data.map((backup) => (
            <Row
              key={backup.id}
              lead={
                <span className="set-tile" aria-hidden="true">
                  <Icon name="history" />
                </span>
              }
              label={backupTime(backup.createdAt)}
              sub={byteSize(backup.size)}
              chevron
              onClick={() =>
                push({
                  kind: 'backup',
                  agentId,
                  file,
                  backupId: backup.id,
                  title: backupTime(backup.createdAt),
                })
              }
            />
          ))
        )}
      </Block>
    </>
  )
}

export function BackupPage({
  endpoint,
  agentId,
  file,
  backupId,
  readOnly,
}: {
  endpoint: string
  agentId: string
  file: string
  backupId: string
  readOnly: boolean
}) {
  const queries = useQueryClient()
  const { pop, toast } = useSheet()
  const key = fileKey(endpoint, agentId, file)
  const current = useFile(endpoint, agentId, file)
  const preview = useQuery({
    queryKey: [...key, 'backup', backupId],
    queryFn: async ({ signal }) =>
      fileRecord(
        await request(
          endpoint,
          `${filePath(agentId, file)}/backups/${encodeURIComponent(backupId)}`,
          signal,
        ),
      ),
  })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const error = current.error || preview.error
  async function restore() {
    if (!current.data) return
    setBusy(true)
    setNotice('')
    try {
      await request(
        endpoint,
        `${filePath(agentId, file)}/backups/${encodeURIComponent(backupId)}/restore`,
        AbortSignal.timeout(20000),
        current.data.sha256,
      )
      await queries.invalidateQueries({ queryKey: key })
      toast('Backup restored.')
      pop(2)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Restore failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <BarTools>
        <ViewToggle />
        <RefreshFiles
          endpoint={endpoint}
          agentId={agentId}
          file={file}
          done={() => setNotice('')}
        />
      </BarTools>
      {readOnly && <Callout>Archived identities are read-only.</Callout>}
      {error && (
        <Callout tone="danger" alert>
          {error.message}
        </Callout>
      )}
      <Block
        foot={
          preview.data
            ? `Backup of ${file} · ${textSize(preview.data.content)}`
            : undefined
        }
      >
        <div className="set-document" aria-label="Backup preview">
          {preview.data ? (
            <Document text={preview.data.content} />
          ) : (
            <p className="set-empty">Loading backup…</p>
          )}
        </div>
      </Block>
      {!readOnly && preview.data && (
        <Block>
          <Row
            label="Restore this backup"
            sub="Replaces the current file and keeps the current version as a backup. Restoring does not regenerate its Learned section."
            control={
              <button
                className="set-button primary"
                disabled={busy || !current.data}
                onClick={() => void restore()}
              >
                {busy ? 'Restoring…' : 'Restore'}
              </button>
            }
          />
        </Block>
      )}
      {notice && (
        <Callout tone="danger" alert>
          {notice}
        </Callout>
      )}
    </>
  )
}
