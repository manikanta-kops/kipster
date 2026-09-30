/** Small wire helpers shared by the in-memory Core services. */
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

export class WireError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'Request failed'
  const status =
    error instanceof WireError
      ? error.status
      : /denied|mismatch|unauthorized/i.test(message)
        ? 403
        : /not found/i.test(message)
          ? 404
          : /Invalid|Expected|Unknown|Future|missing|required/i.test(message) ||
              error instanceof SyntaxError ||
              error instanceof TypeError
            ? 400
            : 500
  const code =
    error instanceof WireError
      ? error.code
      : status === 403
        ? 'forbidden'
        : status === 404
          ? 'not-found'
          : status === 400
            ? 'invalid'
            : 'unavailable'
  return json(
    {
      version: 1,
      code,
      message: status === 500 ? 'Request failed' : message,
      requestId: crypto.randomUUID(),
    },
    status,
  )
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid object')
  return value as Record<string, unknown>
}

export function fields(
  value: unknown,
  keys: string[],
  required: string[] = [],
): Record<string, unknown> {
  const row = record(value)
  if (
    Object.keys(row).some((key) => !keys.includes(key)) ||
    required.some((key) => row[key] === undefined)
  )
    throw new Error('Invalid fields')
  return row
}

export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length)
    throw new Error('Invalid text')
  return value
}

export async function body(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text()
  if (new TextEncoder().encode(raw).length > 64 * 1024)
    throw new Error('Invalid request body size')
  const row = record(JSON.parse(raw))
  if (row.version !== 1) throw new Error('Invalid protocol version')
  return row
}

export type Context =
  | { kind: 'installation'; installationId: string }
  | { kind: 'organization'; organizationId: string }
export function context(value: unknown): Context {
  const row = record(value)
  if (row.kind === 'installation') {
    fields(row, ['kind', 'installationId'], ['installationId'])
    return { kind: 'installation', installationId: text(row.installationId) }
  }
  if (row.kind === 'organization') {
    fields(row, ['kind', 'organizationId'], ['organizationId'])
    return { kind: 'organization', organizationId: text(row.organizationId) }
  }
  throw new Error('Invalid context')
}
export const contextId = (value: Context) =>
  value.kind === 'installation' ? value.installationId : value.organizationId
