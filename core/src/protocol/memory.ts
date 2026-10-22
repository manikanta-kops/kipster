import { array, boolean, boundedString, integer, literal, nonempty, nullable, object, optional, record, utcTimestamp, type Infer } from './schema.js'

const id = nonempty()

/** A message a memory or lesson was learned from. */
export const memorySource = object({ threadId: id, messageId: id }, false)
/**
 * A memory: a fact about the person that every kip of the installation shares. `organizationId` is null for an
 * installation memory, otherwise the organization it was learned in. `confirmed` means the person said it; `core`
 * memories are loaded on every turn. A replaced memory has `validTo` and names its replacement in `replacedBy`; a retired
 * one has `validTo` alone.
 */
export const memory = object({
  id, type: nonempty(), subject: nonempty(), statement: nonempty(), details: record(), confirmed: boolean(), core: boolean(),
  organizationId: nullable(id), validFrom: utcTimestamp(), validTo: nullable(utcTimestamp()), replacedBy: nullable(id),
  createdAt: utcTimestamp(), updatedAt: utcTimestamp(), embedded: boolean(), sources: array(memorySource),
}, false)
export type MemoryRecord = Infer<typeof memory>
/** Memories newest first. Pass `nextCursor` as `cursor` for the next page; null is the last page. */
export const memoryPage = object({ version: literal(1), memories: array(memory), nextCursor: nullable(id) }, false)
export type MemoryPage = Infer<typeof memoryPage>
export const memoryResult = object({ version: literal(1), memory }, false)
export type MemoryResult = Infer<typeof memoryResult>
/** A person's edit of a current memory; omitted fields are unchanged and the memory becomes confirmed. */
export const memoryUpdate = object({
  version: literal(1), type: optional(boundedString(1, 40)), subject: optional(boundedString(1, 200)), statement: optional(boundedString(1, 2000)), details: optional(record()),
})
export type MemoryUpdate = Infer<typeof memoryUpdate>
/** `deleted` is false when the memory was already gone. */
export const memoryRemoval = object({ version: literal(1), memoryId: id, deleted: boolean() }, false)
export type MemoryRemoval = Infer<typeof memoryRemoval>

/**
 * A lesson: how one kip should do its work, kept for that kip in every workspace. `organizationId` is the workspace it
 * was learned in, or null. `confirmations` counts the nights it came up; the kip's 10 most confirmed are in the Learned
 * section of its identity.md. An ended lesson has `validTo`, and `replacedBy` when a merge took its place.
 */
export const lesson = object({
  id, agentId: id, organizationId: nullable(id), statement: nonempty(), confirmations: integer(), lastConfirmedNight: nonempty(),
  validFrom: utcTimestamp(), validTo: nullable(utcTimestamp()), replacedBy: nullable(id),
  createdAt: utcTimestamp(), updatedAt: utcTimestamp(), embedded: boolean(), sources: array(memorySource),
}, false)
export type LessonRecord = Infer<typeof lesson>
/** Lessons newest first. Pass `nextCursor` as `cursor` for the next page; null is the last page. */
export const lessonPage = object({ version: literal(1), lessons: array(lesson), nextCursor: nullable(id) }, false)
export type LessonPage = Infer<typeof lessonPage>
export const lessonResult = object({ version: literal(1), lesson }, false)
export type LessonResult = Infer<typeof lessonResult>
/** A person's correction of a current lesson's wording. */
export const lessonUpdate = object({ version: literal(1), statement: boundedString(1, 1000) })
export type LessonUpdate = Infer<typeof lessonUpdate>
/** `deleted` is false when the lesson was already gone. */
export const lessonRemoval = object({ version: literal(1), lessonId: id, deleted: boolean() }, false)
export type LessonRemoval = Infer<typeof lessonRemoval>
