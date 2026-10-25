import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '../playwright-runtime.mjs';
import { ChatBrowser, MessageIdentityTracker, readContactDom, readConversationDom, readChatIdentityDom, readFollowingDom } from '../chat-browser.mjs';
import { messageFingerprint } from '../chat-message.mjs';

let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });

async function virtualContactFixture() {
  const f = await fixture();
  await f.page.evaluate(() => {
    const dialog = document.querySelector('[data-e2e="im-dialog"]');
    for (const row of dialog.querySelectorAll('[data-e2e="conversation-item"]')) row.remove();
    const viewport = document.createElement('div'); viewport.setAttribute('data-e2e', 'conversation-list'); viewport.style.cssText = 'height:140px;width:260px;overflow-y:auto;position:relative';
    const content = document.createElement('div'); content.style.position = 'relative'; viewport.append(content); dialog.prepend(viewport);
    const rows = Array.from({ length: 12 }, (_, index) => ({ id: `synthetic-window-${index}`, name: index === 8 ? '合成屏外群聊' : index === 11 ? '名字像群的未知会话' : `合成虚拟好友${index}`, type: index === 8 ? 'group' : index === 11 ? null : 'direct', avatar: `https://fixture.local/window-avatar-${index}.png` }));
    window.syntheticSelections = []; window.syntheticPreviewReads = 0; window.syntheticContacts = rows;
    window.renderSyntheticContactList = () => {
      content.style.height = `${rows.length * 70}px`; content.replaceChildren();
      const first = Math.floor(viewport.scrollTop / 70);
      for (const [offset, data] of rows.slice(first, first + 3).entries()) {
        const row = document.createElement('div'); row.setAttribute('data-e2e', 'conversation-item'); row.setAttribute('data-conversation-id', data.id); if (data.type) row.setAttribute('data-conversation-type', data.type); row.style.cssText = `position:absolute;left:0;right:0;top:${(first + offset) * 70}px;height:70px`;
        const avatar = document.createElement('img'); avatar.src = data.avatar; avatar.width = 20; avatar.height = 20;
        const name = document.createElement('div'); name.className = 'conversationConversationItemtitle'; name.textContent = data.name;
        const preview = document.createElement('pre'); preview.className = 'synthetic-private-preview'; Object.defineProperty(preview, 'textContent', { get() { window.syntheticPreviewReads++; throw new Error('不能读取列表中的其他私信预览'); } });
        row.append(avatar, name, preview); row.addEventListener('click', () => { window.syntheticSelections.push(data.id); const header = document.querySelector('.StackLayoutStackChatHeaderuser'); header.setAttribute('data-conversation-id', data.id); header.setAttribute('data-conversation-type', data.type || 'unknown'); header.querySelector('.StackLayoutStackChatHeadertitle').textContent = data.name; header.querySelector('img').src = data.avatar; });
        content.append(row);
      }
    };
    viewport.addEventListener('scroll', window.renderSyntheticContactList); window.renderSyntheticContactList();
  });
  f.chat.following = []; f.chat.relationshipDiscovery = { status: 'unavailable', code: 'FOLLOWING_LIST_UNAVAILABLE' };
  return f;
}

async function fixture() {
  const page = await browser.newPage();
  await page.setContent(`<div data-e2e="im-dialog">
    <div data-e2e="conversation-item" data-conversation-id="test-a" data-conversation-type="direct"><img src="https://fixture.local/avatar-a.png"><div class="conversationConversationItemtitle">测试甲</div><div class="unread-count">1</div><pre id="private-preview">不应读取的其他预览</pre></div>
    <div data-e2e="conversation-item" data-conversation-id="test-b" data-conversation-type="direct"><img src="https://fixture.local/avatar-b.png"><div class="conversationConversationItemtitle">测试乙</div></div>
    <div class="StackLayoutpagespageRoot" data-e2e="chat-page"><div class="StackLayoutStackChatHeaderuser" data-conversation-id="test-a" data-conversation-type="direct"><img src="https://fixture.local/avatar-a.png"><div class="StackLayoutStackChatHeadertitle">测试甲</div></div>
      <div id="message-list"><div class="MessageBoxTimetimeLayout">2026-10-14 12:00</div><div data-index="0"><div class="messageMessageBoxmessageBox"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">合成消息</div></div></div></div></div>
      <div data-e2e="msg-input"><div contenteditable="true" style="min-width:80px;min-height:30px"></div><button class="e2e-send-msg-btn">发送</button></div>
    </div></div>`);
  await page.evaluate(() => {
    window.sent = 0; window.previewReads = 0;
    Object.defineProperty(document.getElementById('private-preview'), 'textContent', { get() { window.previewReads += 1; throw new Error('禁止读取预览'); } });
    for (const row of document.querySelectorAll('[data-e2e="conversation-item"]')) row.addEventListener('click', () => {
      document.querySelector('.StackLayoutStackChatHeaderuser').setAttribute('data-conversation-id', row.getAttribute('data-conversation-id') || '');
      document.querySelector('.StackLayoutStackChatHeaderuser').setAttribute('data-conversation-type', row.getAttribute('data-conversation-type') || 'unknown');
      document.querySelector('.StackLayoutStackChatHeadertitle').textContent = row.querySelector('.conversationConversationItemtitle').textContent;
      document.querySelector('.StackLayoutStackChatHeaderuser img').src = row.querySelector('img').src;
    });
    document.querySelector('.e2e-send-msg-btn').addEventListener('click', () => {
      window.sent += 1;
      const text = document.querySelector('[contenteditable]').innerText;
      const row = document.createElement('div'); row.setAttribute('data-index', String(document.querySelectorAll('[data-e2e="msg-item-content"]').length));
      const box = document.createElement('div'); box.className = 'messageMessageBoxmessageBox messageMessageBoxisFromMe';
      const content = document.createElement('div'); content.setAttribute('data-e2e', 'msg-item-content');
      const body = document.createElement('div'); body.className = 'MessageItemTextcontainer'; body.textContent = text;
      content.append(body); box.append(content); row.append(box); document.getElementById('message-list').append(row);
      document.querySelector('[contenteditable]').textContent = '';
    });
  });
  const controller = { withPage: async (callback, { signal } = {}) => { signal?.throwIfAborted(); return callback(page); }, close: async () => page.close() };
  const chat = new ChatBrowser({ controller });
  chat.following = [{ displayName: '测试甲', mutual: true }, { displayName: '测试乙', mutual: true }];
  return { page, chat };
}

async function peerIdentityFixture() {
  const f = await fixture(), html = await f.page.locator('body').innerHTML();
  await f.page.route('https://www.douyin.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await f.page.goto('https://www.douyin.com/');
  await f.page.evaluate(() => {
    window.identityGetterReads = 0; window.identityBodyReads = 0; window.identityClicks = 0;
    const header = document.querySelector('.StackLayoutStackChatHeaderuser'); header.removeAttribute('data-conversation-id');
    const peer = { _toParticipantSecUserId: 'synthetic-stable-peer-0' };
    for (const key of ['toParticipantSecUserId', 'myLastVisibleMessage', 'myLastMessage']) Object.defineProperty(peer, key, { get() { window.identityGetterReads++; throw new Error('不应读取 getter 或消息对象'); } });
    Object.defineProperty(header, '__reactProps$stableHeader', { value: { children: [{ props: { conversation: peer } }] }, configurable: true });
    for (const [index, row] of [...document.querySelectorAll('[data-e2e="conversation-item"]')].entries()) {
      row.removeAttribute('data-conversation-id');
      const conversation = { _toParticipantSecUserId: `synthetic-stable-peer-${index}` };
      Object.defineProperty(row, '__reactProps$stableRow', { value: { children: [{ props: { conversation } }] }, configurable: true });
      row.addEventListener('click', () => { window.identityClicks++; if (!window.keepWrongHeaderPeer) peer._toParticipantSecUserId = conversation._toParticipantSecUserId; header.querySelector('.StackLayoutStackChatHeadertitle').textContent = row.querySelector('.conversationConversationItemtitle').textContent; header.querySelector('img').src = row.querySelector('img').src; });
    }
    const root = document.querySelector('[data-e2e="chat-page"]'), query = root.querySelectorAll.bind(root);
    root.querySelectorAll = selector => { if (selector.includes('msg-item-content')) window.identityBodyReads++; return query(selector); };
  });
  f.chat.following = []; f.chat.relationshipDiscovery = { status: 'unavailable' };
  return f;
}

test('实际头部固定props的peer身份与行双向核对，改名换头像不误停且不执行getter', async () => {
  const { page, chat } = await peerIdentityFixture();
  try {
    const contact = (await chat.listContacts({ verifyFollowing: false })).contacts[0];
    assert.equal(contact.identityVersion, 2); assert.equal(contact.identityKind, 'rendered-user'); assert.equal(contact.identityHash, contact.id.slice(5));
    const header = await page.evaluate(readChatIdentityDom), row = (await page.evaluate(readContactDom))[0]; assert.equal(header.identityKey, row.identityKey);
    await page.evaluate(() => { const header = document.querySelector('.StackLayoutStackChatHeaderuser'), row = document.querySelector('[data-e2e="conversation-item"]'); header.querySelector('.StackLayoutStackChatHeadertitle').textContent = row.querySelector('.conversationConversationItemtitle').textContent = '合成新昵称'; header.querySelector('img').src = row.querySelector('img').src = 'https://fixture.local/new-avatar.png'; });
    const updated = (await chat.listContacts({ verifyFollowing: false })).contacts[0]; assert.equal(updated.id, contact.id); assert.equal(updated.identityBinding, contact.identityBinding);
    const result = await chat.readConversation(contact.id, { allowed: true }); assert.equal(result.contact.name, '合成新昵称'); assert.equal(result.messages.length, 1);
    assert.equal(await page.evaluate(() => window.identityGetterReads), 0); assert.equal(JSON.stringify([contact, header]).includes('synthetic-stable-peer'), false);
  } finally { await chat.close(); }
});

test('同名同头像但头部peer不同不得读取正文，缺失稳定头部身份同样拒绝', async () => {
  const { page, chat } = await peerIdentityFixture();
  try {
    const contact = (await chat.listContacts({ verifyFollowing: false })).contacts[0];
    await page.evaluate(() => { window.keepWrongHeaderPeer = true; document.querySelector('.StackLayoutStackChatHeaderuser')['__reactProps$stableHeader'].children[0].props.conversation._toParticipantSecUserId = 'synthetic-other-peer'; });
    await assert.rejects(chat.readConversation(contact.id, { allowed: true }), /稳定身份.*不一致/);
    assert.equal(await page.evaluate(() => window.identityBodyReads), 0);
    await page.evaluate(() => { delete document.querySelector('.StackLayoutStackChatHeaderuser')['__reactProps$stableHeader']; });
    const raw = await page.evaluate(readConversationDom); assert.equal(raw.identityUnavailable, true); assert.deepEqual(raw.messages, []); assert.equal(await page.evaluate(() => window.identityBodyReads), 0);
  } finally { await chat.close(); }
});

test('异步核对peer期间会话类型变化即丢弃身份，不读取变化后正文', async () => {
  const { page, chat } = await peerIdentityFixture();
  try {
    await page.evaluate(() => { const digest = crypto.subtle.digest.bind(crypto.subtle); crypto.subtle.digest = (...args) => { document.querySelector('.StackLayoutStackChatHeaderuser').setAttribute('data-conversation-type', 'group'); return digest(...args); }; });
    const raw = await page.evaluate(readConversationDom); assert.equal(raw.identityConflict, true); assert.equal(raw.identityUnavailable, true); assert.deepEqual(raw.messages, []); assert.equal(await page.evaluate(() => window.identityBodyReads), 0);
  } finally { await chat.close(); }
});

test('会话切换短暂双头部和位移动画只等待稳定metadata，不读取其他正文', async () => {
  const { page, chat } = await fixture();
  try {
    const contact = (await chat.listContacts()).contacts[1];
    await page.evaluate(() => {
      window.transientBodyReads = 0;
      const root = document.querySelector('[data-e2e="chat-page"]'), query = root.querySelectorAll.bind(root); root.querySelectorAll = selector => { if (selector.includes('msg-item-content')) window.transientBodyReads++; return query(selector); };
      document.querySelectorAll('[data-e2e="conversation-item"]')[1].addEventListener('click', () => {
        const header = document.querySelector('.StackLayoutStackChatHeaderuser'), clone = header.cloneNode(true); root.append(clone);
        header.style.position = 'relative'; header.style.left = '120px';
        setTimeout(() => clone.remove(), 350); setTimeout(() => header.style.left = '60px', 500); setTimeout(() => header.style.left = '0px', 650);
      });
    });
    const started = Date.now(), selected = await chat.select(page, contact.id); assert.equal(selected.contact.id, contact.id); assert.ok(Date.now() - started >= 650);
    assert.equal(await page.evaluate(() => window.transientBodyReads), 0); assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('可见无文字captcha也阻止选会话，隐藏容器不冒充验证', async () => {
  const { page, chat } = await fixture();
  try {
    const contact = (await chat.listContacts()).contacts[1];
    await page.evaluate(() => { window.captchaClicks = 0; for (const row of document.querySelectorAll('[data-e2e="conversation-item"]')) row.addEventListener('click', () => window.captchaClicks++); const captcha = document.createElement('div'); captcha.id = 'captcha_container'; captcha.style.cssText = 'position:fixed;inset:0;z-index:100000;background:white'; document.body.append(captcha); });
    const result = await chat.select(page, contact.id); assert.equal(result.flags.verificationRequired, true); assert.equal(result.flags.blocked, true); assert.equal(await page.evaluate(() => window.captchaClicks), 0);
    await page.locator('#captcha_container').evaluate(element => element.style.display = 'none');
    assert.equal((await chat.select(page, contact.id)).contact.id, contact.id);
  } finally { await chat.close(); }
});

test('会话列表不读取预览，昵称、关系和不透明 ID 正确', async () => {
  const { page, chat } = await fixture();
  try {
    const list = await chat.listContacts();
    assert.equal(list.contacts.length, 2);
    assert.equal(list.contacts[0].followed, true);
    assert.equal(list.contacts[0].isGroup, false);
    assert.match(list.contacts[0].id, /^conv:[a-f0-9]{64}$/);
    assert.equal(list.contacts[0].lastMessagePreview, undefined);
    assert.equal(JSON.stringify(list).includes('test-a'), false);
    assert.equal(await page.evaluate(() => window.previewReads), 0);
    assert.equal((await page.evaluate(readContactDom)).length, 2);
  } finally { await chat.close(); }
});

test('联系人枚举遍历虚拟列表取得屏外群聊，恢复原滚动位置且不读取预览', async () => {
  const { page, chat } = await virtualContactFixture();
  try {
    const list = await chat.listContacts({ verifyFollowing: false });
    assert.equal(list.contacts.length, 12); assert.equal(list.listDiscovery.scannedToEnd, true);
    assert.equal(list.listDiscovery.source, 'current-conversation-list'); assert.match(list.listDiscovery.note, /不代表全部关注好友或所有群聊/);
    const group = list.contacts.find(item => item.name === '合成屏外群聊'); assert.equal(group.isGroup, true); assert.equal(group.identityVerified, true); assert.match(group.identityBinding, /^binding:[a-f0-9]{64}$/);
    assert.equal(list.contacts.find(item => item.name === '名字像群的未知会话').isGroup, null);
    assert.equal(await page.locator('[data-e2e="conversation-list"]').evaluate(element => element.scrollTop), 0);
    assert.equal(await page.evaluate(() => window.syntheticPreviewReads), 0); assert.deepEqual(await page.evaluate(() => window.syntheticSelections), []);
    const selection = await chat.controller.withPage(page => chat.select(page, group.id));
    assert.equal(selection.contact.isGroup, true); assert.deepEqual(await page.evaluate(() => window.syntheticSelections), ['synthetic-window-8']);
    assert.equal(await page.evaluate(() => window.syntheticPreviewReads), 0); assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('枚举等待列表自身加载并合并新增窗口，不把当前两位当成完整好友名单', async () => {
  const { page, chat } = await virtualContactFixture();
  try {
    await page.evaluate(() => {
      const viewport = document.querySelector('[data-e2e="conversation-list"]'); window.syntheticContacts.splice(2); window.renderSyntheticContactList();
      const loading = document.createElement('div'); loading.setAttribute('data-e2e', 'conversation-loading'); loading.style.cssText = 'position:absolute;top:0;left:0;width:20px;height:20px'; viewport.append(loading);
      setTimeout(() => { window.syntheticContacts.push({ id: 'synthetic-late-group', name: '合成延迟加载群聊', type: 'group', avatar: 'https://fixture.local/late-group.png' }); loading.remove(); window.renderSyntheticContactList(); }, 400);
    });
    const list = await chat.listContacts({ verifyFollowing: false });
    assert.equal(list.contacts.length, 3); assert.equal(list.contacts.some(item => item.name === '合成延迟加载群聊' && item.isGroup), true); assert.equal(list.listDiscovery.scannedToEnd, true);
    assert.equal(await page.evaluate(() => window.syntheticPreviewReads), 0);
  } finally { await chat.close(); }
});

test('关注面板缺失时返回已有会话和明确的未确认关系，不伪造已关注', async () => {
  const { page, chat } = await fixture();
  try {
    const html = await page.locator('body').innerHTML();
    let followClicks = 0;
    await page.exposeFunction('countSyntheticFollow', () => { followClicks += 1; });
    await page.route('https://www.douyin.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><body><a href="https://www.douyin.com/user/synthetic-self"><span>我的</span></a><button data-e2e="user-info-follow" onclick="window.countSyntheticFollow()">关注 31</button>${html}</body></html>` }));
    chat.following = null;
    const result = await chat.listContacts();
    assert.equal(result.relationshipDiscovery.status, 'unavailable');
    assert.equal(result.relationshipDiscovery.code, 'FOLLOWING_LIST_UNAVAILABLE');
    assert.equal(followClicks, 2);
    assert.equal(result.contacts.length, 2);
    const contact = result.contacts[0];
    assert.equal(contact.followed, null); assert.equal(contact.relationshipStatus, 'unavailable');
    assert.equal(contact.identityVerified, true); assert.equal(contact.isGroup, false);
    assert.match(contact.identityBinding, /^binding:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(result).includes('test-a'), false);
    const previous = contact.identityBinding;
    await page.locator('[data-e2e="conversation-item"] img').first().evaluate(image => { image.src = 'https://fixture.local/changed-avatar.png'; });
    const updated = await chat.listContacts({ verifyFollowing: false });
    assert.equal(updated.contacts[0].identityBinding, previous);
  } finally { await chat.close(); }
});

test('新版关注列表的明确关系标签可读取，推荐用户区域不充当关注证据', async () => {
  const { page, chat } = await fixture();
  try {
    await page.locator('body').evaluate(body => { body.insertAdjacentHTML('beforeend', '<aside><a href="/user/recommended">不能采用的推荐人</a></aside><div data-e2e="following-list"><div data-e2e="follow-user-item"><a data-e2e="user-name" href="/user/synthetic">测试甲</a><span data-e2e="follow-status">互相关注</span></div></div>'); });
    assert.deepEqual(await page.evaluate(readFollowingDom), [{ displayName: '测试甲', mutual: true }]);
  } finally { await chat.close(); }
});

test('关注入口被覆盖层遮挡时返回待本人授权的现有会话，不强制点击或中断名单', async () => {
  const { page, chat } = await fixture();
  try {
    const html = await page.locator('body').innerHTML(); let clicks = 0;
    await page.exposeFunction('recordBlockedFollowClick', () => { clicks += 1; });
    await page.route('https://www.douyin.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<a href="https://www.douyin.com/user/synthetic-self"><span>我的</span></a><button data-e2e="user-info-follow" onclick="window.recordBlockedFollowClick()">关注</button>${html}<div style="position:fixed;inset:0;z-index:999999;background:transparent"></div>` }));
    chat.following = null;
    const list = await chat.listContacts({ verifyFollowing: true });
    assert.equal(list.relationshipDiscovery.status, 'unavailable'); assert.equal(list.relationshipDiscovery.code, 'FOLLOWING_LIST_UNAVAILABLE');
    assert.equal(list.contacts.length, 2); assert.equal(list.contacts.every(contact => contact.followed === null && contact.identityVerified), true);
    assert.equal(clicks, 0); assert.match(page.url(), /^https:\/\/www\.douyin\.com\/\?recommend/);
  } finally { await chat.close(); }
});

test('已渲染行的三层会话身份可哈希绑定，getter和消息预览始终不读取', async () => {
  const { page, chat } = await fixture();
  try {
    const html = await page.locator('body').innerHTML();
    await page.route('https://www.douyin.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
    await page.goto('https://www.douyin.com/');
    chat.following = []; chat.relationshipDiscovery = { status: 'unavailable', code: 'FOLLOWING_LIST_UNAVAILABLE' };
    await page.evaluate(() => {
      window.forbiddenMetadataReads = 0;
      for (const [index, row] of [...document.querySelectorAll('[data-e2e="conversation-item"]')].entries()) {
        row.removeAttribute('data-conversation-id');
        const conversation = { _toParticipantSecUserId: `synthetic-participant-${index}` };
        for (const key of ['toParticipantSecUserId', 'myLastMessage', 'myLastVisibleMessage']) Object.defineProperty(conversation, key, { get() { window.forbiddenMetadataReads += 1; throw new Error('禁止执行 getter'); } });
        const children = { props: { children: { props: { children: { props: { conversation } } } } } };
        Object.defineProperty(row, '__reactProps$synthetic', { configurable: true, value: { children } });
      }
    });
    const contacts = (await chat.listContacts({ verifyFollowing: false })).contacts;
    assert.equal(contacts.length, 2); assert.equal(contacts.every(contact => contact.identityVerified && contact.identitySource === 'rendered-row-metadata'), true);
    assert.equal(contacts[0].followed, null); assert.equal(contacts[0].relationshipStatus, 'unavailable');
    assert.notEqual(contacts[0].id, contacts[1].id); assert.notEqual(contacts[0].identityBinding, contacts[1].identityBinding);
    const raw = await page.evaluate(readContactDom);
    assert.match(raw[0].identityKey, /^user:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify([contacts, raw]).includes('synthetic-participant'), false);
    assert.equal(await page.evaluate(() => window.forbiddenMetadataReads), 0);
    await page.locator('[data-e2e="conversation-item"]').first().evaluate(row => { const props = row['__reactProps$synthetic']; props.children.props.children.props.children.props.conversation._toParticipantSecUserId = 'changed-synthetic-participant'; });
    const changed = (await chat.listContacts({ verifyFollowing: false })).contacts[0];
    assert.notEqual(changed.id, contacts[0].id); assert.notEqual(changed.identityBinding, contacts[0].identityBinding);
  } finally { await chat.close(); }
});

test('行身份冲突、四层以外数据和群聊的个人ID不能获得稳定授权', async () => {
  const { page, chat } = await fixture();
  try {
    const html = await page.locator('body').innerHTML();
    await page.route('https://www.douyin.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html })); await page.goto('https://www.douyin.com/');
    chat.following = []; chat.relationshipDiscovery = { status: 'unavailable', code: 'FOLLOWING_LIST_UNAVAILABLE' };
    await page.evaluate(() => {
      const [first, second] = document.querySelectorAll('[data-e2e="conversation-item"]');
      first.removeAttribute('data-conversation-id'); second.removeAttribute('data-conversation-id');
      Object.defineProperty(first, '__reactProps$synthetic', { value: { children: [{ props: { conversation: { id: 'conflict-a' } } }, { props: { conversation: { id: 'conflict-b' } } }] } });
      Object.defineProperty(second, '__reactProps$synthetic', { configurable: true, value: { children: { props: { children: { props: { children: { props: { children: { props: { conversation: { id: 'outside-depth-bound' } } } } } } } } } } });
    });
    let contacts = (await chat.listContacts({ verifyFollowing: false })).contacts;
    assert.equal(contacts.every(contact => !contact.identityVerified), true);
    await page.locator('[data-e2e="conversation-item"]').last().evaluate(row => { row.setAttribute('data-conversation-type', 'group'); Object.defineProperty(row, '__reactProps$synthetic', { value: { conversation: { secUid: 'personal-user-is-not-a-group' } } }); });
    contacts = (await chat.listContacts({ verifyFollowing: false })).contacts;
    assert.equal(contacts[1].isGroup, true); assert.equal(contacts[1].identityVerified, false);
  } finally { await chat.close(); }
});

test('稳定会话允许重名，明确群聊标记与个人类型分开返回', async () => {
  const { page, chat } = await fixture();
  try {
    chat.following = []; chat.relationshipDiscovery = { status: 'unavailable', code: 'FOLLOWING_LIST_UNAVAILABLE' };
    await page.locator('[data-e2e="conversation-item"]').last().evaluate(row => { row.querySelector('.conversationConversationItemtitle').textContent = '测试甲'; });
    const result = await chat.listContacts();
    assert.equal(result.contacts.every(row => row.identityVerified === true && row.identityVersion === 2), true);
    assert.notEqual(result.contacts[0].identityBinding, result.contacts[1].identityBinding);
    await page.locator('[data-e2e="conversation-item"]').last().evaluate(row => { row.querySelector('.conversationConversationItemtitle').textContent = '测试乙'; row.setAttribute('data-conversation-type', 'group'); });
    const group = (await chat.listContacts()).contacts[1];
    assert.equal(group.identityVerified, true); assert.equal(group.isGroup, true); assert.equal(group.conversationType, 'group');
  } finally { await chat.close(); }
});

test('DOM通知只在许可行未读增加时唤醒，切换、输入、正文变化和同数重挂载不自激', async () => {
  const { page, chat } = await fixture();
  try {
    const events = [], abort = new AbortController();
    const { contacts } = await chat.listContacts();
    const cleanup = await chat.subscribeIncoming(event => events.push(event), { recipientIds: [contacts[0].id], signal: abort.signal });
    await page.waitForTimeout(250); assert.equal(events.length, 0);
    await page.locator('body').evaluate(body => body.insertAdjacentHTML('beforeend', '<div id="outside-notification">外部区域变化</div>'));
    await page.waitForTimeout(250); assert.equal(events.length, 0);
    await page.locator('#message-list').evaluate(list => { list.insertAdjacentHTML('beforeend', '<div data-message-id="synthetic-wake">不应出现在通知里的正文</div>'); });
    await page.locator('[data-e2e="conversation-item"]').first().evaluate(row => row.classList.add('selected'));
    await page.locator('[contenteditable]').fill('不应触发唤醒的本机输入');
    await page.waitForTimeout(300); assert.equal(events.length, 0);
    await page.locator('[data-e2e="conversation-item"]').last().evaluate(row => row.insertAdjacentHTML('beforeend', '<div data-e2e="unread-count">9</div>'));
    await page.waitForTimeout(300); assert.equal(events.length, 0);
    await page.locator('[data-e2e="conversation-item"] .unread-count').evaluate(badge => badge.textContent = '2');
    await page.waitForTimeout(300); assert.deepEqual(events, [{ type: 'wake', recipientId: contacts[0].id }]);
    await page.locator('[data-e2e="conversation-item"]').first().evaluate(row => row.replaceWith(row.cloneNode(true)));
    await page.waitForTimeout(300); assert.equal(events.length, 1);
    await chat.listContacts({ verifyFollowing: false });
    await page.waitForTimeout(300); assert.equal(events.length, 1);
    await page.locator('[data-e2e="conversation-item"] .unread-count').evaluate(badge => badge.remove());
    await page.waitForTimeout(300); assert.equal(events.length, 1);
    await page.locator('[data-e2e="conversation-item"]').first().evaluate(row => row.insertAdjacentHTML('beforeend', '<div data-e2e="unread-count">1</div>'));
    await page.waitForTimeout(300); assert.deepEqual(events, [{ type: 'wake', recipientId: contacts[0].id }, { type: 'wake', recipientId: contacts[0].id }]);
    assert.equal(await page.evaluate(() => window.previewReads), 0); assert.equal(await page.evaluate(() => window.sent), 0);
    abort.abort(); await cleanup();
    await page.locator('#message-list').evaluate(list => { list.insertAdjacentHTML('beforeend', '<div>取消之后的变化</div>'); });
    await page.waitForTimeout(300); assert.equal(events.length, 2);
    assert.equal(await page.evaluate(() => Object.keys(window.__deepseekIncomingObservers || {}).length), 0);
  } finally { await chat.close(); }
});

test('群聊用明确类型和稳定会话ID核对，类型变化不能沿用旧绑定', async () => {
  const { page, chat } = await fixture();
  try {
    chat.following = []; chat.relationshipDiscovery = { status: 'unavailable' };
    await page.locator('[data-e2e="conversation-item"]').first().evaluate(row => { row.setAttribute('data-is-group', 'true'); row.setAttribute('data-conversation-type', 'group'); row.querySelector('img').outerHTML = '<div data-e2e="group-avatar"><img src="https://fixture.local/avatar-a.png"></div>'; });
    const group = (await chat.listContacts()).contacts[0];
    assert.equal(group.isGroup, true); assert.equal(group.conversationType, 'group'); assert.equal(group.identityVerified, true);
    assert.equal(group.followed, null); assert.equal(group.relationshipStatus, 'unavailable');
    await page.locator('[data-e2e="conversation-item"]').first().evaluate(row => { row.removeAttribute('data-is-group'); row.setAttribute('data-conversation-type', 'direct'); row.querySelector('[data-e2e="group-avatar"]').outerHTML = '<img src="https://fixture.local/avatar-a.png">'; });
    const direct = (await chat.listContacts()).contacts[0];
    assert.equal(direct.isGroup, false); assert.notEqual(direct.identityBinding, group.identityBinding);
  } finally { await chat.close(); }
});

test('名字含群但没有类型证据的条目保持unknown，用户公开ID可绑定明确个人会话', async () => {
  const { page, chat } = await fixture();
  try {
    chat.following = []; chat.relationshipDiscovery = { status: 'unavailable' };
    await page.locator('[data-e2e="conversation-item"]').first().evaluate(row => { row.removeAttribute('data-conversation-type'); row.querySelector('.conversationConversationItemtitle').textContent = '仅名字里有群'; });
    const unknown = (await chat.listContacts()).contacts[0];
    assert.equal(unknown.conversationType, 'unknown'); assert.equal(unknown.isGroup, null); assert.equal(unknown.identityVerified, false);
    await page.locator('[data-e2e="conversation-item"]').first().evaluate(row => { row.removeAttribute('data-conversation-id'); row.setAttribute('data-conversation-type', 'direct'); const name = row.querySelector('.conversationConversationItemtitle'); const link = document.createElement('a'); link.href = 'https://www.douyin.com/user/synthetic-person?tracking=not-kept'; name.replaceWith(link); link.append(name); });
    const personal = (await chat.listContacts()).contacts[0];
    assert.equal(personal.conversationType, 'direct'); assert.equal(personal.identityVerified, true);
    assert.equal(JSON.stringify(personal).includes('synthetic-person'), false);
  } finally { await chat.close(); }
});

test('普通头像和稳定会话ID不足以证明个人类型，unknown不能沿用关注关系授权', async () => {
  const { page, chat } = await fixture();
  try {
    await page.locator('[data-e2e="conversation-item"]').first().evaluate(row => { row.removeAttribute('data-conversation-type'); const image = row.querySelector('img'), avatar = document.createElement('div'); avatar.className = 'commonIMAvataravatarContainer'; image.replaceWith(avatar); avatar.append(image); });
    const contact = (await chat.listContacts()).contacts[0];
    assert.equal(contact.conversationType, 'unknown'); assert.equal(contact.isGroup, null); assert.equal(contact.identityVerified, false); assert.equal(contact.followed, null);
    await assert.rejects(chat.readConversation(contact.id, { allowed: true }), /类型尚未核实/);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('输入框扩高只移除虚拟列表的旧前缀时仍可发送，原最新端与内容必须保留', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => {
      const list = document.querySelector('#message-list'); list.className = 'messageMessageListlist'; list.style.transform = 'scale(-1,-1)';
      list.innerHTML = [0, 1, 2].map(index => `<div data-index="${index}"><div class="messageMessageBoxmessageBox" data-message-id="synthetic-window-${index}"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">合成历史 ${index}</div></div></div></div>`).join('');
      document.querySelector('[contenteditable]').addEventListener('input', () => { list.querySelector('[data-index="2"]')?.remove(); }, { once: true });
      const oldButton = document.querySelector('.e2e-send-msg-btn'), button = oldButton.cloneNode(true); oldButton.replaceWith(button);
      button.addEventListener('click', () => {
        window.sent += 1; const editor = document.querySelector('[contenteditable]');
        for (const row of list.querySelectorAll('[data-index]')) row.setAttribute('data-index', String(Number(row.getAttribute('data-index')) + 1));
        const row = document.createElement('div'); row.setAttribute('data-index', '0'); row.innerHTML = '<div class="messageMessageBoxmessageBox messageMessageBoxisFromMe" data-message-id="synthetic-new-outgoing"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer"></div></div></div>'; row.querySelector('.MessageItemTextcontainer').textContent = editor.innerText; list.prepend(row); editor.textContent = '';
      });
    });
    const contact = (await chat.listContacts()).contacts[0], before = await chat.readConversation(contact.id, { allowed: true });
    const result = await chat.sendMessage(contact.id, '足够长的合成回复，用来触发输入区域扩高后的虚拟列表收缩。', { allowed: true, expectedMessageIds: before.messages.map(row => row.id) });
    assert.equal(result.confirmed, true); assert.equal(await page.evaluate(() => window.sent), 1);
  } finally { await chat.close(); }
});

test('受控编辑器拒发后通过真实键盘清理自有草稿，模型不会恢复文字', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => {
      const editor = document.querySelector('[contenteditable]'); window.controlledDraft = '';
      editor.addEventListener('input', event => { if (event.isTrusted) window.controlledDraft = editor.innerText; else editor.textContent = window.controlledDraft; });
    });
    const contact = (await chat.listContacts()).contacts[0], phases = [];
    const authorize = ({ phase }) => { phases.push(phase); return true; }; authorize.beginDispatch = () => { throw new Error('合成最终许可阻断'); };
    const result = await chat.sendMessage(contact.id, '应清理的本次合成草稿', { allowed: true, authorize });
    assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(result.failureStage, 'authorization'); assert.equal(result.failureCode, 'CHAT_FINAL_AUTHORIZATION_REJECTED'); assert.equal(result.draftCleanup, 'cleared');
    assert.equal((await page.locator('[contenteditable]').innerText()).trim(), ''); assert.equal((await page.evaluate(() => window.controlledDraft)).trim(), '');
    await page.evaluate(() => { document.querySelector('[contenteditable]').textContent = window.controlledDraft; });
    assert.equal((await page.locator('[contenteditable]').innerText()).trim(), ''); assert.equal(await page.evaluate(() => window.sent), 0); assert.equal(phases.includes('before-click'), true);
  } finally { await chat.close(); }
});

test('发送trial前补载可信旧前缀且保留最新锚点和全部重叠内容时可以只发送一次', async () => {
  const { page, chat } = await fixture(); let hydrated = false;
  try {
    await page.evaluate(() => {
      const list = document.querySelector('#message-list'); list.className = 'messageMessageListlist'; list.style.transform = 'scale(-1,-1)';
      list.innerHTML = [0, 1, 2].map(index => `<div data-index="${index}"><div class="messageMessageBoxmessageBox" data-message-id="synthetic-hydrate-${index}"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">合成原窗口 ${index}</div></div></div></div>`).join('');
      const old = document.querySelector('.e2e-send-msg-btn'), button = old.cloneNode(true); old.replaceWith(button);
      button.addEventListener('click', () => {
        window.sent += 1; const editor = document.querySelector('[contenteditable]');
        for (const row of list.querySelectorAll('[data-index]')) row.setAttribute('data-index', String(Number(row.getAttribute('data-index')) + 1));
        const row = document.createElement('div'); row.setAttribute('data-index', '0'); row.innerHTML = '<div class="messageMessageBoxmessageBox messageMessageBoxisFromMe" data-message-id="synthetic-hydrate-sent"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer"></div></div></div>'; row.querySelector('.MessageItemTextcontainer').textContent = editor.innerText; list.prepend(row); editor.textContent = '';
      });
    });
    const contact = (await chat.listContacts()).contacts[0], before = await chat.readConversation(contact.id, { allowed: true });
    const authorize = async ({ phase }) => {
      if (phase === 'monitor' && !hydrated) { hydrated = true; await page.locator('#message-list').evaluate(list => list.insertAdjacentHTML('beforeend', '<div data-index="3"><div class="messageMessageBoxmessageBox" data-message-id="synthetic-older-prefix"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">滚动补载的合成旧消息</div></div></div></div>')); }
      return true;
    }; authorize.beginDispatch = () => () => {};
    const result = await chat.sendMessage(contact.id, '补载旧前缀后的合成回复', { allowed: true, expectedMessageIds: before.messages.map(row => row.id), authorize });
    assert.equal(hydrated, true); assert.equal(result.confirmed, true); assert.equal(await page.evaluate(() => window.sent), 1);
  } finally { await chat.close(); }
});

test('虚拟列表空窗、丢失最新锚点、新增、修改或重排都不能利用后缀兼容继续发送', async () => {
  for (const mode of ['empty', 'lost-latest', 'new-message', 'modified', 'reordered', 'unverified-order']) {
    const { page, chat } = await fixture();
    try {
      await page.evaluate(change => {
        const list = document.querySelector('#message-list'); list.className = 'messageMessageListlist'; if (change !== 'unverified-order') list.style.transform = 'scale(-1,-1)';
        list.innerHTML = [0, 1, 2].map(index => `<div data-index="${index}"><div class="messageMessageBoxmessageBox" data-message-id="synthetic-guard-${index}"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">合成边界 ${index}</div></div></div></div>`).join('');
        document.querySelector('[contenteditable]').addEventListener('input', () => {
          if (change === 'empty') list.innerHTML = '';
          else if (change === 'lost-latest') list.querySelector('[data-index="0"]').remove();
          else if (change === 'new-message') { list.querySelector('[data-index="2"]').remove(); for (const old of list.querySelectorAll('[data-index]')) old.setAttribute('data-index', String(Number(old.getAttribute('data-index')) + 1)); const row = document.createElement('div'); row.setAttribute('data-index', '0'); row.innerHTML = '<div class="messageMessageBoxmessageBox" data-message-id="synthetic-guard-new"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">合成新消息</div></div></div>'; list.prepend(row); }
          else if (change === 'modified') { list.querySelector('[data-index="2"]').remove(); list.querySelector('.MessageItemTextcontainer').textContent = '已修改的合成内容'; }
          else if (change === 'reordered') list.append(list.firstElementChild);
          else list.querySelector('[data-index="0"]').remove();
        }, { once: true });
      }, mode);
      const contact = (await chat.listContacts()).contacts[0], before = await chat.readConversation(contact.id, { allowed: true });
      const result = await chat.sendMessage(contact.id, '不能越过水位检查的合成回复', { allowed: true, expectedMessageIds: before.messages.map(row => row.id) });
      assert.equal(result.confirmed, false, mode); assert.equal(result.deliveryUncertain, false, mode); assert.equal(await page.evaluate(() => window.sent), 0, mode); assert.equal(result.failureCode, 'CHAT_WATERMARK_CHANGED', mode);
    } finally { await chat.close(); }
  }
});

test('选中已授权群聊才读取发言者和本人提及标记，不扫描其他会话预览', async () => {
  const { page, chat } = await fixture();
  try {
    chat.following = []; chat.relationshipDiscovery = { status: 'unavailable' };
    await page.evaluate(() => {
      const row = document.querySelector('[data-e2e="conversation-item"]'); row.setAttribute('data-conversation-type', 'group');
      row.querySelector('.conversationConversationItemtitle').textContent = '合成群聊';
      row.querySelector('img').outerHTML = '<div data-e2e="group-avatar"><img src="https://fixture.local/avatar-a.png"></div>';
      row.addEventListener('click', () => {
        const header = document.querySelector('.StackLayoutStackChatHeaderuser'); header.setAttribute('data-e2e', 'group-chat-header'); header.setAttribute('data-conversation-type', 'group'); header.setAttribute('data-conversation-id', 'test-a');
        const image = header.querySelector('img'); if (!image.closest('[data-e2e="group-avatar"]')) { const avatar = document.createElement('div'); avatar.setAttribute('data-e2e', 'group-avatar'); image.replaceWith(avatar); avatar.append(image); }
      });
      const box = document.querySelector('.messageMessageBoxmessageBox'); box.setAttribute('data-sender-id', 'synthetic-member-id');
      box.insertAdjacentHTML('afterbegin', '<div data-e2e="message-sender">合成成员</div>');
      box.querySelector('.MessageItemTextcontainer').innerHTML = '<span data-mention-self="true">@大肥鱼</span> 合成群消息';
    });
    const group = (await chat.listContacts()).contacts[0];
    await assert.rejects(chat.readConversation(group.id), /明确授权/);
    const result = await chat.readConversation(group.id, { allowed: true });
    assert.equal(result.conversation.isGroup, true); assert.equal(result.conversation.conversationType, 'group');
    assert.equal(result.messages[0].mentionedSelf, true); assert.equal(result.messages[0].memberName, '合成成员');
    assert.match(result.messages[0].memberId, /^member:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(result).includes('synthetic-member-id'), false); assert.equal(JSON.stringify(result).includes('test-a'), false);
    assert.equal(await page.evaluate(() => window.previewReads), 0);
  } finally { await chat.close(); }
});

test('未授权读取或发送都不进入页面，不向合成联系人发送', async () => {
  const { page, chat } = await fixture();
  try {
    await assert.rejects(chat.readConversation('conv:' + 'a'.repeat(64)), /明确授权/);
    await assert.rejects(chat.sendMessage('conv:' + 'a'.repeat(64), '测试'), /明确授权/);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('完整许可绑定在填写前核对，同ID头像变化可用但类型变化不发送', async () => {
  for (const mutation of ['avatar', 'group']) {
    const { page, chat } = await fixture();
    try {
      const contact = (await chat.listContacts()).contacts[0];
      const expectedContact = { ...contact, authorizationKind: 'following', verifiedAt: new Date().toISOString() };
      await page.evaluate(change => {
        const row = document.querySelector('[data-e2e="conversation-item"]'), header = document.querySelector('.StackLayoutStackChatHeaderuser');
        if (change === 'avatar') { row.querySelector('img').src = 'https://fixture.local/replaced-avatar.png'; header.querySelector('img').src = 'https://fixture.local/replaced-avatar.png'; }
        else { row.setAttribute('data-conversation-type', 'group'); header.setAttribute('data-conversation-type', 'group'); }
      }, mutation);
      if (mutation === 'avatar') { const result = await chat.sendMessage(contact.id, '同身份更新头像后的合成文字', { allowed: true, expectedContact }); assert.equal(result.confirmed, true); assert.equal(await page.evaluate(() => window.sent), 1); }
      else { await assert.rejects(chat.sendMessage(contact.id, '不能发出的合成文字', { allowed: true, expectedContact }), /绑定已变化|稳定身份已变化/); assert.equal(await page.evaluate(() => window.sent), 0); }
      assert.equal((await page.locator('[contenteditable]').innerText()).trim(), '');
    } finally { await chat.close(); }
  }
});

test('填写后和最终输入许可期间更换绑定，完整授权也不能向变化后的会话发送', async () => {
  for (const phase of ['input', 'dispatch']) {
    const { page, chat } = await fixture();
    try {
      const contact = (await chat.listContacts()).contacts[0];
      const expectedContact = { ...contact, authorizationKind: 'following', verifiedAt: new Date().toISOString() };
      if (phase === 'input') await page.evaluate(() => document.querySelector('[contenteditable]').addEventListener('input', () => document.querySelector('[data-e2e="conversation-item"]').setAttribute('data-conversation-id', 'changed-during-input'), { once: true }));
      const authorize = () => true;
      authorize.beginDispatch = async () => { if (phase === 'dispatch') await page.locator('[data-e2e="conversation-item"]').first().evaluate(row => row.setAttribute('data-conversation-type', 'group')); return () => {}; };
      const result = await chat.sendMessage(contact.id, '合成文字', { allowed: true, expectedContact, ...(phase === 'dispatch' ? { authorize } : {}) });
      assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(await page.evaluate(() => window.sent), 0); assert.equal((await page.locator('[contenteditable]').innerText()).trim(), '');
    } finally { await chat.close(); }
  }
});

test('精确会话选择后回读身份及消息，只读指定联系人', async () => {
  const { chat } = await fixture();
  try {
    const list = await chat.listContacts();
    const selected = await chat.readConversation(list.contacts[1].id, { allowed: true });
    assert.equal(selected.conversation.id, list.contacts[1].id);
    assert.equal(selected.contact.name, '测试乙');
    assert.equal(selected.messages[0].sender, 'incoming');
    assert.equal(selected.messages[0].text, '合成消息');
    assert.equal(selected.messages[0].eligibleForReply, false);
    assert.equal(selected.messages[0].sentAt, '2026-10-14 12:00');
    assert.equal(selected.messages[0].dateEvidence.kind, 'absolute');
    assert.equal(selected.dayEvidence.latestEndVerified, false);
  } finally { await chat.close(); }
});

test('同名同头像会话有歧义时拒绝操作', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => { const row = document.querySelector('[data-e2e="conversation-item"]'); row.removeAttribute('data-conversation-id'); row.after(row.cloneNode(true)); });
    await assert.rejects(chat.listContacts(), /歧义/);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('发送按钮点击和发出消息回读仅在合成页面验证', async () => {
  const { page, chat } = await fixture();
  try {
    const { contacts } = await chat.listContacts();
    const result = await chat.sendMessage(contacts[1].id, '合成回复', { allowed: true });
    assert.equal(result.confirmed, true);
    assert.equal(result.contact.id, contacts[1].id);
    assert.equal(result.deliveryUncertain, false);
    assert.match(result.messageId, /^msg:/);
    assert.equal(await page.evaluate(() => window.sent), 1);
  } finally { await chat.close(); }
});

test('发送后仅重新打开原会话一次，读取延迟挂载的新模块消息节点且不重发', async () => {
  const { page, chat } = await fixture();
  try {
    const { contacts } = await chat.listContacts();
    await page.evaluate(() => {
      window.reopened = 0; window.pendingSentText = null;
      const send = document.querySelector('.e2e-send-msg-btn'), replacement = send.cloneNode(true);
      send.replaceWith(replacement);
      replacement.addEventListener('click', () => { window.sent++; window.pendingSentText = document.querySelector('[contenteditable]').innerText; document.querySelector('[contenteditable]').textContent = ''; });
      document.querySelector('[data-e2e="conversation-item"]').addEventListener('click', () => {
        if (!window.pendingSentText) return;
        window.reopened++;
        const row = document.createElement('div'); row.setAttribute('data-index', '1'); row.setAttribute('data-message-id', 'synthetic-new-server-id');
        row.className = 'messageMessageBoxmessageBox_hash'; row.setAttribute('data-direction', 'outgoing');
        const node = document.createElement('div'); node.setAttribute('data-e2e', 'message-content');
        const text = document.createElement('div'); text.className = 'MessageItemTextcontainer_hash'; text.textContent = window.pendingSentText;
        node.append(text); row.append(node); document.getElementById('message-list').append(row); window.pendingSentText = null;
      });
    });
    const result = await chat.sendMessage(contacts[0].id, '等待挂载的合成回复', { allowed: true });
    assert.equal(result.confirmed, true); assert.equal(result.deliveryUncertain, false);
    assert.equal(await page.evaluate(() => window.sent), 1); assert.equal(await page.evaluate(() => window.reopened), 1);
    const raw = await page.evaluate(readConversationDom);
    assert.equal(raw.messages.at(-1).direction, 'outgoing'); assert.equal(raw.messages.at(-1).nativeId, 'synthetic-new-server-id');
  } finally { await chat.close(); }
});

test('后台低RAF仍以真实几何和中心命中核对后只产生一次可信发送', async () => {
  const { page, chat } = await fixture();
  try {
    const contact = (await chat.listContacts()).contacts[0];
    await page.evaluate(() => { window.requestAnimationFrame = () => 0; window.trustedSendCount = 0; document.querySelector('.e2e-send-msg-btn').addEventListener('click', event => { if (event.isTrusted) window.trustedSendCount += 1; }); });
    const result = await chat.sendMessage(contact.id, '后台低帧合成回复', { allowed: true });
    assert.equal(result.confirmed, true); assert.equal(await page.evaluate(() => window.sent), 1); assert.equal(await page.evaluate(() => window.trustedSendCount), 1);
  } finally { await chat.close(); }
});

test('几何等待中遮挡或持续移动，以及最终许可后替换移动遮挡控件均不产生发送', async () => {
  for (const mode of ['covered', 'moving', 'replace-final', 'move-final', 'cover-final']) {
    const { page, chat } = await fixture(); let prepared = false;
    try {
      const contact = (await chat.listContacts()).contacts[0];
      const alter = change => {
        const button = document.querySelector('.e2e-send-msg-btn');
        if (change === 'covered' || change === 'cover-final') { const r = button.getBoundingClientRect(), cover = document.createElement('div'); cover.style.cssText = `position:fixed;z-index:999999;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;background:black`; document.body.append(cover); }
        else if (change === 'moving') button.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(300px)' }], { duration: 700, iterations: Infinity, direction: 'alternate' });
        else if (change === 'replace-final') { const replacement = button.cloneNode(true); replacement.removeAttribute('data-deepseek-send-token'); button.replaceWith(replacement); }
        else button.style.marginLeft = '150px';
      };
      const authorize = async ({ phase }) => { if (phase === 'monitor' && !prepared && ['covered', 'moving'].includes(mode)) { prepared = true; await page.evaluate(alter, mode); } return true; };
      authorize.beginDispatch = async () => { if (mode.endsWith('-final')) await page.evaluate(alter, mode); return () => {}; };
      const result = await chat.sendMessage(contact.id, '几何检查应阻止的合成回复', { allowed: true, authorize });
      assert.equal(result.confirmed, false, mode); assert.equal(result.deliveryUncertain, false, mode); assert.equal(await page.evaluate(() => window.sent), 0, mode);
    } finally { await chat.close(); }
  }
});

test('可信新尾部先pending后完成时沿用本次候选ID确认，不重复点击', async () => {
  const { page, chat } = await fixture();
  try {
    const contact = (await chat.listContacts()).contacts[0];
    await page.evaluate(() => document.querySelector('.e2e-send-msg-btn').addEventListener('click', () => {
      const box = document.querySelector('#message-list > div:last-child .messageMessageBoxmessageBox'); box.setAttribute('data-message-id', 'synthetic-pending-receipt');
      const pending = document.createElement('span'); pending.setAttribute('data-e2e', 'message-pending'); box.append(pending); setTimeout(() => pending.remove(), 450);
    }));
    const result = await chat.sendMessage(contact.id, '合成等待完成的回复', { allowed: true });
    assert.equal(result.confirmed, true); assert.equal(result.deliveryUncertain, false); assert.equal(await page.evaluate(() => window.sent), 1); assert.match(result.messageId, /^msg:/);
  } finally { await chat.close(); }
});

test('模块样式后缀和外层本人标记可读，缺少明确方向的新结构保持未知', async () => {
  const { page, chat } = await fixture();
  try {
    const { contacts } = await chat.listContacts();
    await page.evaluate(() => {
      document.querySelector('.StackLayoutStackChatHeaderuser').className = 'StackLayoutStackChatHeaderuser_hash';
      document.querySelector('.StackLayoutStackChatHeadertitle').className = 'StackLayoutStackChatHeadertitle_hash';
      document.querySelector('.StackLayoutpagespageRoot').className = 'StackLayoutpagespageRoot_hash';
      const box = document.querySelector('.messageMessageBoxmessageBox'); box.className = 'messageMessageBoxmessageBox_hash';
      const outer = document.createElement('div'); outer.className = 'MessageBoxContent_isFromMe__hash'; box.replaceWith(outer); outer.append(box);
      const node = box.querySelector('[data-e2e="msg-item-content"]'); node.removeAttribute('data-e2e'); node.setAttribute('data-testid', 'message-content');
      node.querySelector('.MessageItemTextcontainer').className = 'MessageItemTextcontainer_hash';
    });
    const result = await chat.readConversation(contacts[0].id, { allowed: true });
    assert.equal(result.messages[0].sender, 'outgoing'); assert.equal(result.messages[0].text, '合成消息');
    await page.locator('.MessageBoxContent_isFromMe__hash').evaluate(e => { e.className = ''; });
    assert.equal((await page.evaluate(readConversationDom)).messages[0].sender, 'unknown');
  } finally { await chat.close(); }
});

test('重新挂载后出现同文的旧发出历史不能充当本次发送成功', async () => {
  const { page, chat } = await fixture();
  try {
    const { contacts } = await chat.listContacts();
    await page.evaluate(() => {
      const send = document.querySelector('.e2e-send-msg-btn'), replacement = send.cloneNode(true); send.replaceWith(replacement);
      replacement.addEventListener('click', () => { window.sent++; document.querySelector('[contenteditable]').textContent = ''; });
      document.querySelector('[data-e2e="conversation-item"]').addEventListener('click', () => {
        if (!window.sent || document.getElementById('old-history')) return;
        const row = document.createElement('div'); row.id = 'old-history'; row.setAttribute('data-index', '0'); row.setAttribute('data-message-id', 'synthetic-old-server-id');
        row.className = 'messageMessageBoxmessageBox messageMessageBoxisFromMe';
        row.innerHTML = '<div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">同文合成回复</div></div>';
        document.getElementById('message-list').prepend(row);
      });
    });
    const result = await chat.sendMessage(contacts[0].id, '同文合成回复', { allowed: true });
    assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, true);
    assert.equal(await page.evaluate(() => window.sent), 1);
  } finally { await chat.close(); }
});

test('等待按钮稳定期间撤回主动问候许可，不会迟发或调用最终输入许可', async () => {
  const { page, chat } = await fixture(); let enabled = true, began = 0, prepared = false;
  try {
    const { contacts } = await chat.listContacts();
    const authorize = async ({ phase }) => {
      if (phase === 'monitor' && !prepared) { prepared = true; await page.evaluate(() => document.querySelector('.e2e-send-msg-btn').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }], { duration: 900 })); setTimeout(() => { enabled = false; }, 80); }
      return enabled;
    };
    authorize.beginDispatch = () => { began++; return () => {}; };
    const result = await chat.sendMessage(contacts[0].id, '合成问候', { allowed: true, authorize });
    assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(began, 0);
    await page.waitForTimeout(300); assert.equal(await page.evaluate(() => window.sent), 0); assert.equal((await page.locator('[contenteditable]').innerText()).trim(), '');
  } finally { await chat.close(); }
});

test('可信最终输入许可覆盖唯一真实点击，撤回或释放后不会再次点击', async () => {
  const { page, chat } = await fixture(); let enabled = true, held = false, began = 0, released = 0, finalClicks = 0, finalClickSettled = false, releaseCheck;
  const mousePrototype = Object.getPrototypeOf(page.mouse), originalClick = mousePrototype.click;
  try {
    const { contacts } = await chat.listContacts();
    await page.evaluate(() => {
      window.fixtureLease = { held: false, trace: [] };
      document.querySelector('.e2e-send-msg-btn').addEventListener('click', event => {
        const lease = window.fixtureLease;
        lease.trace.push({ phase: 'click', trusted: event.isTrusted, held: lease.held });
      });
    });
    // 同步记录最终点击 Promise 的完成顺序，不插入浏览器等待或更改产品点击参数。
    mousePrototype.click = async function(x, y, options) {
      if (this !== page.mouse) return originalClick.apply(this, arguments);
      assert.equal(options?.delay || 0, 0); assert.equal(options?.clickCount || 1, 1);
      assert.equal(held, true); assert.equal(released, 0); finalClicks++;
      const result = await originalClick.apply(this, arguments);
      assert.equal(held, true); finalClickSettled = true;
      return result;
    };
    const authorize = () => enabled;
    authorize.beginDispatch = async () => {
      assert.equal(held, false); assert.equal(released, 0); began++; held = true;
      await page.evaluate(() => { const lease = window.fixtureLease; lease.held = true; lease.trace.push({ phase: 'acquired' }); });
      return () => {
        assert.equal(held, true); assert.equal(finalClickSettled, true); assert.equal(released, 0);
        held = false; released++;
        releaseCheck = page.evaluate(() => { const lease = window.fixtureLease; lease.held = false; lease.trace.push({ phase: 'released' }); return lease.trace; });
      };
    };
    const result = await chat.sendMessage(contacts[0].id, '合成问候', { allowed: true, authorize });
    assert.equal(result.confirmed, true); assert.equal(began, 1); assert.equal(finalClicks, 1); assert.equal(released, 1); assert.equal(held, false);
    assert.deepEqual(await releaseCheck, [{ phase: 'acquired' }, { phase: 'click', trusted: true, held: true }, { phase: 'released' }]);
    assert.equal(await page.evaluate(() => window.sent), 1);
    enabled = false;
    await assert.rejects(chat.sendMessage(contacts[0].id, '撤回后不得发送', { allowed: true, authorize }), /许可已撤回/);
    const abort = new AbortController(); abort.abort(new Error('合成取消后不得迟发'));
    await assert.rejects(chat.sendMessage(contacts[0].id, '取消后不得发送', { allowed: true, authorize, signal: abort.signal }), /合成取消/);
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.sent), 1); assert.equal((await page.evaluate(() => window.fixtureLease.trace)).filter(item => item.phase === 'click').length, 1);
    assert.equal(began, 1); assert.equal(finalClicks, 1); assert.equal(released, 1);
  } finally { mousePrototype.click = originalClick; await releaseCheck?.catch(() => {}); await chat.close(); }
});

test('等待按钮稳定期间会话身份变化，不向变化后的好友发送', async () => {
  const { page, chat } = await fixture(); let prepared = false;
  try {
    const { contacts } = await chat.listContacts();
    const authorize = async ({ phase }) => { if (phase === 'monitor' && !prepared) { prepared = true; await page.evaluate(() => { document.querySelector('.e2e-send-msg-btn').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }], { duration: 900 }); setTimeout(() => { document.querySelector('.StackLayoutStackChatHeadertitle').textContent = '合成其他好友'; }, 80); }); } return true; };
    authorize.beginDispatch = () => () => {};
    const result = await chat.sendMessage(contacts[0].id, '不应发送', { allowed: true, authorize });
    assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('旧自动回复没有主动许可钩子时，取消信号仍阻止等待后的迟发', async () => {
  const { page, chat } = await fixture(); const abort = new AbortController();
  try {
    const { contacts } = await chat.listContacts();
    await page.exposeFunction('fixtureAbortSend', () => abort.abort(new Error('合成停止回复')));
    await page.evaluate(() => document.querySelector('[contenteditable]').addEventListener('input', () => {
      document.querySelector('.e2e-send-msg-btn').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(200px)' }], { duration: 900 }); setTimeout(() => window.fixtureAbortSend(), 80);
    }, { once: true }));
    const result = await chat.sendMessage(contacts[0].id, '旧回复停止测试', { allowed: true, signal: abort.signal });
    assert.equal(result.confirmed, false); assert.equal(result.deliveryUncertain, false); await page.waitForTimeout(300); assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('已有草稿或发送按钮不唯一时不点击发送', async () => {
  const { page, chat } = await fixture();
  try {
    const { contacts } = await chat.listContacts();
    await page.locator('[contenteditable]').fill('用户草稿');
    await assert.rejects(chat.sendMessage(contacts[0].id, '合成回复', { allowed: true }), /已有草稿/);
    assert.equal(await page.locator('[contenteditable]').innerText(), '用户草稿');
    await page.locator('[contenteditable]').fill('');
    await page.evaluate(() => document.querySelector('.e2e-send-msg-btn').after(document.querySelector('.e2e-send-msg-btn').cloneNode(true)));
    const result = await chat.sendMessage(contacts[0].id, '合成回复', { allowed: true });
    assert.equal(result.confirmed, false);
    assert.equal(result.deliveryUncertain, false);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('预期私信水位或填写期间消息变化时不点击发送', async () => {
  const { page, chat } = await fixture();
  try {
    const { contacts } = await chat.listContacts();
    const before = await chat.readConversation(contacts[0].id, { allowed: true });
    const wrong = await chat.sendMessage(contacts[0].id, '合成回复', { allowed: true, expectedMessageIds: ['msg:其他水位'] });
    assert.equal(wrong.confirmed, false);
    assert.equal(wrong.deliveryUncertain, false);
    await page.evaluate(() => document.querySelector('[contenteditable]').addEventListener('input', () => {
      const newRow = document.createElement('div'); newRow.setAttribute('data-index', '1');
      newRow.innerHTML = '<div class="messageMessageBoxmessageBox"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">填写期间的新消息</div></div></div>';
      document.getElementById('message-list').append(newRow);
    }, { once: true }));
    const changed = await chat.sendMessage(contacts[0].id, '合成回复', { allowed: true, expectedMessageIds: before.messages.map(item => item.id) });
    assert.equal(changed.confirmed, false);
    assert.equal(changed.deliveryUncertain, false);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('填写期间用户改写草稿，取消发送时保留用户内容',async()=>{
  const {page,chat}=await fixture();
  try{
    const {contacts}=await chat.listContacts();
    const before=await chat.readConversation(contacts[0].id,{allowed:true});
    await page.evaluate(()=>document.querySelector('[contenteditable]').addEventListener('input',event=>{event.target.textContent='用户刚输入的草稿';},{once:true}));
    const result=await chat.sendMessage(contacts[0].id,'合成回复',{allowed:true,expectedMessageIds:before.messages.map(item=>item.id)});
    assert.equal(result.confirmed,false);assert.equal(await page.evaluate(()=>window.sent),0);
    assert.equal(await page.locator('[contenteditable]').innerText(),'用户刚输入的草稿');
  }finally{await chat.close();}
});

const row = (order, text, timestamp = '2026-10-14 12:00') => ({ nativeId: null, direction: 'incoming', kind: 'text', text, timestamp, order });
test('同日重复短句用真实序号区分，滑动窗口保留旧 ID', () => {
  const tracker = new MessageIdentityTracker();
  const first = tracker.identify('测试会话', [row(0, '你好'), row(1, '你好')]);
  assert.notEqual(first[0].id, first[1].id);
  const shifted = tracker.identify('测试会话', [row(1, '你好'), row(2, '你好')]);
  assert.equal(shifted[0].id, first[1].id);
  assert.equal(shifted[0].eligibleForReply, false);
  assert.equal(shifted[1].eligibleForReply, true);
  const again = tracker.identify('测试会话', [row(1, '你好'), row(2, '你好')]);
  assert.deepEqual(again.map(item => item.id), shifted.map(item => item.id));
});

test('前插旧历史、时间标签变化和无重叠窗口不认作新私信', () => {
  const tracker = new MessageIdentityTracker();
  const first = tracker.identify('测试会话', [row(0, '甲'), row(1, '乙')]);
  const prepended = tracker.identify('测试会话', [row(0, '旧'), row(1, '甲'), row(2, '乙')]);
  assert.equal(prepended[0].eligibleForReply, false);
  assert.equal(prepended[1].id, first[0].id);
  assert.equal(prepended[2].id, first[1].id);
  const changed = tracker.identify('测试会话', [row(1, '甲', '昨天'), row(2, '乙', '昨天')]);
  assert.equal(changed.some(item => item.eligibleForReply), false);
  const unrelated = tracker.identify('测试会话', [row(10, '旧窗口'), row(11, '旧窗口')]);
  assert.equal(unrelated.some(item => item.eligibleForReply), false);
});

test('非文字和无法核实序号的消息保留 ID 但不纳入自动回复', () => {
  const tracker = new MessageIdentityTracker();
  const images = tracker.identify('测试会话', [{ ...row(0, ''), kind: 'video' }, { ...row(1, ''), kind: 'emoji' }]);
  assert.equal(images.every(item => item.unsupported), true);
  const unknown = tracker.identify('无序号会话', [row(null, '短句'), row(null, '短句')]);
  assert.notEqual(unknown[0].id, unknown[1].id);
  assert.equal(unknown.every(item => !item.eligibleForReply), true);
});

test('网页重复消息身份会停止自动回复', () => {
  const tracker = new MessageIdentityTracker();
  assert.throws(() => tracker.identify('重复序号会话', [row(0, '你好'), row(0, '你好')]), /身份重复/);
});

test('相对时间逐分钟变化不产生新消息身份或回复资格', () => {
  const tracker = new MessageIdentityTracker();
  const before = tracker.identify('相对时间会话', [row(0, '既有消息', '48分钟前'), row(1, '既有消息', '48分钟前')]);
  const after = tracker.identify('相对时间会话', [row(0, '既有消息', '49分钟前'), row(1, '既有消息', '49分钟前')]);
  assert.deepEqual(after.map(item => item.id), before.map(item => item.id));
  assert.equal(after.every(item => item.arrivalClassification === 'known-old-window'), true);
  assert.equal(after.every(item => !item.eligibleForReply), true);
  assert.equal(after[0].timestamp, '49分钟前');
});

test('补载旧历史只标为旧历史，回到已知窗口不重复认作新到达', () => {
  const tracker = new MessageIdentityTracker();
  const first = tracker.identify('历史窗口会话', [row(4, '甲'), row(5, '乙')]);
  const earlier = tracker.identify('历史窗口会话', [row(0, '早期消息'), row(1, '另一个早期消息')]);
  assert.equal(earlier.every(item => item.arrivalClassification === 'old-history'), true);
  const returned = tracker.identify('历史窗口会话', [row(4, '甲', '昨日'), row(5, '乙', '昨日')]);
  assert.deepEqual(returned.map(item => item.id), first.map(item => item.id));
  assert.equal(returned.every(item => item.arrivalClassification === 'known-old-window'), true);
  const newest = tracker.identify('历史窗口会话', [row(5, '乙'), row(6, '乙')]);
  assert.equal(newest[1].arrivalClassification, 'new-tail');
  assert.equal(newest[1].eligibleForReply, true);
});

test('无重叠且高于已知水位的陌生窗口仍需核对', () => {
  const tracker = new MessageIdentityTracker();
  tracker.identify('陌生窗口会话', [row(0, '基线')]);
  const uncertain = tracker.identify('陌生窗口会话', [row(20, '可能新消息')]);
  assert.equal(uncertain[0].arrivalClassification, 'ambiguous-new');
  assert.equal(uncertain[0].eligibleForReply, false);
});

test('前插旧历史使重复短句序号移动时不重新回复', () => {
  const tracker = new MessageIdentityTracker();
  const before = tracker.identify('重复历史会话', [row(0, '你好'), row(1, '你好')]);
  const after = tracker.identify('重复历史会话', [row(0, '早期记录'), row(1, '你好'), row(2, '你好')]);
  assert.deepEqual(after.slice(1).map(item => item.id), before.map(item => item.id));
  assert.equal(after.every(item => !item.eligibleForReply), true);
  assert.equal(after[0].arrivalClassification, 'old-history');
});

test('表情提取标签和本机资源引用，不把图片临时 URL 放进返回值', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => {
      document.querySelector('[data-e2e="msg-item-content"]').innerHTML = '<div class="MessageItemEmojiemojiBox"><img alt="[赞]" src="https://fixture.local/private-emoji.png?temporary_secret=test" style="width:64px;height:64px"></div>';
    });
    const { contacts } = await chat.listContacts();
    const result = await chat.readConversation(contacts[0].id, { allowed: true });
    const message = result.messages[0];
    assert.equal(message.kind, 'emoji');
    assert.equal(message.media.label, '[赞]');
    assert.equal(message.media.imageCount, 1);
    assert.match(message.media.resources[0].resourceRef, /^media:[a-f0-9]{64}$/);
    assert.equal(message.unsupported, false);
    assert.equal(JSON.stringify(result).includes('temporary_secret'), false);
    assert.equal(JSON.stringify(result).includes('private-emoji.png'), false);
  } finally { await chat.close(); }
});

test('文字内原生表情按顺序读取平台标题，不遗失只含表情的新消息', async () => {
  const { page, chat } = await fixture();
  try {
    await page.locator('[data-e2e="msg-item-content"]').evaluate(node => { node.innerHTML = '<div class="MessageItemTextcontainer"><span>你好</span><span class="TextMessageTextemoji"><img title="[微笑]" src="https://fixture.local/emoji-a"></span><span>呀</span><br><span class="TextMessageTextemoji"><img title="[赞]" src="https://fixture.local/emoji-b"></span></div>'; });
    const contact = (await chat.listContacts()).contacts[0];
    const message = (await chat.readConversation(contact.id, { allowed: true })).messages[0];
    assert.equal(message.text, '你好[微笑]呀\n[赞]'); assert.equal(message.kind, 'text'); assert.equal(message.media, null); assert.equal(message.unsupported, false);
    await page.locator('.MessageItemTextcontainer').evaluate(node => { node.innerHTML = '<span class="TextMessageTextemoji"><img title="[呲牙]" src="https://fixture.local/emoji-c"></span>'; });
    const next = (await chat.readConversation(contact.id, { allowed: true })).messages[0];
    assert.equal(next.text, '[呲牙]'); assert.equal(next.unsupported, false);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('无名称的文字内表情保留未知标记并只采样本条消息', async () => {
  const { page, chat } = await fixture();
  try {
    await page.locator('[data-e2e="msg-item-content"]').evaluate(node => { node.innerHTML = '<div class="MessageItemTextcontainer" style="width:160px;height:60px">看这个<span class="TextMessageTextemoji"><img width="20" height="20" src="data:image/svg+xml,%3Csvg xmlns=\"http://www.w3.org/2000/svg\"/%3E"></span></div>'; });
    const contact = (await chat.listContacts()).contacts[0], message = (await chat.readConversation(contact.id, { allowed: true })).messages[0];
    assert.equal(message.text, '看这个[未命名表情]'); assert.equal(message.media.inline, true); assert.equal(message.media.label, null);
    const captured = await chat.captureMessage(contact.id, message.id, { allowed: true });
    assert.equal(captured.frames.length, 1); assert.equal(captured.messageId, message.id);
  } finally { await chat.close(); }
});

test('普通图片只读本条图片框，临时链接保持在本机内部', async () => {
  const { page, chat } = await fixture();
  try {
    const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="green"/></svg>');
    await page.locator('[data-e2e="msg-item-content"]').evaluate((node, src) => { node.innerHTML = '<div class="MessageItemImageImageBox"><img class="commonMyImageimgReal MessageItemImageImage" width="160" height="100"></div>'; node.querySelector('img').src = src; }, image);
    const contact = (await chat.listContacts()).contacts[0], read = await chat.readConversation(contact.id, { allowed: true }), message = read.messages[0];
    assert.equal(message.kind, 'image'); assert.equal(message.media.type, 'image'); assert.equal(message.media.imageCount, 1); assert.equal(message.unsupported, false);
    assert.equal(JSON.stringify(read).includes('data:image'), false);
    const captured = await chat.captureMessage(contact.id, message.id, { allowed: true });
    assert.equal(captured.frames.length, 1); assert.equal(captured.understandingScope, 'single-message-image'); assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

async function voiceFixture({ source = 'https://sf26-sign.douyinstatic.com/private-audio.mp3?signature=synthetic-private', duration = 3825, display = '3"' } = {}) {
  const f = await fixture();
  await f.page.locator('[data-e2e="msg-item-content"]').evaluate((node, values) => {
    node.innerHTML = '<div class="MessageItemAudioaudioBoxWrapper"><div class="MessageItemAudioaudioBox"><span class="MessageItemAudioduration"></span><div class="AudioAudioIconiconBox"></div></div></div>';
    node.querySelector('.MessageItemAudioduration').textContent = values.display;
    const data = { resource_url: { url_list: [values.source] }, duration: values.duration };
    Object.defineProperty(data, 'ai_audio_text', { get() { throw new Error('不能读取非资源字段'); } });
    Object.defineProperty(node.querySelector('.MessageItemAudioaudioBoxWrapper'), '__reactProps$syntheticVoice', { value: { children: [{ props: { children: [null, { props: { data } }] } }] } });
  }, { source, duration, display });
  f.chat.voiceCaptureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'douyin-message-voice-'));
  const audio = Buffer.alloc(96); audio.write('RIFF'); audio.write('WAVE', 8);
  f.chat.fetchImpl = async () => new Response(audio, { headers: { 'content-type': 'audio/wav', 'content-length': String(audio.length) } });
  f.contact = (await f.chat.listContacts()).contacts[0];
  f.message = (await f.chat.readConversation(f.contact.id, { allowed: true })).messages[0];
  f.cleanup = async () => { await f.chat.close(); fs.rmdirSync(f.chat.voiceCaptureDir); };
  return f;
}

test('指定语音只读固定渲染资源，毫秒时长与显示核对，临时文件可释放', async () => {
  const f = await voiceFixture();
  try {
    const message = f.message;
    assert.equal(message.kind, 'voice'); assert.equal(message.media.durationSeconds, 3.825); assert.equal(message.media.sourceCount, 1); assert.equal(message.unsupported, false);
    assert.equal(JSON.stringify(message).includes('signature'), false); assert.equal(JSON.stringify(message).includes('private-audio'), false);
    await assert.rejects(f.chat.captureVoiceMessage(f.contact.id, message.id), /明确授权/);
    let fetched = 0; const original = f.chat.fetchImpl;
    f.chat.fetchImpl = async (url, options) => { fetched += 1; assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); return original(); };
    const captured = await f.chat.captureVoiceMessage(f.contact.id, message.id, { allowed: true });
    assert.equal(fetched, 1); assert.equal(captured.conversation.id, f.contact.id); assert.equal(captured.messageId, message.id);
    assert.match(captured.captureId, /^voice:[a-f0-9]{64}$/); assert.equal(captured.media.durationSeconds, 3.825); assert.equal(captured.interval.durationSeconds, 3.825);
    assert.equal(captured.audio.mimeType, 'audio/wav'); assert.equal(fs.statSync(captured.audio.path).size, captured.audio.bytes);
    assert.equal(JSON.stringify(captured).includes('signature'), false); assert.equal(await f.page.evaluate(() => window.sent), 0);
    assert.equal(await f.chat.releaseVoiceCapture(captured.captureId), true); assert.equal(fs.existsSync(captured.audio.path), false);
    assert.equal(await f.chat.releaseVoiceCapture(captured.captureId), false);
  } finally { await f.cleanup(); }
});

test('语音来源不是平台HTTPS或时长超过120秒时不下载', async () => {
  for (const values of [{ source: 'http://sf26-sign.douyinstatic.com/test' }, { source: 'https://sf26-sign.douyinstatic.com.evil.invalid/test' }, { source: 'https://127.0.0.1/test' }, { source: 'https://sf26-sign.douyinstatic.com:444/test' }, { duration: 121_000, display: '121"' }, { duration: 3000, display: '9"' }]) {
    const f = await voiceFixture(values);
    try {
      let fetched = false; f.chat.fetchImpl = async () => { fetched = true; assert.fail('拒绝的资源不应下载'); };
      await assert.rejects(f.chat.captureVoiceMessage(f.contact.id, f.message.id, { allowed: true }), /平台 HTTPS|120 秒/); assert.equal(fetched, false);
      assert.equal(fs.readdirSync(f.chat.voiceCaptureDir).length, 0);
    } finally { await f.cleanup(); }
  }
});

test('语音下载跳转、过大、伪装内容和会话消息变化都不产生可转写文件', async () => {
  for (const scenario of ['redirect', 'large-header', 'large-stream', 'invalid-audio', 'message-changed', 'abort']) {
    const f = await voiceFixture();
    try {
      const abort = new AbortController(), original = f.chat.fetchImpl;
      f.chat.fetchImpl = async () => {
        if (scenario === 'redirect') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
        if (scenario === 'large-header') return new Response('a', { headers: { 'content-length': String(25 * 1024 * 1024 + 1) } });
        if (scenario === 'large-stream') return new Response(new Uint8Array(25 * 1024 * 1024 + 1));
        if (scenario === 'invalid-audio') return new Response('<html>not audio</html>');
        if (scenario === 'message-changed') await f.page.locator('.MessageItemAudioduration').evaluate(node => { node.textContent = '8"'; });
        if (scenario === 'abort') abort.abort(new Error('本人取消语音读取'));
        return original();
      };
      await assert.rejects(f.chat.captureVoiceMessage(f.contact.id, f.message.id, { allowed: true, signal: abort.signal }));
      assert.equal(fs.readdirSync(f.chat.voiceCaptureDir).length, 0); assert.equal(await f.page.evaluate(() => window.sent), 0);
    } finally { await f.cleanup(); }
  }
});

test('音频清理暂时失败时保留本机清理记录，可以再次释放', async () => {
  const f = await voiceFixture();
  try {
    const captured = await f.chat.captureVoiceMessage(f.contact.id, f.message.id, { allowed: true }), directory = path.dirname(captured.audio.path);
    const blocker = path.join(directory, 'synthetic-cleanup-blocker'); fs.writeFileSync(blocker, '合成测试文件');
    await assert.rejects(f.chat.releaseVoiceCapture(captured.captureId), { code: 'ENOTEMPTY' });
    assert.equal(f.chat.voiceCaptures.has(captured.captureId), true); assert.equal(fs.existsSync(captured.audio.path), false);
    fs.unlinkSync(blocker); assert.equal(await f.chat.releaseVoiceCapture(captured.captureId), true); assert.equal(f.chat.voiceCaptures.has(captured.captureId), false);
  } finally { await f.cleanup(); }
});

test('单消息截图只取精确表情区域，缺少标签时保持未知', async () => {
  const { page, chat } = await fixture();
  try {
    const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="blue"/></svg>');
    await page.evaluate(src => {
      const box = document.querySelector('[data-e2e="msg-item-content"]');
      const media = document.createElement('div'); media.className = 'MessageItemEmojiemojiBox';
      const img = document.createElement('img'); img.src = src; img.width = 64; img.height = 64;
      media.append(img); box.replaceChildren(media);
    }, image);
    const { contacts } = await chat.listContacts();
    const read = await chat.readConversation(contacts[0].id, { allowed: true });
    assert.equal(read.messages[0].media.label, null);
    await assert.rejects(chat.captureMessage(contacts[0].id, read.messages[0].id), /明确授权/);
    const captured = await chat.captureMessage(contacts[0].id, read.messages[0].id, { allowed: true });
    assert.equal(captured.frames.length, 1);
    assert.equal(captured.frames[0].mimeType, 'image/jpeg');
    assert.equal(Buffer.from(captured.frames[0].data, 'base64').length > 100, true);
    assert.equal(captured.understandingScope, 'single-message-image');
    assert.equal(captured.messageId, read.messages[0].id);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('分享作品仅从真实 DOM 链接取得公开作品 ID，未知时不猜', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => {
      document.querySelector('[data-e2e="msg-item-content"]').innerHTML = '<div class="MessageItemShareAwemecontainer"><img class="MessageItemShareAwemeawemeContainer" src="https://fixture.local/private-cover.jpg?secret=test"><p class="MessageItemShareAwemeauthorName">合成作者</p><div data-e2e="shared-video-title">合成作品</div><a href="https://www.douyin.com/video/12345?temporary_secret=test">打开</a></div>';
    });
    const { contacts } = await chat.listContacts();
    const read = await chat.readConversation(contacts[0].id, { allowed: true });
    const message = read.messages[0];
    assert.equal(message.media.type, 'shared-work');
    assert.equal(message.media.videoId, '12345');
    assert.equal(message.media.url, 'https://www.douyin.com/video/12345');
    assert.equal(message.media.title, '合成作品');
    assert.equal(message.media.author, '合成作者');
    assert.equal(message.media.safeOpenSelector.includes(message.id), true);
    assert.equal(JSON.stringify(read).includes('temporary_secret'), false);
    assert.equal(JSON.stringify(read).includes('private-cover.jpg'), false);
    const resolved = await chat.openSharedVideo(contacts[0].id, message.id, { allowed: true });
    assert.equal(resolved.source, 'dom-link');
    assert.equal(resolved.opened, false);
    await page.evaluate(() => document.querySelector('.MessageItemShareAwemecontainer a').remove());
    const withoutLink = await chat.readConversation(contacts[0].id, { allowed: true });
    assert.equal(withoutLink.messages[0].media.videoId, null);
    assert.equal(withoutLink.messages[0].media.url, null);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('只有空白或零宽占位符视为空草稿，真实文字和图片草稿保留', async () => {
  const { page, chat } = await fixture();
  try {
    const { contacts } = await chat.listContacts();
    await page.evaluate(() => document.querySelector('[contenteditable]').textContent = '\u200B\u2060 ');
    const sent = await chat.sendMessage(contacts[0].id, '合成回复', { allowed: true });
    assert.equal(sent.confirmed, true);
    assert.equal(await page.evaluate(() => window.sent), 1);
    await page.evaluate(() => document.querySelector('[contenteditable]').textContent = '\u200B用户草稿');
    await assert.rejects(chat.sendMessage(contacts[0].id, '另一条合成回复', { allowed: true }), /已有草稿/);
    assert.equal(await page.locator('[contenteditable]').innerText(), '\u200B用户草稿');
    await page.evaluate(() => document.querySelector('[contenteditable]').innerHTML = '<img src="https://fixture.local/draft.png">');
    await assert.rejects(chat.sendMessage(contacts[0].id, '另一条合成回复', { allowed: true }), /已有草稿/);
    assert.equal(await page.locator('[contenteditable] img').count(), 1);
    assert.equal(await page.evaluate(() => window.sent), 1);
  } finally { await chat.close(); }
});

test('相同原生消息 ID 的表情资源变化，进入发送前与填写后都拒绝回复', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => {
      const content = document.querySelector('[data-e2e="msg-item-content"]');
      content.setAttribute('data-message-id', 'fixture-native-stable');
      content.innerHTML = '<div class="MessageItemEmojiemojiBox"><img src="https://fixture.local/emoji-a.png" alt="合成表情甲"></div>';
    });
    const { contacts } = await chat.listContacts();
    const first = await chat.readConversation(contacts[0].id, { allowed: true });
    const expected = first.messages.map(item => ({ id: item.id, fingerprint: messageFingerprint(item) }));
    await page.evaluate(() => document.querySelector('.MessageItemEmojiemojiBox').innerHTML = '<img src="https://fixture.local/emoji-b.png" alt="合成表情乙">');
    const changedBefore = await chat.sendMessage(contacts[0].id, '合成回复', { allowed: true, expectedMessageIds: first.messages.map(item => item.id), expectedMessageContent: expected });
    assert.equal(changedBefore.confirmed, false);
    assert.equal((await page.locator('[contenteditable]').innerText()).trim(), '');
    const current = await chat.readConversation(contacts[0].id, { allowed: true });
    assert.equal(current.messages[0].id, first.messages[0].id);
    await page.evaluate(() => document.querySelector('[contenteditable]').addEventListener('input', () => document.querySelector('.MessageItemEmojiemojiBox').innerHTML = '<img src="https://fixture.local/emoji-c.png" alt="合成表情丙">', { once: true }));
    const changedDuring = await chat.sendMessage(contacts[0].id, '合成回复', { allowed: true });
    assert.equal(changedDuring.confirmed, false);
    assert.equal(changedDuring.deliveryUncertain, false);
    assert.equal((await page.locator('[contenteditable]').innerText()).trim(), '');
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('聊天页面暂停背景视频，播放捕获监听只注册一次', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => { const video = document.createElement('video'); video.id = 'fixture-video'; window.pauseCount = 0; video.pause = () => { window.pauseCount += 1; }; document.body.append(video); });
    await chat.listContacts(); await chat.listContacts();
    const before = await page.evaluate(() => window.pauseCount);
    await page.evaluate(() => document.querySelector('#fixture-video').dispatchEvent(new Event('play')));
    assert.equal(await page.evaluate(() => window.pauseCount), before + 1);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('解析没有公开链接的分享卡片，点击前紧邻检查时间限制', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => { document.querySelector('[data-e2e="msg-item-content"]').innerHTML = '<div class="MessageItemShareAwemecontainer" style="width:80px;height:40px">合成卡片</div>'; window.cardClicks = 0; document.querySelector('.MessageItemShareAwemecontainer').addEventListener('click', () => window.cardClicks += 1); });
    chat.controller.source = 'dsh-chat';
    chat.controller.limits = () => ({ beforeAction: (source, name) => { assert.equal(source, 'dsh'); assert.equal(name, 'douyin_open_video'); return { allowed: false, reason: '合成时间到点' }; } });
    const { contacts } = await chat.listContacts();
    const read = await chat.readConversation(contacts[0].id, { allowed: true });
    await assert.rejects(chat.openSharedVideo(contacts[0].id, read.messages[0].id, { allowed: true }), /时间到点/);
    assert.equal(await page.evaluate(() => window.cardClicks), 0);
  } finally { await chat.close(); }
});

test('无链接卡片点击没有导航或新窗口，原详情 URL 不能充当作品回读', async () => {
  const { page, chat } = await fixture();
  try {
    const markup = await page.content();
    await page.route('https://www.douyin.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await page.goto('https://www.douyin.com/video/12345'); await page.setContent(markup);
    await page.evaluate(() => { document.querySelector('[data-e2e="msg-item-content"]').innerHTML = '<div class="MessageItemShareAwemecontainer" style="width:80px;height:40px">合成卡片</div>'; window.cardClicks = 0; document.querySelector('.MessageItemShareAwemecontainer').addEventListener('click', () => window.cardClicks += 1); });
    chat.controller.source = 'api-chat'; chat.controller.limits = () => ({ beforeAction: () => ({ allowed: true }) });
    const { contacts } = await chat.listContacts();
    const read = await chat.readConversation(contacts[0].id, { allowed: true });
    const resolved = await chat.openSharedVideo(contacts[0].id, read.messages[0].id, { allowed: true });
    assert.equal(resolved.opened, true); assert.equal(resolved.videoId, null); assert.equal(resolved.url, null);
    assert.match(resolved.reason, /未采用原详情页/);
    assert.equal(await page.evaluate(() => window.cardClicks), 1);
  } finally { await chat.close(); }
});

test('同作品 ID 在点击后新开窗口可回读，解析窗口暂停后关闭', async () => {
  const { page, chat } = await fixture();
  try {
    const markup = await page.content(); let pauseCount = 0;
    await page.context().route('https://www.douyin.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body><video id="fixture-video"></video><script>document.querySelector("video").pause=()=>console.log("fixture-paused")</script></body>' }));
    await page.goto('https://www.douyin.com/video/12345'); await page.setContent(markup);
    await page.evaluate(() => { document.querySelector('[data-e2e="msg-item-content"]').innerHTML = '<div class="MessageItemShareAwemecontainer" style="width:80px;height:40px">合成卡片</div>'; document.querySelector('.MessageItemShareAwemecontainer').addEventListener('click', () => window.open('https://www.douyin.com/video/12345')); });
    page.on('popup', popup => popup.on('console', message => { if (message.text() === 'fixture-paused') pauseCount += 1; }));
    chat.controller.source = 'api-chat'; chat.controller.limits = () => ({ beforeAction: () => ({ allowed: true }) });
    const { contacts } = await chat.listContacts();
    const read = await chat.readConversation(contacts[0].id, { allowed: true });
    const resolved = await chat.openSharedVideo(contacts[0].id, read.messages[0].id, { allowed: true });
    assert.equal(resolved.opened, true); assert.equal(resolved.videoId, '12345'); assert.equal(resolved.source, 'actual-opened-page-url');
    assert.equal(pauseCount, 1); assert.equal(page.context().pages().length, 1);
  } finally { await chat.close(); }
});

test('真实抖音纵向翻转列表逆序为旧到新，标记仍绑定原 DOM 消息', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => {
      const list = document.querySelector('#message-list'); list.className = 'messageMessageListlist'; list.style.transform = 'scale(-1,-1)';
      list.innerHTML = '<div data-index="0" style="transform:scale(-1,-1)"><div class="messageMessageBoxmessageBox"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">最新合成消息</div></div></div></div>'
        + '<div data-index="1" style="transform:scale(-1,-1)"><div class="messageMessageBoxmessageBox"><div data-e2e="msg-item-content"><div class="MessageItemEmojiemojiBox"><img width="64" height="64" alt="合成表情" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2264%22 height=%2264%22%3E%3Crect width=%2264%22 height=%2264%22 fill=%22red%22/%3E%3C/svg%3E"></div></div></div></div>'
        + '<div data-index="2" style="transform:scale(-1,-1)"><div class="MessageBoxTimetimeLayout">30分钟前</div><div class="messageMessageBoxmessageBox"><div data-e2e="msg-item-content"><div class="MessageItemTextcontainer">较旧合成消息</div></div></div></div>';
    });
    const { contacts } = await chat.listContacts();
    const read = await chat.readConversation(contacts[0].id, { allowed: true });
    assert.deepEqual(read.messages.map(item => item.domIndex), [2, 1, 0]);
    assert.deepEqual(read.messages.map(item => item.order), [0, 1, 2]);
    assert.equal(read.messages.every(item => item.orderMode === 'relative'), true);
    assert.equal(read.messages.every(item => item.latestEndVerified === true), true);
    assert.equal(read.messages[0].text, '较旧合成消息'); assert.equal(read.messages[2].text, '最新合成消息');
    await chat.markMessages(page, read.messages);
    assert.equal(await page.locator('[data-index="0"] [data-e2e="msg-item-content"]').getAttribute('data-deepseek-message-id'), read.messages[2].id);
    assert.equal(await page.locator('[data-index="2"] [data-e2e="msg-item-content"]').getAttribute('data-deepseek-message-id'), read.messages[0].id);
    const captured = await chat.captureMessage(contacts[0].id, read.messages[1].id, { allowed: true });
    assert.equal(captured.frames.length, 1); assert.equal(captured.media.type, 'emoji');
    await page.evaluate(() => document.querySelector('[data-index="0"]').remove());
    const olderWindow = await chat.readConversation(contacts[0].id, { allowed: true });
    assert.equal(olderWindow.messages.every(item => item.orderMode === 'relative' && item.latestEndVerified === false), true);
    assert.equal(olderWindow.messages.some(item => item.eligibleForReply), false);
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});

test('消息列表拓扑未知时不把相对位置当永久水位，不授予新回复资格', async () => {
  const { page, chat } = await fixture();
  try {
    await page.evaluate(() => document.querySelector('#message-list').className = 'messageMessageListlist');
    const { contacts } = await chat.listContacts();
    await chat.readConversation(contacts[0].id, { allowed: true });
    await page.evaluate(() => {
      const row = document.createElement('div'); row.setAttribute('data-index', '1');
      row.innerHTML = '<div class="messageMessageBoxmessageBox"><div data-e2e="msg-item-content" data-message-id="fixture-new-native"><div class="MessageItemTextcontainer">另一合成消息</div></div></div>';
      document.querySelector('#message-list').append(row);
    });
    const read = await chat.readConversation(contacts[0].id, { allowed: true });
    assert.equal(read.messages.every(item => item.orderMode === 'relative' && item.latestEndVerified === false), true);
    assert.equal(read.messages.some(item => item.eligibleForReply), false);
    const raw = await page.evaluate(readConversationDom);
    assert.equal(raw.chronology, 'unknown'); assert.equal(raw.sourceDomOrder, 'unknown');
    assert.equal(await page.evaluate(() => window.sent), 0);
  } finally { await chat.close(); }
});
