import { isDeepStrictEqual } from 'node:util'
import type { Postgres } from '../platform/postgres/public.js'
import { authorizeAdministration, type AdminCaller } from '../modules/identity/public.js'
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

/**
 * Changes the type, subject, statement or details of a current card and marks it confirmed: the person, or Kip for
 * them, stated it. Changed content is embedded again by the next nightly run. Saving the card's current values changes
 * nothing, so a retried edit leaves it as it is.
 */
export async function editCard(db: Postgres, actor: AdminCaller, id: string, edit: Omit<CardEdit, 'confirmed'>): Promise<Card> {
  cardId(id)
  const fields = Object.fromEntries((['type', 'subject', 'statement', 'details'] as const).flatMap(key => edit[key] === undefined ? [] : [[key, edit[key]]])) as Omit<CardEdit, 'confirmed'>
  if (!Object.keys(fields).length) throw new Error('Invalid card edit: nothing to change')
  return db.transaction(async client => {
    await authorizeAdministration(client, actor, true)
    const service = new CardService(db, actor.installationId)
    const card = await service.get(id, client)
    if (!card) throw new Error('Card not found')
    if (card.validTo) throw new CardReplacedError()
    const same = card.confirmed && (fields.type === undefined || fields.type.trim().toLowerCase() === card.type)
      && (fields.subject === undefined || fields.subject.trim() === card.subject) && (fields.statement === undefined || fields.statement.trim() === card.statement)
      && (fields.details === undefined || isDeepStrictEqual(fields.details, card.details))
    if (same) return card
    if (!await service.update(id, { ...fields, confirmed: true }, [], client)) {
      if (await service.get(id, client)) throw new CardReplacedError()
      throw new Error('Card not found')
    }
    return (await service.get(id, client))!
  })
}

/** Deletes a card with its sources and embedding; the messages it was learned from stay. A card it replaced keeps its end. */
export async function deleteCard(db: Postgres, actor: AdminCaller, id: string): Promise<{ cardId: string; deleted: boolean }> {
  cardId(id)
  return db.transaction(async client => {
    await authorizeAdministration(client, actor, true)
    return { cardId: id, deleted: await new CardService(db, actor.installationId).delete([id], client) > 0 }
  })
}
