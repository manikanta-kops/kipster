import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Postgres, SqlClient } from '../platform/postgres/public.js'
import { claimOperation, completeOperation, operationKey, type Operation } from '../modules/administration/public.js'
import { authorizeAdministration, type AdminAuthority, type AdminCaller } from '../modules/identity/public.js'
import { CardService, type Card, type CardEdit } from '../modules/memory/public.js'

/** The card was replaced or ended; only a current card can be edited. Mapped to 409 `conflict`. */
export class CardReplacedError extends Error {
  constructor() { super('Card was replaced; only a current card can be edited') }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const cardId = (id: string): string => {
  if (!uuid.test(id)) throw new Error('Card not found')
  return id
}

export interface CardPageRequest { ended?: boolean | undefined; limit?: number | undefined; cursor?: string | null | undefined }

/**
 * The cards of every organization and the installation, for the owner or the admin agent. Cards come newest first,
 * current ones only unless `ended`; `cursor` is the `nextCursor` of the previous page.
 */
export async function listCards(db: Postgres, actor: AdminCaller, request: CardPageRequest = {}): Promise<{ cards: Card[]; nextCursor: string | null }> {
  if (request.cursor && !uuid.test(request.cursor)) throw new Error('Invalid card cursor')
  return db.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await authorizeAdministration(client, actor)
    return new CardService(db, actor.installationId).list({ scope: 'all', ended: request.ended === true, ...(request.limit !== undefined ? { limit: request.limit } : {}), cursor: request.cursor ?? null }, client)
  })
}

export async function readCard(db: Postgres, actor: AdminCaller, id: string): Promise<Card> {
  cardId(id)
  return db.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await authorizeAdministration(client, actor)
    const card = await new CardService(db, actor.installationId).get(id, client)
    if (!card) throw new Error('Card not found')
    return card
  })
}

/** JSON with sorted keys, so the same edit always has the same digest. */
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
    : JSON.stringify(value)

/**
 * Claims the caller's operation ID for a card action in the caller's transaction, or returns the operation already
 * recorded under it. The receipt keeps the card ID and a digest of the request, never the card's text, so a deleted card
 * leaves no copy of what it said.
 */
async function claimCardOperation(client: SqlClient, actor: AdminCaller, authority: AdminAuthority, operationId: string | undefined, kind: 'card.update' | 'card.delete', id: string, request: Record<string, unknown>): Promise<{ operation: Operation; claimed: boolean } | null> {
  if (operationId === undefined) return null
  return claimOperation(client, operationKey(actor, authority, operationId), kind, { kind: 'card', id }, { digest: createHash('sha256').update(canonical(request)).digest('hex') })
}

/**
 * Changes the type, subject, statement or details of a current card and marks it confirmed: the person, or the admin kip for
 * them, stated it. Changed content is embedded again by the next nightly run. Saving the card's current values changes
 * nothing. With an `operationId`, a repeat of the same edit changes nothing again and returns the card as it is now.
 */
export async function editCard(db: Postgres, actor: AdminCaller, id: string, edit: Omit<CardEdit, 'confirmed'>, operationId?: string): Promise<{ card: Card; alreadyApplied: boolean }> {
  cardId(id)
  const fields = Object.fromEntries((['type', 'subject', 'statement', 'details'] as const).flatMap(key => edit[key] === undefined ? [] : [[key, edit[key]]])) as Omit<CardEdit, 'confirmed'>
  if (!Object.keys(fields).length) throw new Error('Invalid card edit: nothing to change')
  return db.transaction(async client => {
    const authority = await authorizeAdministration(client, actor, true)
    const service = new CardService(db, actor.installationId)
    const receipt = await claimCardOperation(client, actor, authority, operationId, 'card.update', id, fields)
    const card = await service.get(id, client)
    if (!card) throw new Error('Card not found')
    if (receipt && !receipt.claimed) return { card, alreadyApplied: true }
    if (card.validTo) throw new CardReplacedError()
    const same = card.confirmed && (fields.type === undefined || fields.type.trim().toLowerCase() === card.type)
      && (fields.subject === undefined || fields.subject.trim() === card.subject) && (fields.statement === undefined || fields.statement.trim() === card.statement)
      && (fields.details === undefined || isDeepStrictEqual(fields.details, card.details))
    if (!same && !await service.update(id, { ...fields, confirmed: true }, [], client)) {
      if (await service.get(id, client)) throw new CardReplacedError()
      throw new Error('Card not found')
    }
    if (receipt) await completeOperation(client, receipt.operation.id, { cardId: id })
    return { card: same ? card : (await service.get(id, client))!, alreadyApplied: false }
  })
}

/**
 * Deletes a card with its sources and embedding; the messages it was learned from stay. A card it replaced keeps its end.
 * With an `operationId`, a repeat returns the first outcome.
 */
export async function deleteCard(db: Postgres, actor: AdminCaller, id: string, operationId?: string): Promise<{ cardId: string; deleted: boolean; alreadyApplied: boolean }> {
  cardId(id)
  return db.transaction(async client => {
    const authority = await authorizeAdministration(client, actor, true)
    const receipt = await claimCardOperation(client, actor, authority, operationId, 'card.delete', id, {})
    if (receipt && !receipt.claimed) return { ...receipt.operation.result as { cardId: string; deleted: boolean }, alreadyApplied: true }
    const result = { cardId: id, deleted: await new CardService(db, actor.installationId).delete([id], client) > 0 }
    if (receipt) await completeOperation(client, receipt.operation.id, result)
    return { ...result, alreadyApplied: false }
  })
}
