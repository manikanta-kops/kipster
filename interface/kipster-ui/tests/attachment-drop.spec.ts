import { test, expect, type Locator, type Page } from '@playwright/test'
import { startDemo } from './demo.ts'
import { mediaMessages, send } from './media-helpers.ts'

type Sample = { name: string; type: string; text: string }
const notes: Sample = { name: 'notes.txt', type: 'text/plain', text: 'notes' }
const shot: Sample = { name: 'shot.png', type: 'image/png', text: 'png' }

/** Dispatches the drag sequence a browser sends when files are dragged in from the desktop. */
async function drag(
  target: Locator,
  files: Sample[],
  steps: string[] = ['dragenter', 'dragover', 'drop'],
) {
  return target.evaluate(
    (element, { files, steps }) => {
      const data = new DataTransfer()
      for (const f of files)
        data.items.add(new File([f.text], f.name, { type: f.type }))
      return steps.map((type) => {
        const event = new DragEvent(type, {
          dataTransfer: data,
          bubbles: true,
          cancelable: true,
        })
        element.dispatchEvent(event)
        return event.defaultPrevented
      })
    },
    { files, steps },
  )
}

async function paste(target: Locator, files: Sample[], text = '') {
  return target.evaluate(
    (element, { files, text }) => {
      const data = new DataTransfer()
      for (const f of files)
        data.items.add(new File([f.text], f.name, { type: f.type }))
      if (text) data.setData('text/plain', text)
      const event = new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      })
      element.dispatchEvent(event)
      return event.defaultPrevented
    },
    { files, text },
  )
}

async function openThread(page: Page) {
  await page
    .locator('.feed .message-body')
    .getByText('Shape a calmer workspace for the next release', { exact: true })
    .click()
  return page.getByRole('region', {
    name: 'Thread: Shape a calmer workspace for the next release',
    exact: true,
  })
}

test('files dropped anywhere on the conversation attach and send', async ({
  page,
}) => {
  await startDemo(page)
  const conversation = page.locator('#conversation')
  const feed = conversation.locator('.feed-scroll')
  const overlay = conversation.locator('.file-drop')
  expect(await drag(feed, [notes], ['dragenter', 'dragover'])).toEqual([
    true,
    true,
  ])
  await expect(overlay).toBeVisible()
  await expect(overlay).toContainText('Drop to attach')
  await expect(overlay).toContainText('Files join a new thread')
  await drag(feed, [notes], ['dragleave'])
  await expect(overlay).toHaveCount(0)

  await drag(feed, [notes, shot])
  await expect(overlay).toHaveCount(0)
  const tray = conversation.locator('.pending-media')
  await expect(tray).toHaveCount(2)
  await expect(tray.filter({ hasText: 'notes.txt' })).toContainText('Uploaded')
  await expect(tray.filter({ hasText: 'shot.png' })).toContainText('Uploaded')
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeFocused()
  await send(page, 'Two dropped files')
  await expect(tray).toHaveCount(0)
  await expect
    .poll(async () =>
      (await mediaMessages(page)).map(
        (m: { parts: { kind: string }[] }) =>
          m.parts.filter((p) => p.kind === 'file').length,
      ),
    )
    .toContainEqual(2)
})

test('files dropped on an open thread attach to that thread only', async ({
  page,
}) => {
  await startDemo(page)
  const thread = await openThread(page)
  await drag(thread.locator('.thread-scroll'), [notes], ['dragenter'])
  await expect(thread.locator('.file-drop')).toContainText(
    'Files join your reply',
  )
  await expect(page.locator('#conversation .file-drop')).toHaveCount(0)
  await drag(thread.locator('.thread-scroll'), [notes], ['dragover', 'drop'])
  await expect(thread.locator('.pending-media')).toContainText('notes.txt')
  await expect(page.locator('#conversation .pending-media')).toHaveCount(0)
  await expect(
    thread.getByRole('textbox', { name: 'Reply in this thread' }),
  ).toBeFocused()
})

test('pasted files attach and copied document text still pastes as text', async ({
  page,
}) => {
  await startDemo(page)
  const field = page.getByRole('textbox', { name: 'Start a new thread' })
  const tray = page.locator('#conversation .pending-media')
  expect(await paste(field, [shot])).toBe(true)
  await expect(tray).toHaveCount(1)
  await expect(tray).toContainText('shot.png')
  await expect(tray).toContainText('Uploaded')
  // Spreadsheet and document copies carry text plus a rendered image.
  expect(await paste(field, [shot], 'a\tb')).toBe(false)
  expect(await paste(field, [], 'plain words')).toBe(false)
  await expect(tray).toHaveCount(1)
})

test('folders are refused with a notice and drops outside a chat are ignored', async ({
  page,
}) => {
  await startDemo(page)
  await page.evaluate(() => {
    const original = DataTransferItem.prototype.getAsFile
    Object.defineProperty(DataTransferItem.prototype, 'webkitGetAsEntry', {
      configurable: true,
      value(this: DataTransferItem) {
        return { isDirectory: original.call(this)?.name === 'Designs' }
      },
    })
  })
  const feed = page.locator('#conversation .feed-scroll')
  await drag(feed, [{ name: 'Designs', type: '', text: '' }, notes])
  await expect(page.getByRole('alert')).toContainText(
    'A folder can’t be attached.',
  )
  await expect(page.locator('.pending-media')).toHaveCount(1)
  await expect(page.locator('.pending-media')).toContainText('notes.txt')
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.getByText('A folder can’t be attached.')).toHaveCount(0)

  const sidebar = page.locator('#workspace-sidebar')
  expect(await drag(sidebar, [notes], ['dragover', 'drop'])).toEqual([
    true,
    true,
  ])
  await expect(page.locator('.pending-media')).toHaveCount(1)
  await expect(page.locator('.file-drop')).toHaveCount(0)
})
