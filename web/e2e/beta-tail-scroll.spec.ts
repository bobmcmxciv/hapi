import { expect, test, type Page } from '@playwright/test'
import type { TailFrame } from '../e2e-fixtures/beta-timeline-fixture'

// Offline real-consumer contract: this fixture mounts BetaThreadView, real
// timeline store and row renderers. It never starts/connects a Hub or Runner.
async function readHistory(page: Page) {
    await page.locator('.beta-viewport').hover()
    await page.mouse.wheel(0, -1000)
    await page.evaluate(() => { document.querySelector<HTMLElement>('.beta-viewport')!.scrollTop = 35000 })
    await expect(page.locator('.beta-jump-tail')).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.__betaProbe.viewMode)).toBe('history')
}

async function geometry(page: Page) {
    return page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>('.beta-viewport')!
        return { top: viewport.scrollTop, gap: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight, mode: window.__betaProbe.viewMode }
    })
}

function expectStableDestination(frames: TailFrame[]) {
    expect(frames.every((frame) => frame.visible > 0), 'no painted spacer-only viewport').toBe(true)
    expect(Math.max(...frames.map((frame) => frame.mounted))).toBeLessThanOrEqual(100)
    expect(frames.every((frame) => Math.abs(frame.gap) <= 1), 'tail owns each frame after click').toBe(true)
    // Absolute scrollTop may shrink as unmounted estimates are replaced. The
    // rendered destination must not move in viewport coordinates during that.
    const bottoms = frames.map((frame) => frame.tailBottom!)
    expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(1)
}

test.beforeEach(async ({ page }) => {
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url())
        if (url.hostname !== '127.0.0.1' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io')) return route.abort()
        return route.continue()
    })
    await page.goto('/e2e-fixtures/beta-timeline-fixture.html')
    await expect(page.locator('[data-beta-total-rows]')).toHaveAttribute('data-beta-total-rows', '1200')
})

test('Latest mounts and measures its bounded destination before the first painted frame', async ({ page }) => {
    await readHistory(page)
    expectStableDestination(await page.evaluate(() => window.__betaProbe.captureTailJump()))
    await expect(page.locator('[data-beta-measure-id="h:fixture-2999"]')).toBeVisible()
})

test('tail growth follows, but wheel input cancels ownership before streaming and history replacement', async ({ page }) => {
    await page.getByRole('button', { name: 'Grow tail', exact: true }).click()
    await expect.poll(async () => (await geometry(page)).gap).toBeLessThanOrEqual(1)
    await readHistory(page)
    const before = await geometry(page)
    await page.evaluate(() => window.__betaProbe.start())
    await expect.poll(() => page.evaluate(() => window.__betaProbe.publications)).toBeGreaterThan(15)
    await page.evaluate(() => window.__betaProbe.finish())
    await expect.poll(async () => (await geometry(page)).mode).toBe('history')
    expect(Math.abs((await geometry(page)).top - before.top)).toBeLessThanOrEqual(1)
    // A real wheel must move forward, not be restored to the previous anchor
    // by a range-only render or the old 700ms tail timer.
    await page.locator('.beta-viewport').hover()
    await page.mouse.wheel(0, 1400)
    await expect.poll(async () => (await geometry(page)).top).toBeGreaterThan(before.top + 1200)
    const samples = await page.evaluate(async () => {
        const samples: number[] = []
        for (let i = 0; i < 60; i += 1) {
            const frame = Promise.withResolvers<void>()
            requestAnimationFrame(() => frame.resolve())
            await frame.promise
            samples.push(document.querySelector<HTMLElement>('.beta-viewport')!.scrollTop)
        }
        return samples
    })
    expect(Math.max(...samples) - Math.min(...samples)).toBeLessThanOrEqual(1)
})

test('prepend preserves the reader anchor; a pending load cannot restore it over Latest', async ({ page }) => {
    await readHistory(page)
    const anchor = await page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>('.beta-viewport')!
        const bounds = viewport.getBoundingClientRect()
        const node = [...viewport.querySelectorAll<HTMLElement>('[data-beta-measure-id]')].find((element) => element.getBoundingClientRect().bottom > bounds.top)!
        return { id: node.dataset.betaMeasureId!, offset: node.getBoundingClientRect().top - bounds.top }
    })
    await page.evaluate(() => window.__betaProbe.prepend())
    await expect.poll(() => page.evaluate((anchor) => {
        const viewport = document.querySelector<HTMLElement>('.beta-viewport')!
        const node = [...viewport.querySelectorAll<HTMLElement>('[data-beta-measure-id]')].find((element) => element.dataset.betaMeasureId === anchor.id)
        return node ? Math.abs(node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - anchor.offset) : Infinity
    }, anchor)).toBeLessThanOrEqual(1)
    await page.evaluate(() => {
        window.__betaProbe.loadDelay = 1000
        const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Load earlier'))!
        button.click()
    })
    expectStableDestination(await page.evaluate(() => window.__betaProbe.captureTailJump(30)))
    await expect.poll(() => page.evaluate(() => window.__betaProbe.totalRows())).toBe(1400)
    await expect.poll(async () => (await geometry(page)).mode).toBe('tail')
    await expect.poll(async () => (await geometry(page)).gap).toBeLessThanOrEqual(1)
})

test('failed history load retains its error while Latest remains usable', async ({ page }) => {
    await readHistory(page)
    await page.evaluate(() => {
        window.__betaProbe.failLoad = true
            ;[...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Load earlier'))!.click()
    })
    await expect(page.getByRole('alert')).toContainText('Controlled fixture history failure')
    expectStableDestination(await page.evaluate(() => window.__betaProbe.captureTailJump(30)))
    await expect(page.getByRole('alert')).toContainText('Controlled fixture history failure')
})

test('approval and error pins remain reachable outside the window and sharing still opens', async ({ page }) => {
    await page.getByRole('button', { name: 'Live', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__betaProbe.publications)).toBeGreaterThan(5)
    await page.getByRole('button', { name: 'Error', exact: true }).click()
    await page.getByRole('button', { name: 'Question', exact: true }).click()
    await readHistory(page)
    await expect(page.getByRole('button', { name: /pending approvals/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /errors in this conversation/ })).toBeVisible()
    await page.getByRole('button', { name: /pending approvals/ }).click()
    await expect(page.getByText('Do pending questions remain reachable outside the virtual window?', { exact: true }).last()).toBeVisible()
    await readHistory(page)
    await page.getByRole('button', { name: /errors in this conversation/ }).click()
    await expect(page.getByText('Fixture native terminal error').last()).toBeVisible()
    await readHistory(page)
    await page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>('.beta-viewport')!.getBoundingClientRect()
        const button = [...document.querySelectorAll<HTMLButtonElement>('button[title="Share turn as image"]')].find((button) => {
            const box = button.getBoundingClientRect()
            return box.top >= viewport.top && box.bottom <= viewport.bottom
        })!
        button.click()
    })
    await expect(page.getByRole('dialog')).toBeVisible()
})
