import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '../playwright-runtime.mjs';
import { createHash } from 'node:crypto';
import { readPageState } from '../core.mjs?v=9';
import { VideoForwarder, canonicalVideoUrl, forwardAvatarIdentity, readForwardPanelDom, selectForwardRecipient, safeForwardFailure } from '../video-forward.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });
const hash = value => createHash('sha256').update(value).digest('hex');
const stable = (nativeId, isGroup = false) => ({ id: `conv:${hash(`native:${nativeId}`)}`, nativeId, isGroup, identityVersion: 2, identityVerified: true, identityKind: 'native-conversation', identityHash: hash(`native:${nativeId}`), identityBinding: `binding:${hash(`${isGroup ? 'group' : 'direct'}\0native:${nativeId}`)}` });
const recipientId = stable('fixture-person').id;
const contact = { ...stable('fixture-person'), name: '合成好友甲', displayName: '合成好友甲', followed: true, avatar: '/img/aweme-avatar/fixture-avatar' };
const card = { id: `msg:${'b'.repeat(64)}`, sender: 'outgoing', arrivalClassification: 'new-tail', media: { type: 'shared-work', videoId: '12345', url: 'https://www.douyin.com/video/12345' } };

async function fixture({ rows = [{ name: '合成好友甲', avatar: 'https://fixture.local/aweme/aweme-avatar/fixture-avatar.jpeg', label: '分享' }], follow = true, shareResult = [card], existing = [], gateHook, contactData = contact } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-forward-test-'));
  fs.writeFileSync(path.join(stateDir, 'chat-policy.json'), JSON.stringify({ allowlist: [{ ...contactData, verifiedAt: '2026-10-14T00:00:00Z' }] }));
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill(route.request().resourceType() === 'document' ? { contentType: 'text/html', body: '<!doctype html><html><body></body></html>' } : { contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>' }));
  await page.goto('https://www.douyin.com/video/12345');
  await page.setContent('<div data-e2e="video-share-icon-container"><div class="s7K4YLGp" style="width:40px;height:40px">分享</div><div data-e2e="video-share-container"></div></div>');
  await page.evaluate(({ rows, existing, shareResult }) => {
    document.body.insertAdjacentHTML('beforeend', '<section data-e2e="feed-active-video" class="video_12345"><video style="position:fixed;left:700px;top:10px;width:80px;height:50px"></video></section>');
    Object.defineProperty(document.querySelector('video'), 'readyState', { value: 4 });
    window.sent = 0; window.messages = existing; window.shareResult = shareResult;
    window.fixtureState = { video: { id: '12345', url: 'https://www.douyin.com/video/12345', readyState: 4 }, loginRequired: false, verificationRequired: false };
    const panel = document.querySelector('[data-e2e="video-share-container"]');
    for (const row of rows) {
      const item = document.createElement('div'); item.className = 'otFjqQEX';
      item.setAttribute('data-conversation-type', row.isGroup ? 'group' : 'direct');
      if (row.isGroup) { item.setAttribute('data-e2e', 'share-group-row'); }
      if (row.nativeId) item.setAttribute('data-conversation-id', row.nativeId);
      const image = document.createElement('img'); image.src = row.avatar; image.width = 30; image.height = 30;
      const name = document.createElement('span'); name.className = 'EnYt_IKl'; name.textContent = row.name;
      const send = document.createElement('div'); send.className = 'xu0OjnsQ'; send.textContent = row.label; send.style.cssText = 'width:70px;height:30px';
      send.addEventListener('click', () => { send.dataset.clicked = 'true'; window.sent += 1; window.messages = [...window.messages, ...window.shareResult]; });
      item.append(image, name, send); panel.append(item);
      if (row.groupMarker) { const group = document.createElement('div'); group.setAttribute('data-e2e', 'group-avatar'); item.append(group); }
    }
  }, { rows: rows.map(row => ({ ...row, nativeId: row.nativeId === undefined ? contactData.nativeId : row.nativeId })), existing, shareResult });
  let gates = 0, pauses = 0, verified = 0, opened = 0, connected = 0;
  const realEvaluate = page.evaluate.bind(page);
  page.evaluate = (fn, arg) => fn === readPageState ? realEvaluate(() => window.fixtureState) : realEvaluate(fn, arg);
  const controller = { source: 'api', withPage: async fn => { connected += 1; return fn(page); }, pauseForLimits: async () => { pauses += 1; }, settle: async () => {} };
  const chatBrowser = {
    contacts: new Map([[recipientId, contactData]]),
    listContacts: async options => { assert.equal(options.verifyFollowing, true); verified += 1; return { contacts: [{ ...contactData, followed: follow }] }; },
    readConversation: async (id, options) => { assert.equal(id, recipientId); assert.equal(options.allowed, true); return { conversation: { id: recipientId }, messages: await realEvaluate(() => window.messages) }; },
    openSharedVideo: async (id, messageId, options) => { opened += 1; assert.equal(id, recipientId); assert.equal(options.allowed, true); return { videoId: '12345', url: 'https://www.douyin.com/video/12345' }; },
    sendMessage: async () => { throw new Error('测试禁止文字链接自动降级'); },
  };
  const videoLimits = { beforeAction: (source, name) => { assert.equal(source, 'api'); assert.equal(name, 'douyin_forward_video'); gates += 1; return gateHook?.({ gates, page }) ?? { allowed: true }; } };
  const forwarder = new VideoForwarder({ controller, chatBrowser, videoLimits, stateDir });
  return { page, forwarder, stateDir, stats: () => ({ gates, pauses, verified, opened, connected }), cleanup: async () => { await page.close(); fs.rmSync(stateDir, { recursive: true, force: true }); } };
}

test('可信人类入口未授权时只提示本机选择，不进入浏览器', async () => {
  const f = await fixture();
  try { const result = await f.forwarder.forward({ recipientId }); assert.equal(result.humanActionRequired, true); assert.equal(result.confirmed, false); assert.deepEqual(f.stats(), { gates: 0, pauses: 0, verified: 0, opened: 0, connected: 0 }); } finally { await f.cleanup(); }
});

test('作品链接只保留公开作品路径，拒绝其他站点及链接和 ID 不一致', async () => {
  assert.deepEqual(canonicalVideoUrl('https://www.douyin.com/video/12345?secret=fixture'), { videoId: '12345', url: 'https://www.douyin.com/video/12345' });
  for (const url of ['https://evil.local/video/12345', 'javascript:alert(1)', 'https://user:pass@www.douyin.com/video/12345', 'https://www.douyin.com/video/12345/other']) assert.throws(() => canonicalVideoUrl(url));
  const f = await fixture(); try { await assert.rejects(f.forwarder.forward({ recipientId, url: 'https://www.douyin.com/video/12345', expectedVideoId: '999' }, { humanAuthorized: true }), /不一致/); assert.equal(f.stats().connected, 0); } finally { await f.cleanup(); }
});

test('时间门控先于联系人或分享界面，拒绝后主动暂停', async () => {
  const f = await fixture({ gateHook: () => ({ allowed: false, reason: '合成时间窗外' }) });
  try { await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /时间窗外/); assert.equal(f.stats().pauses, 1); assert.equal(f.stats().verified, 0); assert.equal(await f.page.evaluate(() => window.sent), 0); } finally { await f.cleanup(); }
});

test('当前取消关注或固定白名单外联系人都拒绝转发', async () => {
  const f = await fixture({ follow: false });
  try { await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /关注关系/); await assert.rejects(f.forwarder.forward({ recipientId: `conv:${'c'.repeat(64)}` }, { humanAuthorized: true }), /名单内/); assert.equal(await f.page.evaluate(() => window.sent), 0); } finally { await f.cleanup(); }
});

test('相同头像资源的代理前缀和图片格式可核对，其他头像不等价', () => {
  assert.equal(forwardAvatarIdentity('/img/aweme-avatar/fixture-avatar'), forwardAvatarIdentity('https://fixture.local/aweme/100x100/aweme-avatar/fixture-avatar.jpeg?temporary=1'));
  assert.notEqual(forwardAvatarIdentity('/img/aweme-avatar/fixture-avatar'), forwardAvatarIdentity('/img/aweme-avatar/other-avatar'));
});

test('分享只按稳定身份选择，重复同ID或同名同头像不同ID都不点击', async () => {
  for (const rows of [[{ name: '合成好友甲', avatar: contact.avatar, label: '分享' }, { name: '另一个显示名', avatar: contact.avatar, label: '分享' }], [{ name: '合成好友甲', avatar: contact.avatar, nativeId: 'another-stable-account', label: '分享' }]]) {
    const f = await fixture({ rows }); try { await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /稳定身份/); assert.equal(await f.page.evaluate(() => window.sent), 0); } finally { await f.cleanup(); }
  }
});

test('同稳定账号更换昵称和头像仍可分享，不依赖外观作身份回退', async () => {
  const f = await fixture({ rows: [{ name: '合成更新昵称', avatar: 'https://fixture.local/aweme-avatar/changed.png', label: '分享' }] });
  try { assert.equal((await f.forwarder.forward({ recipientId }, { humanAuthorized: true })).confirmed, true); assert.equal(await f.page.evaluate(() => window.sent), 1); } finally { await f.cleanup(); }
});

test('合成原生卡片只点击一次并精确回读作品 ID，收据持久化', async () => {
  const f = await fixture();
  try { const result = await f.forwarder.forward({ recipientId, expectedVideoId: '12345' }, { humanAuthorized: true }); assert.equal(result.confirmed, true); assert.equal(result.deliveryType, 'native-card'); assert.equal(result.messageId, card.id); assert.equal(result.videoId, '12345'); assert.equal(await f.page.evaluate(() => window.sent), 1); assert.equal(f.stats().verified, 1); const receipt = JSON.parse(fs.readFileSync(path.join(f.stateDir, 'video-forward-receipts.json'))); assert.equal(receipt.operations[0].status, 'confirmed'); assert.equal(fs.existsSync(path.join(f.stateDir, 'video-forward.guard')), false); } finally { await f.cleanup(); }
});

test('后台低RAF分享仍通过真实几何和中心命中，只产生一次可信输入', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => { window.requestAnimationFrame = () => 0; window.trustedShares = 0; document.querySelector('.xu0OjnsQ').addEventListener('click', event => { if (event.isTrusted) window.trustedShares += 1; }); });
    const result = await f.forwarder.forward({ recipientId, expectedVideoId: '12345' }, { humanAuthorized: true });
    assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.sent), 1); assert.equal(await f.page.evaluate(() => window.trustedShares), 1);
  } finally { await f.cleanup(); }
});

test('分享几何检查拒绝遮挡移动，最终许可后换控件换好友或换作品也不点击', async () => {
  for (const mode of ['covered', 'moving', 'replace-final', 'friend-final', 'video-final', 'move-final', 'cover-final']) {
    const f = await fixture(); let prepared = false;
    try {
      await f.page.evaluate(() => { window.anyTrustedShares = 0; document.addEventListener('click', event => { if (event.isTrusted && event.target.closest('.xu0OjnsQ')) window.anyTrustedShares += 1; }, true); });
      const alter = kind => {
        const send = document.querySelector('.xu0OjnsQ');
        if (kind === 'covered' || kind === 'cover-final') { const r = send.getBoundingClientRect(), cover = document.createElement('div'); cover.style.cssText = `position:fixed;z-index:999999;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;background:black`; document.body.append(cover); }
        else if (kind === 'moving') send.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(300px)' }], { duration: 700, iterations: Infinity, direction: 'alternate' });
        else if (kind === 'replace-final') { const next = send.cloneNode(true); next.removeAttribute('data-deepseek-forward-token'); send.replaceWith(next); }
        else if (kind === 'friend-final') { document.querySelector('.otFjqQEX').setAttribute('data-conversation-id', 'changed-stable-account'); }
        else if (kind === 'video-final') window.fixtureState.video.id = '54321';
        else send.style.marginLeft = '150px';
      };
      const authorize = async ({ phase }) => { if (phase === 'monitor' && !prepared && ['covered', 'moving'].includes(mode)) { prepared = true; await f.page.evaluate(alter, mode); } return true; };
      authorize.beginDispatch = async () => { if (mode.endsWith('-final')) await f.page.evaluate(alter, mode); return () => {}; };
      await assert.rejects(f.forwarder.forwardAutonomous({ recipientId, expectedVideoId: '12345' }, { authorize }), /几何|控件|昵称|头像|身份|切换/, mode);
      assert.equal(await f.page.evaluate(() => window.sent), 0, mode); assert.equal(await f.page.evaluate(() => window.anyTrustedShares), 0, mode);
      assert.equal(f.forwarder.receipts().operations.at(-1).status, 'not-sent', mode);
    } finally { await f.cleanup(); }
  }
});

test('分享的最终短输入许可一直持有到唯一可信鼠标点击完成，随后释放', async () => {
  const f = await fixture(); let held = false, began = 0, released = 0, settled = false, clicks = 0;
  const prototype = Object.getPrototypeOf(f.page.mouse), original = prototype.click;
  try {
    prototype.click = async function(x, y, options) {
      if (this !== f.page.mouse) return original.apply(this, arguments);
      assert.equal(held, true); assert.equal(released, 0); assert.equal(options?.delay || 0, 0); assert.equal(options?.clickCount || 1, 1); clicks += 1;
      const result = await original.apply(this, arguments); assert.equal(held, true); settled = true; return result;
    };
    const authorize = () => true;
    authorize.beginDispatch = () => { assert.equal(held, false); held = true; began += 1; return () => { assert.equal(held, true); assert.equal(settled, true); held = false; released += 1; }; };
    const result = await f.forwarder.forwardAutonomous({ recipientId, expectedVideoId: '12345' }, { authorize });
    assert.equal(result.confirmed, true); assert.equal(clicks, 1); assert.equal(began, 1); assert.equal(released, 1); assert.equal(held, false); assert.equal(await f.page.evaluate(() => window.sent), 1);
  } finally { prototype.click = original; await f.cleanup(); }
});

test('显式授权的现有个人会话绑定可转发，身份绑定变化则不点击', async () => {
  const authorized = { ...contact, followed: null, relationshipStatus: 'unavailable', authorizationKind: 'existing-conversation' };
  for (const changed of [false, true]) {
    const f = await fixture({ follow: null, contactData: authorized });
    try {
      if (changed) f.forwarder.chatBrowser.listContacts = async () => ({ contacts: [{ ...authorized, identityBinding: `binding:${'e'.repeat(64)}` }] });
      if (changed) {
        await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /身份或关注关系/);
        assert.equal(await f.page.evaluate(() => window.sent), 0);
      } else {
        const result = await f.forwarder.forward({ recipientId }, { humanAuthorized: true });
        assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.sent), 1);
      }
    } finally { await f.cleanup(); }
  }
});

test('显式许可群聊只匹配真实群聊行，不向同名个人发送', async () => {
  const group = { ...contact, ...stable(contact.nativeId, true), name: '合成群聊', displayName: '合成群聊', followed: null, conversationType: 'group', avatar: 'group-marker', relationshipStatus: 'unavailable', authorizationKind: 'existing-group' };
  const f = await fixture({ follow: null, contactData: group, rows: [{ name: '合成群聊', avatar: 'https://fixture.local/personal.png', label: '分享' }, { name: '合成群聊', avatar: '', label: '分享', isGroup: true, nativeId: group.nativeId, groupMarker: true }] });
  try {
    const result = await f.forwarder.forward({ recipientId }, { humanAuthorized: true });
    assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.sent), 1);
    assert.equal(await f.page.locator('[data-e2e="share-group-row"] .xu0OjnsQ').getAttribute('data-clicked'), 'true');
    assert.equal(await f.page.locator('.otFjqQEX').first().locator('.xu0OjnsQ').getAttribute('data-clicked'), null);
  } finally { await f.cleanup(); }
});

test('没有群聊类型证据或稳定群身份的分享行拒绝匹配', () => {
  const group = { ...stable('synthetic-group', true), name: '同名会话', displayName: '同名会话', avatar: 'group-marker' };
  assert.throws(() => selectForwardRecipient([{ displayName: group.displayName, nativeId: group.nativeId, isGroup: false, sendTargetVerified: true, sendLabel: '分享', disabled: false }], group), /稳定身份/);
  assert.throws(() => selectForwardRecipient([{ displayName: group.displayName, isGroup: true, nativeId: 'another-group', sendTargetVerified: true, sendLabel: '分享', disabled: false }], group), /稳定身份/);
  assert.throws(() => selectForwardRecipient([{ displayName: group.displayName, isGroup: true, sendTargetVerified: true, sendLabel: '分享', disabled: false }], group), /稳定身份/);
  assert.equal(forwardAvatarIdentity('group-avatar:["https://fixture.local/aweme/100x100/aweme-avatar/avatar-b.jpeg","/img/aweme-avatar/avatar-a"]'), forwardAvatarIdentity('group-avatar:["/img/aweme-avatar/avatar-a","/img/aweme-avatar/avatar-b"]'));
});

test('分享点击后先重新打开已授权会话再核对新卡片，不重复点击分享', async () => {
  const f = await fixture();
  try {
    const read = f.forwarder.chatBrowser.readConversation;
    const options = [];
    f.forwarder.chatBrowser.readConversation = async (id, opts) => {
      options.push({ ...opts });
      if (options.length > 1 && opts.refresh !== true) return { conversation: { id }, messages: [] };
      return read(id, opts);
    };
    const result = await f.forwarder.forward({ recipientId }, { humanAuthorized: true });
    assert.equal(result.confirmed, true); assert.equal(options[1].refresh, true);
    assert.equal(await f.page.evaluate(() => window.sent), 1);
  } finally { await f.cleanup(); }
});
test('视频分享的完整事务持共同锁，确认卡片也进入共同发出账本', async () => {
  const f = await fixture();
  try {
    const prepare = f.forwarder.prepareContact.bind(f.forwarder);
    f.forwarder.prepareContact = async (...args) => { assert.equal(fs.existsSync(path.join(f.stateDir, 'outbound-send.guard')), true); return prepare(...args); };
    const result = await f.forwarder.forward({ recipientId }, { humanAuthorized: true });
    assert.equal(result.confirmed, true); const rows = f.forwarder.outbound.history(recipientId); assert.equal(rows.length, 1); assert.equal(rows[0].kind, 'video'); assert.equal(rows[0].messageId, card.id);
    assert.equal(fs.existsSync(path.join(f.stateDir, 'outbound-send.guard')), false);
  } finally { await f.cleanup(); }
});

test('点击前作品变化或时间到点都拒绝分享', async () => {
  for (const kind of ['video', 'expired']) {
    const f = await fixture({ gateHook: ({ gates }) => gates === 3 && kind === 'expired' ? { allowed: false, reason: '合成到点' } : { allowed: true } });
    try { if (kind === 'video') { const original = f.forwarder.gate.bind(f.forwarder); let calls = 0; f.forwarder.gate = async signal => { const result = await original(signal); if (++calls === 3) await f.page.evaluate(() => window.fixtureState.video.id = '999'); return result; }; } await assert.rejects(f.forwarder.forward({ recipientId, expectedVideoId: '12345' }, { humanAuthorized: true }), /切换|到点/); assert.equal(await f.page.evaluate(() => window.sent), 0); } finally { await f.cleanup(); }
  }
});

test('标记行被复用成另一好友，即使目标仍在原位置也不点击错误行', async () => {
  for (const mutationGate of [3, 4]) {
    const f = await fixture();
    try {
      const original = f.forwarder.gate.bind(f.forwarder); let calls = 0;
      f.forwarder.gate = async signal => {
        const result = await original(signal);
        if (++calls === mutationGate) await f.page.evaluate(() => {
          const old = document.querySelector('[data-deepseek-forward-id]');
          const replacement = old.cloneNode(true); replacement.removeAttribute('data-deepseek-forward-id');
          old.before(replacement);
          old.querySelector('.EnYt_IKl').textContent = '合成其他好友';
          old.setAttribute('data-conversation-id', 'another-stable-account');
          old.querySelector('img').src = 'https://fixture.local/aweme/aweme-avatar/other-avatar.jpeg';
        });
        return result;
      };
      await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /昵称|头像|身份/);
      assert.equal(await f.page.evaluate(() => window.sent), 0);
      assert.equal(f.forwarder.receipts().operations.at(-1).status, 'not-sent');
    } finally { await f.cleanup(); }
  }
});

test('最后一次门控期间取消操作，标记行仍正确也不分享', async () => {
  const f = await fixture(); const aborter = new AbortController();
  try {
    const original = f.forwarder.gate.bind(f.forwarder); let calls = 0;
    f.forwarder.gate = async signal => { const result = await original(signal); if (++calls === 4) aborter.abort(); return result; };
    await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true, signal: aborter.signal }), { name: 'AbortError' });
    assert.equal(await f.page.evaluate(() => window.sent), 0);
  } finally { await f.cleanup(); }
});

test('旧卡片或不同作品不作为成功证据，未确认记录阻止再次点击', async () => {
  const f = await fixture({ existing: [card], shareResult: [{ ...card, id: `msg:${'d'.repeat(64)}`, media: { type: 'shared-work', videoId: '999' } }] });
  try { const result = await f.forwarder.forward({ recipientId }, { humanAuthorized: true }); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true); assert.equal(await f.page.evaluate(() => window.sent), 1); await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /未确认的转发记录/); assert.equal(await f.page.evaluate(() => window.sent), 1); } finally { await f.cleanup(); }
});

test('卡片没有 DOM 链接时通过指定新卡片打开结果核实作品', async () => {
  const f = await fixture({ shareResult: [{ ...card, media: { type: 'shared-work' } }] });
  try { const result = await f.forwarder.forward({ recipientId }, { humanAuthorized: true }); assert.equal(result.confirmed, true); assert.equal(f.stats().opened, 1); assert.equal(await f.page.evaluate(() => window.sent), 1); } finally { await f.cleanup(); }
});

test('补载的旧卡片以及两个相同作品新卡片不作为唯一转发回读', async () => {
  for (const shareResult of [[{ ...card, arrivalClassification: 'old-history' }], [card, { ...card, id: `msg:${'c'.repeat(64)}` }]]) {
    const f = await fixture({ shareResult });
    try { const result = await f.forwarder.forward({ recipientId }, { humanAuthorized: true }); assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true); assert.equal(await f.page.evaluate(() => window.sent), 1); } finally { await f.cleanup(); }
  }
});

test('没有原生分享界面时提示公开链接降级，不自动发送文字', async () => {
  const f = await fixture({ rows: [] });
  try { const result = await f.forwarder.forward({ recipientId }, { humanAuthorized: true }); assert.equal(result.needsFallback, true); assert.equal(result.deliveryUncertain, false); assert.equal(await f.page.evaluate(() => window.sent), 0); } finally { await f.cleanup(); }
});

test('同一转发控制锁阻止并发入口，保留需要人工核对的锁', async () => {
  const f = await fixture();
  try { fs.writeFileSync(path.join(f.stateDir, 'video-forward.guard'), '{}'); await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /转发锁/); assert.equal(f.stats().verified, 0); assert.equal(fs.existsSync(path.join(f.stateDir, 'video-forward.guard')), true); } finally { await f.cleanup(); }
});

test('分享 DOM 仅读取身份和发送按钮，未返回会话预览', async () => {
  const f = await fixture();
  try { const panel = await f.page.evaluate(readForwardPanelDom); assert.equal(panel.rows[0].displayName, '合成好友甲'); assert.equal(panel.rows[0].sendLabel, '分享'); assert.equal(panel.rows[0].lastMessagePreview, undefined); assert.equal(panel.rows[0].message, undefined); } finally { await f.cleanup(); }
});

async function currentPanelFixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-forward-current-')), page = await browser.newPage();
  const secUid = 'MS4SyntheticSelectedStableAccount', uid = '1234567890123456', key = `rendered:user:${hash(secUid)}`;
  const allowed = { ...contact, id: `conv:${hash(key)}`, identityKind: 'rendered-user', identityHash: hash(key), identityBinding: `binding:${hash(`direct\0${key}`)}`, verifiedAt: '2026-10-14T00:00:00Z' };
  delete allowed.nativeId;
  fs.writeFileSync(path.join(stateDir, 'chat-policy.json'), JSON.stringify({ allowlist: [allowed] }));
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('https://www.douyin.com/video/12345');
  await page.setContent('<section data-e2e="feed-active-video"><div data-e2e="video-player-share" style="width:60px;height:40px">分享</div></section><div data-e2e="video-player-share">非当前作品分享</div><div class="lC5eOSqy" style="display:none;position:fixed;left:100px;top:100px;width:300px;height:230px;z-index:20;background:white"><h3 class="S874re0p">分享给朋友</h3><div class="VzoNDwLw"><div class="row-wrapper"><div class="otFjqQEX"><span class="EnYt_IKl">改过的合成昵称</span><div class="xu0OjnsQ" style="width:70px;height:32px">分享</div></div></div></div></div>');
  await page.evaluate(({ secUid, uid }) => {
    const video = document.createElement('video'); video.style.cssText = 'position:fixed;left:700px;top:10px;width:80px;height:50px'; document.querySelector('[data-e2e="feed-active-video"]').append(video); Object.defineProperty(video, 'readyState', { value: 4 });
    window.sent = 0; window.opened = 0; window.hiddenDataReads = 0;
    const row = document.querySelector('.otFjqQEX'), user = { type: 1, uid, sec_uid: secUid };
    Object.defineProperty(user, 'infoDict', { get() { window.hiddenDataReads++; throw new Error('禁止读取未展示资料'); } });
    row.parentElement.__reactProps$fixture = { children: { props: { user } } };
    row.__reactProps$fixture = { children: [{ props: {} }, { props: { children: [{ props: { children: [{ props: {} }, { props: { uid, isGroup: false } }] } }] } }, { props: { 'data-userid': uid } }] };
    const send = row.querySelector('.xu0OjnsQ'); send.dataset.userid = uid;
    send.addEventListener('click', event => { if (event.isTrusted) window.sent++; });
    document.querySelector('[data-e2e="feed-active-video"] [data-e2e="video-player-share"]').addEventListener('click', () => { window.opened++; document.querySelector('.lC5eOSqy').style.display = 'block'; });
  }, { secUid, uid });
  const realEvaluate = page.evaluate.bind(page);
  page.evaluate = (fn, arg) => fn === readPageState ? Promise.resolve({ video: { id: '12345', url: 'https://www.douyin.com/video/12345', readyState: 4 } }) : realEvaluate(fn, arg);
  const chatBrowser = { contacts: new Map([[allowed.id, allowed]]), listContacts: async () => ({ contacts: [allowed] }), readConversation: async () => ({ conversation: { id: allowed.id }, messages: await realEvaluate(() => window.sent) ? [card] : [] }) };
  const forwarder = new VideoForwarder({ controller: { source: 'api', withPage: fn => fn(page), pauseForLimits: async () => {} }, chatBrowser, videoLimits: { beforeAction: () => ({ allowed: true }) }, stateDir });
  return { page, forwarder, allowed, secUid, uid, cleanup: async () => { await page.close(); const target = path.resolve(stateDir); assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(target, { recursive: true, force: true }); } };
}

test('当前真实分享UI结构按固定user稳定ID绑定发送目标，打开面板后只发送一次卡片', async () => {
  const f = await currentPanelFixture();
  try {
    const result = await f.forwarder.forward({ recipientId: f.allowed.id, expectedVideoId: '12345' }, { humanAuthorized: true });
    assert.equal(result.confirmed, true); assert.equal(result.deliveryUncertain, false);
    assert.deepEqual(await f.page.evaluate(() => ({ sent: window.sent, opened: window.opened, hiddenDataReads: window.hiddenDataReads })), { sent: 1, opened: 1, hiddenDataReads: 0 });
    assert.equal(f.forwarder.receipts().operations[0].status, 'confirmed');
  } finally { await f.cleanup(); }
});

test('当前分享行不同secUID、按钮uid冲突、类型冲突和缺少固定身份均拒绝且记录具体阶段', async () => {
  for (const mutation of ['secUid', 'buttonUid', 'type', 'missing', 'getter']) {
    const f = await currentPanelFixture();
    try {
      await f.page.evaluate(mutation => {
        const row = document.querySelector('.otFjqQEX'), user = row.parentElement.__reactProps$fixture.children.props.user;
        if (mutation === 'secUid') user.sec_uid = 'MS4SyntheticDifferentAccount';
        if (mutation === 'buttonUid') row.querySelector('.xu0OjnsQ').dataset.userid = '9999999999999999';
        if (mutation === 'type') row.setAttribute('data-conversation-type', 'group');
        if (mutation === 'missing') delete user.sec_uid;
        if (mutation === 'getter') Object.defineProperty(user, 'sec_uid', { get() { throw new Error('不允许执行身份getter'); } });
      }, mutation);
      await assert.rejects(f.forwarder.forward({ recipientId: f.allowed.id }, { humanAuthorized: true }), /稳定身份|目标标识/, mutation);
      assert.equal(await f.page.evaluate(() => window.sent), 0, mutation);
      const receipt = f.forwarder.receipts().operations[0]; assert.equal(receipt.status, 'not-sent'); assert.equal(receipt.sendClicks, 0);
      assert.equal(receipt.failure.code, 'FORWARD_RECIPIENT_IDENTITY_MISMATCH'); assert.equal(receipt.failure.stage, 'recipient');
      assert.equal(await f.page.evaluate(() => window.hiddenDataReads), 0);
    } finally { await f.cleanup(); }
  }
});

test('真实pointerdown后同DOM行改成其他稳定账号、换作品或出现验证码，最终click被同步门禁拦截', async () => {
  for (const mode of ['native-account', 'native-button-uid', 'rendered-account', 'video', 'captcha']) {
    const f = mode.startsWith('native-') ? await fixture() : await currentPanelFixture(), id = f.allowed?.id || recipientId;
    try {
      await f.page.evaluate(mode => {
        const row = document.querySelector('.otFjqQEX'), send = row.querySelector('.xu0OjnsQ');
        send.addEventListener('pointerdown', () => {
          if (mode === 'native-account') row.setAttribute('data-conversation-id', 'changed-account-during-pointerdown');
          if (mode === 'native-button-uid') send.dataset.userid = '7777777777777777';
          if (mode === 'rendered-account') {
            const user = row.parentElement.__reactProps$fixture.children.props.user; user.sec_uid = 'MS4SyntheticOtherDuringPointerdown'; user.uid = '7777777777777777'; send.dataset.userid = user.uid;
            row.__reactProps$fixture.children[1].props.children[0].props.children[1].props.uid = user.uid;
          }
          if (mode === 'video') document.querySelector('[data-e2e="feed-active-video"]').className = 'video_99999';
          if (mode === 'captcha') { const captcha = document.createElement('div'); captcha.id = 'captcha_container'; captcha.style.cssText = 'position:fixed;left:800px;top:20px;width:80px;height:50px'; document.body.append(captcha); }
        }, { once: true });
      }, mode);
      const result = await f.forwarder.forward({ recipientId: id, expectedVideoId: '12345' }, { humanAuthorized: true });
      assert.equal(result.confirmed, false, mode); assert.equal(result.deliveryUncertain, true, mode); assert.equal(result.failure.code, 'FORWARD_INPUT_IDENTITY_CHANGED', mode); assert.equal(result.failure.stage, 'dispatch', mode);
      assert.equal(await f.page.evaluate(() => window.sent), 0, mode); assert.equal(f.forwarder.receipts().operations.at(-1).status, 'uncertain', mode);
    } finally { await f.cleanup(); }
  }
});

test('native行不能用row的稳定编号替代无法映射的显式按钮uid', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => { document.querySelector('.xu0OjnsQ').dataset.userid = '7777777777777777'; });
    await assert.rejects(f.forwarder.forward({ recipientId }, { humanAuthorized: true }), /稳定身份|目标标识/); assert.equal(await f.page.evaluate(() => window.sent), 0);
  } finally { await f.cleanup(); }
});

test('最终事件只改变昵称仍按同一稳定账号发送，不把外观变化扩大成身份条件', async () => {
  const f = await currentPanelFixture();
  try {
    await f.page.evaluate(() => document.querySelector('.xu0OjnsQ').addEventListener('pointerdown', () => { document.querySelector('.EnYt_IKl').textContent = '点击前换了一个合成昵称'; }, { once: true }));
    const result = await f.forwarder.forward({ recipientId: f.allowed.id }, { humanAuthorized: true }); assert.equal(result.confirmed, true); assert.equal(await f.page.evaluate(() => window.sent), 1);
  } finally { await f.cleanup(); }
});

test('超过50个完整稳定许可仍可选择，重复或不完整许可名单不放行', async () => {
  const f = await fixture();
  try {
    const many = [contact, ...Array.from({ length: 60 }, (_, index) => ({ ...contact, ...stable(`合成其他账号${index}`) }))].map(item => ({ ...item, verifiedAt: '2026-10-14T00:00:00Z' }));
    fs.writeFileSync(f.forwarder.policyFile, JSON.stringify({ allowlist: many }));
    assert.equal(f.forwarder.policyContact(recipientId).id, recipientId);
    fs.writeFileSync(f.forwarder.policyFile, JSON.stringify({ allowlist: [...many, many[0]] })); assert.throws(() => f.forwarder.policyContact(recipientId), /名单/);
    delete many[1].identityHash; fs.writeFileSync(f.forwarder.policyFile, JSON.stringify({ allowlist: many })); assert.throws(() => f.forwarder.policyContact(recipientId), /名单/);
  } finally { await f.cleanup(); }
});

test('分享失败诊断保留阶段原因并隐藏凭据、平台原标识和本地路径', () => {
  const failure = safeForwardFailure({ code: 'FORWARD_SYNTHETIC_FAILURE', stage: 'recipient', message: `合成原因 token=private-token Cookie=private-cookie Bearer private-bearer sk-private-key https://example.invalid/private C:\\private\\key.txt MS4PrivateAccount ${'a'.repeat(64)} 1234567890123456\n后续内容不保留` });
  assert.equal(failure.code, 'FORWARD_SYNTHETIC_FAILURE'); assert.equal(failure.stage, 'recipient'); assert.match(failure.message, /合成原因/);
  for (const secret of ['private-token', 'private-cookie', 'private-bearer', 'sk-private-key', 'example.invalid', 'key.txt', 'MS4PrivateAccount', 'a'.repeat(64), '1234567890123456', '后续内容']) assert.equal(failure.message.includes(secret), false, secret);
});
