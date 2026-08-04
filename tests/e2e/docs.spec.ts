import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('landing motion follows the live repair state', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('http://127.0.0.1:43119/');
  await expect(page.getByLabel('Generated repair diff')).toHaveCount(0);
  await expect(page.getByText('Increment applies the step twice.')).toHaveCount(0);

  expect(
    await page
      .locator('.mascot-image')
      .evaluate((element) => getComputedStyle(element).animationName)
  ).toBe('mascot-float');

  await page.getByRole('button', { name: 'Run QAgent' }).click();
  await expect(page.getByTestId('repair-lab')).toHaveAttribute('data-stage', 'test');
  await expect(page.locator('.lab-agent-hud')).toContainText('Capturing the failed assertion');
  expect(
    await page
      .locator('.lab-mascot img')
      .evaluate((element) => getComputedStyle(element).animationName)
  ).toBe('mascot-working');
  expect(
    await page
      .locator('.mascot-image')
      .evaluate((element) => getComputedStyle(element).animationName)
  ).toBe('mascot-working');

  await expect(page.getByTestId('repair-lab')).toHaveAttribute('data-stage', 'complete', {
    timeout: 5_000,
  });
  expect(
    await page
      .locator('.mascot-image')
      .evaluate((element) => getComputedStyle(element).animationName)
  ).toBe('mascot-celebrate');
  await expect(page.getByLabel('Generated repair diff')).toBeVisible();
});

for (const viewport of [
  { name: 'compact', width: 320, height: 720 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
]) {
  test(`landing repair loop works and remains accessible on ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('http://127.0.0.1:43119/');

    await expect(page.getByRole('heading', { level: 1, name: 'QAgent' })).toBeVisible();
    await expect(page.getByAltText("Patch, QAgent's pixel-art repair scout")).toBeVisible();
    await expect(page.getByLabel('Generated repair diff')).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    expect(
      await page.locator('.lab-band').evaluate((element) => element.getBoundingClientRect().top)
    ).toBeLessThan(viewport.height);

    await page.getByRole('button', { name: 'Increment' }).click();
    await expect(page.getByTestId('fixture-count')).toHaveText('2');
    await expect(page.getByText('Failing', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Run QAgent' }).click();
    await expect(page.getByTestId('repair-lab')).toHaveAttribute('data-stage', 'complete', {
      timeout: 5_000,
    });
    await expect(page.getByText('Repair verified.', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Increment' }).click();
    await expect(page.getByTestId('fixture-count')).toHaveText('1');
    await expect(page.getByText('Passing', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Increment' }).click();
    await expect(page.getByTestId('fixture-count')).toHaveText('2');
    await expect(page.getByText('Failing', { exact: true })).toBeVisible();

    await page.getByRole('tab', { name: 'Desktop' }).focus();
    await page.getByRole('tab', { name: 'Desktop' }).press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'CLI' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('$ qagent run start project_42')).toBeVisible();
    const enlargeEvidence = page.getByRole('button', { name: 'Enlarge QAgent run evidence' });
    await enlargeEvidence.click();
    await expect(page.getByRole('dialog', { name: 'QAgent run evidence' })).toBeVisible();
    const closeImage = page.getByRole('button', { name: 'Close image' });
    await closeImage.press('Tab');
    await expect(closeImage).toBeFocused();
    await closeImage.click();
    await expect(enlargeEvidence).toBeFocused();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? '')
      )
    ).toEqual([]);

    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: testInfo.outputPath(`landing-${viewport.name}.png`),
      fullPage: true,
    });
  });

  test(`documentation is readable and accessible on ${viewport.name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('http://127.0.0.1:43119/quickstart/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Five-minute quickstart' })
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'GitHub' })).toBeVisible();
    if (viewport.width <= 760) {
      await expect(page.locator('.sidebar-current')).toBeVisible();
    }
    await expect(page.locator('.nav-group a[aria-current="page"]')).toHaveText(
      'Five-minute quickstart'
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? '')
      )
    ).toEqual([]);
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: testInfo.outputPath(`docs-${viewport.name}.png`),
      fullPage: true,
    });
  });
}
