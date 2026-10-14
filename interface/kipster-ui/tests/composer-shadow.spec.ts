import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { startDemo } from './demo.ts'

for (const theme of ['light', 'dark'] as const) {
  for (const surface of ['glass', 'outline'] as const) {
    for (const width of [1440, 390]) {
      test(`${theme} ${surface} ${width}px composers retain bounds and leave shadow clearance`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
        await startDemo(page)
        if (surface === 'outline')
          await page.evaluate(() => {
            document.documentElement.dataset.surface = 'outline'
          })
        for (const target of ['new', 'reply'] as const) {
          if (target === 'new') {
            await page.getByRole('button', { name: 'Kip', exact: true }).click()
          } else {
            await page.setViewportSize({ width: 1440, height: 900 })
            await page
              .getByRole('button', { name: 'Atlas', exact: true })
              .first()
              .click()
          }
          await page.setViewportSize({ width, height: 900 })
          if (target === 'reply')
            await page
              .getByRole('button', {
                name: 'Open thread: Shape a calmer workspace for the next release',
                exact: true,
              })
              .click()
          const composer = page.locator(
            target === 'new'
              ? '.composer-dock .composer'
              : '.thread-pane .composer',
          )
          await expect(composer).toBeVisible()
          await expect(composer.locator('textarea')).toBeEnabled()
          const bounds = await composer.boundingBox()
          for (const focused of [false, true]) {
            if (focused) await composer.locator('textarea').focus()
            else
              await composer
                .locator('textarea')
                .evaluate((element) => (element as HTMLElement).blur())
            // Wait for the focus shadow transition before inspecting/capturing.
            await expect
              .poll(() =>
                composer.evaluate((element) =>
                  getComputedStyle(element).boxShadow.includes('1.5px inset'),
                ),
              )
              .toBe(focused)
            const layout = await composer.evaluate((element) => {
              const rect = element.getBoundingClientRect()
              const ancestors = []
              for (
                let node = element.parentElement;
                node;
                node = node.parentElement
              ) {
                const style = getComputedStyle(node)
                if (
                  [style.overflowX, style.overflowY].every(
                    (value) => value === 'visible',
                  )
                )
                  continue
                const r = node.getBoundingClientRect()
                ancestors.push({
                  class: node.className,
                  overflowX: style.overflowX,
                  overflowY: style.overflowY,
                  left: rect.left - r.left,
                  right: r.right - rect.right,
                  top: rect.top - r.top,
                  bottom: r.bottom - rect.bottom,
                })
              }
              const style = getComputedStyle(element)
              return {
                shadow: style.boxShadow,
                radius: style.borderRadius,
                ancestors,
                window: {
                  left: rect.left,
                  right: innerWidth - rect.right,
                  top: rect.top,
                  bottom: innerHeight - rect.bottom,
                },
              }
            })
            const drops = layout.shadow
              .split(/,(?![^()]*\))/)
              .filter((layer) => !layer.includes('inset'))
            expect(drops.length).toBeGreaterThan(0)
            for (const drop of drops) {
              const lengths = [...drop.matchAll(/(-?[\d.]+)px/g)].map((match) =>
                Number(match[1]),
              )
              expect(lengths.slice(0, 2)).toEqual([0, 0])
              expect(lengths[2]).toBeGreaterThan(0)
              // Allow the blur kernel to fade within the tightest pane gutter.
              expect(
                Math.ceil(lengths[2] * 1.5) + lengths[3],
              ).toBeLessThanOrEqual(8)
            }
            for (const clearance of [...layout.ancestors, layout.window])
              for (const side of ['left', 'right', 'top', 'bottom'] as const)
                expect(
                  clearance[side],
                  JSON.stringify(layout),
                ).toBeGreaterThanOrEqual(8)
            expect(await composer.boundingBox()).toEqual(bounds)
            expect(layout.radius).toBe(target === 'new' ? '26px' : '22px')
            // Compare against the original dock metrics without changing the bar.
            if (target === 'new') {
              const original = await page
                .locator('.composer-dock')
                .evaluate((element) => {
                  const node = element as HTMLElement
                  const previous = node.style.cssText
                  node.style.padding = '0'
                  node.style.margin = '0'
                  const r = node
                    .querySelector('.composer')!
                    .getBoundingClientRect()
                  const bounds = {
                    x: r.x,
                    y: r.y,
                    width: r.width,
                    height: r.height,
                  }
                  node.style.cssText = previous
                  return bounds
                })
              expect(original).toEqual(bounds)
            }
            if (process.env.EVIDENCE_DIR) {
              const directory = join(process.env.EVIDENCE_DIR, 'composer')
              await mkdir(directory, { recursive: true })
              const name = `${theme}-${surface}-${width}-${target}-${focused ? 'focus' : 'rest'}`
              await writeFile(
                join(directory, `${name}.json`),
                JSON.stringify(layout, null, 2),
              )
              const r = bounds!
              await page.screenshot({
                path: join(directory, `${name}.png`),
                clip: {
                  x: Math.max(0, r.x - 24),
                  y: r.y - 24,
                  width: Math.min(width, r.width + 48),
                  height: Math.min(98, 900 - (r.y - 24)),
                },
                animations: 'disabled',
              })
            }
          }
        }
      })
    }
  }
}
