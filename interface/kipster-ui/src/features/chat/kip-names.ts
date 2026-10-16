import type { WorkspaceData } from './model'

/** A kip's name, as the message's readers know it. */
export const kipName = (data: WorkspaceData, agentId: string) =>
  data.actorsById[agentId]?.name ?? 'Unknown kip'

/** Names joined for a sentence: “Atlas”, “Atlas and Mira”, “Atlas, Mira and Rowan”. */
export const listNames = (names: string[]) =>
  names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
