import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const viewport of [
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

    await page.getByRole('tab', { name: 'CLI' }).click();
    await expect(page.getByText('$ qagent run start project_42')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations.filter((violation) =>
        ['serious', 'critical'].includes(violation.impact ?? '')
      )
    ).toEqual([]);

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
    await page.screenshot({
      path: testInfo.outputPath(`docs-${viewport.name}.png`),
      fullPage: true,
    });
  });
}
