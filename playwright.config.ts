import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Playwright configuration for Supp v2 E2E tests
 * Runs Chrome with the test-mode extension loaded
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,  // Tests share Firebase state - must run serially
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,  // Single worker - tests share Chrome profiles and Firebase
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
    ['html', { outputFolder: 'playwright-report', open: 'never' }]
  ],

  use: {
    headless: false,  // Chrome extensions require headed mode
    viewport: { width: 1280, height: 720 },
    actionTimeout: 10000,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  timeout: 45000,  // Extension startup is slower than typical web tests

  // Clear Firebase signaling before test suite runs
  globalSetup: './tests/helpers/firebase-reset.ts',

  projects: [
    {
      name: 'chromium',
      use: {}, // Browser launched manually via launchPersistentContext in fixtures
    },
  ],
});
