import { test, expect, type Page } from '@playwright/test'
export { test, expect }
export { DEMO_IDS } from '../src/fake-core/admin.ts'
export const DEMO_ORIGIN = 'https://demo.kipster.invalid'
export async function startDemo(
  page: Page,
  options: {
    session?: string
    faults?: Record<string, string>
    notification?: 'foreground' | 'background'
  } = {},
) {
  const session = options.session || crypto.randomUUID()
  const query = new URLSearchParams({ testCore: session })
  if (options.faults) query.set('faults', JSON.stringify(options.faults))
  if (options.notification) query.set('notification', options.notification)
  await page.goto(`/?${query}`)
  await page.waitForFunction(
    () =>
      (window as unknown as { kipsterTest?: { ready: boolean } }).kipsterTest
        ?.ready === true,
  )
  return session
}
export async function demo(page: Page, path: string, body?: unknown) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(
        `https://${new URLSearchParams(location.search).get('testCore') || 'default'}.demo.kipster.invalid/__demo${path}`,
        body === undefined
          ? undefined
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            },
      )
      if (!response.ok) throw new Error(await response.text())
      return response.json()
    },
    { path, body },
  )
}
export async function storageFault(
  page: Page,
  key: string,
  mode: 'hold' | 'fail' | 'allow',
) {
  await page.evaluate(
    ({ key, mode }) => {
      ;(
        window as unknown as {
          kipsterTest: { fault(key: string, mode: string): void }
        }
      ).kipsterTest.fault(key, mode)
    },
    { key, mode },
  )
}
/** Phones keep the theme switch in the sidebar drawer. */
export async function switchTheme(page: Page, mode: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: mode })
}
