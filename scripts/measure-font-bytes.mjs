/**
 * 字体下载量实测：分别访问落地页与患者端首页，累加所有字体文件的实际响应字节数。
 * 用法： node scripts/measure-font-bytes.mjs [tag]
 * 输出： tasks/shots/font-slim/bytes-<tag>.json + 控制台明细
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'tasks', 'shots', 'font-slim');
const BASE = 'http://localhost:5173';
const tag = process.argv[2] || 'run';

const FONT_RE = /\.(woff2?|ttf|otf|eot)(\?|$)/i;

async function collect(page, url, name, login) {
  const items = [];
  const onResponse = async (resp) => {
    const u = resp.url();
    if (!FONT_RE.test(u)) return;
    let bytes = 0;
    try {
      const body = await resp.body();
      bytes = body.length;
    } catch {
      try {
        bytes = Number(resp.headers()['content-length'] || 0);
      } catch {
        bytes = 0;
      }
    }
    items.push({ file: u.replace(BASE, ''), bytes, status: resp.status() });
  };
  page.on('response', onResponse);

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  if (login) {
    await page.waitForTimeout(800);
    const user = page.locator('input[type="text"], input[name="username"], input#username').first();
    if (await user.count()) {
      await user.fill('guifang');
      await page.locator('input[type="password"]').first().fill('GuiFang@CareLoop2026');
      await page.locator('button[type="submit"], button:has-text("登录")').first().click();
      await page.waitForTimeout(2500);
    }
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  await page.waitForTimeout(1200);
  page.off('response', onResponse);

  const total = items.reduce((s, i) => s + i.bytes, 0);
  return { page: name, url, total, count: items.length, items };
}

const browser = await chromium.launch({ channel: 'msedge' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

const results = [];
results.push(await collect(page, BASE + '/', 'landing', false));

const page2 = await ctx.newPage();
results.push(await collect(page2, BASE + '/patient/dashboard', 'dashboard', true));

fs.mkdirSync(OUT_DIR, { recursive: true });
let grand = 0;
for (const r of results) {
  console.log(`\n=== ${r.page} (${r.url}) ===`);
  for (const i of r.items.sort((a, b) => b.bytes - a.bytes)) {
    console.log(`  ${(i.bytes / 1024).toFixed(1).padStart(9)} KB  ${i.file}`);
  }
  console.log(`  ${'-'.repeat(40)}`);
  console.log(`  ${(r.total / 1024 / 1024).toFixed(3)} MB  合计 (${r.count} 个字体文件)`);
}
fs.writeFileSync(
  path.join(OUT_DIR, `bytes-${tag}.json`),
  JSON.stringify({ tag, results, grandTotal: results.reduce((s, r) => s + r.total, 0) }, null, 2),
);
console.log(`\n[写入] tasks/shots/font-slim/bytes-${tag}.json`);
await browser.close();
