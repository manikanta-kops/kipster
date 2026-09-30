/** One canonical destination also serves as the local journal namespace. */
export function backendURL(value: string): string {
  const url = new URL(value.trim())
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'Enter an HTTPS backend address, or HTTP on localhost, without a path, password, query or fragment.',
    )
  return url.origin
}
export const backendStorageKey = 'kipster-backend-url'

export function readBackendConnection(): string {
  const saved = localStorage.getItem(backendStorageKey)
  return saved ? backendURL(saved) : ''
}

export function saveBackendConnection(value: string): void {
  localStorage.setItem(backendStorageKey, backendURL(value))
}
