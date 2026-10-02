import { fileURLToPath } from 'node:url'

/** A how-to file shipped with Core. A run's instructions name it; the agent reads the file when it does that work. */
export interface Skill { readonly name: string; readonly description: string; readonly path: string }

const skill = (name: string, description: string): Skill => ({ name, description, path: fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url)) })

export const adminSkill = skill('kipster-admin', 'Change anything in Kipster for the person: workspaces, kips and their identity files, groups, execution settings, learning, appearance, notifications and updates.')

/** The instructions section that names the skills of a run. */
export function skillsSection(skills: readonly Skill[]): string {
  if (!skills.length) return ''
  return `Skills. Before work that matches a skill, read its file with your file tools and follow it.\n${skills.map(item => `- ${item.name}: ${item.description} File: ${item.path}`).join('\n')}`
}
