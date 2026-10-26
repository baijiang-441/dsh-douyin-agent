// 向置顶会话（爸爸）发送一条私信，带重试与落屏核对（2026-10-26 GLM 要求）：
// - 最多 3 次尝试，退避 8s / 20s；每次重发前先回读会话尾部，已落屏则不再重发（防重复气泡）；
// - 每次发送后回读核对，found:true 才算送达；
// - 3 次都失败：打印 TEXT_SEND_FINAL_FAILURE 并以非 0 退出，绝不静默丢。
import { chromium } from '/home/hatch/workspace/dsh-src/douyin/playwright-runtime.mjs';
const text = process.argv[2];
if (!text) { console.log('TEXT_SEND_FINAL_FAILURE: no text argument'); process.exit(1); }
const browser = await chromium.connectOverCDP('http://127.0.0.1:9227', { timeout: 10000 });
let page = null;
for (const ctx of browser.contexts()) for (const p of ctx.pages()) {
  let n = ''; try { n = await p.evaluate(() => window.name); } catch {}
  if (n === 'deepseek-douyin-api-chat') page = p;
}
if (!page) { console.log('TEXT_SEND_FINAL_FAILURE: NO_CHAT_PAGE'); process.exit(1); }
const readTail = () => page.evaluate((t) => {
  const wrap = document.querySelector('[data-e2e="im-dialog"] .messageMessageListwrapper');
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
  const rows = [...document.querySelectorAll('[data-e2e="im-dialog"] [data-e2e="msg-item-content"]')];
  return { found: rows.some(r => r.textContent.includes(t.slice(0, 10))), last: rows.slice(-2).map(r => r.textContent.slice(0, 40)) };
}, text);
const backoffs = [0, 8000, 20000];
let last = null;
for (let attempt = 1; attempt <= 3; attempt++) {
  if (backoffs[attempt - 1]) await page.waitForTimeout(backoffs[attempt - 1]);
  if (attempt > 1) {
    const pre = await readTail().catch(() => null);
    if (pre?.found) { console.log('result:', JSON.stringify({ ...pre, attempt, note: 'already-present' })); process.exit(0); }
  }
  try {
    const editor = page.locator('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]').first();
    await editor.click({ timeout: 6000 });
    await page.waitForTimeout(300);
    // 清掉编辑器里可能残留的旧文本，避免叠字
    await page.evaluate(() => {
      const ed = document.querySelector('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]');
      if (ed && ed.textContent) { ed.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); }
    });
    await page.evaluate((t) => { document.execCommand('insertText', false, t); }, text);
    await page.waitForTimeout(500);
    const inEditor = await page.evaluate(() => document.querySelector('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]')?.textContent || '');
    if (!inEditor.includes(text.slice(0, 8))) throw new Error('editor does not hold text');
    const btn = page.locator('[data-e2e="im-dialog"] .messageMsgInputpublishBtn').first();
    await btn.click({ timeout: 6000 });
    await page.waitForTimeout(3000);
    last = await readTail();
    if (last.found) { console.log('result:', JSON.stringify({ ...last, attempt })); process.exit(0); }
    console.log(`attempt ${attempt}: not landed yet`);
  } catch (e) {
    console.log(`attempt ${attempt}: error ${String(e).slice(0, 120)}`);
  }
}
console.log('TEXT_SEND_FINAL_FAILURE:', JSON.stringify(last));
process.exit(1);
