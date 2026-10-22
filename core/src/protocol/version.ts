/**
 * Protocol numbers this Core serves. Raise `current` for a change that released
 * clients cannot read, and keep `oldest` for at least one release afterwards.
 * A client speaks `current` from the Core it was built against. See decision record 5.1.7.
 */
export const protocolRange = { current: 1, oldest: 1 } as const
