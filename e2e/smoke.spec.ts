import { test, expect } from '@playwright/test';

/**
 * One pass over the running app: the page boots, the server answers, and
 * rclone lists `fixtures/`, which is mounted as LOCAL_ROOT. A dependency bump
 * that builds but breaks at runtime fails here instead of shipping, e.g. react
 * and react-dom on different versions, which throws as react-dom loads and
 * leaves a blank page.
 */
test('app loads and lists the local fixture folder', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/');

  // Both panes open on Local Filesystem at its root. Soft, so a failure here
  // still goes on to report the page errors that usually explain it.
  await expect.soft(page.getByRole('checkbox', { name: 'Select smoke.txt' })).toHaveCount(2);
  expect(errors).toEqual([]);
});
