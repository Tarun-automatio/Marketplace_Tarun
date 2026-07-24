const { defineConfig } = require('@playwright/test');

// Detect `--headed` (or `--ui` / `--debug`, which imply headed) in the CLI
// args of the main Playwright process, then forward the decision to worker
// processes via an env var. Workers don't see the parent's argv but they do
// inherit env vars, so this makes `frameworkConfig.headless` resolve
// consistently in both places (main config load + browserHelper in workers).
if (process.argv.some(a => a === '--headed' || a === '--ui' || a === '--debug')) {
  process.env.PW_HEADED = '1';
}

// R6: single source of config. framework.config.js already loads
// globalproperties.env → default .env; we just read the resolved values here.
const frameworkConfig = require('./config/framework.config');

module.exports = defineConfig({
  globalSetup: './hooks/globalSetup.js',
  globalTeardown: './hooks/globalTeardown.js',
  testDir: './tests',
  // Keep every generated artifact under reports/ so the workspace root stays clean.
  outputDir: 'reports/test-results',
  // R10: allow Playwright to distribute per-scope describe blocks across
  // workers. Each scope has `mode: 'serial'` so plans within a scope still
  // share the same accordion page; only different scopes go to different workers.
  fullyParallel: true,
  timeout: frameworkConfig.testTimeoutMs,
  expect: {
    timeout: 20000,
  },
  retries: 0,
  use: {
    headless: frameworkConfig.headless,
    channel: 'chrome',
    viewport: {
      width:  frameworkConfig.viewport.width,
      height: frameworkConfig.viewport.height,
    },
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--force-color-profile=srgb',
        '--force-device-scale-factor=1',
        '--font-render-hinting=none',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  reporter: [
    ['list'],
  ],
});
