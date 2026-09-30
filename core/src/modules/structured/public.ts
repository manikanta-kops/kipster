import { createHash, randomUUID } from 'node:crypto'
import { Postgres, type SqlClient } from '../../platform/postgres/public.js'

type Value = string | number | boolean | null | Record<string, unknown> | unknown[]
type Input = Record<string, unknown>
type Target = { kind: 'agent' | 'organization'; ownerId: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const identifier = /^[a-z][a-z0-9_]{0,39}$/
const types = new Set(['text', 'bigint', 'double precision', 'boolean', 'timestamptz', 'jsonb', 'uuid'])
const mutations = new Set(['create_table', 'add_column', 'drop_column', 'create_index', 'drop_index', 'drop_table', 'insert', 'update', 'delete'])
const operations = new Set([...mutations, 'discover', 'describe', 'query'])
const guardSourceHash = '23e0ea4a3c5f3425b95699fdff65aa31cd60d6f97462003998f7180688d3a291'

function object(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Input
}
function only(input: Input, names: readonly string[]): void {
  if (Object.keys(input).some(key => !names.includes(key))) throw new Error('Unexpected task-data field')
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) throw new Error('Invalid UUID')
  return value
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !identifier.test(value) || value.startsWith('pg_') || value.startsWith('kipster_')) throw new Error('Invalid task-data name')
  return value
}
function quote(value: string): string { return `"${value}"` }
function target(value: unknown): Target {
  const input = object(value)
  only(input, ['kind', 'ownerId'])
  if (input.kind !== 'agent' && input.kind !== 'organization') throw new Error('Invalid task-data target')
  return { kind: input.kind, ownerId: id(input.ownerId) }
}
function schema(target: Target): string { return `task_${target.kind === 'agent' ? 'a' : 'o'}_${target.ownerId.replaceAll('-', '').toLowerCase()}` }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Invalid task-data value')
  return encoded
}
function bounded(value: unknown, max = 65536): void {
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded) > max) throw new Error('Task-data byte limit exceeded')
}
function rowValues(value: unknown): Input {
  const row = object(value)
  if (!Object.keys(row).length || Object.keys(row).length > 16) throw new Error('Invalid task-data row')
  for (const [key, item] of Object.entries(row)) {
    name(key)
    if (key === 'id' || item === undefined || typeof item === 'function') throw new Error('Invalid task-data value')
    if (typeof item === 'number' && (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) throw new Error('Unsafe numeric value; use a decimal string for bigint')
  }
  bounded(row, 16384)
  return row
}
function sqlValues(row: Input): unknown[] {
  return Object.values(row).map(value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value)
}

/**
 * Drops an owner's task-data space: its schema with every table in it, its registry entry and its
 * receipts. Run it on the Core login, which owns every task-data schema.
 */
export async function dropOwnerTaskData(client: SqlClient, owner: Target): Promise<void> {
  id(owner.ownerId)
  // Serialized with provisioning, which creates schemas under the same lock.
  await client.query('SELECT pg_advisory_xact_lock($1,$2)', [78315, 13])
  await client.query(`DROP SCHEMA IF EXISTS ${quote(schema(owner))} CASCADE`)
  await client.query('DELETE FROM task_data.namespaces WHERE owner_kind=$1 AND owner_id=$2', [owner.kind, owner.ownerId])
  await client.query('DELETE FROM task_data.receipts WHERE owner_kind=$1 AND owner_id=$2', [owner.kind, owner.ownerId])
}

/** A separate login owns only custom task objects; Core state is reachable only through guard_attempt. */
export class StructuredDataService {
  private readonly admin: Postgres
  private readonly restricted: Postgres
  private login = ''
  constructor(adminConnectionString: string, connectionString: string, onError?: (error: Error) => void) {
    this.admin = new Postgres(adminConnectionString, 2, 1000, onError)
    this.restricted = new Postgres(connectionString, 4, 1000, onError)
  }
  async initialize(): Promise<void> {
    const identity = (await this.restricted.query<{ role: string; session: string; database: string; superuser: boolean; createdb: boolean; createrole: boolean; bypassrls: boolean; inherit: boolean; temp: boolean; dbcreate: boolean; coreusage: boolean; publiccreate: boolean }>(`SELECT current_user AS role,session_user AS session,current_database() AS database,
      r.rolsuper AS superuser,r.rolcreatedb AS createdb,r.rolcreaterole AS createrole,
      r.rolbypassrls AS bypassrls,r.rolinherit AS inherit,
      has_database_privilege(current_user,current_database(),'TEMP') AS temp,
      has_database_privilege(current_user,current_database(),'CREATE') AS dbcreate,
      has_schema_privilege(current_user,'kipster','USAGE') AS coreusage,
      has_schema_privilege(current_user,'public','CREATE') AS publiccreate
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`)).rows[0]
    const adminDb = (await this.admin.query<{ database: string }>('SELECT current_database() AS database')).rows[0]?.database
    if (!identity || identity.database !== adminDb || identity.role !== identity.session || identity.superuser || identity.createdb || identity.createrole || identity.bypassrls || identity.inherit || identity.temp || identity.dbcreate || identity.coreusage || identity.publiccreate) throw new Error('Task-data login must be an isolated restricted PostgreSQL identity in the Core database')
    const membership = (await this.restricted.query<{ allowed: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member WHERE r.rolname=current_user) AS allowed`)).rows[0]?.allowed
    if (membership) throw new Error('Task-data login must not inherit or assume other roles')
    const setup = (await this.admin.query<{ schema_owner: string; receipt_owner: string; identity_owner: string; registry_owner: string; guard_owner: string; guard_security: boolean; guard_path: string[]; guard_source: string; public_execute: boolean }>(`SELECT pg_catalog.pg_get_userbyid(n.nspowner) AS schema_owner,
      pg_catalog.pg_get_userbyid(c.relowner) AS receipt_owner,
      pg_catalog.pg_get_userbyid(marker.relowner) AS identity_owner,
      pg_catalog.pg_get_userbyid(registry.relowner) AS registry_owner,
      pg_catalog.pg_get_userbyid(p.proowner) AS guard_owner,
      p.prosecdef AS guard_security,p.proconfig AS guard_path,p.prosrc AS guard_source,
      (p.proacl IS NULL OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(p.proacl) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')) AS public_execute
      FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname='receipts'
      JOIN pg_catalog.pg_class marker ON marker.relnamespace=n.oid AND marker.relname='database_identity'
      JOIN pg_catalog.pg_class registry ON registry.relnamespace=n.oid AND registry.relname='namespaces'
      JOIN pg_catalog.pg_proc p ON p.oid='task_data.guard_attempt(uuid,uuid,bigint,text,uuid)'::pg_catalog.regprocedure
      WHERE n.nspname='task_data' AND p.pronamespace=n.oid`)).rows[0]
    const adminRole = (await this.admin.query<{ role: string }>('SELECT current_user AS role')).rows[0]?.role
    if (!setup || setup.schema_owner !== adminRole || setup.receipt_owner !== adminRole || setup.identity_owner !== adminRole || setup.registry_owner !== adminRole || setup.guard_owner !== adminRole || !setup.guard_security || !setup.guard_path?.includes('search_path=pg_catalog') || setup.public_execute || createHash('sha256').update(setup.guard_source).digest('hex') !== guardSourceHash) throw new Error('Task-data guard ownership or definition is untrusted')
    this.login = identity.role
    const role = quote(this.login.replaceAll('"', '""'))
    await this.admin.transaction(async client => {
      await client.query(`GRANT USAGE ON SCHEMA task_data TO ${role}`)
      await client.query(`GRANT SELECT,INSERT ON task_data.receipts TO ${role}`)
      await client.query(`GRANT SELECT ON task_data.database_identity TO ${role}`)
      await client.query(`GRANT EXECUTE ON FUNCTION task_data.guard_attempt(uuid,uuid,bigint,text,uuid) TO ${role}`)
    })
    const adminIdentity = (await this.admin.query<{ id: string }>('SELECT id FROM task_data.database_identity WHERE singleton=true')).rows[0]?.id
    const restrictedIdentity = (await this.restricted.query<{ id: string }>('SELECT id FROM task_data.database_identity WHERE singleton=true')).rows[0]?.id
    if (!adminIdentity || adminIdentity !== restrictedIdentity) throw new Error('Task-data login points to another PostgreSQL database instance')
    const boundary = (await this.restricted.query<{ guard: boolean; service_create: boolean }>(`SELECT
      has_function_privilege(current_user,'task_data.guard_attempt(uuid,uuid,bigint,text,uuid)','EXECUTE') AS guard,
      has_schema_privilege(current_user,'task_data','CREATE') AS service_create`)).rows[0]
    if (!boundary?.guard || boundary.service_create) throw new Error('Task-data privilege boundary invalid')
    type Grants = { name: string; select_grant: boolean; insert_grant: boolean; update_grant: boolean; delete_grant: boolean; truncate_grant: boolean; references_grant: boolean; trigger_grant: boolean; maintain_grant: boolean; column_select: boolean; column_insert: boolean; column_update: boolean; column_references: boolean }
    const grants = (await this.restricted.query<Grants>(`SELECT c.relname AS name,
      has_table_privilege(current_user,c.oid,'SELECT') AS select_grant,
      has_table_privilege(current_user,c.oid,'INSERT') AS insert_grant,
      has_table_privilege(current_user,c.oid,'UPDATE') AS update_grant,
      has_table_privilege(current_user,c.oid,'DELETE') AS delete_grant,
      has_table_privilege(current_user,c.oid,'TRUNCATE') AS truncate_grant,
      has_table_privilege(current_user,c.oid,'REFERENCES') AS references_grant,
      has_table_privilege(current_user,c.oid,'TRIGGER') AS trigger_grant,
      has_table_privilege(current_user,c.oid,'MAINTAIN') AS maintain_grant,
      bool_or(has_column_privilege(current_user,c.oid,a.attnum,'SELECT')) AS column_select,
      bool_or(has_column_privilege(current_user,c.oid,a.attnum,'INSERT')) AS column_insert,
      bool_or(has_column_privilege(current_user,c.oid,a.attnum,'UPDATE')) AS column_update,
      bool_or(has_column_privilege(current_user,c.oid,a.attnum,'REFERENCES')) AS column_references
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname='task_data' AND c.relkind IN ('r','p')
      GROUP BY c.oid,c.relname ORDER BY c.relname`)).rows
    if (grants.length !== 3 || grants.some(row => !['receipts','database_identity','namespaces'].includes(row.name))) throw new Error('Task-data protected metadata set is untrusted')
    for (const row of grants) {
      const receipt = row.name === 'receipts', identityRow = row.name === 'database_identity'
      if (row.select_grant !== (receipt || identityRow) || row.insert_grant !== receipt || row.column_select !== (receipt || identityRow) || row.column_insert !== receipt ||
          row.update_grant || row.delete_grant || row.truncate_grant || row.references_grant || row.trigger_grant || row.maintain_grant || row.column_update || row.column_references) throw new Error('Task-data privilege boundary invalid')
    }
  }
  private async provision(attemptId: string, incarnation: string, generation: string, target: Target): Promise<string> {
    const namespace = schema(target), role = quote(this.login.replaceAll('"', '""'))
    await this.admin.transaction(async client => {
      await client.query("SET LOCAL transaction_timeout='2s'")
      await client.query("SET LOCAL lock_timeout='500ms'")
      await client.query('SELECT pg_advisory_xact_lock($1,$2)', [78315, 13])
      await client.query('SELECT task_data.guard_attempt($1::uuid,$2::uuid,$3::bigint,$4::text,$5::uuid)',[attemptId,incarnation,generation,target.kind,target.ownerId])
      const adminRole = (await client.query<{ role: string }>('SELECT current_user AS role')).rows[0]!.role
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quote(namespace)}`)
      const owner = (await client.query<{ owner: string }>(`SELECT pg_catalog.pg_get_userbyid(nspowner) AS owner FROM pg_catalog.pg_namespace WHERE nspname=$1`, [namespace])).rows[0]
      if (!owner || owner.owner !== adminRole) throw new Error('Task-data namespace ownership is untrusted')
      await client.query(`GRANT USAGE,CREATE ON SCHEMA ${quote(namespace)} TO ${role}`)
      await client.query(`INSERT INTO task_data.namespaces(owner_kind,owner_id,schema_name) VALUES ($1,$2,$3)
        ON CONFLICT (owner_kind,owner_id) DO NOTHING`,[target.kind,target.ownerId,namespace])
      const registered = (await client.query<{ schema_name: string }>('SELECT schema_name FROM task_data.namespaces WHERE owner_kind=$1 AND owner_id=$2',[target.kind,target.ownerId])).rows[0]
      if (registered?.schema_name !== namespace) throw new Error('Task-data namespace registry mismatch')
    })
    return namespace
  }
  async invoke(attemptId: string, incarnation: string, callId: string, inputValue: unknown): Promise<unknown> {
    id(attemptId); id(incarnation)
    if (!callId || callId.length > 200) throw new Error('Invalid task-data call ID')
    const input = object(inputValue), operation = input.operation
    if (typeof operation !== 'string' || !operations.has(operation)) throw new Error('Unknown task-data operation')
    const owner = target(input.target)
    bounded(input, 20000)
    const table = operation === 'discover' ? undefined : name(input.table)
    const allowed = operation === 'discover' ? ['operation','target'] :
      operation === 'create_table' ? ['operation','target','table','columns'] :
      operation === 'add_column' ? ['operation','target','table','column','type'] :
      operation === 'drop_column' ? ['operation','target','table','column'] :
      operation === 'create_index' || operation === 'drop_index' ? ['operation','target','table','index','column'] :
      operation === 'query' ? ['operation','target','table','where','afterId','limit'] :
      operation === 'insert' || operation === 'update' ? ['operation','target','table','id','values'] :
      operation === 'delete' ? ['operation','target','table','id'] : ['operation','target','table']
    only(input, allowed)
    const hash = createHash('sha256').update(canonical(input)).digest('hex')
    const generation = (await this.admin.query<{ generation: string }>('SELECT generation FROM kipster.attempts WHERE id=$1 AND incarnation=$2', [attemptId, incarnation])).rows[0]?.generation
    if (!generation) throw new Error('Unknown task-data attempt')
    if (mutations.has(operation)) {
      const prior = (await this.restricted.query<{ owner_kind: string; owner_id: string; operation: string; payload_hash: string; result: unknown }>('SELECT owner_kind,owner_id,operation,payload_hash,result FROM task_data.receipts WHERE attempt_id=$1 AND call_id=$2',[attemptId,callId])).rows[0]
      if (prior) {
        if (prior.owner_kind !== owner.kind || prior.owner_id !== owner.ownerId || prior.operation !== operation || prior.payload_hash !== hash) throw new Error('Task-data call ID reused with different arguments')
        return prior.result
      }
    }
    let namespace: string
    try { namespace = await this.provision(attemptId,incarnation,generation,owner) }
    catch (error) {
      const prior = mutations.has(operation) ? (await this.restricted.query<{ owner_kind: string; owner_id: string; operation: string; payload_hash: string; result: unknown }>('SELECT owner_kind,owner_id,operation,payload_hash,result FROM task_data.receipts WHERE attempt_id=$1 AND call_id=$2',[attemptId,callId])).rows[0] : undefined
      if (prior && prior.owner_kind === owner.kind && prior.owner_id === owner.ownerId && prior.operation === operation && prior.payload_hash === hash) return prior.result
      throw error
    }
    return this.restricted.transaction(async client => {
      await client.query("SET LOCAL transaction_timeout='5s'")
      await client.query("SET LOCAL statement_timeout='2s'")
      await client.query("SET LOCAL lock_timeout='1500ms'")
      await client.query("SET LOCAL search_path='pg_catalog'")
      const prior = (await client.query<{ actor_id: string; owner_kind: string; owner_id: string; operation: string; payload_hash: string; result: unknown }>('SELECT actor_id,owner_kind,owner_id,operation,payload_hash,result FROM task_data.receipts WHERE attempt_id=$1 AND call_id=$2', [attemptId, callId])).rows[0]
      if (prior) {
        if (prior.owner_kind !== owner.kind || prior.owner_id !== owner.ownerId || prior.operation !== operation || prior.payload_hash !== hash) throw new Error('Task-data call ID reused with different arguments')
        return prior.result
      }
      const actor = (await client.query<{ actor_id: string }>('SELECT task_data.guard_attempt($1::uuid,$2::uuid,$3::bigint,$4::text,$5::uuid) AS actor_id', [attemptId, incarnation, generation, owner.kind, owner.ownerId])).rows[0]?.actor_id
      if (!actor) throw new Error('Task-data attempt guard failed')
      // The capacity lock serializes task calls for this installation. A concurrent
      // call may have committed the receipt while this call waited for the guard.
      const raced = (await client.query<{ actor_id: string; owner_kind: string; owner_id: string; operation: string; payload_hash: string; result: unknown }>('SELECT actor_id,owner_kind,owner_id,operation,payload_hash,result FROM task_data.receipts WHERE attempt_id=$1 AND call_id=$2', [attemptId, callId])).rows[0]
      if (raced) {
        if (raced.actor_id !== actor || raced.owner_kind !== owner.kind || raced.owner_id !== owner.ownerId || raced.operation !== operation || raced.payload_hash !== hash) throw new Error('Task-data call ID reused with different arguments')
        return raced.result
      }
      const result = await this.execute(client, namespace, operation, table, input)
      bounded(result)
      if (mutations.has(operation)) {
        await client.query(`INSERT INTO task_data.receipts(attempt_id,call_id,actor_id,owner_kind,owner_id,operation,payload_hash,result)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [attemptId, callId, actor, owner.kind, owner.ownerId, operation, hash, JSON.stringify(result)])
      }
      return result
    })
  }
  private async execute(client: SqlClient, namespace: string, operation: string, table: string | undefined, input: Input): Promise<unknown> {
    const ns = quote(namespace), qualified = `${ns}.${quote(table ?? '')}`
    if (operation === 'discover') {
      const rows = (await client.query<{ table_name: string }>('SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type=$2 ORDER BY table_name LIMIT 33', [namespace, 'BASE TABLE'])).rows
      return { tables: rows.slice(0,32).map(row => row.table_name), truncated: rows.length > 32 }
    }
    if (operation === 'create_table') {
      if (!Array.isArray(input.columns) || input.columns.length < 1 || input.columns.length > 16) throw new Error('Invalid table columns')
      const columns = input.columns.map(value => {
        const col = object(value); only(col,['name','type']); const column = name(col.name)
        if (column === 'id' || typeof col.type !== 'string' || !types.has(col.type)) throw new Error('Invalid table column')
        return { name: column, type: col.type }
      })
      if (new Set(columns.map(item => item.name)).size !== columns.length) throw new Error('Duplicate table column')
      const count = (await client.query<{ n: string }>('SELECT count(*) AS n FROM information_schema.tables WHERE table_schema=$1 AND table_type=$2',[namespace,'BASE TABLE'])).rows[0]!
      if (Number(count.n) >= 32) throw new Error('Task-data table limit reached')
      await client.query(`CREATE TABLE ${qualified} (id uuid PRIMARY KEY,${columns.map(item => `${quote(item.name)} ${item.type}`).join(',')})`)
      return { status:'completed', table }
    }
    if (operation === 'describe') {
      const columns = (await client.query<{ column_name: string; data_type: string }>('SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position',[namespace,table])).rows
      if (!columns.length) throw new Error('Task-data table unavailable')
      const indexes = (await client.query<{ indexname: string; indexdef: string }>('SELECT indexname,indexdef FROM pg_catalog.pg_indexes WHERE schemaname=$1 AND tablename=$2 ORDER BY indexname LIMIT 33',[namespace,table])).rows
      return { table, columns: columns.map(c => ({ name:c.column_name,type:c.data_type })), indexes:indexes.slice(0,32).map(i => i.indexname) }
    }
    if (operation === 'add_column') {
      const column = name(input.column)
      if (column === 'id' || typeof input.type !== 'string' || !types.has(input.type)) throw new Error('Invalid table column')
      const count = (await client.query<{ n: string }>('SELECT count(*) AS n FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',[namespace,table])).rows[0]!
      if (Number(count.n) >= 17) throw new Error('Task-data column limit reached')
      await client.query(`ALTER TABLE ${qualified} ADD COLUMN ${quote(column)} ${input.type}`)
      return { status:'completed', table, column }
    }
    if (operation === 'drop_column') {
      const column = name(input.column)
      if (column === 'id') throw new Error('Cannot drop row ID')
      await client.query(`ALTER TABLE ${qualified} DROP COLUMN ${quote(column)} RESTRICT`)
      return { status:'completed', table, column }
    }
    if (operation === 'create_index') {
      const index = name(input.index), column = name(input.column)
      const count = (await client.query<{ n: string }>('SELECT count(*) AS n FROM pg_catalog.pg_indexes WHERE schemaname=$1',[namespace])).rows[0]!
      if (Number(count.n) >= 64) throw new Error('Task-data index limit reached')
      await client.query(`CREATE INDEX ${quote(index)} ON ${qualified} (${quote(column)})`)
      return { status:'completed', table, index }
    }
    if (operation === 'drop_index') {
      const index = name(input.index)
      const found = (await client.query('SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname=$1 AND tablename=$2 AND indexname=$3',[namespace,table,index])).rows[0]
      if (!found || index.endsWith('_pkey')) throw new Error('Task-data index unavailable')
      await client.query(`DROP INDEX ${ns}.${quote(index)}`)
      return { status:'completed', table, index }
    }
    if (operation === 'drop_table') {
      await client.query(`DROP TABLE ${qualified} RESTRICT`)
      return { status:'completed', table }
    }
    if (operation === 'insert') {
      if (input.id !== undefined) throw new Error('Row ID is generated by Core')
      const row = rowValues(input.values), rowId = randomUUID(), columns = Object.keys(row)
      await client.query(`INSERT INTO ${qualified} (id,${columns.map(quote).join(',')}) VALUES ($1,${columns.map((_, index) => `$${index + 2}`).join(',')})`,[rowId,...sqlValues(row)])
      return { status:'completed', id:rowId }
    }
    if (operation === 'update') {
      const rowId = id(input.id), row = rowValues(input.values), columns = Object.keys(row)
      const changed = await client.query(`UPDATE ${qualified} SET ${columns.map((column,index)=>`${quote(column)}=$${index+2}`).join(',')} WHERE id=$1`,[rowId,...sqlValues(row)])
      return { status:'completed', affected:changed.rowCount ?? 0 }
    }
    if (operation === 'delete') {
      const rowId = id(input.id)
      const changed = await client.query(`DELETE FROM ${qualified} WHERE id=$1`,[rowId])
      return { status:'completed', affected:changed.rowCount ?? 0 }
    }
    if (operation === 'query') {
      const limit = input.limit === undefined ? 20 : input.limit
      if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new Error('Invalid query limit')
      const afterId = input.afterId === undefined ? undefined : id(input.afterId)
      let filter = '', values: unknown[] = []
      if (input.where !== undefined) {
        const where = object(input.where); only(where,['column','equals'])
        const column = name(where.column)
        if (!Object.hasOwn(where,'equals')) throw new Error('Invalid query predicate')
        bounded(where,4096)
        if (where.equals === null) filter = `${quote(column)} IS NULL`
        else { filter = `${quote(column)}=$1`; values = [typeof where.equals === 'object' ? JSON.stringify(where.equals) : where.equals] }
      }
      if (afterId) { filter += `${filter ? ' AND ' : ''}id>$${values.length+1}`; values.push(afterId) }
      values.push((limit as number)+1)
      const rows = (await client.query<Record<string, Value>>(`SELECT * FROM ${qualified}${filter ? ` WHERE ${filter}` : ''} ORDER BY id LIMIT $${values.length}`,values)).rows
      const page = rows.slice(0,limit as number)
      const result = { rows:page, nextAfterId:rows.length > (limit as number) ? page.at(-1)?.id : null }
      bounded(result)
      return result
    }
    throw new Error('Unsupported task-data operation')
  }
  async close(): Promise<void> { try { await this.restricted.close() } finally { await this.admin.close() } }
}
