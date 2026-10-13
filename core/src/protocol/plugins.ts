import { array, boolean, boundedString, fallback, integer, literal, nonempty, nullable, object, optional, preserve, string, union, utcTimestamp, type Infer } from './schema.js'

/*
 * Kipster Plugins: Core relays the plugin server's control API v1. Responses carry the plugin server's JSON with
 * `version: 1` added, keep fields this schema does not name, and read an unknown value of a named choice as
 * `unknown`. Read `capabilities.plugins` from bootstrap first; while plugins are off every route answers 503
 * `plugins-unavailable`.
 */

const id = nonempty()
/** Takes an optional `version: 1`, so a bare plugin-server body is accepted too. */
const requestVersion = optional(literal(1))

/** Routes relative to the Core address. Identifiers are encoded; `accounts` and `sign-ins` are not plugin ids. */
export const pluginPaths = {
  plugins: '/v1/plugins',
  plugin: (pluginId: string) => `/v1/plugins/${encodeURIComponent(pluginId)}`,
  signIn: (pluginId: string) => `/v1/plugins/${encodeURIComponent(pluginId)}/sign-in`,
  signInStatus: (signInId: string) => `/v1/plugins/sign-ins/${encodeURIComponent(signInId)}`,
  accounts: (pluginId?: string) => pluginId === undefined ? '/v1/plugins/accounts' : `/v1/plugins/accounts?plugin=${encodeURIComponent(pluginId)}`,
  account: (accountId: string) => `/v1/plugins/accounts/${encodeURIComponent(accountId)}`,
  defaultAccount: (pluginId: string) => `/v1/plugins/${encodeURIComponent(pluginId)}/default-account`,
  /** Unauthenticated sign-in return address; Core forwards its query unchanged to the plugin server's `/callback`. */
  callback: '/plugins/callback',
} as const

/**
 * Error codes of the plugin routes besides the plugin server's own, which errors keep unchanged.
 * `returnAddressRefused` is Core's: a return address that is not Core's own callback. `serverFailed` (502) is Core's too: the
 * plugin server did not answer in time or answered with something Core cannot read.
 */
export const pluginErrorCodes = {
  unavailable: 'plugins-unavailable',
  invalidReturnAddress: 'invalid-return-address',
  loopbackOnly: 'loopback-only',
  needsClientMetadataDocument: 'needs-client-metadata-document',
  returnAddressRefused: 'return-address-refused',
  serverFailed: 'plugin-server-failed',
} as const
/** Why a sign-in failed, in `code` of a failed status. Other values may appear. */
export const pluginSignInFailureCodes = ['denied', 'expired', 'failed', 'no-sign-in-method', 'invalid-address'] as const

/** A route error. `code` is Kipster's or the plugin server's, such as `unknown-plugin` or `invalid-label`. */
export const pluginError = object({ version: literal(1), code: nonempty(), message: string(), requestId: id }, false)
export type PluginError = Infer<typeof pluginError>

export const pluginSignInMethod = fallback('dcr', 'cimd')
/** The catalogue's last check of the service. */
export const pluginProbe = preserve(object({
  result: fallback('ok', 'sign-in-changed', 'needs-address', 'needs-client-metadata-document', 'unreachable', 'error'),
  signIn: array(pluginSignInMethod), checkedOn: string(), reason: string(),
}, false))
const summaryFields = {
  id, name: string(), description: optional(string()), category: string(), website: optional(string()),
  /** How the service signs people in. */
  signIn: array(pluginSignInMethod),
  available: boolean(), unavailableReason: optional(string()), probe: nullable(pluginProbe),
  verification: nullable(fallback('probe', 'account')),
  /** Signing in needs `address`, such as the person's workspace; `addressPrompt` asks for it. */
  needsAddress: boolean(), addressPrompt: optional(string()),
  accountCount: integer(),
}
export const pluginSummary = preserve(object(summaryFields, false))
export type PluginSummary = Infer<typeof pluginSummary>
/** A signed-in account. `reconnect-needed` asks the person to sign in again; `isDefault` is the plugin's default. */
export const pluginAccount = preserve(object({
  id, plugin: id, label: string(), status: fallback('working', 'reconnect-needed'), isDefault: boolean(),
  issuer: optional(string()), identityVerified: optional(boolean()), identitySource: optional(string()), serverUrl: optional(string()),
  createdAt: utcTimestamp(), updatedAt: optional(utcTimestamp()),
}, false))
export type PluginAccount = Infer<typeof pluginAccount>
export const pluginDetail = preserve(object({ ...summaryFields, accounts: array(pluginAccount) }, false))
export type PluginDetail = Infer<typeof pluginDetail>

export const pluginList = preserve(object({ version: literal(1), plugins: array(pluginSummary) }, false))
export type PluginList = Infer<typeof pluginList>
export const pluginResult = preserve(object({ version: literal(1), plugin: pluginDetail }, false))
export type PluginResult = Infer<typeof pluginResult>

/**
 * Starts a sign-in. `address` answers `needsAddress`. `returnAddress` replaces the plugin server's own callback for a
 * browser that reaches Core through another address; it must be Core's `/plugins/callback` on a host Core answers:
 * its listener or one of its allowed hosts.
 */
export const pluginSignInRequest = object({ version: requestVersion, address: optional(boundedString(1, 2000)), returnAddress: optional(boundedString(1, 2000)) })
export type PluginSignInRequest = Infer<typeof pluginSignInRequest>
/**
 * `redirect`: open `authorizationUrl` in the person's browser, then poll the sign-in until `expiresAt`.
 * `needs-client-metadata-document`: the service needs a client metadata document this installation does not publish.
 */
export const pluginSignInStart = preserve(union(
  object({ version: literal(1), status: literal('redirect'), id, method: pluginSignInMethod, authorizationUrl: nonempty(), serverUrl: optional(string()), expiresAt: utcTimestamp() }, false),
  object({ version: literal(1), status: literal('needs-client-metadata-document') }, false),
  object({ version: literal(1), status: fallback() }, false),
))
export type PluginSignInStart = Infer<typeof pluginSignInStart>
/** A completed sign-in names its account; `duplicate` means it reconnected one already known. A failure has a `code`. */
export const pluginSignInStatus = preserve(union(
  object({ version: literal(1), id, status: literal('pending'), plugin: id }, false),
  object({ version: literal(1), id, status: literal('completed'), plugin: id, account: pluginAccount, duplicate: boolean() }, false),
  object({ version: literal(1), id, status: literal('failed'), plugin: optional(id), code: string() }, false),
  object({ version: literal(1), id, status: fallback() }, false),
))
export type PluginSignInStatus = Infer<typeof pluginSignInStatus>

export const pluginAccountList = preserve(object({ version: literal(1), accounts: array(pluginAccount) }, false))
export type PluginAccountList = Infer<typeof pluginAccountList>
export const pluginAccountResult = preserve(object({ version: literal(1), account: pluginAccount }, false))
export type PluginAccountResult = Infer<typeof pluginAccountResult>
/** Renames an account: 1 to 64 characters, unique within its plugin ignoring case. */
export const pluginAccountRename = object({ version: requestVersion, label: boundedString(1, 64) })
export type PluginAccountRename = Infer<typeof pluginAccountRename>
/** Sets the plugin's default account; null clears it. */
export const pluginDefaultAccountWrite = object({ version: requestVersion, account: nullable(id) })
export type PluginDefaultAccountWrite = Infer<typeof pluginDefaultAccountWrite>
export const pluginDefaultAccount = preserve(object({ version: literal(1), plugin: id, defaultAccount: nullable(id) }, false))
export type PluginDefaultAccount = Infer<typeof pluginDefaultAccount>
/** `revoked` says whether the service confirmed revoking the account's tokens; the account is removed either way. */
export const pluginAccountRemoval = preserve(object({ version: literal(1), removed: boolean(), revoked: boolean() }, false))
export type PluginAccountRemoval = Infer<typeof pluginAccountRemoval>
