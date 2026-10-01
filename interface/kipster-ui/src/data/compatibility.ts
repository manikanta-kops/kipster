import { protocolRange } from '@kipster/core/protocol'

/** The protocol number this app speaks: the current one of the Core it was built against. */
export const appProtocol: number = protocolRange.current

export type ProtocolRange = { current: number; oldest: number }
export type Compatibility = 'compatible' | 'update-app' | 'update-backend'

/** Decision record 5.1.7: the app blocks only when its protocol is outside Core's range. */
export function compatibility(
  range: ProtocolRange,
  protocol: number = appProtocol,
): Compatibility {
  if (protocol < range.oldest) return 'update-app'
  if (protocol > range.current) return 'update-backend'
  return 'compatible'
}

const protocolNumber = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0

export const isProtocolRange = (value: unknown): value is ProtocolRange =>
  !!value &&
  typeof value === 'object' &&
  protocolNumber((value as ProtocolRange).current) &&
  protocolNumber((value as ProtocolRange).oldest) &&
  (value as ProtocolRange).oldest <= (value as ProtocolRange).current
