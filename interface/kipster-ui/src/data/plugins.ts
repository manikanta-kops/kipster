import {
  createClient,
  KipsterClientError,
  type KipsterClient,
} from '@kipster/core/client'
import { pluginPaths } from '@kipster/core/protocol'
import { isLoopbackHost } from './backend-connection.ts'

export type {
  PluginAccount,
  PluginDetail,
  PluginSignInStart,
  PluginSignInStatus,
  PluginSummary,
} from '@kipster/core/protocol'
export { KipsterClientError }
export type PluginsClient = KipsterClient & { endpoint: string }

/** Kipster Plugins routes of the Core this window is connected to. */
export function createPluginsClient(endpoint: string): PluginsClient {
  return Object.assign(createClient({ baseUrl: endpoint }), { endpoint })
}

/** How often a pending sign-in is checked. */
export const signInPollMs = 1500

/**
 * Where the provider sends the browser after sign-in: Core's callback on the address this window
 * uses, or null when that address cannot receive it (plain HTTP to another computer).
 */
export function signInReturnAddress(endpoint: string): string | null {
  const url = new URL(endpoint)
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) return null
  return new URL(pluginPaths.callback, url.origin).href
}

export const remoteHTTPMessage =
  'Connecting needs the computer itself or an HTTPS (Tailscale Serve) address. Open Kipster on the computer running it, or connect this window through its HTTPS address.'
export const needsDocumentMessage =
  'This service signs in with a client metadata document, which this Kipster installation does not publish, so it cannot be connected yet.'

/** Plain words for a refused request or a failed sign-in. */
export function pluginProblem(code: string, fallback?: string): string {
  switch (code) {
    case 'loopback-only':
      return 'This service only connects from the computer running Kipster. Open Kipster on that computer and connect from there.'
    case 'invalid-return-address':
    case 'return-address-refused':
      return remoteHTTPMessage
    case 'needs-client-metadata-document':
      return needsDocumentMessage
    case 'denied':
      return 'Sign-in was denied, so nothing was connected.'
    case 'expired':
      return 'Sign-in took too long and expired. Try again.'
    case 'no-sign-in-method':
      return 'This service offers no sign-in Kipster can use.'
    case 'invalid-address':
      return fallback
        ? `That address did not work: ${fallback}`
        : 'That address did not work. Check it and try again.'
    case 'plugins-unavailable':
      return 'Plugins are not running right now. Try again in a moment.'
    case 'failed':
      return 'Sign-in failed. Try again.'
    default:
      return fallback
        ? `Sign-in failed: ${fallback}`
        : 'Sign-in failed. Try again.'
  }
}

/** The message for an error from a plugin route. */
export function pluginErrorText(error: unknown): string {
  if (error instanceof KipsterClientError) {
    if (error.code === 'invalid-response')
      return 'Core sent a response this app cannot read.'
    if (error.code === 'plugins-unavailable') return pluginProblem(error.code)
    return error.message
  }
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return 'Core did not answer in time.'
  return error instanceof Error && error.message
    ? error.message
    : 'Core is unavailable.'
}
