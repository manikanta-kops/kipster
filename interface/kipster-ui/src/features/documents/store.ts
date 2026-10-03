import { useContext, useSyncExternalStore } from 'react'
import { WorkspaceContext } from '../../data/workspace-context'
import type { DocumentClient, Summary } from '../../data/documents'
import type { CallerScope } from '../../data/conversations'

/** Docs the owner can see, kept current by `document-changed` and `document-removed` events. */
export class DocumentStore {
  readonly client: DocumentClient
  private docs = new Map<string, Summary>()
  private removed = new Set<string>()
  private snapshot: Summary[] = []
  private listeners = new Set<() => void>()
  constructor(client: DocumentClient) {
    this.client = client
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  list = () => this.snapshot
  get = (id: string) => this.docs.get(id)
  isRemoved = (id: string) => this.removed.has(id)
  private changed() {
    this.snapshot = [...this.docs.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    )
    for (const listener of this.listeners) listener()
  }
  async refresh(signal?: AbortSignal) {
    const docs = await this.client.list(signal)
    this.docs = new Map(docs.map((doc) => [doc.id, doc]))
    this.changed()
  }
  upsert(summary: Summary) {
    const old = this.docs.get(summary.id)
    if (old && old.revision > summary.revision) return
    this.docs.set(summary.id, summary)
    this.changed()
  }
  remove(id: string) {
    this.removed.add(id)
    this.docs.delete(id)
    this.changed()
  }
}

export type Author = { name: string; color?: string; kip: boolean }
export type Documents = {
  store: DocumentStore
  scope: CallerScope
  openId: string | null
  open: (id: string) => void
  author: (agentId: string) => Author
}
export const useDocumentsContext = () =>
  useContext(WorkspaceContext)?.documents ?? null

export function useDocumentList(store: DocumentStore) {
  return useSyncExternalStore(store.subscribe, store.list)
}
export function useDocumentSummary(store: DocumentStore, id: string) {
  return useSyncExternalStore(store.subscribe, () => store.get(id))
}
export function useDocumentGone(store: DocumentStore, id: string) {
  return useSyncExternalStore(store.subscribe, () => store.isRemoved(id))
}

/** Files uploaded in this session show from memory until the saved draft can serve them. */
export const localFiles = new Map<
  string,
  { url: string; name: string; size: number }
>()
