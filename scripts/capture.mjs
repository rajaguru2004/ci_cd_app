// Captures the console's screens for design review:
//   node scripts/capture.mjs [baseUrl] [outDir]
// Signs in with CONSOLE_PASSWORD from .env, then shoots each route at desktop and phone
// widths, full page, after the page has settled. Needs Playwright (PLAYWRIGHT_PATH points at
// a node_modules/playwright if it is not resolvable from here).
import { readFileSync, mkdirSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');

const base = process.argv[2] || 'http://127.0.0.1:7080';
const out = process.argv[3] || '.impeccable/review';
mkdirSync(out, { recursive: true });

const env = readFileSync('.env', 'utf8');
const password = /^CONSOLE_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim();
if (!password) throw new Error('CONSOLE_PASSWORD missing in .env');

const routes = (process.env.ROUTES || '/,/setup').split(',');
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
];

const browser = await chromium.launch();
try {
  for (const vp of viewports) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor ?? 1 });
    const page = await ctx.newPage();
    // Sign-in page first, as a visitor sees it.
    await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
    await page.screenshot({ path: `${out}/login-${vp.name}.png`, fullPage: true });
    await page.fill('#password', password);
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login')), page.click('button[type=submit]')]);
    for (const route of routes) {
      await page.goto(`${base}${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1200);
      const slug = route === '/' ? 'console' : route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
      await page.screenshot({ path: `${out}/${slug}-${vp.name}.png`, fullPage: true });
      console.log(`${slug}-${vp.name}.png`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
