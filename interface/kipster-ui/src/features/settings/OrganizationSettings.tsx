import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { groupHue } from '../../app/appearance'
import type { CoreSettingsClient } from '../../data/core-settings'
import type { WorkspaceSnapshot } from '../../data/directory'
import { useSettingsDraft } from '../../data/use-settings-draft'
import { ExecutionEditor, type Settings } from './ExecutionSettings'
import { KipAvatar, type KipLook } from './KipAvatar'
import { Block, Callout, Glyph, Row, SaveRow } from './ui'
import { useSheet } from './sheet'
import { errorText } from './format'

const instructionLimit = 64 * 1024
const instructionsKey = (
  client: CoreSettingsClient,
  organizationId: string,
) => ['core-instructions', client.endpoint, organizationId]
function useInstructions(client: CoreSettingsClient, organizationId: string) {
  return useQuery({
    queryKey: instructionsKey(client, organizationId),
    queryFn: ({ signal }) => client.instructions(organizationId, signal),
    retry: false,
  })
}
const instructionsDraft = (journalScope: string, organizationId: string) =>
  JSON.stringify([journalScope, 'instructions', organizationId])

/** Defaults for member kips, shared instructions and groups of one organization. */
export function OrganizationPage({
  client,
  settings,
  journalScope,
  chosen,
  choose,
  workspace,
  look,
  manage,
}: {
  client: CoreSettingsClient
  settings: Settings
  journalScope: string
  chosen: string
  choose: (organizationId: string) => void
  workspace?: WorkspaceSnapshot
  look: (agentId: string) => KipLook
  manage?: ReactNode
}) {
  const organizations = settings.directory!.organizations.filter(
    (o) => o.lifecycle === 'active',
  )
  const organization =
    organizations.find((o) => o.id === chosen) ?? organizations[0]
  if (!organization) return <Callout>No organizations yet.</Callout>
  const members = settings.directory!.memberships.filter(
    (m) =>
      m.organizationId === organization.id &&
      settings.directory!.agents.some(
        (a) => a.id === m.agentId && a.lifecycle === 'active',
      ),
  )
  const groups =
    workspace?.groups.filter((g) => g.organizationId === organization.id) ?? []
  const description = workspace?.organizations.find(
    (o) => o.id === organization.id,
  )?.description
  const count = `${members.length} ${members.length === 1 ? 'kip' : 'kips'}${
    workspace
      ? ` in ${groups.length} ${groups.length === 1 ? 'group' : 'groups'}`
      : ''
  }.`
  return (
    <>
      <Block>
        <Row
          className="hero"
          lead={<Glyph icon="organization" hue="var(--hue-ocean)" size={40} />}
          label={<b className="set-hero-name">{organization.name}</b>}
          sub={
            description
              ? `${description.replace(/([^.!?])$/, '$1.')} ${count}`
              : count
          }
          control={
            organizations.length > 1 && (
              <select
                aria-label="Organization"
                value={organization.id}
                onChange={(e) => choose(e.target.value)}
              >
                {organizations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            )
          }
        />
      </Block>
      <ExecutionEditor
        key={`${journalScope}:${organization.id}`}
        journalScope={journalScope}
        title="Default execution settings"
        label="Defaults for member kips"
        foot="Members use these unless they have their own setting. Adapter and model can be changed but not removed."
        target="organization"
        id={organization.id}
        saved={settings.saved!.organizations[organization.id]?.settings ?? {}}
        adapters={settings.adapters}
        save={settings.saveSettings}
      />
      <InstructionsRow
        key={`instructions:${journalScope}:${organization.id}`}
        client={client}
        journalScope={journalScope}
        organizationId={organization.id}
        name={organization.name}
      />
      {(workspace || manage) && (
        <Block label="Groups">
          {groups.map((group, index) => {
            const people = (workspace?.groupAssignments ?? [])
              .filter((a) => a.groupId === group.id)
              .map(
                (a) =>
                  workspace!.memberships.find((m) => m.id === a.membershipId)
                    ?.actorId,
              )
              .filter(
                (id): id is string =>
                  !!id && workspace!.actorsById[id]?.kind === 'agent',
              )
            return (
              <Row
                key={group.id}
                lead={
                  <i
                    className="set-group-dot"
                    style={{ background: groupHue(index) }}
                    aria-hidden="true"
                  />
                }
                label={group.name}
                sub={
                  people
                    .map((id) => workspace!.actorsById[id].name)
                    .join(', ') || 'No kips'
                }
                control={
                  people.length > 0 && (
                    <span className="set-avatars" aria-hidden="true">
                      {people.slice(0, 5).map((id) => (
                        <KipAvatar key={id} look={look(id)} size="small" />
                      ))}
                    </span>
                  )
                }
              />
            )
          })}
          {manage}
        </Block>
      )}
    </>
  )
}

function InstructionsRow({
  client,
  journalScope,
  organizationId,
  name,
}: {
  client: CoreSettingsClient
  journalScope: string
  organizationId: string
  name: string
}) {
  const { push } = useSheet()
  const query = useInstructions(client, organizationId)
  const [draft] = useSettingsDraft<string | null>(
    instructionsDraft(journalScope, organizationId),
    null,
  )
  const text = draft ?? query.data ?? ''
  const preview = text
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line && line !== name)
  return (
    <Block
      label="Shared instructions"
      foot={`Every kip in ${name} reads these on its next run.`}
    >
      <Row
        label="Instructions"
        changed={draft !== null && draft !== query.data}
        sub={
          query.isError
            ? 'Instructions could not be loaded.'
            : query.isPending
              ? 'Loading…'
              : preview || 'None yet'
        }
        subTone={query.isError ? 'bad' : undefined}
        chevron
        onClick={() =>
          push({
            kind: 'instructions',
            organizationId,
            title: 'Shared instructions',
          })
        }
      />
    </Block>
  )
}

/** The organization's shared instructions in an editor. Drafts survive closing Settings. */
export function InstructionsPage({
  client,
  journalScope,
  organizationId,
  name,
}: {
  client: CoreSettingsClient
  journalScope: string
  organizationId: string
  name: string
}) {
  const queries = useQueryClient()
  const query = useInstructions(client, organizationId)
  const [draft, setDraft] = useSettingsDraft<string | null>(
    instructionsDraft(journalScope, organizationId),
    null,
  )
  const [status, setStatus] = useState<
    'idle' | 'saving' | 'saved' | { error: string }
  >('idle')
  const text = draft ?? query.data ?? ''
  const tooLarge = new TextEncoder().encode(text).length > instructionLimit
  const changed = draft !== null && draft !== query.data
  async function save() {
    const content = text
    setStatus('saving')
    try {
      const saved = await client.saveInstructions(
        organizationId,
        content,
        AbortSignal.timeout(20000),
      )
      queries.setQueryData(instructionsKey(client, organizationId), saved)
      setDraft((current) => (current === content ? null : current))
      setStatus('saved')
    } catch (error) {
      setStatus({ error: errorText(error) })
    }
  }
  const state =
    status === 'saving'
      ? 'saving'
      : changed
        ? 'dirty'
        : status === 'saved'
          ? 'saved'
          : null
  return (
    <section aria-label="Organization instructions" className="set-block">
      <div className="set-group">
        <textarea
          className="set-editor"
          aria-label="Organization instructions"
          spellCheck={false}
          value={text}
          disabled={query.isPending}
          aria-invalid={tooLarge}
          onChange={(e) => {
            setDraft(e.target.value)
            if (status !== 'saving') setStatus('idle')
          }}
        />
        {state && (
          <SaveRow state={state}>
            {state === 'dirty' && (
              <>
                <button
                  className="set-button"
                  aria-label="Discard changes"
                  onClick={() => {
                    setDraft(null)
                    setStatus('idle')
                  }}
                >
                  Discard
                </button>
                <button
                  className="set-button primary"
                  aria-label="Save instructions"
                  disabled={tooLarge}
                  onClick={() => void save()}
                >
                  Save
                </button>
              </>
            )}
          </SaveRow>
        )}
      </div>
      <p className="set-foot">
        Markdown. Every kip in {name} reads these on its next run. The latest
        save wins.
      </p>
      {query.isError && (
        <p role="alert" className="set-alert">
          Instructions could not be loaded.
          <button className="set-link" onClick={() => void query.refetch()}>
            Retry
          </button>
        </p>
      )}
      {tooLarge && (
        <p role="alert" className="set-alert">
          Instructions are limited to 64 KB. Shorten them to save.
        </p>
      )}
      {typeof status === 'object' && (
        <p role="alert" className="set-alert">
          Not saved: {status.error} Your text is kept here.
        </p>
      )}
    </section>
  )
}
