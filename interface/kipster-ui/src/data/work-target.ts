import type { WorkTarget } from './work.js'
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

/** Validate identity fields without depending on JSON property order. */
export function sameWorkTarget(value: unknown, expected: WorkTarget): boolean {
  if (!object(value) || !object(value.context)) return false
  if (
    !['installationId', 'callerId', 'chatId', 'threadId'].every(
      (key) =>
        id(value[key]) && value[key] === expected[key as keyof WorkTarget],
    )
  )
    return false
  const context = value.context
  if (context.kind !== expected.context.kind) return false
  return expected.context.kind === 'organization'
    ? id(context.organizationId) &&
        context.organizationId === expected.context.organizationId
    : context.kind === 'installation' &&
        id(context.installationId) &&
        context.installationId === expected.context.installationId
}
