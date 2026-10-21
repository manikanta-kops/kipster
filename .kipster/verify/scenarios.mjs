import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { filesPerMessage, fixtureDirectory, fixtureFiles } from './files.mjs'

export const scenarios = [
  'connection',
  'conversations',
  'submission-recovery',
  'question',
  'approval',
  'stop-resume',
  'retry',
  'inbox',
  'create-kip',
  'create-organization',
  'groups',
  'lifecycle',
  'appearance',
  'permissions',
  'instructions',
  'learning',
  'adapters',
  'identity',
  'rich-doc',
  'attachment',
  'kip-files',
  'voice',
  'voice-real',
  'voice-file',
  'updates',
  'plugins',
  'kip-messaging',
]

export async function drive(
  name,
  {
    page,
    expect,
    origin,
    evidenceDir,
    recordingMs,
    silence,
    mediaFile,
    mediaExpect,
  },
) {
  const unique = (label) => `${label} ${crypto.randomUUID().slice(0, 8)}`
  const get = async (path) => {
    const response = await page.request.get(origin + path)
    expect(response.ok()).toBe(true)
    return response.json()
  }
  const setting = async (category) => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page
      .getByRole('dialog', { name: 'Settings', exact: true })
      .getByRole('button', { name: category, exact: true })
      .click()
  }
  const management = async (category) => {
    await setting('Organization')
    await page
      .getByRole('button', { name: 'Manage kips and groups…', exact: true })
      .click()
    await page
      .getByRole('group', { name: 'Management sections' })
      .getByRole('button', { name: category, exact: true })
      .click()
  }
  const createKip = async (label = 'Factory Scout', organization) => {
    const kip = unique(label)
    await management('Kips')
    await page
      .getByRole('button', { name: 'Create new kip', exact: true })
      .click()
    await page.getByLabel('Name', { exact: true }).fill(kip)
    if (organization)
      await page
        .getByRole('checkbox', { name: `Add to ${organization}`, exact: true })
        .check()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect
      .poll(async () =>
        (await get('/v1/directory')).agents.some((agent) => agent.name === kip),
      )
      .toBe(true)
    return kip
  }
  const closeManagement = async () => {
    await page.getByRole('button', { name: 'Close management' }).click()
    await page.getByRole('button', { name: 'Close settings' }).click()
  }
  const root = async (text) => {
    const composer = page.getByRole('form', {
      name: 'Start a new thread',
      exact: true,
    })
    await composer
      .getByRole('textbox', { name: 'Start a new thread' })
      .fill(text)
    const accepted = page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/text/submissions') &&
        response.request().method() === 'POST',
    )
    await composer.getByRole('button', { name: 'Send message' }).click()
    const receipt = await (await accepted).json()
    const feed = page.locator('.feed-message').filter({ hasText: text })
    await expect(feed).toBeVisible()
    await feed.getByRole('button', { name: /^Open thread:/ }).press('Enter')
    return receipt
  }
  const snapshot = (receipt) => get(`/v1/threads/${receipt.threadId}/snapshot`)
  await page.goto(origin)
  await page.locator('.installation-agents button').first().click()
  await expect(
    page.getByRole('textbox', { name: 'Start a new thread' }),
  ).toBeVisible()

  switch (name) {
    case 'connection': {
      expect(
        await page.evaluate(() => localStorage.getItem('kipster-backend-url')),
      ).toBe(origin)
      await setting('Connection')
      await page.getByRole('button', { name: /^Connection details/ }).click()
      await expect(
        page.getByRole('dialog', { name: 'Settings', exact: true }),
      ).toContainText(origin)
      await page.reload()
      await expect(
        page.getByRole('textbox', { name: 'Start a new thread' }),
      ).toBeVisible()
      expect((await get('/v1/bootstrap')).capabilities.documents).toBe(true)
      break
    }
    case 'conversations': {
      const text = unique('Browser root')
      const receipt = await root(text)
      await expect(
        page.getByText(`Fixture reply: ${text}`, { exact: true }),
      ).toBeVisible()
      const followup = unique('Follow-up')
      await page
        .getByRole('textbox', { name: 'Reply in this thread' })
        .fill(followup)
      await page.getByRole('button', { name: 'Send message' }).last().click()
      await expect(
        page.getByText(`Fixture reply: ${followup}`, { exact: true }),
      ).toBeVisible()
      await page.reload()
      await expect(
        page.getByText(`Fixture reply: ${followup}`, { exact: true }),
      ).toBeVisible()
      expect(
        (await snapshot(receipt)).messages.filter((message) =>
          message.parts.some((part) => part.text === followup),
        ),
      ).toHaveLength(1)
      break
    }
    case 'submission-recovery': {
      const text = unique('Lost acknowledgement')
      let intercepted = 0
      await page.route('**/v1/text/submissions', async (route) => {
        if (++intercepted === 1) {
          await route.fetch()
          await route.abort('failed')
        } else await route.continue()
      })
      await page.getByRole('textbox', { name: 'Start a new thread' }).fill(text)
      await page.getByRole('button', { name: 'Send message' }).first().click()
      await expect(
        page.locator('.feed-message').filter({ hasText: text }),
      ).toHaveCount(1)
      await page.reload()
      await expect(
        page.locator('.feed-message').filter({ hasText: text }),
      ).toHaveCount(1)
      expect(intercepted).toBe(1)
      break
    }
    case 'question':
    case 'approval': {
      const question = name === 'question'
      const receipt = await root(
        unique(question ? '__question__' : '__approval__'),
      )
      await expect(
        page.getByText(
          question ? 'Choose a color' : 'Approve fixture action?',
          { exact: true },
        ),
      ).toBeVisible()
      await page.reload()
      if (question)
        await page.getByRole('radio', { name: 'Blue', exact: true }).check()
      await page
        .getByRole('button', {
          name: question ? 'Send answer' : 'Approve',
          exact: true,
        })
        .click()
      await expect(page.getByText(/^Fixture resumed:/)).toBeVisible()
      await expect
        .poll(async () => (await snapshot(receipt)).interactions[0].state)
        .not.toBe('pending')
      break
    }
    case 'stop-resume': {
      const receipt = await root(unique('__hold__'))
      await expect(
        page.getByRole('button', { name: 'Stop work', exact: true }),
      ).toBeEnabled()
      const followup = unique('After resume')
      await page
        .getByRole('textbox', { name: 'Reply in this thread' })
        .fill(followup)
      await page.getByRole('button', { name: 'Send message' }).last().click()
      await page.getByRole('button', { name: 'Stop work', exact: true }).click()
      await expect
        .poll(async () => (await snapshot(receipt)).work[0].state)
        .toBe('cancelled')
      expect((await snapshot(receipt)).work[0].queueHold).toBe(true)
      await page
        .getByRole('button', { name: 'Resume follow-ups', exact: true })
        .click()
      await expect(
        page.getByText(`Fixture reply: ${followup}`, { exact: true }),
      ).toBeVisible()
      break
    }
    case 'retry': {
      const text = unique('__fail_once__')
      const receipt = await root(text)
      await expect
        .poll(async () => (await snapshot(receipt)).work[0].state)
        .toBe('failed')
      await page
        .getByRole('button', { name: 'Retry work', exact: true })
        .click()
      await expect(
        page.getByText(`Fixture reply: ${text}`, { exact: true }),
      ).toBeVisible()
      break
    }
    case 'inbox': {
      const receipt = await root(unique('__question__'))
      await expect(
        page.getByText('Choose a color', { exact: true }),
      ).toBeVisible()
      await page.getByRole('button', { name: /^Notifications,/ }).click()
      const inbox = page.getByRole('dialog', {
        name: 'Notifications',
        exact: true,
      })
      await expect(
        inbox.getByRole('region', { name: 'Needs you' }),
      ).toBeVisible()
      await inbox.getByRole('button', { name: 'Mark all read' }).click()
      await expect
        .poll(async () =>
          (await get('/v1/app/snapshot')).notifications
            .filter((note) => note.runId === receipt.runId)
            .every((note) => note.read),
        )
        .toBe(true)
      expect((await snapshot(receipt)).interactions[0].state).toBe('pending')
      await page.getByRole('button', { name: 'Close notifications' }).click()
      await page.getByRole('radio', { name: 'Blue', exact: true }).check()
      await page
        .getByRole('button', { name: 'Send answer', exact: true })
        .click()
      await expect(page.getByText(/^Fixture resumed:/)).toBeVisible()
      break
    }
    case 'create-kip': {
      const kip = await createKip()
      await closeManagement()
      await page.reload()
      expect(
        (await get('/v1/directory')).agents.filter(
          (agent) => agent.name === kip,
        ),
      ).toHaveLength(1)
      break
    }
    case 'create-organization': {
      await management('Organization')
      const organization = unique('Factory Team')
      await page
        .getByRole('button', { name: 'Create organization', exact: true })
        .click()
      await page.getByLabel('Name', { exact: true }).fill(organization)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect
        .poll(async () =>
          (await get('/v1/directory')).organizations.some(
            (org) => org.name === organization,
          ),
        )
        .toBe(true)
      await closeManagement()
      await page
        .getByRole('combobox', { name: 'Organization' })
        .selectOption({ label: organization })
      await expect(page.locator('.profile-context')).toHaveText(organization)
      break
    }
    case 'groups': {
      await management('Groups')
      const group = unique('Factory Group')
      await page
        .getByRole('button', { name: 'Create group', exact: true })
        .click()
      await page.getByLabel('Name', { exact: true }).fill(group)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect
        .poll(async () =>
          (await get('/v1/directory')).groups.some(
            (item) => item.name === group,
          ),
        )
        .toBe(true)
      break
    }
    case 'lifecycle': {
      const kip = await createKip()
      await closeManagement()
      await setting('Archive & deletion')
      await page
        .getByRole('button', { name: `Archive ${kip}`, exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Confirm archive', exact: true })
        .click()
      await expect(
        page.getByRole('button', { name: `Restore ${kip}`, exact: true }),
      ).toBeVisible()
      await page
        .getByRole('button', { name: `Restore ${kip}`, exact: true })
        .click()
      await page
        .getByRole('button', { name: 'Confirm restore', exact: true })
        .click()
      await expect(
        page.getByRole('button', { name: `Archive ${kip}`, exact: true }),
      ).toBeVisible()
      break
    }
    case 'appearance': {
      const before = await get('/v1/settings/interface')
      await setting('Appearance')
      await page.getByRole('radio', { name: 'Dark', exact: true }).check()
      await expect
        .poll(async () => (await get('/v1/settings/interface')).theme)
        .toBe('dark')
      await page.reload()
      await setting('Appearance')
      await expect(
        page.getByRole('radio', { name: 'Dark', exact: true }),
      ).toBeChecked()
      // Return the shared setting through the UI when possible.
      await page
        .getByRole('radio', {
          name:
            { light: 'Light', dark: 'Dark', system: 'System' }[before.theme] ??
            'System',
          exact: true,
        })
        .check()
      break
    }
    case 'permissions': {
      await setting('Permissions')
      await page.getByRole('radio', { name: 'Supervised', exact: true }).check()
      await expect
        .poll(async () => (await get('/v1/settings/permissions')).mode)
        .toBe('supervised')
      await page.reload()
      await setting('Permissions')
      await expect(
        page.getByRole('radio', { name: 'Supervised', exact: true }),
      ).toBeChecked()
      await page.getByRole('radio', { name: 'Auto', exact: true }).check()
      await expect
        .poll(async () => (await get('/v1/settings/permissions')).mode)
        .toBe('auto')
      break
    }
    case 'instructions': {
      await setting('Organization')
      await page.getByRole('button', { name: /^Instructions/ }).click()
      const text = unique('Use concise fixture replies.')
      await page
        .getByRole('textbox', { name: 'Organization instructions' })
        .fill(text)
      await page.getByRole('button', { name: 'Save instructions' }).click()
      await expect(page.getByText('Saved', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Close settings' }).click()
      await setting('Organization')
      await page.getByRole('button', { name: /^Instructions/ }).click()
      await expect(
        page.getByRole('textbox', { name: 'Organization instructions' }),
      ).toHaveValue(text)
      break
    }
    case 'learning': {
      const before = await get('/v1/settings/learning')
      const chosen = before.sleepTime === '03:15' ? '03:16' : '03:15'
      await setting('Learning')
      await page.getByLabel('Default sleep time', { exact: true }).fill(chosen)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect
        .poll(async () => (await get('/v1/settings/learning')).sleepTime)
        .toBe(chosen)
      await page.screenshot({
        path: `${evidenceDir}/learning-saved.png`,
        fullPage: true,
      })
      await page
        .getByLabel('Default sleep time', { exact: true })
        .fill(before.sleepTime)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect
        .poll(async () => (await get('/v1/settings/learning')).sleepTime)
        .toBe(before.sleepTime)
      break
    }
    case 'adapters': {
      await setting('Adapters')
      await expect(
        page.getByRole('dialog', { name: 'Settings', exact: true }),
      ).toContainText('deterministic-fixture')
      break
    }
    case 'identity': {
      const bootstrap = await get('/v1/bootstrap')
      const identity = await get(
        `/v1/agents/${bootstrap.rootAgentId}/identity/identity.md`,
      )
      expect(identity.file).toBe('identity.md')
      await setting('Kips')
      await expect(
        page.getByRole('dialog', { name: 'Settings', exact: true }),
      ).toContainText('Kip')
      break
    }
    case 'rich-doc': {
      await root(unique('Please write a rich doc'))
      await page
        .getByRole('button', { name: 'Open rich doc: Trip plan' })
        .click()
      const doc = page.getByRole('region', { name: /^Rich doc: Trip plan/ })
      await doc.getByRole('radio', { name: /Oslo/ }).click()
      await doc.getByRole('checkbox', { name: 'Done: Book flights' }).check()
      await doc
        .getByRole('slider', { name: 'How flexible are the dates?' })
        .focus()
      await page.keyboard.press('ArrowRight')
      await expect(doc.getByText('2 of 2 answered')).toBeVisible()
      await expect(doc.getByText('Draft saved')).toBeVisible()
      await doc
        .getByRole('textbox', { name: 'Note for Kip' })
        .fill('Oslo it is.')
      await doc.getByRole('button', { name: 'Submit', exact: true }).click()
      await expect(doc.getByText('Trip plan, revised')).toBeVisible()
      await expect(
        doc.getByRole('button', { name: 'Revision 3, show revisions' }),
      ).toBeVisible()
      await expect(
        doc.getByRole('checkbox', { name: 'Done: Book flights' }),
      ).toBeChecked()
      break
    }
    case 'attachment': {
      const file = unique('fixture') + '.txt'
      const composer = page.getByRole('form', {
        name: 'Start a new thread',
        exact: true,
      })
      await composer.locator('input[type=file]').setInputFiles({
        name: file,
        mimeType: 'text/plain',
        buffer: Buffer.from('Factory attachment bytes\n'),
      })
      await expect(composer.getByText(file, { exact: true })).toBeVisible()
      await composer.getByRole('textbox').fill('Read this fixture attachment')
      const accepted = page.waitForResponse(
        (response) =>
          response.url().endsWith('/v1/text/submissions') &&
          response.request().method() === 'POST',
      )
      await composer.getByRole('button', { name: 'Send message' }).click()
      const receipt = await (await accepted).json()
      // Earlier runs leave roots with the same caption; find this one by file.
      const feed = page.locator('.feed-message').filter({
        has: page.getByRole('region', { name: `File: ${file}`, exact: true }),
      })
      await expect(feed).toBeVisible()
      await feed.getByRole('button', { name: /^Open thread:/ }).press('Enter')
      // The root shows in both the feed and the thread pane; check the pane.
      await expect(
        page
          .locator('.thread-pane')
          .getByRole('region', { name: `File: ${file}`, exact: true }),
      ).toBeVisible()
      const saved = await snapshot(receipt)
      const bootstrap = await get('/v1/bootstrap')
      const original = saved.messages.find(
        (message) => message.authorId === bootstrap.callerId,
      )
      const target = {
        installationId: bootstrap.installationId,
        callerId: bootstrap.callerId,
        context: {
          kind: 'installation',
          installationId: bootstrap.installationId,
        },
        chatId: receipt.chatId,
        threadId: receipt.threadId,
      }
      const content = await page.request.get(
        `${origin}/conversations/media/artifacts/${original.parts.find((part) => part.kind === 'file').artifactId}/content?target=${encodeURIComponent(JSON.stringify(target))}`,
      )
      expect(content.ok()).toBe(true)
      expect((await content.body()).toString()).toBe(
        'Factory attachment bytes\n',
      )
      break
    }
    case 'kip-files': {
      // The fixture kip attaches one real file of each common type by path, in
      // a new thread and again in a reply, through post_chat_message.
      const bootstrap = await get('/v1/bootstrap')
      const pdfViewer = await page.evaluate(
        () => navigator.pdfViewerEnabled === true,
      )
      const originals = Object.fromEntries(
        await Promise.all(
          fixtureFiles.map(async ({ name }) => [
            name,
            await readFile(join(fixtureDirectory, name)),
          ]),
        ),
      )
      const size = (bytes) =>
        bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KB`
      const pane = page.locator('.thread-pane')
      const details = {
        chrome: page.context().browser()?.version(),
        pdfViewerEnabled: pdfViewer,
        runs: [],
      }
      // Checks the newest kip file messages in the open thread, on screen and in Core.
      const check = async (label, receipt) => {
        const messages = pane.locator('.message-body')
        const message = (text) =>
          messages.filter({ has: page.getByText(text, { exact: true }) }).last()
        const scopes = [message('Fixture files'), message('More fixture files')]
        const run = { label, threadId: receipt.threadId, files: {} }
        for (const [index, file] of fixtureFiles.entries()) {
          const { name, mimeType } = file
          const bytes = originals[name]
          const card = scopes[index < filesPerMessage ? 0 : 1].getByRole(
            'region',
            { name: `File: ${name}`, exact: true },
          )
          // Without Chrome's PDF viewer a PDF falls back to the generic card.
          const preview =
            file.preview === 'pdf' && !pdfViewer ? 'generic' : file.preview
          await expect(card).toBeVisible()
          await expect(card.locator('.artifact-name strong')).toHaveText(name)
          await expect(card.locator('.artifact-name small')).toHaveText(
            `${size(bytes.length)} · ${mimeType}`,
          )
          const previews = card.locator(
            'img, audio, video, iframe, [aria-label^="Text preview"]',
          )
          if (preview === 'generic') {
            await expect(previews).toHaveCount(0)
            await card
              .getByRole('button', { name: `Prepare download ${name}` })
              .click()
          } else {
            await expect(previews).toHaveCount(1)
            if (preview === 'image') {
              const image = card.getByRole('img', { name, exact: true })
              await expect(image).toBeVisible()
              await expect
                .poll(() => image.evaluate((e) => e.naturalWidth))
                .toBeGreaterThan(0)
            } else if (preview === 'audio' || preview === 'video') {
              const player = card.locator(preview)
              await expect(player).toHaveAccessibleName(`Play ${name}`)
              // Metadata loads only for bytes Chrome can really decode.
              await expect
                .poll(() => player.evaluate((e) => e.readyState))
                .toBeGreaterThan(0)
              expect(await player.evaluate((e) => e.duration)).toBeGreaterThan(
                0,
              )
            } else if (preview === 'pdf') {
              const frame = card.locator('iframe')
              await expect(frame).toHaveAttribute(
                'title',
                `PDF preview of ${name}`,
              )
              await expect(frame).toHaveAttribute('src', /^blob:/)
              // The frame loads lazily; bring it into view so Chrome paints it.
              await frame.scrollIntoViewIfNeeded()
              await expect(frame).toBeVisible()
            } else {
              const text = card.getByRole('region', {
                name: `Text preview of ${name}`,
              })
              // Markup in the file is shown as text, never rendered.
              await expect(text.locator('pre')).toHaveText(
                bytes.toString().replace(/\n$/, ''),
                { useInnerText: true },
              )
              await expect(
                text.locator('pre *, b, i, h1, strong, script'),
              ).toHaveCount(0)
            }
          }
          const downloaded = page.waitForEvent('download')
          await card.getByRole('link', { name: `Download ${name}` }).click()
          const download = await downloaded
          expect(download.suggestedFilename()).toBe(name)
          const chunks = []
          for await (const chunk of await download.createReadStream())
            chunks.push(chunk)
          expect(Buffer.concat(chunks).equals(bytes)).toBe(true)
          // Loaded content still shows no preview for a generic file.
          if (preview === 'generic') await expect(previews).toHaveCount(0)
          run.files[name] = { preview, downloadMatches: true }
        }
        // Core's record of the same messages: text, file names, types and bytes.
        const saved = await snapshot(receipt)
        const target = encodeURIComponent(
          JSON.stringify({
            installationId: bootstrap.installationId,
            callerId: bootstrap.callerId,
            context: {
              kind: 'installation',
              installationId: bootstrap.installationId,
            },
            chatId: receipt.chatId,
            threadId: receipt.threadId,
          }),
        )
        const published = ['Fixture files', 'More fixture files'].map((text) =>
          saved.messages
            .filter(
              (message) =>
                message.authorId !== bootstrap.callerId &&
                message.parts.some((part) => part.text === text),
            )
            .at(-1),
        )
        const artifacts = published.flatMap((message) =>
          message.parts
            .filter((part) => part.kind === 'file')
            .map((part) => part.artifactId),
        )
        expect(artifacts).toHaveLength(fixtureFiles.length)
        for (const [index, artifactId] of artifacts.entries()) {
          const { name, mimeType } = fixtureFiles[index]
          const metadata = await get(
            `/conversations/media/artifacts/${artifactId}?target=${target}`,
          )
          expect(metadata).toMatchObject({
            id: artifactId,
            name,
            mimeType,
            size: originals[name].length,
            availability: 'registered',
          })
          const content = await page.request.get(
            `${origin}/conversations/media/artifacts/${artifactId}/content?target=${target}`,
          )
          expect(content.ok()).toBe(true)
          expect((await content.body()).equals(originals[name])).toBe(true)
          Object.assign(run.files[name], {
            artifactId,
            mimeType: metadata.mimeType,
            size: metadata.size,
          })
        }
        details.runs.push(run)
      }
      const shot = (step, locator = page) =>
        locator.screenshot({
          path: `${evidenceDir}/kip-files-${step}.png`,
          ...(locator === page ? { fullPage: true } : {}),
        })

      // A new thread from the main chat; the kip's files open in its thread.
      const first = unique('__files__ new thread')
      const receipt = await root(first)
      await expect(
        pane.getByText(`Fixture sent files: ${first}`, { exact: true }),
      ).toBeVisible()
      await expect(
        page
          .locator('.feed-message')
          .filter({ hasText: first })
          .locator('.reply-link'),
      ).toBeVisible()
      await check('new thread', receipt)
      await shot('main-chat')

      // A reply inside the open thread.
      const reply = unique('__files__ reply')
      await page
        .getByRole('textbox', { name: 'Reply in this thread' })
        .fill(reply)
      await page.getByRole('button', { name: 'Send message' }).last().click()
      await expect(
        pane.getByText(`Fixture sent files: ${reply}`, { exact: true }),
      ).toBeVisible()
      await check('reply in thread', receipt)
      await shot('thread-pane')
      await shot('thread-pane-files', pane)

      // Light and dark only follow the system when the shared setting allows it.
      details.theme = (await get('/v1/settings/interface')).theme
      if (details.theme === 'system')
        for (const scheme of ['light', 'dark']) {
          await page.emulateMedia({ colorScheme: scheme })
          await shot(scheme)
        }
      expect(await page.evaluate(() => 'mediaExecuted' in window)).toBe(false)
      await writeFile(
        `${evidenceDir}/kip-files-details.json`,
        JSON.stringify(details, null, 2) + '\n',
      )
      break
    }
    case 'voice':
    case 'voice-real': {
      const real =
        (await get('/__fixture/transcription')).provider === 'transcribe-cpp'
      if (name === 'voice-real')
        expect(real, 'Stage the model before factory startup').toBe(true)
      if (name === 'voice' && real) {
        await writeFile(
          `${evidenceDir}/voice-skipped.json`,
          JSON.stringify({
            result: 'skipped',
            reason:
              'Real transcription active; use voice-real with speech and silence WAVs',
          }),
        )
        return { result: 'skipped' }
      }
      if (name === 'voice')
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'mediaDevices', {
            value: {
              getUserMedia: async () => {
                const audio = new AudioContext(),
                  oscillator = audio.createOscillator(),
                  destination = audio.createMediaStreamDestination()
                oscillator.connect(destination)
                oscillator.start()
                await audio.resume()
                const track = destination.stream.getTracks()[0],
                  stop = track.stop.bind(track)
                track.stop = () => {
                  stop()
                  oscillator.stop()
                  void audio.close()
                }
                return destination.stream
              },
            },
          })
        })
      await page
        .getByRole('button', { name: 'Record voice note', exact: true })
        .click()
      await expect(
        page.getByRole('button', { name: 'Stop recording' }),
      ).toBeVisible()
      await page.waitForTimeout(recordingMs ?? 700)
      await page.getByRole('button', { name: 'Stop recording' }).click()
      await expect(page.locator('.pending-media .voice-play')).toBeVisible()
      const accepted = page.waitForResponse(
        (response) =>
          response.url().endsWith('/v1/text/submissions') &&
          response.request().method() === 'POST',
      )
      const voiceFeed = page.locator('.feed-message').filter({
        has: page.getByRole('region', { name: 'Voice preparation' }),
      })
      const before = await voiceFeed.count()
      await page.getByRole('button', { name: 'Send message' }).first().click()
      const receipt = await (await accepted).json()
      await expect(voiceFeed).toHaveCount(before + 1)
      await voiceFeed
        .last()
        .getByRole('button', { name: /^Open thread:/ })
        .press('Enter')
      const expected =
        name === 'voice' ? 'unavailable' : silence ? 'no-speech' : 'succeeded'
      let transcript
      await expect
        .poll(
          async () => {
            const state = await snapshot(receipt)
            transcript = state.messages.flatMap(
              (message) => message.preparation ?? [],
            )[0]
            return transcript?.status
          },
          { timeout: 180000 },
        )
        .toBe(expected)
      const pane = page.locator('.thread-pane')
      if (expected === 'succeeded') {
        expect(transcript.transcript.trim().length).toBeGreaterThan(0)
        await pane
          .getByRole('region', { name: 'Voice preparation' })
          .getByText('Transcript', { exact: true })
          .click()
        await expect(
          pane.getByText(transcript.transcript, { exact: true }),
        ).toBeVisible({ timeout: 10000 })
      } else
        await expect(pane).toContainText(
          expected === 'no-speech'
            ? 'No speech detected'
            : 'Transcription unavailable',
        )
      const reply = pane.getByText(
        new RegExp(
          `^Fixture received voice_note; original available; transcription ${expected};`,
        ),
      )
      await expect(reply).toBeVisible({ timeout: 15000 })
      if (expected === 'succeeded')
        await expect(reply).toContainText(`transcript ${transcript.transcript}`)
      await writeFile(
        `${evidenceDir}/${name}-transcript.json`,
        JSON.stringify(
          {
            expected,
            transcript,
            received: await reply.innerText(),
            threadId: receipt.threadId,
          },
          null,
          2,
        ) + '\n',
      )
      break
    }
    case 'voice-file': {
      // The fixture kip calls Core's transcribe tool on the attached file.
      expect(
        (await get('/__fixture/transcription')).provider,
        'Stage the model and FFmpeg before factory startup',
      ).toBe('transcribe-cpp')
      const composer = page.getByRole('form', {
        name: 'Start a new thread',
        exact: true,
      })
      const file = basename(mediaFile)
      await composer.locator('input[type=file]').setInputFiles(mediaFile)
      await expect(composer.getByText(file, { exact: true })).toBeVisible()
      const caption = unique('Please transcribe this file')
      await composer.getByRole('textbox').fill(caption)
      const accepted = page.waitForResponse(
        (response) =>
          response.url().endsWith('/v1/text/submissions') &&
          response.request().method() === 'POST',
      )
      await composer.getByRole('button', { name: 'Send message' }).click()
      const receipt = await (await accepted).json()
      const feed = page.locator('.feed-message').filter({
        has: page.getByText(caption, { exact: true }),
      })
      await feed.getByRole('button', { name: /^Open thread:/ }).press('Enter')
      const reply = page
        .locator('.thread-pane')
        .getByText(
          new RegExp(
            `^Fixture transcribed ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}; status `,
          ),
        )
      await expect(reply).toBeVisible({ timeout: 180000 })
      const received = await reply.innerText()
      expect(received).toContain(`status ${mediaExpect}`)
      if (mediaExpect === 'succeeded')
        expect(
          received.split('; transcript ')[1]?.trim().length,
        ).toBeGreaterThan(0)
      await writeFile(
        `${evidenceDir}/voice-file-result.json`,
        JSON.stringify(
          { file, expected: mediaExpect, received, threadId: receipt.threadId },
          null,
          2,
        ) + '\n',
      )
      await page.screenshot({ path: `${evidenceDir}/voice-file.png` })
      break
    }
    case 'updates': {
      const bootstrap = await get('/v1/bootstrap')
      await setting('Updates')
      await page
        .getByRole('button', { name: 'Check for updates', exact: true })
        .click()
      await expect
        .poll(async () => (await get('/v1/updates')).checkedAt)
        .not.toBe(null)
      const updates = await get('/v1/updates')
      expect(updates.core.managed).toBe(false)
      expect(updates.core.available).toBe(null)
      await page.getByRole('button', { name: /Version details/ }).click()
      await expect(page.locator('[aria-label="Versions"]')).toContainText(
        bootstrap.coreVersion,
      )
      break
    }
    case 'plugins': {
      // Bootstrap reports plugins once the instance's plugin server is ready.
      await expect
        .poll(async () => (await get('/v1/bootstrap')).capabilities.plugins, {
          timeout: 60000,
        })
        .toBe(true)
      await page.reload()
      await page
        .getByRole('complementary', { name: 'Workspace' })
        .getByRole('button', { name: 'Plugins', exact: true })
        .click()
      const sheet = page.getByRole('dialog', { name: 'Settings', exact: true })
      await expect(
        sheet.getByRole('heading', { name: 'Plugins', exact: true }),
      ).toBeVisible()
      await sheet
        .getByRole('searchbox', { name: 'Search plugins' })
        .fill('fixture')
      await sheet.getByRole('button', { name: /^Fixture/ }).click()
      await expect(
        sheet.getByRole('heading', { name: 'Fixture', exact: true }),
      ).toBeVisible()
      const rows = sheet
        .getByRole('region', { name: 'Accounts' })
        .locator('.set-plugin-account')
      const state = async () =>
        (await get('/v1/plugins/accounts?plugin=fixture')).accounts
      // The screen shows exactly Core's accounts, labels, defaults and status.
      const matchesCore = async (count) => {
        await expect.poll(async () => (await state()).length).toBe(count)
        const accounts = await state()
        if (!count)
          await expect(
            sheet.getByRole('button', { name: 'Connect', exact: true }),
          ).toBeVisible()
        await expect(rows).toHaveCount(count)
        for (const account of accounts) {
          const row = rows.filter({
            has: page.getByRole('button', {
              name: `Rename ${account.label}`,
              exact: true,
            }),
          })
          await expect(row).toHaveCount(1)
          await expect(row.locator('.set-tag')).toHaveCount(
            account.isDefault ? 1 : 0,
          )
          await expect(row).toContainText(
            account.status === 'working' ? 'Working' : 'Reconnect needed',
          )
        }
        return accounts
      }
      const disconnect = async (label) => {
        await sheet
          .getByRole('button', { name: `Disconnect ${label}`, exact: true })
          .click()
        await page
          .getByRole('alertdialog', { name: `Disconnect ${label}?` })
          .getByRole('button', { name: 'Disconnect', exact: true })
          .click()
        await expect(
          sheet.getByRole('button', { name: `Rename ${label}`, exact: true }),
        ).toHaveCount(0)
      }
      const known = new Set()
      // Sign in at the fixture service in the new tab; this page updates itself.
      const signIn = async (button, user, count) => {
        const opened = page.waitForEvent('popup')
        await button.click()
        const tab = await opened
        await tab
          .getByRole('link', { name: `Sign in as ${user}`, exact: true })
          .click()
        await expect(tab.locator('body')).toContainText('Signed in as')
        await tab.close()
        const accounts = await matchesCore(count)
        const added = accounts.find((account) => !known.has(account.id))
        known.add(added.id)
        await expect(
          sheet.getByText(`Connected ${added.label}.`, { exact: true }),
        ).toBeVisible()
        return added
      }
      const shot = (step) =>
        page.screenshot({
          path: `${evidenceDir}/plugins-${step}.png`,
          fullPage: true,
        })
      // Accounts left by an earlier run are disconnected first.
      for (const account of await state()) await disconnect(account.label)
      await matchesCore(0)

      const first = await signIn(
        sheet.getByRole('button', { name: 'Connect', exact: true }),
        'alice',
        1,
      )
      await shot('connect')

      const second = await signIn(
        sheet.getByRole('button', { name: 'Add another account…' }),
        'bob',
        2,
      )
      await shot('second-account')

      const label = unique('Factory side project')
      await sheet
        .getByRole('button', { name: `Rename ${second.label}`, exact: true })
        .click()
      await sheet
        .getByRole('textbox', { name: `New name for ${second.label}` })
        .fill(label)
      await sheet.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByText('Account renamed')).toBeVisible()
      expect(
        (await matchesCore(2)).find((account) => account.id === second.id)
          .label,
      ).toBe(label)
      await shot('rename')

      await sheet
        .getByRole('button', {
          name: `Make ${first.label} the default`,
          exact: true,
        })
        .click()
      await expect(page.getByText('Default account changed')).toBeVisible()
      expect(
        (await matchesCore(2)).map((account) => [
          account.id,
          account.isDefault,
        ]),
      ).toEqual(
        expect.arrayContaining([
          [first.id, true],
          [second.id, false],
        ]),
      )
      await shot('default')

      await disconnect(label)
      expect(await matchesCore(1)).toMatchObject([
        { id: first.id, label: first.label, isDefault: true },
      ])
      await shot('disconnect')
      break
    }
    case 'kip-messaging': {
      // Decision record 11, scenarios 1, 2 and 7 and the silent end, on both
      // sides of each conversation. `__message_kip__` sends a kip message,
      // `__slow__` delays the answer, `__question__` asks the person and
      // `__silent__` ends the woken sender's turn without a message.
      const bootstrap = await get('/v1/bootstrap')
      const directory = await get('/v1/directory')
      const you = bootstrap.callerId
      const adminId = bootstrap.rootAgentId
      const admin = directory.agents.find((agent) => agent.id === adminId).name
      const garden = directory.organizations.find(
        (org) => org.id === bootstrap.organizationId,
      )
      const kips = page.getByRole('navigation', { name: 'Kips' })
      const openAdmin = () =>
        page.locator('.installation-agents button').first().click()
      await page
        .getByRole('combobox', { name: 'Organization' })
        .selectOption({ label: garden.name })
      const planner = await createKip('Planner', garden.name)
      await closeManagement()
      const plannerId = (await get('/v1/directory')).agents.find(
        (agent) => agent.name === planner,
      ).id
      await expect
        .poll(async () =>
          (await get('/v1/directory')).memberships.some(
            (m) => m.agentId === plannerId && m.organizationId === garden.id,
          ),
        )
        .toBe(true)

      const id = crypto.randomUUID().slice(0, 8)
      const slow = { timeout: 45000 }
      const pane = page.locator('.thread-pane')
      // The open thread once a switch has finished: the one pane showing `text`.
      const showing = async (text) => {
        await expect(pane.filter({ hasText: text })).toBeVisible(slow)
        await expect(pane).toHaveCount(1)
      }
      // Opens a thread through a link, retrying while the app learns of it.
      const follow = (button, text) =>
        expect(async () => {
          if (!(await pane.filter({ hasText: text }).count()))
            await pane
              .getByRole('button', button)
              .first()
              .click({ timeout: 2000 })
          await expect(pane.filter({ hasText: text })).toBeVisible({
            timeout: 2000,
          })
        }).toPass(slow)
      const answerCard = (from) =>
        pane.locator('.message-body').filter({
          has: page.getByRole('button', {
            name: `Answer from ${from}’s thread`,
            exact: true,
          }),
        })
      const shot = (name) =>
        page.screenshot({ path: `${evidenceDir}/${name}.png`, fullPage: true })
      const part = (message, kind) =>
        message.parts.find((item) => item.kind === kind)
      const textOf = (message) =>
        message.parts
          .filter((item) => item.kind === 'text')
          .map((item) => item.text)
          .join('\n')
      // Core's messages of a thread in order, as [author, text].
      const thread = async (threadId) =>
        (await get(`/v1/threads/${threadId}/snapshot`)).messages.sort(
          (a, b) => a.position - b.position,
        )
      const said = (messages) =>
        messages.map((message) => [message.authorId, textOf(message)])
      // A thread's summary, read from the application snapshot page by page.
      const summary = async (threadId) => {
        const first = await get('/v1/app/snapshot')
        for (let current = first; ;) {
          const found = current.threads.find((t) => t.threadId === threadId)
          if (found || !current.next) return found
          const query = new URLSearchParams({ at: first.cursor })
          for (const [key, value] of Object.entries(current.next))
            if (value) query.set(key, value)
          current = await get(`/v1/app/snapshot?${query}`)
        }
      }
      const linkedOf = async (threadId) =>
        part(
          (await thread(threadId)).find((m) => part(m, 'kip-message')),
          'kip-message',
        ).threadId
      const details = { admin, planner, plannerId }

      // 1. You ask the admin kip; it messages Planner, its turn ends and the
      // thread waits for Planner's answer, which wakes it to reply to you.
      await openAdmin()
      const s1Body = `__slow__ Which trip plans are confirmed? ${id}`
      const s1Text = `__message_kip__ ${planner}: ${s1Body}`
      const s1 = await root(s1Text)
      await showing(s1Text)
      await expect(
        pane.getByRole('region', { name: `Sent to ${planner}`, exact: true }),
      ).toContainText(s1Body)
      await expect(
        pane.getByText(`Fixture sent a message to ${planner}`, { exact: true }),
      ).toBeVisible()
      await expect(pane.locator('.kip-waiting')).toContainText(
        `Waiting for ${planner}`,
      )
      expect((await summary(s1.threadId)).links).toEqual([
        expect.objectContaining({ agentId: plannerId, waiting: true }),
      ])
      await shot('s1-sender-waiting')
      await follow(
        { name: `Open in ${planner}’s chat`, exact: true },
        `${admin} started this thread from`,
      )
      await expect(pane).toHaveCount(1)
      await expect(
        pane.getByText(`Fixture reply: ${s1Body}`, { exact: true }),
      ).toBeVisible(slow)
      await expect(
        page.locator('.feed-message').filter({ hasText: s1Body }),
      ).toContainText('Kip message')
      await shot('s1-recipient')
      await follow({ name: /^Sent from “/ }, s1Text)
      await expect(pane).toHaveCount(1)
      await expect(answerCard(planner)).toContainText(
        `Fixture reply: ${s1Body}`,
        slow,
      )
      await expect(
        pane.getByText(`Fixture reply: Fixture reply: ${s1Body}`, {
          exact: true,
        }),
      ).toBeVisible(slow)
      await expect(pane.locator('.kip-waiting')).toHaveCount(0)
      await shot('s1-sender')
      const s1Linked = await linkedOf(s1.threadId)
      expect(said(await thread(s1.threadId))).toEqual([
        [you, s1Text],
        [adminId, s1Body],
        [adminId, `Fixture sent a message to ${planner}`],
        [plannerId, `Fixture reply: ${s1Body}`],
        [adminId, `Fixture reply: Fixture reply: ${s1Body}`],
      ])
      expect(part((await thread(s1.threadId))[3], 'kip-answer')).toMatchObject({
        agentId: plannerId,
        threadId: s1Linked,
      })
      expect(said(await thread(s1Linked))).toEqual([
        [adminId, s1Body],
        [plannerId, `Fixture reply: ${s1Body}`],
      ])
      expect(await summary(s1Linked)).toMatchObject({
        agentId: plannerId,
        contextKind: 'organization',
        contextId: garden.id,
        startedBy: adminId,
        linkedFrom: { threadId: s1.threadId, agentId: adminId },
      })
      expect((await summary(s1.threadId)).links).toEqual([
        expect.objectContaining({
          agentId: plannerId,
          threadId: s1Linked,
          waiting: false,
        }),
      ])
      details.s1 = { threadId: s1.threadId, linkedThreadId: s1Linked }

      // 2. In Planner's thread you ask for the admin kip's feedback and keep
      // chatting; the answer lands after your messages and wakes Planner.
      await kips.getByRole('button', { name: planner, exact: true }).click()
      const s2Body = `__slow__ Feedback on the Berlin trip plan? ${id}`
      const s2Text = `__message_kip__ ${admin}: ${s2Body}`
      const s2 = await root(s2Text)
      await showing(s2Text)
      await expect(
        pane.getByText(`Fixture sent a message to ${admin}`, { exact: true }),
      ).toBeVisible()
      const followup = `__slow__ Which train do we take? ${id}`
      await page
        .getByRole('textbox', { name: 'Reply in this thread' })
        .fill(followup)
      await page.getByRole('button', { name: 'Send message' }).last().click()
      await expect(
        pane.getByText(`Fixture reply: ${followup}`, { exact: true }),
      ).toBeVisible(slow)
      await expect(answerCard(admin)).toContainText(
        `Fixture reply: ${s2Body}`,
        slow,
      )
      await expect(
        pane.getByText(`Fixture reply: Fixture reply: ${s2Body}`, {
          exact: true,
        }),
      ).toBeVisible(slow)
      await shot('s2-sender')
      const s2Messages = await thread(s2.threadId)
      const s2Said = said(s2Messages)
      const at = (author, text) =>
        s2Said.findIndex(([who, what]) => who === author && what === text)
      const order = [
        at(you, s2Text),
        at(plannerId, s2Body),
        at(plannerId, `Fixture sent a message to ${admin}`),
        at(you, followup),
        at(adminId, `Fixture reply: ${s2Body}`),
        at(plannerId, `Fixture reply: Fixture reply: ${s2Body}`),
      ]
      expect(order.every((index) => index >= 0)).toBe(true)
      expect(order).toEqual([...order].sort((a, b) => a - b))
      expect(s2Messages).toHaveLength(7)
      const s2Answer = s2Messages[order[4]]
      const s2Linked = await linkedOf(s2.threadId)
      expect(part(s2Answer, 'kip-answer')).toMatchObject({
        agentId: adminId,
        threadId: s2Linked,
      })
      // The answer's turn comes after your follow-up's turn in the queue.
      const s2Work = (await snapshot(s2)).work
      const turn = (message) =>
        s2Work.find((work) => work.messageId === message.id)
      expect(turn(s2Answer).state).toBe('completed')
      expect(turn(s2Answer).queuePosition).toBeGreaterThan(
        turn(s2Messages[order[3]]).queuePosition,
      )
      details.s2 = {
        threadId: s2.threadId,
        linkedThreadId: s2Linked,
        // Whether the answer arrived while Planner still worked on your follow-up.
        answerQueuedBehindRunningTurn:
          order[4] < at(plannerId, `Fixture reply: ${followup}`),
      }
      await follow(
        { name: `Open in ${admin}’s chat`, exact: true },
        `${planner} started this thread from`,
      )
      await expect(pane).toHaveCount(1)
      await expect(
        pane.getByText(`Fixture reply: ${s2Body}`, { exact: true }),
      ).toBeVisible()
      await shot('s2-recipient')
      expect(said(await thread(s2Linked))).toEqual([
        [plannerId, s2Body],
        [adminId, `Fixture reply: ${s2Body}`],
      ])
      expect(await summary(s2Linked)).toMatchObject({
        agentId: adminId,
        contextKind: 'installation',
        startedBy: plannerId,
        linkedFrom: { threadId: s2.threadId, agentId: plannerId },
      })

      // 7. Planner, working for the admin kip, asks you in the linked thread;
      // you answer there and Planner's answer goes back to the admin kip.
      await openAdmin()
      const s7Body = `__question__ Book the hotel for the Berlin trip? ${id}`
      const s7Text = `__message_kip__ ${planner}: ${s7Body}`
      const s7 = await root(s7Text)
      await showing(s7Text)
      await expect(
        pane.getByRole('region', { name: `Sent to ${planner}`, exact: true }),
      ).toContainText(s7Body)
      await expect(pane.locator('.kip-waiting')).toContainText(
        `Waiting for ${planner}`,
      )
      await follow(
        { name: `Open in ${planner}’s chat`, exact: true },
        `${admin} started this thread from`,
      )
      await expect(pane).toHaveCount(1)
      await expect(
        pane.getByText('Choose a color', { exact: true }),
      ).toBeVisible(slow)
      await expect(pane.getByText('Needs your answer').first()).toBeVisible()
      await expect(
        kips.getByRole('button', { name: planner, exact: true }),
      ).toHaveAttribute('data-mark', 'needs')
      await shot('s7-recipient-question')
      await pane.getByRole('radio', { name: 'Blue', exact: true }).check()
      await pane
        .getByRole('button', { name: 'Send answer', exact: true })
        .click()
      await expect(pane.getByText(/^Fixture resumed:/)).toBeVisible(slow)
      await shot('s7-recipient')
      const s7Linked = await linkedOf(s7.threadId)
      const s7Recipient = await get(`/v1/threads/${s7Linked}/snapshot`)
      expect(s7Recipient.interactions).toEqual([
        expect.objectContaining({ kind: 'question', state: 'settled' }),
      ])
      const resumed = textOf(
        (await thread(s7Linked)).filter((m) => m.authorId === plannerId).at(-1),
      )
      expect(resumed).toMatch(/^Fixture resumed:/)
      await follow({ name: /^Sent from “/ }, s7Text)
      await expect(pane).toHaveCount(1)
      await expect(answerCard(planner)).toContainText(resumed, slow)
      await expect(
        pane.getByText(`Fixture reply: ${resumed}`, { exact: true }),
      ).toBeVisible(slow)
      await shot('s7-sender')
      expect(said(await thread(s7.threadId))).toEqual([
        [you, s7Text],
        [adminId, s7Body],
        [adminId, `Fixture sent a message to ${planner}`],
        [plannerId, resumed],
        [adminId, `Fixture reply: ${resumed}`],
      ])
      details.s7 = { threadId: s7.threadId, linkedThreadId: s7Linked }

      // The silent end: Planner's answer repeats `__silent__`, which wakes the
      // admin kip; it has nothing to add and Core saves no message.
      await openAdmin()
      const quietBody = `__silent__ The Berlin budget is approved ${id}`
      const quietText = `__message_kip__ ${planner}: ${quietBody}`
      const quiet = await root(quietText)
      await showing(quietText)
      await expect(answerCard(planner)).toContainText(quietBody, slow)
      await expect
        .poll(async () => {
          const saved = await snapshot(quiet)
          const answer = saved.messages.find((m) => part(m, 'kip-answer'))
          return answer && saved.work.find((w) => w.messageId === answer.id)
        }, slow)
        .toMatchObject({ state: 'completed' })
      expect(said(await thread(quiet.threadId))).toEqual([
        [you, quietText],
        [adminId, quietBody],
        [adminId, `Fixture sent a message to ${planner}`],
        [plannerId, quietBody],
      ])
      await shot('silent-sender')
      details.silent = { threadId: quiet.threadId }
      await writeFile(
        `${evidenceDir}/kip-messaging-details.json`,
        JSON.stringify(details, null, 2) + '\n',
      )
      break
    }
    default:
      throw Error(`Unknown scenario: ${name}`)
  }
  await page.screenshot({ path: `${evidenceDir}/${name}.png`, fullPage: true })
}
