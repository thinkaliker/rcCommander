import { defineConfig, devices } from '@playwright/test';

// Tests run against an rcCommander that is already up (the Docker image in CI),
// on the port the server always listens on unless BASE_URL says otherwise.
export default defineConfig({
  testDir: '.',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3001',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
