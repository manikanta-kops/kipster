import { chromium, webkit } from '@playwright/test'
import assert from 'node:assert/strict'
import { stripTypeScriptTypes } from 'node:module'
import { readFile } from 'node:fs/promises'
for (const [name, type, options] of [
  ['chrome', chromium, { channel: 'chrome' }],
  ['webkit', webkit, {}],
]) {
  const browser = await type.launch({ headless: true, ...options })
  try {
    const page = await browser.newPage()
    await page.goto('about:blank')
    await page.addScriptTag({
      content: stripTypeScriptTypes(
        await readFile(
          new URL('../src/fake-core/transport.ts', import.meta.url),
          'utf8',
        ),
        { mode: 'strip' },
      ).replaceAll('export ', ''),
    })
    const result = await page.evaluate(async () => {
      let calls = 0
      const uninstall = installFakeCoreTransport(async (request) => {
        calls++
        return Response.json({
          method: request.method,
          length: request.headers.get('content-length'),
          bytes: (await request.arrayBuffer()).byteLength,
        })
      })
      const fetched = await (await fetch(DEMO_ORIGIN + '/hello')).json()
      const progress = []
      const uploaded = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', DEMO_ORIGIN + '/upload')
        xhr.upload.onprogress = (e) => progress.push(e.loaded)
        xhr.onload = () => resolve(JSON.parse(xhr.responseText))
        xhr.onerror = reject
        xhr.send(new Blob([new Uint8Array(150000)]))
      })
      const fetchUpload = await (
        await fetch(DEMO_ORIGIN + '/fetch-upload', {
          method: 'PUT',
          body: new Blob(['abc']),
        })
      ).json()
      const uploadAbort = await new Promise((resolve) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', DEMO_ORIGIN + '/upload-abort')
        xhr.upload.onprogress = () => xhr.abort()
        xhr.onabort = () => resolve(true)
        xhr.onload = () => resolve(false)
        xhr.send(new Blob([new Uint8Array(65536)]))
      })
      const native = await (await fetch('data:text/plain,native')).text()
      const controller = new AbortController()
      controller.abort()
      let abort = false
      try {
        await fetch(DEMO_ORIGIN + '/aborted', { signal: controller.signal })
      } catch (e) {
        abort = e.name === 'AbortError'
      }
      uninstall()
      return {
        fetched,
        uploaded,
        fetchUpload,
        uploadAbort,
        progress,
        native,
        abort,
        calls,
      }
    })
    assert.equal(result.calls, 3)
    assert.equal(result.fetchUpload.length, '3')
    assert.equal(result.uploadAbort, true)
    assert.equal(result.fetched.method, 'GET')
    assert.equal(result.uploaded.bytes, 150000)
    assert.equal(result.uploaded.length, '150000')
    assert.deepEqual(result.progress, [65536, 131072, 150000])
    assert.equal(result.native, 'native')
    assert.equal(result.abort, true)
    console.log(name, JSON.stringify(result))
  } finally {
    await browser.close()
  }
}
