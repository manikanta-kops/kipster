import { array, boolean, boundedString, literal, nonempty, nullable, object, optional, record, utcTimestamp, type Infer } from './schema.js'

const id = nonempty()

/** A user message a card was learned from. */
export const memoryCardSource = object({ threadId: id, messageId: id }, false)
/**
 * A card: a fact about the user that every kip of the installation shares. `organizationId` is null for an installation
 * card, otherwise the organization it was learned in. `confirmed` means the user said it; `core` cards are loaded on
 * every turn. A replaced card has `validTo` and names its replacement in `replacedBy`.
 */
export const memoryCard = object({
  id, type: nonempty(), subject: nonempty(), statement: nonempty(), details: record(), confirmed: boolean(), core: boolean(),
  organizationId: nullable(id), validFrom: utcTimestamp(), validTo: nullable(utcTimestamp()), replacedBy: nullable(id),
  createdAt: utcTimestamp(), updatedAt: utcTimestamp(), embedded: boolean(), sources: array(memoryCardSource),
}, false)
export type MemoryCard = Infer<typeof memoryCard>
/** Cards newest first. Pass `nextCursor` as `cursor` for the next page; null is the last page. */
export const memoryCardPage = object({ version: literal(1), cards: array(memoryCard), nextCursor: nullable(id) }, false)
export type MemoryCardPage = Infer<typeof memoryCardPage>
export const memoryCardResult = object({ version: literal(1), card: memoryCard }, false)
export type MemoryCardResult = Infer<typeof memoryCardResult>
/** A person's edit of a current card; omitted fields are unchanged and the card becomes confirmed. */
export const memoryCardUpdate = object({
  version: literal(1), type: optional(boundedString(1, 40)), subject: optional(boundedString(1, 200)), statement: optional(boundedString(1, 2000)), details: optional(record()),
})
export type MemoryCardUpdate = Infer<typeof memoryCardUpdate>
/** `deleted` is false when the card was already gone. */
export const memoryCardRemoval = object({ version: literal(1), cardId: id, deleted: boolean() }, false)
export type MemoryCardRemoval = Infer<typeof memoryCardRemoval>
