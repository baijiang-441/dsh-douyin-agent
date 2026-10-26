import { chromium } from '/home/hatch/workspace/dsh-src/douyin/playwright-runtime.mjs';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9227', { timeout: 10000 });
let page = null;
for (const ctx of browser.contexts()) for (const p of ctx.pages()) {
  let n = ''; try { n = await p.evaluate(() => window.name); } catch {}
  if (n === 'deepseek-douyin-api-chat') page = p;
}
if (!page) { console.log('NO_CHAT_PAGE'); process.exit(0); }
const dlg = page.locator('[data-e2e="im-dialog"]');
const before = await page.evaluate(() => document.querySelectorAll('[data-e2e="im-dialog"] .MessageItemEmojiemojiBox').length);
let panel = page.locator('.componentsemojiemojiPanel');
if (await panel.count() === 0) {
  await dlg.locator('.messageMsgInputiconAction').first().click({ timeout: 6000 });
  await page.waitForTimeout(1500);
  panel = page.locator('.componentsemojiemojiPanel');
}
console.log('panel open:', await panel.count() > 0, '| emoji boxes before:', before);
const items = panel.locator('.emojiEmojiItememojiItem');
const n = await items.count();
let target = -1;
for (let i = 0; i < n; i++) {
  const t = (await items.nth(i).textContent() || '').trim();
  if (t === (process.argv[2] || '吹泡泡')) { target = i; break; }
}
console.log('吹泡泡 index:', target);
if (target < 0) { console.log('NOT_FOUND'); process.exit(0); }
await items.nth(target).click({ timeout: 6000 });
await page.waitForTimeout(2500);
const after = await page.evaluate(() => {
  const boxes = document.querySelectorAll('[data-e2e="im-dialog"] .MessageItemEmojiemojiBox');
  const rows = document.querySelectorAll('[data-e2e="im-dialog"] [data-e2e="msg-item-content"]');
  const last = rows[rows.length - 1];
  return { boxes: boxes.length, lastHasEmoji: !!(last && last.querySelector('.MessageItemEmojiemojiBox')), lastCls: last ? (last.getAttribute('class') || '').slice(0, 90) : '' };
});
console.log('after:', JSON.stringify(after));
process.exit(0);
