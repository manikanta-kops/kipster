// Snapshots the protocol's request and response shapes and rejects changes that are not
// additive unless `protocolRange.current` was raised (decision record 5.1.7).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(new URL('../protocol-shape.json', import.meta.url))
const dist = new URL('../dist/protocol/index.js', import.meta.url)
/** Exact objects that Core only sends; they are checked where responses use them. */
const responseFragments = new Set(['removedPart', 'streamScope'])

const objects = shape => shape.type === 'object' ? [shape] : shape.type === 'union' ? shape.of.filter(s => s.type === 'object') : []

function children(shape, map) {
  switch (shape.type) {
    case 'array': return { ...shape, items: map(shape.items) }
    case 'nullable': case 'optional': return { ...shape, of: map(shape.of) }
    case 'union': return { ...shape, of: shape.of.map(map) }
    case 'object': return { ...shape, fields: Object.fromEntries(Object.entries(shape.fields).map(([k, s]) => [k, map(s)])) }
    default: return shape
  }
}

/**
 * Requests are exact objects Core receives; responses and events are open objects Core sends.
 * A nested shape equal to another exported schema is written as `{ "ref": name }`.
 */
export function snapshot(protocol) {
  const shapes = {}
  for (const name of Object.keys(protocol).sort())
    if (typeof protocol[name]?.describe === 'function') shapes[name] = protocol[name].describe()
  const names = new Map()
  for (const [name, shape] of Object.entries(shapes))
    if (shape.type === 'object' || shape.type === 'union') if (!names.has(JSON.stringify(shape))) names.set(JSON.stringify(shape), name)
  const used = new Set()
  const compact = self => function map(shape) {
    const name = names.get(JSON.stringify(shape))
    if (name && name !== self) { used.add(name); return { ref: name } }
    return children(shape, map)
  }
  const write = name => children(shapes[name], compact(name))
  const requests = {}, responses = {}, fragments = {}
  for (const [name, shape] of Object.entries(shapes)) {
    if (responseFragments.has(name)) continue
    const members = objects(shape)
    if (members.some(s => !s.exact)) responses[name] = write(name)
    else if (members.length) requests[name] = write(name)
  }
  // Writing a fragment can reference further fragments.
  for (let more = true; more;) {
    more = false
    for (const name of [...used].sort()) if (!requests[name] && !responses[name] && !fragments[name]) { fragments[name] = write(name); more = true }
  }
  const { current, oldest } = protocol.protocolRange
  return { protocol: { current, oldest }, requests, responses, fragments: Object.fromEntries(Object.entries(fragments).sort()) }
}

/** The snapshot with every `ref` replaced by the shape it names. */
export function expand(snapshot) {
  const all = { ...snapshot.fragments, ...snapshot.requests, ...snapshot.responses }
  const inline = shape => shape.ref ? inline(all[shape.ref]) : children(shape, inline)
  const section = entries => Object.fromEntries(Object.entries(entries).map(([name, shape]) => [name, inline(shape)]))
  return { protocol: snapshot.protocol, requests: section(snapshot.requests), responses: section(snapshot.responses) }
}

const primitive = new Set(['string', 'integer', 'boolean'])
const literalType = shape => shape.type === 'literal' ? (typeof shape.value === 'number' ? 'integer' : typeof shape.value) : undefined
const literals = shape => Object.fromEntries(Object.entries(shape.fields).filter(([, s]) => s.type === 'literal').map(([k, s]) => [k, s.value]))
const key = shape => shape.type === 'literal' ? `literal:${JSON.stringify(shape.value)}` : shape.type === 'object' ? `object:${JSON.stringify(Object.entries(literals(shape)).sort())}` : shape.type
function label(shape) {
  if (shape.type === 'literal') return JSON.stringify(shape.value)
  if (shape.type !== 'object') return shape.type
  const tags = Object.entries(literals(shape)).filter(([k]) => k !== 'version').map(([k, v]) => `${k}=${v}`)
  return tags.length ? `<${tags.join(',')}>` : 'object'
}
/** Whether `accepting` takes every value `sent` can hold, for strings, integers and arrays. */
function bounds(accepting, sent) {
  if ((accepting.format ?? sent.format) !== sent.format) return false
  return (accepting.min ?? 0) <= (sent.min ?? 0) && (accepting.max ?? Infinity) >= (sent.max ?? Infinity)
}

/**
 * Lists what a reader of `before` cannot handle in `after`. A response is read by released clients:
 * fields, union members, enumeration values and event kinds may be added, nothing removed or narrowed
 * for them. A request is read by Core: it must still accept everything released clients send.
 */
function compare(before, after, path, mode, out) {
  const response = mode === 'response'
  const accepting = response ? before : after
  const sent = response ? after : before
  if (before.type === 'nullable' || after.type === 'nullable') {
    if (sent.type === 'nullable' && accepting.type !== 'nullable') out.push(`${path}: ${response ? 'may now be null' : 'no longer accepts null'}`)
    return compare(before.type === 'nullable' ? before.of : before, after.type === 'nullable' ? after.of : after, path, mode, out)
  }
  if (before.type === 'union' || after.type === 'union') {
    const was = before.type === 'union' ? before.of : [before]
    const now = after.type === 'union' ? after.of : [after]
    const unmatched = [...now]
    for (const old of was) {
      const index = unmatched.findIndex(s => key(s) === key(old))
      if (index >= 0) { compare(old, unmatched.splice(index, 1)[0], old.type === 'object' && was.length > 1 ? `${path}${label(old)}` : path, mode, out); continue }
      const widened = now.some(s => s.type === literalType(old) || (primitive.has(old.type) && literalType(s) === old.type))
      if (response ? old.type === 'literal' || old.type === 'object' || !widened : !(old.type === 'literal' && now.some(s => s.type === literalType(old))))
        out.push(`${path}: ${response ? 'no longer sends' : 'no longer accepts'} ${label(old)}`)
    }
    if (response) for (const added of unmatched)
      if (added.type !== 'literal' && added.type !== 'object' && !was.some(s => s.type === added.type)) out.push(`${path}: may now be ${label(added)}`)
    return
  }
  if (before.type !== after.type) {
    const covered = accepting.type === 'unknown' || (accepting.type === 'record' && sent.type === 'object') || literalType(sent) === accepting.type
    if (!covered) out.push(`${path}: changed from ${label(before)} to ${label(after)}`)
    return
  }
  switch (before.type) {
    case 'literal':
      if (before.value !== after.value) out.push(`${path}: changed from ${label(before)} to ${label(after)}`)
      return
    case 'string': case 'integer':
      if (!bounds(accepting, sent)) out.push(`${path}: ${response ? 'may now hold values outside its former limits' : 'narrowed what it accepts'}`)
      return
    case 'array':
      if (!bounds(accepting, sent)) out.push(`${path}: ${response ? 'may now hold more or fewer items' : 'narrowed how many items it accepts'}`)
      return compare(before.items, after.items, `${path}[]`, mode, out)
    case 'object': {
      if (!response && after.exact && !before.exact) out.push(`${path}: now rejects unknown fields`)
      for (const [name, old] of Object.entries(before.fields)) {
        const field = `${path}.${name}`
        const now = after.fields[name]
        if (!now) {
          if (response || after.exact) out.push(`${field}: ${response ? 'removed' : 'no longer accepted'}`)
          continue
        }
        if (response && old.type !== 'optional' && now.type === 'optional') out.push(`${field}: may now be absent`)
        if (!response && old.type === 'optional' && now.type !== 'optional') out.push(`${field}: now required`)
        compare(old.type === 'optional' ? old.of : old, now.type === 'optional' ? now.of : now, field, mode, out)
      }
      if (!response) for (const [name, now] of Object.entries(after.fields))
        if (!(name in before.fields) && now.type !== 'optional') out.push(`${path}.${name}: new required field`)
    }
  }
}

/** Changes from `base` to `head` that released clients cannot handle. */
export function breakingChanges(base, head) {
  base = expand(base)
  head = expand(head)
  const out = []
  for (const mode of ['requests', 'responses'])
    for (const [name, shape] of Object.entries(base[mode])) {
      if (!head[mode][name]) out.push(`${name}: ${mode === 'requests' ? 'request' : 'response'} schema removed`)
      else compare(shape, head[mode][name], name, mode === 'requests' ? 'request' : 'response', out)
    }
  return out
}

/** Problems that fail the check: breaking changes without a raised protocol, or an early drop. */
export function verdict(base, head) {
  const changes = breakingChanges(base, head)
  const raised = head.protocol.current > base.protocol.current
  const problems = raised ? [] : [...changes]
  if (raised && head.protocol.oldest > base.protocol.current)
    problems.push(`protocolRange.oldest must keep serving protocol ${base.protocol.current} for at least one release after raising current`)
  return { changes, raised, problems }
}

/** JSON with each node that fits on one line written on one line. */
export function format(value, indent = '') {
  const flat = JSON.stringify(value)
  if (flat.length + indent.length <= 100 || value === null || typeof value !== 'object') return flat
  const inner = `${indent}  `
  const items = Array.isArray(value)
    ? value.map(item => inner + format(item, inner))
    : Object.entries(value).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${format(v, inner)}`)
  return `${Array.isArray(value) ? '[' : '{'}\n${items.join(',\n')}\n${indent}${Array.isArray(value) ? ']' : '}'}`
}

async function main([command, flag, basePath]) {
  if (!existsSync(dist)) throw new Error('Build Core first: npm run build -w core')
  const head = snapshot(await import(dist.href))
  const text = `${format(head)}\n`
  if (command === 'write') { writeFileSync(file, text); return }
  if (command !== 'check' || (flag !== undefined && flag !== '--base')) throw new Error('Usage: protocol-shape.mjs write | check [--base <protocol-shape.json>]')
  let failed = false
  if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
    console.error('core/protocol-shape.json is out of date. Run: npm run protocol:shape -w core')
    failed = true
  }
  if (basePath && existsSync(basePath)) {
    const { changes, raised, problems } = verdict(JSON.parse(readFileSync(basePath, 'utf8')), head)
    if (raised && changes.length) console.log(`Protocol raised; breaking changes allowed:\n  ${changes.join('\n  ')}`)
    if (problems.length) {
      console.error(`Protocol changes must be additive, or raise protocolRange.current in core/src/protocol/version.ts:\n  ${problems.join('\n  ')}`)
      failed = true
    }
  } else if (basePath) console.log('No base protocol shape; skipping the additive check.')
  if (failed) process.exitCode = 1
}

if (import.meta.main) await main(process.argv.slice(2))
