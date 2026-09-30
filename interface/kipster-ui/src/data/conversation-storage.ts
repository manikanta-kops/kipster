import type { UploadIntent, UploadReceipt } from './media'
import Dexie, { type Table } from 'dexie'
import type { ConversationTarget, Submission, Receipt } from './conversations'
/** The saved composer draft of one conversation target, scoped to the connection. */
export const draftKey = (scope: string, target: ConversationTarget) =>
  JSON.stringify([
    scope,
    target.context.kind === 'organization'
      ? { kind: 'organization', organizationId: target.context.organizationId }
      : { kind: 'installation', installationId: target.context.installationId },
    target.chatId,
    target.threadId ?? null,
  ])
export interface Draft {
  key: string
  revision: string
  text: string
  uploadIds?: string[]
}
export interface PendingSubmission {
  id: string
  scope: string
  revision: string
  submission: Submission
  state:
    'unsent' | 'sending' | 'uncertain' | 'accepted' | 'rejected' | 'discarded'
  receipt?: Receipt
  updatedAt: number
}
export interface PendingMedia {
  id: string
  draftKey: string
  intent: UploadIntent
  bytes: Blob
  revision: string
  state: 'saved' | 'uploading' | 'uncertain' | 'ready'
  association: 'draft' | 'removed' | 'submitted'
  receipt?: Extract<UploadReceipt, { status: 'accepted' }>
  error?: string
  createdAt: number
  updatedAt: number
}
// WebKit can reject Blob/File structured clones, so bytes are stored as an ArrayBuffer.
type StoredMedia = Omit<PendingMedia, 'bytes'> & { bytes: ArrayBuffer }
const readMedia = (item: StoredMedia): PendingMedia => ({
  ...item,
  bytes: new Blob([item.bytes], { type: item.intent.mimeType }),
})
const db = new Dexie('kipster-conversations') as Dexie & {
  media: Table<StoredMedia, string>
  drafts: Table<Draft, string>
  outbox: Table<PendingSubmission, string>
}
db.version(2).stores({
  drafts: '&key',
  outbox: '&id,scope',
  media: '&id,draftKey',
})
const revision = () => crypto.randomUUID()
export const conversationStorage = {
  readDraft: async (key: string): Promise<Draft | undefined> =>
    db.drafts.get(key),
  async writeDraft(key: string, expected: string | null, text: string) {
    return db.transaction('rw', db.drafts, async () => {
      const current = await db.drafts.get(key)
      if ((current?.revision ?? null) !== expected)
        return { applied: false, current }
      const next = { key, text, revision: revision() }
      await db.drafts.put(next)
      return { applied: true, current: next }
    })
  },
  list: async (scope: string): Promise<PendingSubmission[]> =>
    db.outbox.where('scope').equals(scope).toArray(),
  async reserve(
    scope: string,
    submission: Submission,
    draft: Draft | undefined,
  ) {
    return db.transaction('rw', db.drafts, db.outbox, db.media, async () => {
      for (const id of draft?.uploadIds ?? []) {
        const media = await db.media.get(id)
        if (
          !media ||
          media.draftKey !== draft?.key ||
          media.association !== 'draft' ||
          media.state !== 'ready'
        )
          throw new Error(
            'Attachment changed in another tab. Review the saved draft before sending.',
          )
        await db.media.put({
          ...media,
          association: 'submitted',
          revision: revision(),
        })
      }
      const value: PendingSubmission = {
        id: submission.submissionId,
        scope,
        submission: structuredClone(submission),
        state: 'unsent',
        revision: revision(),
        updatedAt: Date.now(),
      }
      await db.outbox.add(value)
      let cleared: Draft | undefined
      if (draft) {
        const current = await db.drafts.get(draft.key)
        if (current?.revision === draft.revision) {
          cleared = { key: draft.key, text: '', revision: revision() }
          await db.drafts.put(cleared)
        }
      }
      return { value, cleared }
    })
  },
  async transition(
    expected: PendingSubmission,
    state: PendingSubmission['state'],
    receipt?: Receipt,
  ) {
    return db.transaction('rw', db.outbox, async () => {
      const current = await db.outbox.get(expected.id)
      if (
        !current ||
        current.revision !== expected.revision ||
        current.state !== expected.state
      )
        return { applied: false, current }
      const next = {
        ...current,
        state,
        receipt: receipt ?? current.receipt,
        revision: revision(),
        updatedAt: Date.now(),
      }
      await db.outbox.put(next)
      return { applied: true, current: next }
    })
  },
}

export const mediaStorage = {
  list: async (draftKey: string) =>
    (await db.media.where('draftKey').equals(draftKey).sortBy('createdAt')).map(
      readMedia,
    ),
  get: async (id: string) => {
    const item = await db.media.get(id)
    return item ? readMedia(item) : undefined
  },
  add: async (item: PendingMedia): Promise<string> =>
    db.media.add({ ...item, bytes: await item.bytes.arrayBuffer() }),
  async change(
    expected: PendingMedia,
    change: Partial<
      Pick<PendingMedia, 'state' | 'receipt' | 'association' | 'error'>
    >,
  ) {
    return db.transaction('rw', db.media, async () => {
      const current = await db.media.get(expected.id)
      if (!current || current.revision !== expected.revision) return undefined
      const next = {
        ...current,
        ...change,
        revision: revision(),
        updatedAt: Date.now(),
      }
      await db.media.put(next)
      return readMedia(next)
    })
  },
}
