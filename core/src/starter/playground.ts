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

/** The admin kip's daily check-ins. A run with nothing worth telling sends nothing. */
const routines = [
  {
    name: 'Morning check-in',
    triggers: [{ type: 'times', times: ['08:00'] }],
    instructions: 'Look across Kipster since your last check-in. List threads with list_threads: what each kip did, what finished, what failed and what is waiting on the person, such as a question, an approval or a rich doc to review. If the person has connected services such as email, calendar or tasks, check them too: action items, replies they owe, anything due or coming up today, and anything they sent that is still unanswered after two days or more, such as a request to a bank or an airline. Follow up on what you can yourself, and prepare replies as drafts. Then send one short brief with priority normal only if something needs the person: what needs them today first, then what is waiting on others. If nothing needs them, send nothing.',
  },
  {
    name: 'Evening wrap-up',
    triggers: [{ type: 'times', times: ['18:00'] }],
    instructions: 'Look at what happened across Kipster today with list_threads, and in the person\'s connected services if they have any. Close loops: follow up with kips on unfinished work and note what is still open. If it helps, suggest up to three tasks for tomorrow. Send a short summary with priority silent of what got done and what needs the person tomorrow. If the day was quiet, send nothing.',
  },
]

const text = (path: string): Promise<string> => readFile(new URL(`./playground/${path}`, import.meta.url), 'utf8')

async function files(key: string): Promise<AgentFiles> {
  return Object.fromEntries(await Promise.all(identityFileNames.map(async file => [file, await text(`${key}/${file}`)] as const)))
}

/** The content a new installation starts with: the Playground organization, the admin kip with its daily check-ins and a team of four agents in two groups. */
export async function playground(): Promise<Starter> {
  return {
    organization: { description: 'A starter organization for trying Kipster.', instructions: await text('organization.md') },
    rootAgent: { description: 'Manages organizations, agents, groups and settings.', files: await files('admin') },
    agents: await Promise.all(agents.map(async agent => ({ ...agent, files: await files(agent.key) }))),
    groups: [
      { name: 'Team', agents: ['planner', 'researcher', 'writer'] },
      { name: 'Personal', agents: ['coach'] },
    ],
    routines,
  }
}
