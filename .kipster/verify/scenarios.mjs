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
  'voice',
  'updates',
  'plugins',
]

export async function drive(name, { page, expect, origin, evidenceDir }) {
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
  const createKip = async () => {
    const kip = unique('Factory Scout')
    await management('Kips')
    await page
      .getByRole('button', { name: 'Create new kip', exact: true })
      .click()
    await page.getByLabel('Name', { exact: true }).fill(kip)
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
      await page
        .locator('.feed-message')
        .filter({ hasText: 'Read this fixture attachment' })
        .last()
        .getByRole('button', { name: /^Open thread:/ })
        .press('Enter')
      await expect(
        page.getByRole('region', { name: `File: ${file}`, exact: true }),
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
        chatId:
          saved.scope?.chatId ??
          (await get('/v1/app/snapshot')).threads.find(
            (thread) => thread.threadId === receipt.threadId,
          ).chatId,
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
    case 'voice': {
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
      await page.waitForTimeout(700)
      await page.getByRole('button', { name: 'Stop recording' }).click()
      await expect(page.locator('.pending-media .voice-play')).toBeVisible()
      await page.getByRole('button', { name: 'Send message' }).first().click()
      await page
        .locator('.feed-message')
        .filter({
          has: page.getByRole('region', { name: 'Voice preparation' }),
        })
        .last()
        .getByRole('button', { name: /^Open thread:/ })
        .press('Enter')
      await expect(page.getByRole('region', { name: 'Thread' })).toContainText(
        'Transcription unavailable',
      )
      await expect(
        page.getByText(
          /^Fixture received voice_note; original available; transcription unavailable/,
        ),
      ).toBeVisible()
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
    default:
      throw Error(`Unknown scenario: ${name}`)
  }
  await page.screenshot({ path: `${evidenceDir}/${name}.png`, fullPage: true })
}
