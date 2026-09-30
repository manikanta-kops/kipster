export const DEMO_ORIGIN = 'https://demo.kipster.invalid'
export type FakeCoreHandler = (request: Request) => Promise<Response>

function demoUrl(input: string | URL, origin: string): URL | undefined {
  try {
    const url = new URL(input, location.href)
    return url.origin === origin ? url : undefined
  } catch {
    return undefined
  }
}

/** Installs an origin-scoped transport without changing saved connections. */
export function installFakeCoreTransport(
  handler: FakeCoreHandler,
  origin = DEMO_ORIGIN,
): () => void {
  const originalFetch = window.fetch
  window.fetch = async (input, init) => {
    const url = demoUrl(input instanceof Request ? input.url : input, origin)
    if (!url) return originalFetch.call(window, input, init)
    const request = new Request(input, init)
    request.signal.throwIfAborted()
    if (request.body && !request.headers.has('content-length')) {
      const headers = new Headers(request.headers)
      headers.set(
        'content-length',
        String((await request.clone().arrayBuffer()).byteLength),
      )
      Object.defineProperty(request, 'headers', { value: headers })
    }
    request.signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const abort = () => reject(request.signal.reason)
      request.signal.addEventListener('abort', abort, { once: true })
      handler(request)
        .then(resolve, reject)
        .finally(() => request.signal.removeEventListener('abort', abort))
    })
  }
  const restoreXHR = patchXMLHttpRequest(handler, origin)
  return () => {
    window.fetch = originalFetch
    restoreXHR()
  }
}

async function dispatch(
  serve: FakeCoreHandler,
  init: {
    method: string
    url: URL
    headers: Headers
    body: () => Promise<Uint8Array | null>
    signal: AbortSignal
    onBodyProgress: (loaded: number) => void
  },
): Promise<Response> {
  init.signal.throwIfAborted()
  const bytes = await init.body()
  init.signal.throwIfAborted()
  if (bytes) {
    init.headers.set('content-length', String(bytes.length))
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      init.signal.throwIfAborted()
      init.onBodyProgress(Math.min(offset + 65536, bytes.length))
    }
    if (!bytes.length) init.onBodyProgress(0)
  }
  init.signal.throwIfAborted()
  const request = new Request(init.url, {
    method: init.method,
    headers: init.headers,
    signal: init.signal,
    body: bytes ? new Blob([bytes.slice().buffer]) : null,
  })
  // Browser Request strips transport-managed headers; supply the wire length.
  Object.defineProperty(request, 'headers', { value: init.headers })
  return new Promise((resolve, reject) => {
    const abort = () => reject(init.signal.reason)
    init.signal.addEventListener('abort', abort, { once: true })
    serve(request)
      .then(resolve, reject)
      .finally(() => init.signal.removeEventListener('abort', abort))
  })
}

async function bodyBytes(
  body: Document | XMLHttpRequestBodyInit | null | undefined,
): Promise<Uint8Array | null> {
  if (body === null || body === undefined) return null
  if (body instanceof Document)
    return new TextEncoder().encode(new XMLSerializer().serializeToString(body))
  return new Uint8Array(await new Response(body).arrayBuffer())
}

const XHR_STATE = { UNSENT: 0, OPENED: 1, HEADERS_RECEIVED: 2, DONE: 4 }

function patchXMLHttpRequest(serve: FakeCoreHandler, origin: string) {
  const NativeXMLHttpRequest = window.XMLHttpRequest
  interface DemoExchange {
    method: string
    url: URL
    headers: Headers
    readyState: number
    status: number
    statusText: string
    responseText: string
    responseHeaders: Headers | null
    abort?: AbortController
    sent: boolean
  }
  class EmbeddedXMLHttpRequest extends NativeXMLHttpRequest {
    #exchange: DemoExchange | null = null

    open(
      method: string,
      url: string | URL,
      async = true,
      username?: string | null,
      password?: string | null,
    ) {
      const target = demoUrl(url, origin)
      if (!target) {
        this.#exchange = null
        super.open(method, url, async, username, password)
        return
      }
      this.#exchange = {
        method: method.toUpperCase(),
        url: target,
        headers: new Headers(),
        readyState: XHR_STATE.OPENED,
        status: 0,
        statusText: '',
        responseText: '',
        responseHeaders: null,
        sent: false,
      }
      this.#emit(this, 'readystatechange')
    }

    get readyState() {
      return this.#exchange ? this.#exchange.readyState : super.readyState
    }
    get status() {
      return this.#exchange ? this.#exchange.status : super.status
    }
    get statusText() {
      return this.#exchange ? this.#exchange.statusText : super.statusText
    }
    get responseText() {
      return this.#exchange ? this.#exchange.responseText : super.responseText
    }
    get response() {
      return this.#exchange ? this.#exchange.responseText : super.response
    }
    get responseURL() {
      return this.#exchange ? this.#exchange.url.href : super.responseURL
    }

    setRequestHeader(name: string, value: string) {
      if (this.#exchange) this.#exchange.headers.set(name, value)
      else super.setRequestHeader(name, value)
    }
    getResponseHeader(name: string) {
      if (!this.#exchange) return super.getResponseHeader(name)
      return this.#exchange.responseHeaders?.get(name) ?? null
    }
    getAllResponseHeaders() {
      if (!this.#exchange) return super.getAllResponseHeaders()
      return [...(this.#exchange.responseHeaders ?? [])]
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join('')
    }

    abort() {
      const exchange = this.#exchange
      if (!exchange) return super.abort()
      if (!exchange.abort || exchange.readyState === XHR_STATE.DONE) return
      exchange.abort.abort()
    }

    send(body?: Document | XMLHttpRequestBodyInit | null) {
      const exchange = this.#exchange
      if (!exchange) return super.send(body)
      if (exchange.readyState !== XHR_STATE.OPENED || exchange.sent)
        throw new DOMException('The request is not open.', 'InvalidStateError')
      exchange.sent = true
      const controller = new AbortController()
      exchange.abort = controller
      const hasBody = !['GET', 'HEAD'].includes(exchange.method)
      const payload = hasBody ? bodyBytes(body) : Promise.resolve(null)
      const upload = this.upload
      let uploading = hasBody && body !== null && body !== undefined
      let timedOut = false
      const timer =
        this.timeout > 0
          ? setTimeout(() => {
              timedOut = true
              controller.abort()
            }, this.timeout)
          : undefined
      const progress = (
        target: EventTarget,
        type: string,
        loaded: number,
        total: number,
      ) =>
        target.dispatchEvent(
          new ProgressEvent(type, { lengthComputable: true, loaded, total }),
        )
      const finish = (type: 'load' | 'error' | 'abort' | 'timeout') => {
        clearTimeout(timer)
        exchange.readyState = XHR_STATE.DONE
        this.#emit(this, 'readystatechange')
        if (type === 'abort') exchange.readyState = XHR_STATE.UNSENT
        if (uploading) {
          uploading = false
          progress(upload, type, 0, 0)
          progress(upload, 'loadend', 0, 0)
        }
        const length = exchange.responseText.length
        progress(this, type, length, length)
        progress(this, 'loadend', length, length)
      }
      progress(this, 'loadstart', 0, 0)
      void payload
        .then((bytes) => {
          const total = bytes?.length ?? 0
          if (uploading) progress(upload, 'loadstart', 0, total)
          return dispatch(serve, {
            method: exchange.method,
            url: exchange.url,
            headers: exchange.headers,
            body: async () => bytes,
            signal: controller.signal,
            onBodyProgress: (loaded) => {
              if (!uploading) return
              progress(upload, 'progress', loaded, total)
              if (loaded < total) return
              uploading = false
              progress(upload, 'load', loaded, total)
              progress(upload, 'loadend', loaded, total)
            },
          })
        })
        .then(async (response) => {
          exchange.status = response.status
          exchange.statusText = response.statusText
          exchange.responseHeaders = response.headers
          exchange.readyState = XHR_STATE.HEADERS_RECEIVED
          this.#emit(this, 'readystatechange')
          exchange.responseText = await response.text()
          finish('load')
        })
        .catch((error: unknown) => {
          exchange.status = 0
          exchange.statusText = ''
          exchange.responseText = ''
          exchange.responseHeaders = null
          finish(
            timedOut
              ? 'timeout'
              : error instanceof DOMException && error.name === 'AbortError'
                ? 'abort'
                : 'error',
          )
        })
    }

    #emit(target: EventTarget, type: string) {
      target.dispatchEvent(new Event(type))
    }
  }
  window.XMLHttpRequest = EmbeddedXMLHttpRequest
  return () => {
    window.XMLHttpRequest = NativeXMLHttpRequest
  }
}
