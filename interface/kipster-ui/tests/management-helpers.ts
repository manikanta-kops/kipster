import { expect, startDemo } from './demo.ts'
import type { Page } from '@playwright/test'
export async function setup(page: Page, session?: string) {
  const current = await startDemo(page, { session })
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeVisible()
  return `/__test-core/${current}`
}
// Management opens inside the Settings dialog, so the innermost match is management.
export const managementDialog = (page: Page) =>
  page
    .getByRole('dialog')
    .filter({ has: page.getByRole('button', { name: 'Close management' }) })
    .last()
export async function openManagement(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Organization', exact: true }).click()
  await page.getByRole('button', { name: /^Manage kips and groups…/ }).click()
}
export async function manage(page: Page, section = 'Organization') {
  await openManagement(page)
  await managementDialog(page)
    .getByRole('group', { name: 'Management sections' })
    .getByRole('button', { name: section, exact: true })
    .click()
  return managementDialog(page)
}
export async function close(page: Page) {
  await page.getByRole('button', { name: 'Close management' }).click()
  await page.getByRole('button', { name: 'Close settings' }).click()
}
export const save = (page: Page) =>
  page.getByRole('button', { name: 'Save', exact: true }).click()
export const read = async (page: Page, endpoint: string) =>
  (await page.request.get(endpoint + '/v1/directory')).json()
export async function create(
  page: Page,
  kind: 'agent' | 'organization',
  name: string,
) {
  await manage(page, kind === 'agent' ? 'Kips' : 'Organization')
  await page
    .getByRole('button', {
      name: kind === 'agent' ? 'Create new kip' : 'Create organization',
      exact: true,
    })
    .click()
  await page.getByLabel('Name', { exact: true }).fill(name)
}
