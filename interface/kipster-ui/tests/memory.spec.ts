import { test, expect, startDemo } from './demo.ts'
import type { Page } from '@playwright/test'

async function core(page: Page, path: string) {
  const session = new URL(page.url()).searchParams.get('testCore')
  return page.request.fetch(`/__test-core/${session}${path}`)
}
async function coreJson(page: Page, path: string) {
  const response = await core(page, path)
  expect(response.ok()).toBeTruthy()
  return response.json()
}
async function openMemory(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Memory', exact: true }).click()
}
async function openCards(page: Page) {
  await openMemory(page)
  await page.getByRole('button', { name: /^Cards/ }).click()
  await expect(
    page.getByRole('heading', { name: 'Cards', exact: true }),
  ).toBeVisible()
}
const card = (page: Page, statement: string | RegExp) =>
  page.getByRole('region', { name: 'Cards' }).getByRole('button', {
    name: statement,
  })

test('the Memory view lists current cards with their organization, and replaced cards on demand', async ({
  page,
}) => {
  await startDemo(page)
  await openCards(page)
  await expect(card(page, /Vegetarian since Oct 2026/)).toContainText(
    'preference · user · Every organization · Confirmed · Core',
  )
  await expect(card(page, /Launch review every Friday/)).toContainText(
    'routine · launch review · Kipster · Confirmed',
  )
  await expect(card(page, /User’s sister/)).toContainText('Inferred')
  await expect(card(page, /Loves steak/)).toHaveCount(0)

  await page.getByRole('switch', { name: 'Show replaced cards' }).check()
  await expect(card(page, /Loves steak/)).toContainText('Replaced')
  await card(page, /Loves steak/).click()
  await expect(
    page.getByText('Only a current card can be edited.', { exact: false }),
  ).toBeVisible()
  await expect(
    page.getByRole('textbox', { name: 'Statement' }),
  ).toHaveAttribute('readonly', '')
  await page.getByRole('button', { name: 'Open replacement' }).click()
  await expect(page.getByRole('textbox', { name: 'Statement' })).toHaveValue(
    'Vegetarian since Oct 2026',
  )
})

test('a person edits a card in the Memory view; Core saves it as confirmed', async ({
  page,
}) => {
  await startDemo(page)
  await openCards(page)
  await card(page, /User’s sister/).click()
  await expect(page.getByText('Inferred from a conversation')).toBeVisible()
  const bodies: unknown[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      request.url().includes('/v1/memory/cards/')
    )
      bodies.push(request.postDataJSON())
  })
  await page
    .getByRole('textbox', { name: 'Statement' })
    .fill('User’s younger sister')
  await page.getByRole('textbox', { name: 'Details' }).fill('[1]')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(
    'Details must be a JSON object',
  )
  expect(bodies).toEqual([])
  await page
    .getByRole('textbox', { name: 'Details' })
    .fill('{"relation": "sister", "age": "younger"}')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Card saved')).toBeVisible()
  await expect(page.getByText('Confirmed: you said it')).toBeVisible()
  expect(bodies).toEqual([
    {
      version: 1,
      statement: 'User’s younger sister',
      details: { relation: 'sister', age: 'younger' },
    },
  ])
  const cards = await coreJson(page, '/v1/memory/cards')
  const saved = cards.cards.find(
    (item: { subject: string }) => item.subject === 'Priya',
  )
  expect([saved.statement, saved.confirmed, saved.details]).toEqual([
    'User’s younger sister',
    true,
    { relation: 'sister', age: 'younger' },
  ])

  await page.getByRole('button', { name: 'Back to Cards' }).click()
  await expect(card(page, /User’s younger sister/)).toContainText('Confirmed')
})

test('deleting a card asks first, then removes it from Core and the list', async ({
  page,
}) => {
  await startDemo(page)
  await openCards(page)
  await card(page, /Dentist on 13 Oct 2026/).click()
  await page.getByRole('button', { name: 'Delete card…' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete this card?' })
  await expect(dialog).toContainText('The messages it was learned from stay.')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  const { cards } = await coreJson(page, '/v1/memory/cards')
  const dentist = cards.find((item: { statement: string }) =>
    item.statement.startsWith('Dentist'),
  )
  expect(dentist).toBeTruthy()

  await page.getByRole('button', { name: 'Delete card…' }).click()
  await dialog.getByRole('button', { name: 'Delete card' }).click()
  await expect(page.getByText('Card deleted')).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Cards', exact: true }),
  ).toBeVisible()
  await expect(card(page, /Dentist on 13 Oct 2026/)).toHaveCount(0)
  expect((await core(page, `/v1/memory/cards/${dentist.id}`)).status()).toBe(
    404,
  )
})

test('the nightly model and the memory counts are saved in Core', async ({
  page,
}) => {
  await startDemo(page)
  await openMemory(page)
  const model = page.getByRole('combobox', { name: 'Nightly model' })
  await expect(model).toHaveValue('')
  await expect(model.locator('option:checked')).toHaveText('Kip’s model')
  await model.selectOption({ label: 'demo · demo-model' })
  await expect
    .poll(
      async () => (await coreJson(page, '/v1/settings/learning')).nightlyModel,
    )
    .toEqual({ adapterId: 'demo', modelId: 'demo-model' })
  await page
    .getByRole('combobox', { name: 'Nightly effort' })
    .selectOption({ label: 'High' })
  await expect
    .poll(
      async () => (await coreJson(page, '/v1/settings/learning')).nightlyModel,
    )
    .toEqual({ adapterId: 'demo', modelId: 'demo-model', effort: 'high' })

  const core = page.getByRole('spinbutton', { name: 'Core cards' })
  await expect(core).toHaveValue('60')
  await core.fill('201')
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled()
  await core.fill('24')
  await page.getByRole('spinbutton', { name: 'Cards from search' }).fill('0')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect
    .poll(async () => {
      const learning = await coreJson(page, '/v1/settings/learning')
      return [
        learning.coreCardCount,
        learning.searchCardCount,
        learning.searchChunkCount,
      ]
    })
    .toEqual([24, 0, 6])
  await expect(page.getByText('Unsaved changes')).toHaveCount(0)
  await expect(core).toHaveValue('24')

  await model.selectOption({ label: 'Kip’s model' })
  await expect
    .poll(
      async () => (await coreJson(page, '/v1/settings/learning')).nightlyModel,
    )
    .toBeNull()
})
