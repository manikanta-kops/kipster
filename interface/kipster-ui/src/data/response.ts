export class TextHttpError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

export const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function incompatible(
  message = 'Backend response is incompatible. Update the client and reconnect.',
): never {
  throw new TextHttpError(message, 'incompatible')
}

export function check(condition: boolean): asserts condition {
  if (!condition) incompatible()
}

/** Keep readable items without losing a response to one broken entry. */
export function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  check(Array.isArray(value))
  const items: T[] = []
  for (const item of value) {
    try {
      items.push(parse(item))
    } catch (error) {
      if (!(error instanceof TextHttpError) || error.code !== 'incompatible')
        throw error
    }
  }
  return items
}
