// 私信消息列表守护：平时把列表钉在最新端（column-reverse 布局 scrollTop=0 即最新），
// 每 15 秒做一次全程遍历（逐段停留 2.6 秒 ≥ 一个轮询周期），逼虚拟列表把每一段都渲染出来，
// 保证任何一条消息都至少被服务的某次快照看到——2026-10-26 P0 修复（连发成员曾落在未渲染窗口里永不入轮）。
import { chromium } from '/home/hatch/workspace/dsh-src/douyin/playwright-runtime.mjs';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9227', { timeout: 10000 });
async function findPage() {
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) {
    let n = ''; try { n = await p.evaluate(() => window.name); } catch {}
    if (n === 'deepseek-douyin-api-chat') return p;
  }
  return null;
}
const SEL = '[data-e2e="im-dialog"] .messageMessageListwrapper';
let lastSweep = 0;
console.log('list_pin: started (pin + sweep)');
for (;;) {
  try {
    const page = await findPage();
    if (page) {
      const now = Date.now();
      if (now - lastSweep > 15000) {
        lastSweep = now;
        const metrics = await page.evaluate((sel) => {
          const w = document.querySelector(sel);
          return w ? { max: Math.max(0, w.scrollHeight - w.clientHeight), step: Math.max(1, Math.floor(w.clientHeight * 0.7)) } : null;
        }, SEL);
        if (metrics && metrics.max > 0) {
          for (let top = metrics.step; ; top += metrics.step) {
            const t = Math.min(top, metrics.max);
            await page.evaluate(({ sel, t }) => { const w = document.querySelector(sel); if (w) w.scrollTop = t; }, { sel: SEL, t });
            await new Promise(r => setTimeout(r, 2600));
            if (t >= metrics.max) break;
          }
          await page.evaluate((sel) => { const w = document.querySelector(sel); if (w) w.scrollTop = 0; }, SEL);
        }
      } else {
        await page.evaluate((sel) => { const w = document.querySelector(sel); if (w && w.scrollTop !== 0) w.scrollTop = 0; }, SEL);
      }
    }
  } catch {}
  await new Promise(r => setTimeout(r, 1200));
}
