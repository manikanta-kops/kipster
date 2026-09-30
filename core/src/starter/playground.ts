import { readFile } from 'node:fs/promises'
import { identityFileNames } from '../platform/home/public.js'
import type { AgentFiles, Starter } from '../modules/administration/public.js'

export const playgroundNames = { owner: 'Owner', organization: 'Playground', rootAgent: 'Kip' } as const

const agents = [
  { key: 'planner', name: 'Planner', description: 'Turns goals into plans and hands each step to the right teammate.' },
  { key: 'researcher', name: 'Researcher', description: 'Reads, compares and explains, including attached files.' },
  { key: 'writer', name: 'Writer', description: 'Drafts posts, emails and documents and saves them as files.' },
  { key: 'coach', name: 'Coach', description: 'Helps with personal goals and habits and remembers progress.' },
] as const

const text = (path: string): Promise<string> => readFile(new URL(`./playground/${path}`, import.meta.url), 'utf8')

async function files(key: string): Promise<AgentFiles> {
  return Object.fromEntries(await Promise.all(identityFileNames.map(async file => [file, await text(`${key}/${file}`)] as const)))
}

/** The content a new installation starts with: the Playground organization, Kip and a team of four agents in two groups. */
export async function playground(): Promise<Starter> {
  return {
    organization: { description: 'A starter organization for trying Kipster.', instructions: await text('organization.md') },
    rootAgent: { description: 'Manages organizations, agents, groups and settings.', files: await files('admin') },
    agents: await Promise.all(agents.map(async agent => ({ ...agent, files: await files(agent.key) }))),
    groups: [
      { name: 'Team', agents: ['planner', 'researcher', 'writer'] },
      { name: 'Personal', agents: ['coach'] },
    ],
  }
}
