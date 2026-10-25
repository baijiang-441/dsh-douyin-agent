import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from '../playwright-runtime.mjs';
import { readPageState } from '../core.mjs?v=9';
import { CommentBrowser, readCommentDom, inspectCommentComposer } from '../comment-browser.mjs';
import { AutonomousComments } from '../autonomous-comments.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });
const text = '合成画面的配色很舒服。';
async function fixture(t, { result = { id: '90001', mine: true, status: 'sent', videoId: '12345' }, existing = [], draft = '', missingInput = false, doubleButton = false } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-comment-browser-')), page = await browser.newPage();
  await page.setContent('<section data-e2e="feed-active-video"><video></video></section><div class="comment-mainContent" data-video-id="12345"><div data-e2e="comment-list"></div></div>' + (missingInput ? '' : '<div class="comment-input-container"><div contenteditable="true" role="textbox" style="min-height:35px;width:260px"></div><button data-e2e="comment-post">发布</button>' + (doubleButton ? '<button data-e2e="comment-submit">发布</button>' : '') + '</div>'));
  await page.evaluate(({ result, existing }) => {
    window.commentClicks = 0; window.result = result; window.fixtureState = { loginRequired: false, verificationRequired: false, privateChatVisible: false, video: { id: '12345', url: 'https://www.douyin.com/video/12345', readyState: 4 } };
    window.appendComment = entry => { const row = document.createElement('div'); row.setAttribute('data-e2e', 'comment-item'); row.setAttribute('data-comment-id', entry.id); row.setAttribute('data-video-id', entry.videoId || '12345'); if (entry.mine !== undefined) row.setAttribute('data-is-self', String(entry.mine)); if (entry.status) row.setAttribute('data-send-status', entry.status); const content = document.createElement('span'); content.setAttribute('data-e2e', 'comment-content'); content.textContent = entry.text || ''; row.append(content); document.querySelector('[data-e2e="comment-list"]').append(row); };
    for (const entry of existing) window.appendComment(entry);
    document.querySelector('[data-e2e="comment-post"]')?.addEventListener('click', () => { window.commentClicks++; const editor = document.querySelector('[contenteditable]'), content = editor.innerText; if (window.result) { const rows = Array.isArray(window.result) ? window.result : [window.result]; for (const row of rows) window.appendComment({ ...row, text: row.text ?? content }); editor.textContent = ''; } });
  }, { result, existing });
  if (draft && !missingInput) await page.locator('[contenteditable]').fill(draft);
  const evaluate = page.evaluate.bind(page); page.evaluate = (fn, args) => fn === readPageState ? evaluate(() => window.fixtureState) : evaluate(fn, args);
  let allowed = true, lease = false, begins = 0; const phases = [], hooks = {};
  const authorize = async request => { phases.push(request.phase); await hooks.authorize?.(request); return allowed; };
  authorize.beginDispatch = () => { begins++; lease = true; return () => { lease = false; }; };
  const controller = { source: 'api', withPage: async (action, options) => { options.signal?.throwIfAborted(); return action(page); }, close: async () => {} };
  const videoLimits = { state: () => ({ allowed: true, session: { id: 'synthetic-session' } }) };
  const commenter = new CommentBrowser({ source: 'api', controller, videoLimits, stateDir });
  t.after(async () => { await page.close(); assert.equal(path.dirname(stateDir), os.tmpdir()); fs.rmSync(stateDir, { recursive: true, force: true }); });
  return { page, commenter, authorize, stateDir, hooks, setAllowed: value => { allowed = value; }, stats: () => ({ lease, begins, phases }), post: (options = {}) => commenter.post({ expectedVideoId: '12345', text }, { authorize, ...options }) };
}

async function modernFixture(t, { lazyDraft = '', missingSubmit = false, duplicateSubmit = false, clearWithoutReceipt = false, videoId = '12345', hiddenDraft = '' } = {}) {
  const f = await fixture(t, { missingInput: true });
  await f.page.evaluate(({ lazyDraft, missingSubmit, duplicateSubmit, clearWithoutReceipt, videoId, hiddenDraft }) => {
    const composer = document.createElement('section'); composer.setAttribute('data-video-id', videoId); composer.className = 'modern-comment-composer';
    composer.innerHTML = '<div class="comment-input-inner-container" style="min-height:40px;width:300px" data-placeholder="说点什么..."></div><div class="modern-publish-control" style="cursor:pointer;display:none"><span>发布</span></div>';
    const lazy = composer.querySelector('.comment-input-inner-container'); lazy.textContent = lazyDraft;
    if (hiddenDraft) { const textarea = document.createElement('textarea'); textarea.value = hiddenDraft; textarea.style.display = 'none'; lazy.append(textarea); }
    const publish = composer.querySelector('.modern-publish-control');
    if (duplicateSubmit) composer.insertAdjacentHTML('beforeend', '<div class="another-publish-control" style="cursor:pointer;display:none"><span>发布</span></div>');
    window.commentActivations = 0; window.enterCount = 0;
    lazy.addEventListener('click', () => {
      if (lazy.querySelector('[contenteditable]')) return;
      window.commentActivations++;
      lazy.textContent = ''; const editor = document.createElement('div'); editor.setAttribute('contenteditable', 'true'); editor.setAttribute('role', 'textbox'); editor.style.cssText = 'min-height:40px;width:290px'; lazy.append(editor);
      editor.addEventListener('input', () => { if (!missingSubmit) for (const node of composer.querySelectorAll('.modern-publish-control,.another-publish-control')) node.style.display = 'block'; });
      editor.addEventListener('keydown', event => { if (event.key === 'Enter') { window.enterCount++; editor.textContent = ''; event.preventDefault(); } });
      editor.focus();
    });
    publish.addEventListener('click', () => {
      window.commentClicks++; const editor = lazy.querySelector('[contenteditable]');
      if (!clearWithoutReceipt) window.appendComment({ id: '99001', mine: true, status: 'sent', videoId, text: editor.innerText });
      editor.textContent = '';
    });
    document.body.append(composer);
    const danmaku = document.createElement('div'); danmaku.setAttribute('data-e2e', 'danmaku-container'); danmaku.style.display = 'none';
    danmaku.innerHTML = '<div class="comment-input-inner-container"><div contenteditable="true"></div><button>发送</button></div>';
    danmaku.addEventListener('click', () => { window.danmakuClicks = (window.danmakuClicks || 0) + 1; }); document.body.append(danmaku);
  }, { lazyDraft, missingSubmit, duplicateSubmit, clearWithoutReceipt, videoId, hiddenDraft });
  return f;
}

async function nativeFixture(t, { activated = false, existingDraft = '', wrongGeometry = false, disabled = false, wrongToolbar = false, duplicate = false, selectedFile = false } = {}) {
  const f = await fixture(t, { missingInput: true });
  const dom = JSON.parse(fs.readFileSync(new URL('./fixtures/comment-publish-icon-20261024.json', import.meta.url), 'utf8'));
  await f.page.evaluate(({ dom, activated, existingDraft, wrongGeometry, disabled, wrongToolbar, duplicate, selectedFile }) => {
    const outer = document.createElement('div'); outer.className = 'N7WyeAml comment-input-container';
    outer.innerHTML = `<div class="ZWk5Ao93"><div class="McY63d8B ${dom.containerClass}" style="width:420px;min-height:70px"><div class="_x9Gwl7G" style="min-height:40px"></div><span class="${dom.placeholderClass}">${dom.placeholderText}</span><div class="${wrongToolbar ? 'unverified-toolbar' : dom.toolbarClass}"><div class="${dom.toolsWrapperClass}" style="display:flex;justify-content:flex-end"><input type="file" style="display:none"><span><svg width="20" height="20"><path d="M0 0L20 20"></path></svg></span><span><svg width="20" height="20"><path d="M0 20L20 0"></path></svg></span></div></div></div></div>`;
    const inner = outer.querySelector('.comment-input-inner-container'), rich = outer.querySelector('._x9Gwl7G'), tools = outer.querySelector(`.${dom.toolsWrapperClass}`);
    window.nativeCommentClicks = 0; window.commentActivations = 0; window.nativeEmojiClicks = 0;
    const publisher = document.createElement('span'); publisher.className = dom.emptyPublishClass; publisher.style.cursor = 'pointer';
    publisher.innerHTML = `<svg viewBox="${dom.viewBox}" width="36" height="36">${dom.paths.map((entry, index) => `<path d="${entry.d}${wrongGeometry && index === 1 ? ' L1 1' : ''}" fill="${entry.fill}"></path>`).join('')}</svg>`;
    tools.append(publisher); if (duplicate) tools.append(publisher.cloneNode(true));
    for (const emoji of tools.querySelectorAll('span:not(.wchsYBpK)')) emoji.addEventListener('click', () => window.nativeEmojiClicks++);
    const addEditor = () => {
      if (rich.querySelector('[contenteditable]')) return;
      inner.querySelector(`.${dom.placeholderClass}`)?.remove(); rich.innerHTML = `<div class="richtext-container"><div class="DraftEditor-root"><div class="DraftEditor-editorContainer"><div class="${dom.editorClass}" role="${dom.editorRole}" contenteditable="true" style="min-height:40px;width:400px"></div></div></div></div>`;
      const editor = rich.querySelector('[contenteditable]'); editor.textContent = existingDraft || dom.emptyEditorText;
      if (!existingDraft) { const placeholder = document.createElement('span'); placeholder.className = 'm53pwJvW'; placeholder.textContent = dom.placeholderText; placeholder.style.pointerEvents = 'none'; rich.prepend(placeholder); }
      editor.addEventListener('input', () => { const value = editor.innerText.replace(/[\u200B-\u200F\uFEFF]/g, '').trim(); publisher.className = value && !disabled ? dom.enabledPublishClass : dom.emptyPublishClass; rich.querySelector('.m53pwJvW')?.remove(); });
      editor.focus();
    };
    inner.addEventListener('click', event => { if (!event.target.closest('.commentInput-right-ct,.unverified-toolbar') && !rich.querySelector('[contenteditable]')) { window.commentActivations++; addEditor(); } });
    publisher.addEventListener('click', () => {
      window.nativeCommentClicks++; window.commentClicks++;
      const editor = rich.querySelector('[contenteditable]'); if (!editor || !publisher.classList.contains('jfGCpJo0')) return;
      window.appendComment({ id: '99501', mine: true, status: 'sent', videoId: '12345', text: editor.innerText.replace(/[\u200B-\u200F\uFEFF]/g, '').trim() }); editor.textContent = dom.emptyEditorText;
    });
    document.body.append(outer); if (activated) addEditor();
    if (selectedFile) { const transfer = new DataTransfer(); transfer.items.add(new File(['原附件'], 'draft.txt')); tools.querySelector('input[type="file"]').files = transfer.files; }
  }, { dom, activated, existingDraft, wrongGeometry, disabled, wrongToolbar, duplicate, selectedFile });
  return f;
}

test('实机结构的懒占位和无标签两path发布图标经启用态核对后只点击一次', async t => {
  const f = await nativeFixture(t), result = await f.post(); assert.equal(result.confirmed, true); assert.equal(result.commentId, '99501'); assert.equal(await f.page.evaluate(() => window.commentActivations), 1);
  assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 1); assert.equal(await f.page.evaluate(() => window.nativeEmojiClicks), 0); assert.equal(await f.page.locator('[data-deepseek-comment-native-publish]').count(), 0);
});
test('DraftEditor空ZWSP不误判草稿，已有真实文字则不覆盖', async t => {
  const empty = await nativeFixture(t, { activated: true }); assert.equal((await empty.post()).confirmed, true);
  const nonempty = await nativeFixture(t, { activated: true, existingDraft: '用户已有DraftEditor草稿' }); const result = await nonempty.post(); assert.equal(result.confirmed, false); assert.equal(await nonempty.page.locator('.public-DraftEditor-content').innerText(), '用户已有DraftEditor草稿'); assert.equal(await nonempty.page.evaluate(() => window.nativeCommentClicks), 0);
});
test('无标签图标形状、母区域或唯一性不符时不猜测发布目标', async t => {
  for (const options of [{ wrongGeometry: true }, { wrongToolbar: true }, { duplicate: true }]) {
    const f = await nativeFixture(t, options), result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.needsUserAction, true); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0); assert.equal(await f.page.evaluate(() => window.nativeEmojiClicks), 0);
  }
});
test('实机图标没有进入已启用class时不点击', async t => {
  const f = await nativeFixture(t, { disabled: true }), result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(result.needsUserAction, true); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0);
});
test('实机编辑器已经有附件时不激活或追加文字', async t => {
  for (const activated of [false, true]) { const f = await nativeFixture(t, { activated, selectedFile: true }), result = await f.post(); assert.equal(result.confirmed, false); assert.equal(await f.page.locator('input[type="file"]').evaluate(input => input.files.length), 1); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0); }
});
test('评论结构只读检查不会激活、填写或点击，区分实际图标空态和启用态', async t => {
  const f = await nativeFixture(t, { activated: true });
  let result = await inspectCommentComposer(f.page, '12345'); assert.equal(result.submitFound, true); assert.equal(result.nativeIcon, true); assert.equal(result.enabled, false); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0);
  await f.page.locator('.public-DraftEditor-content').fill('合成结构检查'); result = await inspectCommentComposer(f.page, '12345'); assert.equal(result.enabled, true); assert.equal(await f.page.locator('.public-DraftEditor-content').innerText(), '合成结构检查'); assert.equal(await f.page.evaluate(() => window.nativeCommentClicks), 0);
});

test('新版懒加载评论框激活后识别同区域div发布控件，不误点隐藏弹幕', async t => {
  const f = await modernFixture(t), result = await f.post();
  assert.equal(result.confirmed, true); assert.equal(result.commentId, '99001'); assert.equal(await f.page.evaluate(() => window.commentActivations), 1);
  assert.equal(await f.page.evaluate(() => window.commentClicks), 1); assert.equal(await f.page.evaluate(() => window.danmakuClicks || 0), 0); assert.equal(await f.page.evaluate(() => window.enterCount), 0);
  assert.equal(await f.page.locator('[data-deepseek-comment-control]').count(), 0);
});
test('未激活区域有文字或隐藏草稿时不激活、不清空', async t => {
  for (const options of [{ lazyDraft: '用户还没有发出的评论' }, { hiddenDraft: '用户隐藏的输入内容' }]) {
    const f = await modernFixture(t, options), result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.needsUserAction, true);
    assert.equal(await f.page.evaluate(() => window.commentActivations), 0); assert.equal(await f.page.evaluate(() => window.commentClicks), 0);
    if (options.hiddenDraft) assert.equal(await f.page.locator('textarea').inputValue(), options.hiddenDraft); else assert.equal(await f.page.locator('.modern-comment-composer .comment-input-inner-container').innerText(), options.lazyDraft);
  }
});
test('实际新版占位span可激活，普通同文草稿仍保留', async t => {
  const f = await modernFixture(t);
  await f.page.locator('.modern-comment-composer').evaluate(element => { element.classList.add('comment-input-container'); const inner = element.querySelector('.comment-input-inner-container'); inner.removeAttribute('data-placeholder'); inner.innerHTML = '<span class="RXtfhfhu">留下你的精彩评论吧</span>'; });
  const result = await f.post(); assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.commentActivations), 1);
  const other = await modernFixture(t, { lazyDraft: '留下你的精彩评论吧' }); await other.page.locator('.modern-comment-composer .comment-input-inner-container').evaluate(element => element.removeAttribute('data-placeholder'));
  const guarded = await other.post(); assert.equal(guarded.confirmed, false); assert.equal(await other.page.evaluate(() => window.commentActivations), 0); assert.equal(await other.page.locator('.modern-comment-composer .comment-input-inner-container').innerText(), '留下你的精彩评论吧');
});
test('新版评论区域没有发布控件时保留生成草稿，不用回车替代提交', async t => {
  const f = await modernFixture(t, { missingSubmit: true }), result = await f.post();
  assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(result.needsUserAction, true); assert.match(result.reason, /没有唯一可核对的发布控件/);
  assert.equal(await f.page.locator('.modern-comment-composer [contenteditable]').innerText(), text); assert.equal(await f.page.evaluate(() => window.enterCount), 0); assert.equal(await f.page.evaluate(() => window.commentClicks), 0);
});
test('新版输入后出现两个发布控件时拒绝猜测，草稿不丢', async t => {
  const f = await modernFixture(t, { duplicateSubmit: true }), result = await f.post();
  assert.equal(result.confirmed, false); assert.equal(result.needsUserAction, true); assert.match(result.reason, /多个发布控件/); assert.equal(await f.page.evaluate(() => window.commentClicks), 0);
  assert.equal(await f.page.locator('.modern-comment-composer [contenteditable]').innerText(), text);
});
test('新版输入框所属作品不同则不激活或发布', async t => {
  const f = await modernFixture(t, { videoId: '67890' }), result = await f.post(); assert.equal(result.confirmed, false); assert.equal(await f.page.evaluate(() => window.commentActivations), 0); assert.equal(await f.page.evaluate(() => window.commentClicks), 0);
});
test('新版点击发布后只有编辑器清空，没有本人新评论回读仍为未确认', async t => {
  const f = await modernFixture(t, { clearWithoutReceipt: true }), result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true);
  assert.equal(await f.page.evaluate(() => window.commentClicks), 1); assert.equal(await f.page.locator('.modern-comment-composer [contenteditable]').innerText(), ''); assert.equal(f.commenter.receipts().operations[0].status, 'uncertain');
});
test('语义按钮中的发布文字不算第二个控件', async t => {
  const f = await fixture(t); await f.page.locator('[data-e2e="comment-post"]').evaluate(button => { button.innerHTML = '<span>发布</span>'; });
  const result = await f.post(); assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 1);
});
test('编辑器自身带评论标识时仍能核对同组发布按钮', async t => {
  const f = await fixture(t); await f.page.locator('.comment-input-container').evaluate(element => { element.className = 'comment-composer'; element.querySelector('[contenteditable]').setAttribute('data-e2e', 'comment-input'); });
  const result = await f.post(); assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 1);
});
test('只有明确发布辅助标签的图标控件也可核对，保留单次点击与收据要求', async t => {
  const f = await modernFixture(t); await f.page.locator('.modern-publish-control').evaluate(element => { element.innerHTML = '<svg aria-label="发布" width="28" height="28"><path d="M2 2L24 14L2 26Z"></path></svg>'; });
  const result = await f.post(); assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 1);
});
test('新版div发布控件明确禁用时不点击', async t => {
  const f = await modernFixture(t); await f.page.locator('.modern-publish-control').evaluate(element => element.setAttribute('aria-disabled', 'true'));
  const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(result.needsUserAction, true);
  assert.match(result.reason, /发布控件尚不可用/); assert.equal(await f.page.evaluate(() => window.commentClicks), 0); assert.equal(await f.page.locator('.modern-comment-composer [contenteditable]').innerText(), text);
});
test('发布控件选定后出现第二个同区域按钮仍会中止', async t => {
  const f = await modernFixture(t); let added = false;
  f.hooks.authorize = async ({ phase }) => { if (phase === 'monitor' && !added && await f.page.locator('[data-deepseek-comment-control]').count()) { added = true; await f.page.locator('.modern-comment-composer').evaluate(element => element.insertAdjacentHTML('beforeend', '<button>发布</button>')); } };
  const result = await f.post(); assert.equal(added, true); assert.equal(result.confirmed, false); assert.equal(await f.page.evaluate(() => window.commentClicks), 0); assert.equal(await f.page.locator('.modern-comment-composer [contenteditable]').innerText(), text);
});

test('可信许可缺失或JSON伪造时完全不填写与发布', async t => {
  const f = await fixture(t); for (const authorize of [undefined, {}, () => true]) { const result = await f.commenter.post({ expectedVideoId: '12345', text }, { authorize }); assert.equal(result.confirmed, false); }
  assert.equal(await f.page.evaluate(() => window.commentClicks), 0); assert.equal(await f.page.locator('[contenteditable]').innerText(), '');
});
test('未打开评论输入或官方按钮不唯一时明确要求人工处理', async t => {
  for (const options of [{ missingInput: true }, { doubleButton: true }]) { const f = await fixture(t, options), result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.needsUserAction, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 0); }
});
test('已有草稿、处于回复模式或私信遮挡时不填写和发布', async t => {
  const f = await fixture(t, { draft: '用户草稿' }); let result = await f.post(); assert.equal(result.confirmed, false); assert.equal(await f.page.locator('[contenteditable]').innerText(), '用户草稿');
  await f.page.locator('[contenteditable]').fill(''); await f.page.evaluate(() => { const reply = document.createElement('div'); reply.setAttribute('data-e2e', 'comment-reply-target'); reply.textContent = '回复合成评论'; document.querySelector('.comment-input-container').append(reply); }); result = await f.post(); assert.equal(result.confirmed, false); assert.equal((await f.page.locator('[contenteditable]').innerText()).trim(), '');
  await f.page.evaluate(() => { document.querySelector('[data-e2e="comment-reply-target"]').remove(); window.fixtureState.privateChatVisible = true; }); result = await f.post(); assert.equal(result.confirmed, false); assert.equal(await f.page.evaluate(() => window.commentClicks), 0);
});
test('唯一真实点击、同作品新本人commentId和稳定发出状态才确认成功', async t => {
  const f = await fixture(t), result = await f.post(); assert.equal(result.confirmed, true); assert.equal(result.commentId, '90001'); assert.equal(result.videoId, '12345'); assert.equal(await f.page.evaluate(() => window.commentClicks), 1); assert.equal(f.stats().begins, 1); assert.equal(f.stats().lease, false);
  assert.equal(f.commenter.receipts().operations[0].status, 'confirmed'); const again = await f.post(); assert.equal(again.confirmed, false); assert.equal(await f.page.evaluate(() => window.commentClicks), 1); assert.equal(fs.existsSync(path.join(f.stateDir, 'comment-post.guard')), false);
});
test('旧评论、其他人的相同文字、不同作品、pending和无编号都不冒充成功', async t => {
  for (const result of [{ id: '90001', mine: true, status: 'sent' }, { id: '90002', mine: false, status: 'sent' }, { id: '90002', mine: true, status: 'sent', videoId: '67890' }, { id: '90002', mine: true, status: 'pending' }, { id: 'local-pending', mine: true, status: 'sent' }]) {
    const f = await fixture(t, { existing: [{ id: '90001', mine: true, status: 'sent', text }], result }); const output = await f.post(); assert.equal(output.confirmed, false); assert.equal(output.deliveryUncertain, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 1); assert.equal(f.commenter.receipts().operations[0].status, 'uncertain');
  }
});
test('同文多条新本人评论不能作为唯一发布证据', async t => {
  const f = await fixture(t, { result: [{ id: '90001', mine: true, status: 'sent' }, { id: '90002', mine: true, status: 'sent' }] }); const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 1);
});
test('等待真实按钮稳定期间关闭许可，动画结束后也不会迟发，草稿保留', async t => {
  const f = await fixture(t); let prepared = false;
  f.hooks.authorize = async ({ phase }) => { if (phase === 'monitor' && !prepared && await f.page.locator('[contenteditable]').innerText() === text) { prepared = true; await f.page.evaluate(() => document.querySelector('[data-e2e="comment-post"]').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }], { duration: 800 })); setTimeout(() => f.setAllowed(false), 80); } };
  const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(f.stats().begins, 0); await f.page.waitForTimeout(300); assert.equal(await f.page.evaluate(() => window.commentClicks), 0); assert.equal(await f.page.locator('[contenteditable]').innerText(), text);
});
test('等待期间换片或用户改草稿都不发布，保留用户内容', async t => {
  for (const mutation of ['video', 'draft']) {
    const f = await fixture(t); let prepared = false;
    f.hooks.authorize = async ({ phase }) => { if (phase === 'monitor' && !prepared && await f.page.locator('[contenteditable]').innerText() === text) { prepared = true; await f.page.evaluate(kind => { document.querySelector('[data-e2e="comment-post"]').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }], { duration: 800 }); setTimeout(() => { if (kind === 'video') window.fixtureState.video.id = '67890'; else document.querySelector('[contenteditable]').textContent = '用户改写草稿'; }, 80); }, mutation); } };
    const result = await f.post(); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(await f.page.evaluate(() => window.commentClicks), 0); if (mutation === 'draft') assert.equal(await f.page.locator('[contenteditable]').innerText(), '用户改写草稿');
  }
});
test('最终输入期间用户取消后不再次点击，没有回读则保留未确认收据', async t => {
  const f = await fixture(t, { result: null }), abort = new AbortController(); await f.page.exposeFunction('fixtureAbortComment', () => abort.abort(new Error('合成用户取消'))); await f.page.evaluate(() => document.querySelector('[data-e2e="comment-post"]').addEventListener('click', () => window.fixtureAbortComment()));
  const result = await f.post({ signal: abort.signal }); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true); assert.equal(await f.page.evaluate(() => window.commentClicks), 1); assert.equal(await f.page.locator('[contenteditable]').innerText(), text); assert.equal(f.commenter.receipts().operations[0].status, 'uncertain');
});
test('只读评论字段不含账号、昵称或头像，明确限定作品', async t => {
  const f = await fixture(t, { existing: [{ id: '90000', mine: true, status: 'sent', text: '合成已有评论' }] }); await f.page.evaluate(() => { const row = document.querySelector('[data-e2e="comment-item"]'); row.insertAdjacentHTML('beforeend', '<a href="/user/synthetic-private-account">合成评论者姓名</a><img src="https://synthetic.invalid/avatar-private">'); });
  const snapshot = await f.page.evaluate(readCommentDom, '12345'); assert.deepEqual(Object.keys(snapshot.rows[0]).sort(), ['commentId', 'videoId', 'text', 'mine', 'sent', 'pending', 'failed'].sort()); assert.equal(JSON.stringify(snapshot).includes('private'), false); assert.equal(JSON.stringify(snapshot).includes('姓名'), false);
});
async function nativeCommentRows(f, { self = 'synthetic-self-profile', duplicateNavigation = false, navigationOrigin = 'https://www.douyin.com', author = 'synthetic-self-profile', mentionSelf = false, duplicateAuthor = false, nestedSelf = false, statusLabel = '' } = {}) {
  await f.page.evaluate(({ self, duplicateNavigation, navigationOrigin, author, mentionSelf, duplicateAuthor, nestedSelf, statusLabel }) => {
    const nav = document.createElement('div'); nav.className = 'tab-user_self'; nav.innerHTML = `<a href="${navigationOrigin}/user/${self}">我的</a>`; if (duplicateNavigation) nav.append(nav.firstElementChild.cloneNode(true)); document.body.prepend(nav);
    const make = (id, owner, body) => { const row = document.createElement('div'); row.setAttribute('data-e2e', 'comment-item'); row.innerHTML = `<div class="comment-item-avatar"><a href="https://www.douyin.com/user/${owner}"><span style="display:inline-block;width:30px;height:30px">头像</span></a></div><div class="JPoP3Ezg"><div data-e2e="video-comment-more"><div id="tooltip_${id}"></div></div><div class="FduGc_lz"><span class="Sh1Da424">${body}</span></div></div>`; return row; };
    const row = make('98001', author, '新版合成评论正文');
    if (mentionSelf) row.querySelector('.Sh1Da424').insertAdjacentHTML('beforeend', `<a href="https://www.douyin.com/user/${self}">@合成提及</a>`);
    if (duplicateAuthor) row.querySelector('.comment-item-avatar').append(row.querySelector('.comment-item-avatar a').cloneNode(true));
    if (nestedSelf) { const reply = document.createElement('div'); reply.className = 'replyContainer'; reply.append(make('98002', self, '嵌套的本人回复')); row.append(reply); }
    if (statusLabel) { const label = document.createElement('span'); label.className = 'comment-item-tag-text'; label.textContent = statusLabel; row.append(label); }
    document.querySelector('[data-e2e="comment-list"]').append(row);
  }, { self, duplicateNavigation, navigationOrigin, author, mentionSelf, duplicateAuthor, nestedSelf, statusLabel });
}
test('真实作者profile与唯一官方我的导航比对，读取新版正文但不带出账号', async t => {
  const f = await fixture(t); await nativeCommentRows(f);
  const snapshot = await f.page.evaluate(readCommentDom, '12345'); assert.equal(snapshot.rows.length, 1); assert.equal(snapshot.rows[0].mine, true); assert.equal(snapshot.rows[0].commentId, '98001'); assert.equal(snapshot.rows[0].text, '新版合成评论正文'); assert.equal(snapshot.rows[0].sent, true);
  assert.equal(JSON.stringify(snapshot).includes('synthetic-self-profile'), false); assert.equal(JSON.stringify(snapshot).includes('/user/'), false);
});
test('正文提及自己、嵌套本人回复都不能把别人的顶层评论认成本人', async t => {
  const f = await fixture(t); await nativeCommentRows(f, { author: 'synthetic-other-profile', mentionSelf: true, nestedSelf: true });
  const snapshot = await f.page.evaluate(readCommentDom, '12345'); assert.equal(snapshot.rows.length, 1); assert.equal(snapshot.rows[0].mine, false); assert.equal(snapshot.rows[0].commentId, '98001'); assert.equal(snapshot.rows[0].text.includes('嵌套'), false);
});
test('自账号导航或作者不唯一、导航域名不符时不能补出本人证据', async t => {
  for (const options of [{ duplicateNavigation: true }, { duplicateAuthor: true }, { navigationOrigin: 'https://untrusted.invalid' }]) {
    const f = await fixture(t); await nativeCommentRows(f, options); const snapshot = await f.page.evaluate(readCommentDom, '12345'); assert.equal(snapshot.rows[0].mine, false);
  }
});
test('作者匹配仍须绑定同作品，页面视频编号冲突则不返回成功候选', async t => {
  const f = await fixture(t); await nativeCommentRows(f); await f.page.locator('.comment-mainContent').evaluate(element => element.setAttribute('data-video-id', '67890'));
  assert.equal((await f.page.evaluate(readCommentDom, '12345')).rows.length, 0);
  await f.page.locator('.comment-mainContent').evaluate(element => element.setAttribute('data-video-id', '12345'));
  await f.page.evaluate(() => { const player = document.createElement('div'); player.setAttribute('data-e2e', 'player-container'); player.className = 'video_67890'; player.innerHTML = '<video style="width:300px;height:180px"></video>'; document.body.prepend(player); });
  assert.equal((await f.page.evaluate(readCommentDom, '12345')).rows.length, 0);
});
test('真实样式的审核或失败标签不被当成已发布', async t => {
  for (const statusLabel of ['审核中', '审核未通过']) {
    const f = await fixture(t); await nativeCommentRows(f, { statusLabel }); const row = (await f.page.evaluate(readCommentDom, '12345')).rows[0]; assert.equal(row.mine, true); assert.equal(row.sent, false); assert.equal(row.pending || row.failed, true);
  }
});
test('真实合成发布链路跨入口撤回许可，服务保留扣费与草稿但不发布', async t => {
  const f = await fixture(t), now = Date.now(), evidenceId = `video:${'a'.repeat(64)}`, watchRunId = 'synthetic-comment-watch';
  const personaMemory = { snapshot: () => ({ recentObservations: [{ id: evidenceId, videoId: '12345', url: 'https://www.douyin.com/video/12345', sources: ['api'], privacy: 'internal-reference', visibility: 'account-visible-unverified', observedAt: now }] }) };
  const videoLimits = { state: () => ({ allowed: true, session: { status:'active', id: 'synthetic-session', startAt: now, expiresAt: now + 60000 } }) };
  fs.writeFileSync(path.join(f.stateDir, 'watch-loop.lock'), JSON.stringify({ pid: process.pid, source: 'api', runId: watchRunId, sessionId: 'synthetic-session', status: 'running' }));
  const foreign = new AutonomousComments({ personaMemory, videoLimits, stateDir: f.stateDir }); let scheduled = false, disabled = false;
  const service = new AutonomousComments({ personaMemory, videoLimits, stateDir: f.stateDir, post: (input, controls) => {
    const authorize = async request => { const result = controls.authorize(request); if (request.phase === 'monitor' && !scheduled && await f.page.locator('[contenteditable]').innerText() === text) { scheduled = true; await f.page.evaluate(() => document.querySelector('[data-e2e="comment-post"]').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }], { duration: 800 })); setTimeout(() => { disabled = foreign.configure({ enabled: false }, { explicit: true }).enabled === false; }, 80); } return result; }; authorize.beginDispatch = controls.authorize.beginDispatch;
    return f.commenter.post(input, { ...controls, authorize });
  } });
  service.configure({ enabled: true }, { explicit: true }); const result = await service.comment({ evidenceId, videoId: '12345', text }, { watchRunId });
  assert.equal(disabled, true); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(await f.page.evaluate(() => window.commentClicks), 0); assert.equal(await f.page.locator('[contenteditable]').innerText(), text); assert.equal(service.ledger().operations[0].status, 'not-sent'); assert.equal(service.state().daily.attempts, 1); await service.close(); await foreign.close();
});
