import * as protocol from '@kipster/core/protocol'
import type { JsonObject, JsonValue } from '@kipster/core/protocol'
import { defineClientOptions, type ClientOptions } from '@kipster/core/client'

export const sample: JsonObject = { text: 'foundation', values: [1, true, null] }
export const options: ClientOptions = defineClientOptions({ baseUrl: 'https://kipster.example' })
export const protocolExports = Object.keys(protocol)
export const acceptedText = protocol.textSubmission.parse({
  version: 1, submissionId: 's', scope: { installationId: 'i', callerId: 'c' },
  target: { context: { kind: 'installation', installationId: 'i' }, chatId: 'ch' },
  mode: 'root', parts: [{ kind: 'text', text: 'hello' }],
})
export let rejectsMutation = false
try { protocol.textSubmission.parse({ ...acceptedText, unexpected: true }) } catch (error) { rejectsMutation = error instanceof TypeError }
export let rejectsUnboundedRead = false
try { protocol.boundedRead.parse({ version: 1, scope: { installationId: 'i', callerId: 'c' }, context: { kind: 'installation', installationId: 'i' }, chatId: 'ch', threadId: 't', before: null, limit: 101 }) } catch (error) { rejectsUnboundedRead = error instanceof TypeError }
export const parsedWaiting = protocol.threadWork.parse({runId:'r',attemptId:'a',state:'waiting',queueHold:false,cancelDelivery:'none',revision:1,queuePosition:1,messageId:'m',failure:null})
export const parsedInteractionNotice = protocol.notification.parse({id:'n',threadId:'t',runId:'r',kind:'interaction',interactionId:'x',interactionState:'pending',read:false,revision:1,createdAt:'2026-01-01T00:00:00.000Z'})
export let rejectsMalformedAttempt = false
try { protocol.controlCommand.parse({version:1,operationId:'op',context:{kind:'installation',installationId:'i'},chatId:'ch',threadId:'t',runId:'r',attemptId:42,action:'stop'}) } catch (error) { rejectsMalformedAttempt = error instanceof TypeError }
export let rejectsExtraAnswer = false
try { protocol.interactionResponseCommand.parse({version:1,operationId:'op',interactionId:'x',threadId:'t',runId:'r',attemptId:'a',answer:{kind:'approve',extra:true}}) } catch (error) { rejectsExtraAnswer = error instanceof TypeError }

// @ts-expect-error undefined is not a JSON value
const invalidValue: JsonValue = undefined
void invalidValue

// @ts-expect-error the URL option must be a string
const invalidOptions: ClientOptions = { baseUrl: 42 }
void invalidOptions

// @ts-expect-error private package files are not public entry points
import type { AdapterIdentity } from '@kipster/core/dist/adapter-api/index.js'
