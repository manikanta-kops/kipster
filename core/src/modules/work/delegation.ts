import { sealAttemptMessages } from '../conversations/public.js'
import { randomUUID } from 'node:crypto'
import type { Postgres, SqlClient } from '../../platform/postgres/public.js'
import type { Jobs } from '../../platform/jobs/public.js'
import { publishThreadChange, interactionNotificationChanged } from '../synchronization/public.js'
import { workRecord } from '../conversations/public.js'
import { interactionRecord } from './interactions.js'
import { isLive, refuseAgent } from '../identity/public.js'

export interface DelegationRecord {
  /** `parentRunId` and `childRunId` are null once the agent that ran that side was permanently deleted. */
  id: string; parentRunId: string | null; childRunId: string | null; senderAgentId: string; recipientAgentId: string
  originThreadId: string; depth: number; ordinal:number; request: string; state: string; result?: string; failure?: string; revision: number
}
interface Row { id:string; parent_run_id:string|null; child_run_id:string|null; sender_agent_id:string; recipient_agent_id:string; origin_thread_id:string; depth:number; ordinal:number; request:string; state:string; result:string|null; failure:string|null; revision:string }
export function delegationWire(row: Row): DelegationRecord {
  return { id:row.id,parentRunId:row.parent_run_id,childRunId:row.child_run_id,senderAgentId:row.sender_agent_id,recipientAgentId:row.recipient_agent_id,originThreadId:row.origin_thread_id,depth:row.depth,ordinal:row.ordinal,request:row.request,state:row.state,...(row.result!==null?{result:row.result}:{}),...(row.failure!==null?{failure:row.failure}:{}),revision:Number(row.revision) }
}
export function delegationActivity(record:DelegationRecord):Omit<DelegationRecord,'result'>{
  const {result:ignored,...activity}=record
  void ignored
  return activity
}
export async function delegationRecord(client:SqlClient,id:string):Promise<DelegationRecord> {
  const row=(await client.query<Row>('SELECT * FROM kipster.delegations WHERE id=$1',[id])).rows[0]
  if(!row)throw new Error('Delegation not found')
  return delegationWire(row)
}
export async function childDelegation(client:SqlClient,runId:string):Promise<{id:string;originThreadId:string;parentRunId:string|null}|null>{
  const row=(await client.query<{id:string;origin_thread_id:string;parent_run_id:string|null}>('SELECT id,origin_thread_id,parent_run_id FROM kipster.delegations WHERE child_run_id=$1',[runId])).rows[0]
  return row?{id:row.id,originThreadId:row.origin_thread_id,parentRunId:row.parent_run_id}:null
}
export async function listAgents(db:Postgres,attemptId:string,incarnation:string):Promise<{id:string;name:string}[]> {
  const scope=await boundScope(db,attemptId,incarnation)
  const rows=await db.query<{id:string;display_name:string}>(scope.contextKind==='organization'
    ? `SELECT a.id,a.display_name FROM kipster.agents a JOIN kipster.agent_memberships m ON m.agent_id=a.id WHERE a.installation_id=$1 AND kipster.live_agent(a.id) AND m.organization_id=$2 ORDER BY a.display_name,a.id`
    : `SELECT a.id,a.display_name FROM kipster.agents a JOIN kipster.agent_roles r ON r.agent_id=a.id AND r.role='root-admin' WHERE a.installation_id=$1 AND kipster.live_agent(a.id) ORDER BY a.display_name,a.id`,scope.contextKind==='organization'?[scope.installationId,scope.contextId]:[scope.installationId])
  return rows.rows.map(row=>({id:row.id,name:row.display_name}))
}
export async function getAgent(db:Postgres,attemptId:string,incarnation:string,agentId:string):Promise<{id:string;name:string}|null>{
  return (await listAgents(db,attemptId,incarnation)).find(x=>x.id===agentId)??null
}
interface Scope { runId:string; threadId:string; chatId:string; installationId:string; humanId:string; agentId:string; contextKind:'installation'|'organization'; contextId:string; attemptState:string; runState:string; stopRequested:boolean }
async function boundScope(client:SqlClient,attemptId:string,incarnation:string):Promise<Scope>{
  const row=(await client.query<{run_id:string;thread_id:string;chat_id:string;installation_id:string;caller_id:string;agent_id:string;context_kind:'installation'|'organization';context_id:string;attempt_state:string;run_state:string;stop_requested:boolean}>(`SELECT r.id AS run_id,r.thread_id,t.chat_id,c.installation_id,c.caller_id,COALESCE(d.recipient_agent_id,c.agent_id) AS agent_id,c.context_kind,c.context_id,a.state AS attempt_state,r.state AS run_state,r.stop_requested
    FROM kipster.attempts a JOIN kipster.text_runs r ON r.id=a.intent_id JOIN kipster.threads t ON t.id=r.thread_id JOIN kipster.direct_chats c ON c.id=t.chat_id LEFT JOIN kipster.delegations d ON d.child_run_id=r.id
    WHERE a.id=$1 AND a.incarnation=$2 AND r.current_attempt_id=a.id`,[attemptId,incarnation])).rows[0]
  if(!row||row.attempt_state!=='issued'||!['running','waiting'].includes(row.run_state)||row.stop_requested)throw new Error('Attempt no longer owns delegation')
  return {runId:row.run_id,threadId:row.thread_id,chatId:row.chat_id,installationId:row.installation_id,humanId:row.caller_id,agentId:row.agent_id,contextKind:row.context_kind,contextId:row.context_id,attemptState:row.attempt_state,runState:row.run_state,stopRequested:row.stop_requested}
}
export async function delegationStatus(db:Postgres,attemptId:string,incarnation:string,id:string):Promise<DelegationRecord>{
  const scope=await boundScope(db,attemptId,incarnation)
  const row=(await db.query<{parent_run_id:string;origin_thread_id:string}>('SELECT parent_run_id,origin_thread_id FROM kipster.delegations WHERE id=$1',[id])).rows[0]
  if(!row||row.parent_run_id!==scope.runId)throw new Error('Delegation access denied')
  return delegationRecord(db,id)
}
export async function delegate(db:Postgres,jobs:Jobs,attemptId:string,incarnation:string,callId:string,recipientId:string,request:string,artifactIds:readonly string[]=[]):Promise<DelegationRecord>{
  if(!callId||callId.length>200||typeof recipientId!=='string'||!/^[0-9a-f-]{36}$/i.test(recipientId)||typeof request!=='string'||!request.trim()||request.length>16000||!Array.isArray(artifactIds)||artifactIds.length>10||new Set(artifactIds).size!==artifactIds.length||artifactIds.some(id=>typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id)))throw new Error('Invalid delegation request')
  const first=await boundScope(db,attemptId,incarnation)
  const priorParent=(await db.query<{origin_thread_id:string;root_run_id:string;depth:number}>('SELECT origin_thread_id,root_run_id,depth FROM kipster.delegations WHERE child_run_id=$1',[first.runId])).rows[0]
  const originThreadId=priorParent?.origin_thread_id??first.threadId,rootRunId=priorParent?.root_run_id??first.runId,depth=(priorParent?.depth??0)+1
  return db.transaction(async client=>{
    await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE',[first.installationId])
    await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE',[originThreadId])
    if(first.threadId!==originThreadId)await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE',[first.threadId])
    const scope=await boundScope(client,attemptId,incarnation)
    const prior=(await client.query<{id:string;recipient_agent_id:string;request:string;artifact_ids:string[]}>('SELECT id,recipient_agent_id,request,artifact_ids FROM kipster.delegations WHERE parent_attempt_id=$1 AND call_id=$2',[attemptId,callId])).rows[0]
    if(prior){if(prior.recipient_agent_id!==recipientId||prior.request!==request||JSON.stringify(prior.artifact_ids)!==JSON.stringify(artifactIds))throw new Error('Delegation identity conflict');return delegationRecord(client,prior.id)}
    const same=(await client.query<{id:string}>(`SELECT id FROM kipster.delegations WHERE parent_run_id=$1 AND recipient_agent_id=$2 AND request=$3 AND artifact_ids=$4::uuid[] ORDER BY ordinal LIMIT 1`,[scope.runId,recipientId,request,artifactIds])).rows[0]
    if(same)return delegationRecord(client,same.id)
    if(scope.agentId===recipientId)throw new Error('Delegation cycle: agent cannot delegate to itself')
    const limits=(await client.query<{delegation_depth_limit:number;delegation_root_budget:number;delegation_fanout_limit:number}>('SELECT delegation_depth_limit,delegation_root_budget,delegation_fanout_limit FROM kipster.execution_permits WHERE installation_id=$1',[scope.installationId])).rows[0]!
    if(depth>limits.delegation_depth_limit)throw new Error('Delegation depth limit reached')
    const count=(await client.query<{n:string}>('SELECT count(*) AS n FROM kipster.delegations WHERE root_run_id=$1',[rootRunId])).rows[0]!
    if(Number(count.n)>=limits.delegation_root_budget)throw new Error('Delegation root budget reached')
    const siblings=(await client.query<{n:string}>('SELECT count(*) AS n FROM kipster.delegations WHERE parent_attempt_id=$1',[attemptId])).rows[0]!
    if(Number(siblings.n)>=limits.delegation_fanout_limit)throw new Error('Delegation fanout limit reached')
    const nextOrdinal=Number((await client.query<{n:string}>('SELECT count(*) AS n FROM kipster.delegations WHERE parent_run_id=$1',[scope.runId])).rows[0]!.n)+1
    const ancestors=await client.query<{sender_agent_id:string}>(`WITH RECURSIVE parents AS (SELECT d.sender_agent_id,d.parent_run_id FROM kipster.delegations d WHERE d.child_run_id=$1 UNION ALL SELECT d.sender_agent_id,d.parent_run_id FROM kipster.delegations d JOIN parents p ON d.child_run_id=p.parent_run_id) SELECT sender_agent_id FROM parents`,[scope.runId])
    if(ancestors.rows.some(row=>row.sender_agent_id===recipientId))throw new Error('Delegation cycle detected')
    // An organization recipient must be a member; its membership row stays locked until the delegation commits.
    const available=(await client.query<{id:string}>(scope.contextKind==='organization'
      ? `SELECT a.id FROM kipster.agents a JOIN kipster.agent_memberships m ON m.agent_id=a.id WHERE a.id=$1 AND a.installation_id=$2 AND m.organization_id=$3 FOR KEY SHARE OF m`
      : `SELECT a.id FROM kipster.agents a JOIN kipster.agent_roles r ON r.agent_id=a.id AND r.role='root-admin' WHERE a.id=$1 AND a.installation_id=$2`,scope.contextKind==='organization'?[recipientId,scope.installationId,scope.contextId]:[recipientId,scope.installationId])).rows[0]
    // The recipient, and the organization it works in, must be live until the delegation commits.
    if(!available)throw new Error('Recipient agent unavailable in originating context')
    if(!await isLive(client,scope.installationId,'agent',recipientId))await refuseAgent(client,scope.installationId,recipientId,'Recipient agent unavailable in originating context')
    if(scope.contextKind==='organization'&&!await isLive(client,scope.installationId,'organization',scope.contextId))throw new Error('Organization unavailable for delegation')
    // The delegating agent must still be a member: a removed agent's run finishes without starting new work.
    if(scope.contextKind==='organization'&&!(await client.query('SELECT 1 FROM kipster.agent_memberships WHERE organization_id=$1 AND agent_id=$2 FOR KEY SHARE',[scope.contextId,scope.agentId])).rows.length)throw new Error('Delegating agent is not an organization member')
    for(const id of artifactIds){
      const file=(await client.query(`SELECT 1 FROM kipster.message_artifacts ma JOIN kipster.messages m ON m.id=ma.message_id WHERE ma.artifact_id=$1 AND m.thread_id=$2 LIMIT 1`,[id,scope.threadId])).rows[0]
      if(!file)throw new Error('Delegation file access denied')
    }
    const id=randomUUID(),threadId=randomUUID(),runId=randomUUID(),messageId=randomUUID()
    const parts=[{kind:'text',text:request},...artifactIds.map(artifactId=>({kind:'file',artifactId,purpose:'attachment'}))]
    await client.query('INSERT INTO kipster.threads(id,chat_id,internal,next_message_position,next_queue_position) VALUES ($1,$2,true,2,2)',[threadId,scope.chatId])
    await client.query('INSERT INTO kipster.messages(id,thread_id,position,author_id,parts) VALUES ($1,$2,1,$3,$4::jsonb)',[messageId,threadId,scope.agentId,JSON.stringify(parts)])
    for(const [index,artifactId] of artifactIds.entries())await client.query('INSERT INTO kipster.message_artifacts(message_id,ordinal,artifact_id,purpose) VALUES ($1,$2,$3,$4)',[messageId,index+1,artifactId,'attachment'])
    await client.query("INSERT INTO kipster.work_intents(id,installation_id,state) VALUES ($1,$2,'queued')",[runId,scope.installationId])
    await client.query("INSERT INTO kipster.text_runs(id,thread_id,input_message_id,state,queue_position) VALUES ($1,$2,$3,'queued',1)",[runId,threadId,messageId])
    await client.query(`INSERT INTO kipster.delegations(id,installation_id,origin_thread_id,root_run_id,parent_run_id,parent_attempt_id,ordinal,child_run_id,call_id,sender_agent_id,recipient_agent_id,context_kind,context_id,responsible_human_id,depth,request,artifact_ids,state)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::uuid[],'queued')`,[id,scope.installationId,originThreadId,rootRunId,scope.runId,attemptId,nextOrdinal,runId,callId,scope.agentId,recipientId,scope.contextKind,scope.contextId,scope.humanId,depth,request,artifactIds])
    await client.query("UPDATE kipster.text_runs SET state='waiting',revision=revision+1 WHERE id=$1 AND state='running'",[scope.runId])
    await publishThreadChange(client,scope.installationId,scope.humanId,threadId,scope.chatId,'message-final',messageId,1,{id:messageId,threadId,authorId:scope.agentId,parts,final:true,revision:1,position:1},'queued',messageId)
    await publishThreadChange(client,scope.installationId,scope.humanId,threadId,scope.chatId,'work-changed',runId,1,await workRecord(client,runId),'queued',null)
    await publishThreadChange(client,scope.installationId,scope.humanId,scope.threadId,scope.chatId,'work-changed',scope.runId,Number((await client.query<{revision:string}>('SELECT revision FROM kipster.text_runs WHERE id=$1',[scope.runId])).rows[0]!.revision),await workRecord(client,scope.runId),'waiting',null)
    const record=await delegationRecord(client,id)
    await publishThreadChange(client,scope.installationId,scope.humanId,originThreadId,scope.chatId,'delegation-changed',id,record.revision,delegationActivity(record),'running',null)
    await jobs.send(client,runId)
    return record
  })
}

export async function finishDelegation(client:SqlClient,jobs:Jobs,childRunId:string,state:string,failure:string|null):Promise<void>{
  const item=(await client.query<{id:string;installation_id:string;origin_thread_id:string;parent_run_id:string;parent_attempt_id:string;responsible_human_id:string;state:string}>(`SELECT id,installation_id,origin_thread_id,parent_run_id,parent_attempt_id,responsible_human_id,state FROM kipster.delegations WHERE child_run_id=$1 FOR UPDATE`,[childRunId])).rows[0]
  if(!item||['completed','failed','recovery-needed'].includes(item.state))return
  if(!['completed','failed','cancelled','recovery-needed'].includes(state))return
  const final=state==='completed'?'completed':state
  const texts=(await client.query<{parts:{kind:string;text?:string}[]}>(`SELECT m.parts FROM kipster.messages m JOIN kipster.attempts a ON a.id=m.source_attempt_id WHERE a.intent_id=$1 AND m.final=true ORDER BY m.position`,[childRunId])).rows.flatMap(row=>row.parts.flatMap(part=>part.kind==='text'&&part.text?[part.text]:[]))
  const result=texts.join('\n\n').slice(0,65536)
  if(item.state==='cancelled'){
    await client.query('UPDATE kipster.delegations SET late_result=$2,late_failure=$3 WHERE id=$1',[item.id,result||null,failure])
    return
  }
  await client.query('UPDATE kipster.delegations SET state=$2,result=$3,failure=$4,revision=revision+1,finished_at=now() WHERE id=$1',[item.id,final,result||null,failure])
  const record=await delegationRecord(client,item.id)
  const origin=(await client.query<{chat_id:string}>('SELECT chat_id FROM kipster.threads WHERE id=$1',[item.origin_thread_id])).rows[0]!
  await publishThreadChange(client,item.installation_id,item.responsible_human_id,item.origin_thread_id,origin.chat_id,'delegation-changed',item.id,record.revision,delegationActivity(record),final,null)
  const pending=(await client.query('SELECT 1 FROM kipster.delegations WHERE parent_attempt_id=$1 AND state NOT IN ($2,$3,$4,$5) LIMIT 1',[item.parent_attempt_id,'completed','failed','cancelled','recovery-needed'])).rows.length
  if(pending)return
  const parent=(await client.query<{state:string;current_attempt_id:string|null;stop_requested:boolean;thread_id:string}>(`SELECT state,current_attempt_id,stop_requested,thread_id FROM kipster.text_runs WHERE id=$1`,[item.parent_run_id])).rows[0]
  if(!parent||parent.stop_requested||parent.state!=='waiting'||parent.current_attempt_id!==item.parent_attempt_id)return
  const permit=(await client.query('SELECT 1 FROM kipster.owned_permits WHERE attempt_id=$1',[item.parent_attempt_id])).rows.length
  if(permit)return
  await client.query("UPDATE kipster.text_runs SET state='queued',revision=revision+1 WHERE id=$1 AND state='waiting'",[item.parent_run_id])
  await client.query("UPDATE kipster.work_intents SET state='queued' WHERE id=$1",[item.parent_run_id])
  await publishThreadChange(client,item.installation_id,item.responsible_human_id,parent.thread_id,origin.chat_id,'work-changed',item.parent_run_id,Number((await client.query<{revision:string}>('SELECT revision FROM kipster.text_runs WHERE id=$1',[item.parent_run_id])).rows[0]!.revision),await workRecord(client,item.parent_run_id),'queued',null)
  await jobs.send(client,item.parent_run_id)
}

/** Caller holds the installation and root thread locks before traversing descendants. */
export async function cancelDelegationTree(client:SqlClient,parentRunId:string):Promise<string[]>{
  const descendants=await client.query<{id:string;child_run_id:string;origin_thread_id:string;installation_id:string;responsible_human_id:string}>(`WITH RECURSIVE tree AS (
    SELECT d.id,d.child_run_id,d.origin_thread_id,d.installation_id,d.responsible_human_id,d.depth FROM kipster.delegations d WHERE d.parent_run_id=$1
    UNION ALL SELECT d.id,d.child_run_id,d.origin_thread_id,d.installation_id,d.responsible_human_id,d.depth FROM kipster.delegations d JOIN tree p ON d.parent_run_id=p.child_run_id
  ) SELECT id,child_run_id,origin_thread_id,installation_id,responsible_human_id FROM tree ORDER BY depth,id LIMIT 1000`,[parentRunId])
  const cancelAttempts:string[]=[]
  for(const item of descendants.rows){
    const run=(await client.query<{state:string;current_attempt_id:string|null;thread_id:string;input_message_id:string;stop_requested:boolean}>(`SELECT state,current_attempt_id,thread_id,input_message_id,stop_requested FROM kipster.text_runs WHERE id=$1`,[item.child_run_id])).rows[0]
    if(!run||run.stop_requested||['completed','failed','cancelled','recovery-needed'].includes(run.state))continue
    await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE',[run.thread_id])
    const active=run.current_attempt_id?!!(await client.query('SELECT 1 FROM kipster.owned_permits WHERE attempt_id=$1',[run.current_attempt_id])).rows.length:false
    const next=active?'cancellation-requested':'cancelled'
    await client.query(`UPDATE kipster.text_runs SET state=$2,stop_requested=true,queue_hold=true,queue_generation=queue_generation+1,retry_continue_generation=NULL,cancel_delivery=$3,revision=revision+1 WHERE id=$1`,[item.child_run_id,next,active?'requested':'not-needed'])
    if(run.current_attempt_id)await sealAttemptMessages(client,run.current_attempt_id,next)
    if(!active){
      if(run.current_attempt_id)await client.query("UPDATE kipster.attempts SET state='settled' WHERE id=$1 AND state='preparing'",[run.current_attempt_id])
      await client.query("UPDATE kipster.work_intents SET state='settled' WHERE id=$1 AND state<>'uncertain'",[item.child_run_id])
    }else if(run.current_attempt_id)cancelAttempts.push(run.current_attempt_id)
    const cards=await client.query<{id:string}>("UPDATE kipster.interactions SET state='cancelled',revision=revision+1 WHERE run_id=$1 AND state='pending' RETURNING id",[item.child_run_id])
    const chat=(await client.query<{chat_id:string}>('SELECT chat_id FROM kipster.threads WHERE id=$1',[run.thread_id])).rows[0]!
    for(const card of cards.rows){const record=await interactionRecord(client,card.id);await publishThreadChange(client,item.installation_id,item.responsible_human_id,item.origin_thread_id,chat.chat_id,'interaction-changed',card.id,record.revision,record,'cancelled',null);await interactionNotificationChanged(client,card.id)}
    await client.query("UPDATE kipster.delegations SET state='cancelled',revision=revision+1,finished_at=now() WHERE id=$1 AND state NOT IN ('completed','failed','cancelled','recovery-needed')",[item.id])
    const record=await delegationRecord(client,item.id)
    await publishThreadChange(client,item.installation_id,item.responsible_human_id,item.origin_thread_id,chat.chat_id,'delegation-changed',item.id,record.revision,delegationActivity(record),'cancelled',null)
  }
  return cancelAttempts
}

/** Surface interrupted child execution without guessing whether its provider ended. */
export async function reconcileInterruptedDelegations(db:Postgres):Promise<void>{
  const rows=await db.query<{id:string;installation_id:string;origin_thread_id:string;child_run_id:string;responsible_human_id:string}>(`SELECT d.id,d.installation_id,d.origin_thread_id,d.child_run_id,d.responsible_human_id FROM kipster.delegations d JOIN kipster.text_runs r ON r.id=d.child_run_id WHERE r.state='recovery-needed' AND d.state IN ('queued','running','waiting') ORDER BY d.origin_thread_id,d.id`)
  for(const item of rows.rows)await db.transaction(async client=>{
    await client.query('SELECT 1 FROM kipster.execution_permits WHERE installation_id=$1 FOR UPDATE',[item.installation_id])
    await client.query('SELECT 1 FROM kipster.threads WHERE id=$1 FOR UPDATE',[item.origin_thread_id])
    const changed=await client.query("UPDATE kipster.delegations SET state='recovery-needed',failure='Child provider outcome requires reconciliation',revision=revision+1 WHERE id=$1 AND state IN ('queued','running','waiting') RETURNING id",[item.id])
    if(!changed.rows.length)return
    const record=await delegationRecord(client,item.id)
    const chat=(await client.query<{chat_id:string}>('SELECT chat_id FROM kipster.threads WHERE id=$1',[item.origin_thread_id])).rows[0]!
    await publishThreadChange(client,item.installation_id,item.responsible_human_id,item.origin_thread_id,chat.chat_id,'delegation-changed',item.id,record.revision,delegationActivity(record),'recovery-needed',null)
  })
}
