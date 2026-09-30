import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Postgres } from '../../dist/platform/postgres/public.js'
import { openRuntime, TextDispatcher, textPublicationHost } from '../../dist/runtime.js'
import { MAINTENANCE_SWEEP_JOB_ID } from '../../dist/modules/memory/public.js'
import { acceptText, resolveDirectChat } from '../../dist/modules/conversations/public.js'
import { addMembership, changeSettings, createAgent, createOrganization } from '../../dist/modules/administration/public.js'
import { fixtureAdapter } from '../.build/tests/fixtures/deterministic-adapter.js'
import { adminUrl } from '../support/database.mjs'

// A small runner for memory scenarios. A story drives the real dispatcher against its own PostgreSQL database and
// agent home: people chat with agents inside and outside organizations, the clock moves on, and the agents sleep.
// The deterministic fixture adapter stands in for every model call. Replies, extracted facts, consolidation verdicts
// and Learned sections are scripted by the story, so scenarios test what Core does with them, never model quality.

const fixture = { adapterId: { set: 'deterministic-fixture' }, modelId: { set: 'fixture-model' } }
const profile = { id: 'ollama', contractMajor: 1, model: 'fixture-embedding' }
const dimensions = 512
const terminalSources = ['committed', 'skipped', 'fenced', 'superseded', 'source_deleted']

// A deterministic stand-in for an embedding model: texts that share words are near each other, texts that share
// none are orthogonal. Common words are ignored.
const common = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'we', 'with'])
function embedWords(text) {
  const values = Array(dimensions).fill(0)
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (common.has(word)) continue
    let hash = 2166136261
    for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
    values[hash % (dimensions - 1)] += 1
  }
  if (values.every(value => value === 0)) values[dimensions - 1] = 1
  return values
}

/** Polls `read` until `predicate` holds. */
export async function until(read, predicate, label, attempts = 1000) {
  let value
  for (let i = 0; i < attempts; i++) {
    value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${label} (last value: ${JSON.stringify(value)?.slice(0, 200)})`)
}

/** Memory excerpts an execution received as automatic context, in order: `{ id, text, contradicts }`. */
export function excerpts(memory) {
  return memory.flatMap(block => block.split('\n').slice(1)).map(line => {
    const label = line.slice(0, line.indexOf('] ') + 1)
    return { id: /^\[memory (\S+) /.exec(label)[1], text: line.slice(label.length + 1), contradicts: /; contradicts (\S+) via /.exec(label)?.[1] ?? null }
  })
}

/**
 * Opens a story that starts at `start` (local time) with the installation's root agent learning. The story closes
 * itself when the test ends.
 */
export async function story(t, { start = new Date(2026, 2, 2, 9) } = {}) {
  const admin = new Postgres(adminUrl)
  const database = `kipster_scenario_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE DATABASE "${database}"`)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const home = await mkdtemp(join(tmpdir(), 'kipster-scenario-'))
  const s = {
    url, home, now: new Date(start), executions: [], handled: new Set(), facts: new Map(), agents: [],
    /** The embedding service. While it is down, indexing and query embedding fail. */
    embedding: { down: false },
  }
  const embedder = {
    async embed(text) {
      if (s.embedding.down) throw new Error('Embedding service unavailable')
      return embedWords(text)
    },
  }

  s.open = async () => {
    s.runtime = await openRuntime({ connectionString: url.href, home, clock: () => s.now, names: { owner: 'Owner', organization: 'Northwind', rootAgent: 'Kip' }, embedding: { ...profile, ...embedder } })
    // Indexing runs when the story says, so every night sees the same vectors.
    await s.runtime.memory.stopIndexing()
    s.db = s.runtime.db
    let dispatcher
    s.adapter = fixtureAdapter({ now: () => new Date().toISOString(), invokeTool: request => textPublicationHost(dispatcher).invokeTool(request) })
    dispatcher = new TextDispatcher(s.runtime, { ...s.adapter, async execute(context) { const handle = await s.adapter.execute(context); s.executions.push({ context, handle }); return handle } })
    s.dispatcher = dispatcher
    await dispatcher.start()
  }
  /** Stops Core as a shutdown would. `restart()` opens it again on the same database and home. */
  s.stop = async () => {
    await s.dispatcher.close().catch(() => undefined)
    await s.runtime.close().catch(() => undefined)
  }
  s.restart = async () => { await s.stop(); await s.open() }

  await s.open()
  t.after(async () => {
    await s.stop()
    await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin.close().catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  })

  s.owner = { installationId: s.runtime.bootstrap.installationId, personId: s.runtime.bootstrap.ownerId }
  s.agent = s.runtime.bootstrap.rootAgentId
  s.agents.push(s.agent)
  await changeSettings(s.db, s.owner, randomUUID(), 'agent', s.agent, fixture)
  await s.runtime.learning.setInstallation(s.owner, { enabled: true })

  // Places where people talk to agents: outside any organization, or inside one.
  const place = (name, organizationId) => {
    const context = organizationId ? { kind: 'organization', organizationId } : { kind: 'installation', installationId: s.owner.installationId }
    const chats = new Map()
    const where = {
      name, organizationId, context,
      chatWith: async agentId => {
        if (!chats.has(agentId)) chats.set(agentId, (await resolveDirectChat(s.db, s.owner, context, agentId)).chatId)
        return chats.get(agentId)
      },
      /** A human message to an agent, answered with `reply`; extraction then learns `learn` from the conversation. */
      chat: (message, options) => s.chat(where, message, options),
    }
    return where
  }
  /** Conversations outside any organization. */
  s.home = place('home', null)
  /** The organization the installation starts with. */
  s.northwind = place('Northwind', s.runtime.bootstrap.organizationId)

  /** Creates an organization that the root agent belongs to. */
  s.organization = async name => {
    const { organization } = await createOrganization(s.db, s.runtime.home, s.owner, randomUUID(), { name })
    await addMembership(s.db, s.owner, randomUUID(), organization.id, s.agent)
    return place(name, organization.id)
  }
  /** Creates another agent on the fixture model, optionally as a member of organizations. */
  s.hire = async (name, { organizations = [] } = {}) => {
    const { agent } = await createAgent(s.db, s.runtime.home, s.owner, randomUUID(), { name, settings: fixture })
    for (const organization of organizations) await addMembership(s.db, s.owner, randomUUID(), organization.organizationId, agent.id)
    s.agents.push(agent.id)
    return agent.id
  }

  /** Accepts a human message for `agent` in `where`. Returns the run. */
  s.send = async (where, message, agent = s.agent) => acceptText(s.db, s.runtime.jobs, s.runtime.artifacts, s.owner, {
    version: 1, submissionId: randomUUID(),
    scope: { installationId: s.owner.installationId, callerId: s.owner.personId },
    target: { context: where.context, chatId: await where.chatWith(agent) }, mode: 'root', parts: [{ kind: 'text', text: message }],
  })
  /** The next live execution of a run: its context, tool calls and a way to finish it with a reply. */
  s.execution = async (runId, after = 0) => {
    const found = await until(() => s.executions.filter(e => e.context.runId === runId && e.context.kind !== 'maintenance')[after], Boolean, `execution of ${runId}`)
    const attemptId = found.context.attemptId
    return {
      context: found.context, handle: found.handle,
      memory: excerpts(found.context.memory ?? []),
      call: (name, args) => found.handle.callTool(randomUUID(), name, args),
      finish: reply => {
        found.handle.release({ kind: 'text', attemptId, messageId: 'answer', text: reply, final: true })
        found.handle.release({ kind: 'ended', attemptId, confirmed: true })
      },
    }
  }
  s.completed = runId => until(async () => (await s.row('SELECT state FROM kipster.text_runs WHERE id=$1', [runId])).state, state => state === 'completed', `run ${runId} completed`)

  s.chat = async (where, message, { agent = s.agent, reply = 'Noted.', learn = [], tools } = {}) => {
    const run = await s.send(where, message, agent)
    const live = await s.execution(run.runId)
    const used = tools ? await tools(live.call) : undefined
    live.finish(reply)
    await s.completed(run.runId)
    const learned = await s.extract(run.runId, learn)
    return { runId: run.runId, memory: live.memory, instructions: live.context.instructions, used, learned }
  }

  /** Runs extraction for a completed run until its source is settled, answering with `facts`. Extractions of other
   * runs that come up meanwhile learn what the story scripted for them, or nothing. Returns the source status,
   * undefined when nothing was captured, or `refused: <reason>` when Core rejected the answer. */
  s.extract = async (runId, facts = []) => {
    s.facts.set(runId, facts)
    const status = async () => (await s.row('SELECT status FROM kipster.maintenance_sources WHERE run_id=$1', [runId]))?.status
    for (let turn = 0; turn < 10; turn++) {
      const current = await status()
      if (current === undefined || terminalSources.includes(current)) return current
      await s.db.transaction(client => s.runtime.jobs.send(client, MAINTENANCE_SWEEP_JOB_ID))
      const found = await until(() => s.executions.find(e => e.context.maintenance?.task === 'extract' && !s.handled.has(e)), Boolean, 'an extraction')
      s.handled.add(found)
      const source = found.context.maintenance.sourceRunId
      const state = await answerWith(found, JSON.stringify({ candidates: await candidates(source, s.facts.get(source) ?? []) }))
      if (state === 'failed' && source === runId) return `refused: ${(await s.row('SELECT failure FROM kipster.maintenance_runs WHERE id=$1', [found.context.runId])).failure}`
    }
    throw new Error(`Extraction of ${runId} did not settle`)
  }
  /** Extraction candidates citing the source's messages. `from` is 'human', 'agent' (the agent that answered) or an
   * agent id; the excerpt defaults to the whole cited message. */
  const candidates = async (sourceRunId, facts) => {
    const { manifest, agent_id: owner } = await s.row('SELECT manifest, agent_id FROM kipster.maintenance_sources WHERE run_id=$1', [sourceRunId])
    const result = []
    for (const fact of facts) {
      const from = fact.from ?? 'human'
      const entry = manifest.entries.findLast(item => from === 'human' ? item.author_class === 'human' : item.author_id === (from === 'agent' ? owner : from))
      if (!entry) throw new Error(`No message from ${from} to cite`)
      const text = (await s.row('SELECT parts FROM kipster.messages WHERE id=$1', [entry.message_id])).parts[0].text
      result.push({
        kind: fact.kind ?? 'fact', text: fact.text, subject: fact.subject ?? 'notes', author_id: entry.author_id, author_class: entry.author_class,
        ...(fact.importance === undefined ? {} : { importance: fact.importance }),
        ...(fact.explicit === undefined ? {} : { explicit: fact.explicit }),
        citations: [{ message_id: entry.message_id, revision: entry.revision, parts_hash: entry.parts_sha256, excerpt: fact.excerpt ?? text }],
      })
    }
    return result
  }
  const started = new WeakSet()
  const startModel = found => {
    if (started.has(found)) return
    started.add(found)
    found.handle.release({ kind: 'provider', attemptId: found.context.attemptId, threadId: 'fixture-thread', processId: 4242, providerStateScope: 'shared-codex-home', workingDirectory: '/tmp/fixture', modelId: 'fixture-model' })
  }
  const answerWith = async (found, text) => {
    const attemptId = found.context.attemptId
    startModel(found)
    found.handle.release({ kind: 'text', attemptId, messageId: 'output', text, final: true })
    found.handle.release({ kind: 'ended', attemptId, confirmed: true })
    return until(async () => (await s.row('SELECT state FROM kipster.maintenance_runs WHERE id=$1', [found.context.runId]))?.state,
      state => ['completed', 'failed'].includes(state), `maintenance run ${found.context.runId} settled`)
  }

  const setClock = date => { s.now = date }
  const days = n => { const next = new Date(s.now); next.setDate(next.getDate() + n); return next }
  /** Busy days: the clock moves on and each learning agent's active-day counter advances by one per day, as a day
   * of work does in Core. Memories age only on active days. */
  s.work = async n => {
    setClock(days(n))
    await s.db.query(`INSERT INTO kipster.memory_activity(agent_id, active_on, active_days)
      SELECT g.id, $3::date, $2 FROM kipster.agents g JOIN kipster.installations i ON i.id=g.installation_id
      WHERE g.id=ANY($1::uuid[]) AND i.learning_enabled AND g.learning_enabled
      ON CONFLICT (agent_id) DO UPDATE SET active_days=memory_activity.active_days+EXCLUDED.active_days, active_on=EXCLUDED.active_on`, [s.agents, n, s.now.toISOString().slice(0, 10)])
  }
  /** Quiet days: the clock moves on while nobody works. */
  s.idle = async n => { setClock(days(n)) }
  /** Moves the clock to a local time today, or tomorrow when that time has passed. */
  s.at = async (hours, minutes = 0) => {
    const next = new Date(s.now)
    next.setHours(hours, minutes, 0, 0)
    if (next <= s.now) next.setDate(next.getDate() + 1)
    setClock(next)
  }

  /** Indexes every pending memory, as the background indexer would. Stops when a pass makes no progress. */
  s.index = async () => {
    for (let pass; (pass = await s.runtime.memory.indexPending(20, true)).processed > pass.failed;);
  }

  /**
   * The night: the clock moves to 01:00 (or `at`), pending memories are indexed and the maintenance tick sleeps every
   * learning agent. Each model request a sleep makes is answered from the story's script: `consolidation` gives
   * verdicts and lessons, with memories named by text ({ same, contradicts, related: [[a, b]], lessons: [{ text,
   * from: [a, b] }] }; nothing by default), and `promotion` gives the new Learned section (a string, or a function of
   * the request). Returns the agent's sleep with the requests its model received; the clock then moves to 09:00.
   */
  s.night = async ({ consolidation = {}, promotion, agent = s.agent, at = [1, 0] } = {}) => {
    await s.bedtime(at)
    const asked = {}
    for (;;) {
      await s.tick()
      const request = await s.request()
      if (!request) break
      if (request.agentId === agent) asked[request.task === 'identity' ? 'promotion' : 'consolidation'] = request.input
      await s.respond(request, request.agentId === agent ? { consolidation, promotion } : {})
    }
    await s.at(9)
    return { ...await s.lastSleep(agent), ...asked }
  }
  /** Moves the clock to the sleep time and indexes pending memories, unless the embedding service is down. */
  s.bedtime = async (at = [1, 0]) => {
    await s.at(...at)
    if (!s.embedding.down) await s.index()
  }
  /** One maintenance tick: sleeps begin, move on or finish, and queued model requests are handed to the adapter. */
  s.tick = () => s.dispatcher.maintenanceTick()
  /** The model request a running sleep is waiting for, if any: `{ agentId, task, input }`. */
  s.request = async () => {
    const run = await s.row(`SELECT r.id FROM kipster.maintenance_runs r JOIN kipster.memory_sleeps z ON z.id=r.sleep_id
      WHERE z.state='running' AND r.state IN ('queued','preparing','running') ORDER BY r.created_at LIMIT 1`)
    if (!run) return null
    const found = await until(() => s.executions.find(e => e.context.runId === run.id && !s.handled.has(e)), Boolean, `sleep request ${run.id}`)
    s.handled.add(found)
    return { agentId: found.context.agentId, task: found.context.maintenance.task, input: found.context.maintenance, found }
  }
  /** The model starts working on a sleep request, without answering yet. */
  s.startWorking = async request => { startModel(request.found) }
  /** Answers a sleep request from a script and waits for the answer to settle. Returns the run's final state; the
   * next tick moves the sleep on. */
  s.respond = async (request, { consolidation = {}, promotion } = {}) => {
    let answer
    if (request.task === 'consolidate') answer = consolidate(request.input, consolidation)
    else {
      const section = typeof promotion === 'function' ? promotion(request.input) : promotion
      if (section === undefined) throw new Error('A sleep asked to rebuild the Learned section, but the story gave no section')
      answer = JSON.stringify({ section })
    }
    return answerWith(request.found, answer)
  }
  const consolidate = (request, { same = [], contradicts = [], related = [], lessons = [], raw }) => {
    if (raw !== undefined) return raw
    const ref = text => request.memories.find(item => item.text === text)?.ref ?? fail(`The sleep did not offer "${text}"`)
    const pair = ([a, b]) => request.pairs.find(item => item.memories.includes(ref(a)) && item.memories.includes(ref(b)))?.ref ?? fail(`The sleep did not pair "${a}" with "${b}"`)
    return JSON.stringify({
      verdicts: [...same.map(p => ({ pair: pair(p), verdict: 'same' })), ...contradicts.map(p => ({ pair: pair(p), verdict: 'contradicts' })), ...related.map(p => ({ pair: pair(p), verdict: 'related' }))],
      lessons: lessons.map(lesson => ({ text: lesson.text, memories: lesson.from.map(ref) })),
    })
  }
  const fail = message => { throw new Error(message) }

  // Probes.
  s.row = async (sql, params = []) => (await s.db.query(sql, params)).rows[0]
  s.rows = async (sql, params = []) => (await s.db.query(sql, params)).rows
  s.lastSleep = agent => s.row(`SELECT sleep_on::text AS day, state, step, report FROM kipster.memory_sleeps WHERE agent_id=$1 ORDER BY sleep_on DESC LIMIT 1`, [agent ?? s.agent])
  /** The agent's memory with this text, with its weight: origin, importance, evidence, organization home and strength. */
  s.memory = (text, agent = s.agent) => s.row(`SELECT m.id, m.text, m.origin, m.importance, m.evidence, m.revision::int AS revision,
      m.home_organization_id AS home, kipster.memory_strength(m.importance, m.evidence, COALESCE(a.active_days, 0) - m.refreshed_day) AS strength
    FROM kipster.memory_records m LEFT JOIN kipster.memory_activity a ON a.agent_id=m.owner_id
    WHERE m.scope='agent' AND m.owner_id=$1 AND m.text=$2`, [agent, text])
  /** Texts of the agent's memories, sorted. */
  s.memories = async (agent = s.agent) => (await s.rows(`SELECT text FROM kipster.memory_records WHERE scope='agent' AND owner_id=$1 ORDER BY text`, [agent])).map(r => r.text)
  /** What a search in `where` returns, best first, without counting as recall. */
  s.search = async (where, query, agent = s.agent) => (await s.runtime.memory.search(agent, where.organizationId, query, 20)).map(hit => hit.record.text)
  /** Links between the agent's memories: [kind, text, text], the two texts in sorted order. */
  s.links = async (agent = s.agent) => (await s.rows(`SELECT r.kind, f.text AS a, t.text AS b FROM kipster.memory_relationships r
    JOIN kipster.memory_records f ON f.id=r.from_id JOIN kipster.memory_records t ON t.id=r.to_id WHERE r.owner_id=$1 ORDER BY r.kind, f.text`, [agent])).map(r => [r.kind, ...[r.a, r.b].sort()])
  s.identity = { read: (file = 'identity.md', agent = s.agent) => readFile(join(s.runtime.home.agent(agent), file), 'utf8') }
  /** Model requests so far by task: extract, consolidate and identity. A request asked again after a crash counts once. */
  s.modelCalls = async () => Object.fromEntries((await s.rows(`SELECT task_kind, count(*)::int AS n FROM kipster.maintenance_runs GROUP BY task_kind`)).map(r => [r.task_kind, r.n]))
  return s
}
