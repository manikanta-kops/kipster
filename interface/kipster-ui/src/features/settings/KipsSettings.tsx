import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { CoreSettingsClient, Directory } from '../../data/core-settings'
import { ExecutionEditor, NextRun, type Settings } from './ExecutionSettings'
import { effectiveQuery, readiness } from './effective'
import { IdentityGroup } from './IdentityFiles'
import { KipAvatar, type KipLook } from './KipAvatar'
import { KipLearning } from './LearningSettings'
import { Block, Callout, Row, StatusDot } from './ui'
import { useSheet } from './sheet'

function agentOrganizations(directory: Directory, agentId: string) {
  const active = new Set(
    directory.organizations
      .filter((o) => o.lifecycle === 'active')
      .map((o) => o.id),
  )
  return directory.memberships
    .filter((m) => m.agentId === agentId && active.has(m.organizationId))
    .map((m) => directory.organizations.find((o) => o.id === m.organizationId)!)
}
const listed = (directory: Directory) =>
  directory.agents
    .filter((a) => a.lifecycle !== 'deleted')
    .sort(
      (a, b) =>
        Number(b.admin) - Number(a.admin) ||
        Number(a.lifecycle === 'archived') - Number(b.lifecycle === 'archived'),
    )

function Tags({ admin, archived }: { admin?: boolean; archived?: boolean }) {
  return (
    <>
      {admin && <em className="set-tag">Admin</em>}
      {archived && <em className="set-tag">Archived</em>}
    </>
  )
}

/** Every kip, with what it runs on, opening into its own page. */
export function KipsPage({
  client,
  settings,
  look,
}: {
  client: CoreSettingsClient
  settings: Settings
  look: (agentId: string) => KipLook
}) {
  const directory = settings.directory!
  const { push } = useSheet()
  const agents = listed(directory)
  const admin = agents.find((a) => a.admin)
  if (!agents.length) return <Callout>No kips yet.</Callout>
  return (
    <Block
      foot={
        admin
          ? `${admin.name} is your main kip and works outside organizations. The others use their organization’s defaults unless they have their own.`
          : 'Kips use their organization’s defaults unless they have their own.'
      }
    >
      {agents.map((agent) => {
        const kip = look(agent.id)
        return (
          <Row
            key={agent.id}
            lead={<KipAvatar look={kip} />}
            label={
              <>
                {agent.name}
                <Tags
                  admin={agent.admin}
                  archived={agent.lifecycle === 'archived'}
                />
              </>
            }
            sub={kip.description || (agent.admin ? 'Your main kip' : undefined)}
            control={
              <KipSummary
                client={client}
                agentId={agent.id}
                organizationId={
                  agent.admin
                    ? null
                    : (agentOrganizations(directory, agent.id)[0]?.id ?? null)
                }
              />
            }
            chevron
            onClick={() =>
              push({ kind: 'kip', agentId: agent.id, title: agent.name })
            }
          />
        )
      })}
    </Block>
  )
}
function KipSummary({
  client,
  agentId,
  organizationId,
}: {
  client: CoreSettingsClient
  agentId: string
  organizationId: string | null
}) {
  const { data } = useQuery(effectiveQuery(client, agentId, organizationId))
  if (!data) return null
  const tone = readiness(data.status)
  return (
    <span className="set-summary">
      {tone !== 'run' && <StatusDot tone={tone} />}
      {[data.settings.adapterId, data.settings.modelId]
        .filter(Boolean)
        .join(' · ')}
    </span>
  )
}

/** One kip: what it runs on, what its next run will use, its identity and learning. */
export function KipPage({
  client,
  settings,
  journalScope,
  endpoint,
  agentId,
  look,
}: {
  client: CoreSettingsClient
  settings: Settings
  journalScope: string
  endpoint: string
  agentId: string
  look: (agentId: string) => KipLook
}) {
  const directory = settings.directory!
  const agent = directory.agents.find(
    (a) => a.id === agentId && a.lifecycle !== 'deleted',
  )
  const organizations = agent?.admin
    ? []
    : agentOrganizations(directory, agentId)
  const [chosenOrganization, setChosenOrganization] = useState<string | null>(
    null,
  )
  if (!agent) return <Callout>This kip is no longer available.</Callout>
  const organization =
    organizations.find((o) => o.id === chosenOrganization) ?? organizations[0]
  const organizationId = organization?.id ?? null
  const kip = look(agent.id)
  const archived = agent.lifecycle === 'archived'
  return (
    <>
      <Block>
        <Row
          className="hero"
          lead={<KipAvatar look={kip} size="hero" />}
          label={
            <>
              <b className="set-hero-name">{agent.name}</b>
              <Tags admin={agent.admin} archived={archived} />
            </>
          }
          sub={
            <>
              {kip.description && (
                <span className="set-line">{kip.description}</span>
              )}
              <span className="set-line set-muted">
                {agent.admin
                  ? 'Works outside organizations'
                  : organizations.map((o) => o.name).join(' · ') ||
                    'Not in an organization'}
              </span>
            </>
          }
          control={
            organizations.length > 1 && (
              <select
                aria-label="Organization"
                title="Whose defaults to show and check against"
                value={organizationId ?? ''}
                onChange={(e) => setChosenOrganization(e.target.value)}
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
        key={`${journalScope}:${agent.id}`}
        journalScope={journalScope}
        title="Own settings"
        label="Model"
        foot={
          agent.admin
            ? 'Your main kip works outside organizations. Without its own settings, it uses the default adapter and model.'
            : `Without its own setting, each value comes from ${organization?.name ?? 'the organization'}’s defaults.`
        }
        target="agent"
        id={agent.id}
        saved={settings.saved!.agents[agent.id]?.settings ?? {}}
        inherited={
          agent.admin
            ? undefined
            : organizationId
              ? (settings.saved!.organizations[organizationId]?.settings ?? {})
              : {}
        }
        adapters={settings.adapters}
        save={settings.saveSettings}
        reset={
          agent.admin ? 'Use adapter defaults' : 'Use organization defaults'
        }
      />
      <NextRun
        client={client}
        agentId={agent.id}
        organizationId={organizationId}
      />
      <IdentityGroup
        endpoint={endpoint}
        agentId={agent.id}
        name={agent.name}
        admin={directory.agents.find((a) => a.admin)?.name}
        readOnly={archived}
      />
      <KipLearning
        key={`learning:${agent.id}`}
        agentId={agent.id}
        settings={settings}
      />
    </>
  )
}
