// 应用方案 HTML → PDF：Playwright (msedge headless) 打印
// 用法：node tasks/print-pdf.mjs [输入html] [输出pdf]
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const input = resolve(process.argv[2] || 'docs/应用方案-CareLoop.html');
const output = resolve(process.argv[3] || 'docs/CareLoop-应用方案.pdf');

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
await page.goto(`file:///${input.replace(/\\/g, '/')}`, { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(1500); // 等字体/布局稳定
await page.pdf({
  path: output,
  format: 'A4',
  printBackground: true,
  margin: { top: '16mm', bottom: '18mm', left: '16mm', right: '16mm' },
});
await browser.close();
console.log(`PDF 已生成：${output}`);
