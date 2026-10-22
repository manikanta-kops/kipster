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
async function openMemories(page: Page) {
  await openMemory(page)
  await page.getByRole('button', { name: /^Memories/ }).click()
  await expect(
    page.getByRole('heading', { name: 'Memories', exact: true }),
  ).toBeVisible()
}
const card = (page: Page, statement: string | RegExp) =>
  page.getByRole('region', { name: 'Memories' }).getByRole('button', {
    name: statement,
  })
async function openLessons(page: Page) {
  await openMemory(page)
  await page.getByRole('button', { name: /^Lessons/ }).click()
  await expect(
    page.getByRole('heading', { name: 'Lessons', exact: true }),
  ).toBeVisible()
}
const lesson = (page: Page, kip: string, statement: string | RegExp) =>
  page.getByRole('region', { name: `Lessons of ${kip}` }).getByRole('button', {
    name: statement,
  })

test('the Memory view lists current memories with their workspace, and replaced ones on demand', async ({
  page,
}) => {
  await startDemo(page)
  await openMemories(page)
  await expect(card(page, /Vegetarian since Oct 2026/)).toContainText(
    'preference · user · Every workspace · Confirmed · Core',
  )
  await expect(card(page, /Launch review every Friday/)).toContainText(
    'routine · launch review · Kipster · Confirmed',
  )
  await expect(card(page, /User’s sister/)).toContainText('Inferred')
  await expect(card(page, /Loves steak/)).toHaveCount(0)

  await page
    .getByRole('switch', { name: 'Show replaced and retired memories' })
    .check()
  await expect(card(page, /Loves steak/)).toContainText('Replaced')
  await card(page, /Loves steak/).click()
  await expect(
    page.getByText('Only a current memory can be edited.', { exact: false }),
  ).toBeVisible()
  await expect(
    page.getByRole('textbox', { name: 'Statement' }),
  ).toHaveAttribute('readonly', '')
  await page.getByRole('button', { name: 'Open replacement' }).click()
  await expect(page.getByRole('textbox', { name: 'Statement' })).toHaveValue(
    'Vegetarian since Oct 2026',
  )
})

test('a person edits a memory in the Memory view; Core saves it as confirmed', async ({
  page,
}) => {
  await startDemo(page)
  await openMemories(page)
  await card(page, /User’s sister/).click()
  await expect(page.getByText('Inferred from a conversation')).toBeVisible()
  const bodies: unknown[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      request.url().includes('/v1/memory/memories/')
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
  await expect(page.getByText('Memory saved')).toBeVisible()
  await expect(page.getByText('Confirmed: you said it')).toBeVisible()
  expect(bodies).toEqual([
    {
      version: 1,
      statement: 'User’s younger sister',
      details: { relation: 'sister', age: 'younger' },
    },
  ])
  const listed = await coreJson(page, '/v1/memory/memories')
  const saved = listed.memories.find(
    (item: { subject: string }) => item.subject === 'Priya',
  )
  expect([saved.statement, saved.confirmed, saved.details]).toEqual([
    'User’s younger sister',
    true,
    { relation: 'sister', age: 'younger' },
  ])

  await page.getByRole('button', { name: 'Back to Memories' }).click()
  await expect(card(page, /User’s younger sister/)).toContainText('Confirmed')
})

test('deleting a memory asks first, then removes it from Core and the list', async ({
  page,
}) => {
  await startDemo(page)
  await openMemories(page)
  await card(page, /Dentist on 13 Oct 2026/).click()
  await page.getByRole('button', { name: 'Delete memory…' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete this memory?' })
  await expect(dialog).toContainText('The messages it was learned from stay.')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  const { memories } = await coreJson(page, '/v1/memory/memories')
  const dentist = memories.find((item: { statement: string }) =>
    item.statement.startsWith('Dentist'),
  )
  expect(dentist).toBeTruthy()

  await page.getByRole('button', { name: 'Delete memory…' }).click()
  await dialog.getByRole('button', { name: 'Delete memory' }).click()
  await expect(page.getByText('Memory deleted')).toBeVisible()
  await expect(
    page.getByRole('heading', { name: 'Memories', exact: true }),
  ).toBeVisible()
  await expect(card(page, /Dentist on 13 Oct 2026/)).toHaveCount(0)
  expect((await core(page, `/v1/memory/memories/${dentist.id}`)).status()).toBe(
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

  const core = page.getByRole('spinbutton', { name: 'Core memories' })
  await expect(core).toHaveValue('60')
  await core.fill('201')
  await expect(
    page.getByRole('button', { name: 'Save', exact: true }),
  ).toBeDisabled()
  await core.fill('24')
  await page.getByRole('spinbutton', { name: 'Memories from search' }).fill('0')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect
    .poll(async () => {
      const learning = await coreJson(page, '/v1/settings/learning')
      return [
        learning.coreMemoryCount,
        learning.searchMemoryCount,
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

test('a Core without memories shows the Memory switch and sleep time, but no Memories, Lessons or memory counts', async ({
  page,
}) => {
  await page.route('**/v1/bootstrap', async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    delete body.capabilities.memories
    await route.fulfill({ response, json: body })
  })
  // An older Core's learning settings have no nightly model or counts.
  await page.route('**/v1/settings/learning', async (route) => {
    const response = await route.fetch()
    const {
      nightlyModel: _model,
      coreMemoryCount: _core,
      searchMemoryCount: _cards,
      searchChunkCount: _chunks,
      ...body
    } = await response.json()
    await route.fulfill({ response, json: body })
  })
  const reads: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/v1/memory/')) reads.push(request.url())
  })
  await startDemo(page)
  await openMemory(page)
  const learn = page.getByRole('switch', { name: 'Learn from conversations' })
  await expect(learn).toBeVisible()
  await expect(page.getByLabel('Default sleep time')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Memories/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Lessons/ })).toHaveCount(0)
  await expect(
    page.getByRole('combobox', { name: 'Nightly model' }),
  ).toHaveCount(0)
  await expect(
    page.getByRole('spinbutton', { name: 'Core memories' }),
  ).toHaveCount(0)

  const enabled = (await coreJson(page, '/v1/settings/learning')).enabled
  await learn.click()
  await expect
    .poll(async () => (await coreJson(page, '/v1/settings/learning')).enabled)
    .toBe(!enabled)
  expect(reads).toEqual([])
  // Finish in-flight settings reads before Playwright disposes their responses.
  await page.unrouteAll({ behavior: 'wait' })
})

test('a Core advertising memories offers Memories, which lists them', async ({
  page,
}) => {
  const reads: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/v1/memory/')) reads.push(request.url())
  })
  await startDemo(page)
  await openMemory(page)
  expect(reads).toEqual([])
  await page.getByRole('button', { name: /^Memories/ }).click()
  await expect(card(page, /Vegetarian since Oct 2026/)).toBeVisible()
  expect(reads.length).toBeGreaterThan(0)
})

test('the Lessons view groups lessons by kip, marks the ones in identity.md and shows merged ones on demand', async ({
  page,
}) => {
  await startDemo(page)
  await openLessons(page)
  await expect(lesson(page, 'Kip', /first three steps/)).toContainText(
    'Came up on 4 nights · In identity.md',
  )
  await expect(lesson(page, 'Atlas', /Launch review notes/)).toContainText(
    'Learned in Kipster',
  )
  await expect(lesson(page, 'Atlas', /^Quote sources with/)).toHaveCount(0)
  await page
    .getByRole('switch', { name: 'Show merged and retired lessons' })
    .check()
  await expect(lesson(page, 'Atlas', /^Quote sources with/)).toContainText(
    'Merged',
  )
  await lesson(page, 'Atlas', /^Quote sources with/).click()
  await expect(page.getByRole('textbox', { name: 'Lesson' })).toHaveAttribute(
    'readonly',
    '',
  )
  await page.getByRole('button', { name: 'Open merged lesson' }).click()
  await expect(page.getByRole('textbox', { name: 'Lesson' })).toHaveValue(
    /a link the person can open/,
  )
})

test('a person rewords and deletes a lesson; Core saves both', async ({
  page,
}) => {
  await startDemo(page)
  await openLessons(page)
  await lesson(page, 'Kip', /hotel searches/).click()
  const bodies: unknown[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'PUT' &&
      request.url().includes('/v1/memory/lessons/')
    )
      bodies.push(request.postDataJSON())
  })
  await page
    .getByRole('textbox', { name: 'Lesson' })
    .fill('For hotel searches, give Atlas the dates, the budget and the area')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Lesson saved')).toBeVisible()
  expect(bodies).toEqual([
    {
      version: 1,
      statement:
        'For hotel searches, give Atlas the dates, the budget and the area',
    },
  ])
  await page.getByRole('button', { name: 'Delete lesson…' }).click()
  const dialog = page.getByRole('alertdialog', { name: 'Delete this lesson?' })
  await dialog.getByRole('button', { name: 'Delete lesson' }).click()
  await expect(page.getByText('Lesson deleted')).toBeVisible()
  await expect(lesson(page, 'Kip', /hotel searches/)).toHaveCount(0)
  const { lessons } = await coreJson(page, '/v1/memory/lessons')
  expect(
    lessons.some((item: { statement: string }) =>
      item.statement.includes('hotel'),
    ),
  ).toBe(false)
})
