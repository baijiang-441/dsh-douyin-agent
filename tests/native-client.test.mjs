import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = await fs.readFile(path.join(root, 'client.js'), 'utf8');
function load() {
  let definition; const dependencies = [];
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: value => { definition = value; } } }, globalThis: {}, AbortSignal, Set, Error }, { filename: 'client.js' });
  const plugin = definition.factory(name => { dependencies.push(name); if (name === 'react') return {}; if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Button() {} }; throw new Error(`意外客户端依赖 ${name}`); });
  return { definition, dependencies, plugin };
}

test('原生客户端以实际包身份自注册设置插槽，依赖已有静态组件而非不存在runtime包', async () => {
  const { definition, plugin, dependencies } = load(), manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(definition.id, manifest.name); assert.deepEqual(dependencies, ['react', '@deepseek-ai/dsh-client-ui-primitives']);
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-settings-general']);
  let slot, component, disposed = false;
  plugin.apply({ slots: { inject(name, action) { assert.equal(name, 'settings.section'); this.cleanup = action(); }, register(options, view) { slot = options; component = view; return () => { disposed = true; }; } } });
  assert.equal(slot.id, 'douyin-browser'); assert.equal(slot.name, 'settings.section'); assert.equal(slot.label(), '刷抖音'); assert.equal(component, plugin.SettingsPage); assert.equal(disposed, false);
  assert.doesNotMatch(source, /dsh-client-runtime|http:\/\/127\.0\.0\.1:3218/);
});

test('原生设置仅同源请求，会话token只进写请求头，403不隐式重试，无载体file页明确拒绝', async () => {
  const { plugin } = load(), calls = [];
  const native = plugin.createSettingsTransport({ location: { protocol: 'http:', hostname: '127.0.0.1' }, fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => url.endsWith('/state') ? { token: 'synthetic-native-token', persona: {} } : { saved: true } }; } });
  await assert.rejects(native.request('/video/start', {}), /先刷新/); assert.equal(calls.length, 0);
  const state = await native.request('/state'); assert.equal(state.token, undefined);
  await native.request('/mode/configure', { silent: true }); assert.equal(calls[1].url, '/api/douyin-browser/mode/configure'); assert.equal(calls[1].init.headers['x-douyin-settings-token'], 'synthetic-native-token'); assert.equal(calls[1].init.body, '{"silent":true}'); assert.equal(calls[1].init.credentials, 'same-origin');
  await assert.rejects(native.request('//evil.example/state'), /只允许/); await assert.rejects(native.request('/reports/read?date=2026-10-15&token=x'), /只允许/);
  let leaked = false; const unavailable = plugin.createSettingsTransport({ location: { protocol: 'file:', hostname: '' }, fetch: () => { leaked = true; } }); await assert.rejects(unavailable.request('/state'), /没有可用的插件设置通信接口/); assert.equal(leaked, false);
  const denied = plugin.createSettingsTransport({ location: { protocol: 'http:', hostname: '127.0.0.1' }, fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: '合成授权已过期。' }) }) });
  await assert.rejects(denied.request('/state'), error => error.status === 403); assert.equal(calls.length, 2);
  let carried = false; const carrier = plugin.createSettingsTransport({ location: { protocol: 'file:', hostname: '' }, __DSH_TRANSPORT__: { fetch: async () => { carried = true; return { ok: true, json: async () => ({ token: 'synthetic-carrier' }) }; } } });
  await carrier.request('/state'); assert.equal(carried, true);
});

test('官方桌面 dsh-app 同源设置可请求，其他自定义域名仍拒绝，非JSON响应提示后端兼容性', async () => {
  const { plugin } = load(), calls = [];
  const desktop = plugin.createSettingsTransport({ location: { protocol: 'dsh-app:', hostname: 'app' }, fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ token: 'synthetic-desktop-token' }) }; } });
  await desktop.request('/state'); await desktop.request('/browser/open', {});
  assert.equal(calls.length, 2); assert.equal(calls[0].url, '/api/douyin-browser/state');
  assert.equal(calls[1].init.headers['x-douyin-settings-token'], 'synthetic-desktop-token');
  const bound = { fetch() { assert.equal(this, bound); return Promise.resolve({ ok: true, json: async () => ({ token: 'synthetic-bound-token' }) }); } };
  await plugin.createSettingsTransport({ __DSH_TRANSPORT__: bound }).request('/state');
  for (const location of [{ protocol: 'dsh-app:', hostname: 'other' }, { protocol: 'https:', hostname: 'example.com' }]) {
    const rejected = plugin.createSettingsTransport({ location, fetch: () => assert.fail('不应向未支持来源发送请求') });
    await assert.rejects(rejected.request('/state'), /没有可用的插件设置通信接口/);
  }
  const missing = plugin.createSettingsTransport({ location: { protocol: 'dsh-app:', hostname: 'app' }, fetch: async () => ({ ok: false, status: 404, json: async () => { throw new SyntaxError('HTML'); } }) });
  await assert.rejects(missing.request('/state'), error => error.status === 404 && /WebServer.*版本兼容性/.test(error.message));
});

test('file 桌面页优先复用宿主 RPC，令牌只进载荷，写失败不换载体重试', async () => {
  const { plugin } = load(), calls = [];
  const rpc = { async call(channel, endpoint, payload) { calls.push({ channel, endpoint, payload }); return { ok: true, value: { status: 200, body: payload.path === '/state' ? { token: 'synthetic-rpc-session', model: {} } : { saved: true } } }; } };
  const transport = plugin.createSettingsTransport({ location: { protocol: 'file:', hostname: '' }, fetch: () => assert.fail('不能猜测 file 页的 HTTP 服务地址') }, rpc);
  const state = await transport.request('/state'); assert.equal(state.token, undefined);
  await transport.request('/video/configure', { sessionMinutes: 5 });
  assert.equal(calls[1].channel, '/douyin-settings'); assert.equal(calls[1].endpoint, 'request'); assert.equal(calls[1].payload.token, 'synthetic-rpc-session');
  assert.deepEqual(calls[1].payload.input, { sessionMinutes: 5 });
  const denied = plugin.createSettingsTransport({ location: { protocol: 'file:', hostname: '' }, fetch: () => assert.fail('RPC 失败不能自动重放写操作') }, { async call() { return { ok: true, value: { status: 403, body: { error: '合成会话过期' } } }; } });
  await assert.rejects(denied.request('/state'), error => error.status === 403);
});

test('常用 dsh 桌面协议和本机 HTTPS 可使用已有 Fetch，仍拒绝其他主机', async () => {
  const { plugin } = load();
  for (const location of [{ protocol: 'dsh:', hostname: 'app' }, { protocol: 'https:', hostname: 'localhost' }]) {
    let called = false; const transport = plugin.createSettingsTransport({ location, fetch: async () => { called = true; return { ok: true, json: async () => ({ token: 'synthetic-local-token' }) }; } });
    await transport.request('/state'); assert.equal(called, true);
  }
});

test('原生设置自动保存有效输入，保留并发草稿，好友共用总开关且每日观看按时段生效', { timeout: 60_000 }, async t => {
  const desktop = createRequire(new URL('../desktop/package.json', import.meta.url)), local = createRequire(new URL('../desktop/ui-api/package.json', import.meta.url));
  let build, chromium;
  try { ({ build } = desktop('esbuild')); ({ chromium } = await import('../playwright-runtime.mjs')); local.resolve('react'); } catch { t.skip('可选原生页面检查需要已有桌面构建依赖和临时 Edge。'); return; }
  const assets = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-native-client-ui-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(assets)), path.resolve(os.tmpdir())); await fs.rm(assets, { recursive: true, force: true }); });
  const nativeAssets = 'F:/codex/DSH Desktop 2/resources/app/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets';
  try { await fs.writeFile(path.join(assets, 'native-theme.css'), (await Promise.all(['vendor-BNsW4eBh.css', 'index-BPHePDI_.css'].map(file => fs.readFile(path.join(nativeAssets, file), 'utf8')))).join('\n')); } catch { await fs.writeFile(path.join(assets, 'native-theme.css'), ''); }
  const upstream = path.join(root, 'desktop/.cache/upstream/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/client');
  await build({ stdin: { sourcefile: 'native-client-harness.jsx', resolveDir: root, loader: 'jsx', contents: `import React from 'react';import{createRoot}from'react-dom/client';import * as primitives from '@native/primitives';import '@native/theme/base.css';import '@native/theme/design-platform.css';window.__ModuleLoader__={load({factory}){const plugin=factory(name=>name==='react'?React:name==='@deepseek-ai/dsh-client-ui-primitives'?primitives:(()=>{throw Error('意外依赖')})());window.__nativePlugin=plugin;plugin.apply({slots:{inject(name,action){action()},register(options,Component){createRoot(document.getElementById('root')).render(<Component/>);return()=>{}}}})}};const original=setInterval;window.setInterval=(fn,ms)=>original(fn,Math.min(ms,100));const script=document.createElement('script');script.src='/client.js';document.body.appendChild(script);` }, bundle: true, outfile: path.join(assets, 'harness.js'), format: 'esm', platform: 'browser', target: 'chrome120', jsx: 'automatic', alias: { '@native/primitives': path.join(upstream, 'ui-primitives/src/index.ts'), '@native/theme': path.join(upstream, 'ui-theme/src/styles'), ...Object.fromEntries(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'].map(name => [name, local.resolve(name)])) }, nodePaths: [path.join(root, 'desktop/ui-api/node_modules')], tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } }, loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, assetNames: 'assets/[name]-[hash]', minify: true });
  const stable = (hex, name, extra = {}) => ({ id: 'conv:' + hex.repeat(64), name, followed: true, isGroup: false, identityVerified: true, identityBinding: 'binding:' + hex.repeat(64), identityVersion: 2, identityKind: 'rendered-user', identityHash: hex.repeat(64), verifiedAt: '2026-10-24T00:00:00.000Z', authorizationKind: 'following', ...extra });
  const allowed = [stable('a', '合成许可好友甲'), stable('b', '合成群聊乙', { followed: null, isGroup: true, identityKind: 'rendered-group', relationshipStatus: 'unavailable', authorizationKind: 'existing-group' }), { id: 'conv:' + 'c'.repeat(64), name: '合成未知类型', followed: null, isGroup: null, identityVerified: false, relationshipStatus: 'unavailable' }, { id: 'conv:' + 'e'.repeat(64), name: '合成缺少稳定身份', followed: true, isGroup: false, identityVerified: true, identityBinding: 'binding:' + 'e'.repeat(64) }];
  const state = { token: 'synthetic-native-settings', persona: { manualText: '合成人格初始正文。', revision: 'synthetic-v1', personaFolder: 'C:/合成记忆/persona' }, model: { configured: true, providers: [{ id: 'synthetic', name: '合成已配置提供商' }], models: [{provider:'synthetic',id:'synthetic-vision',name:'合成视觉模型'},{provider:'synthetic',id:'synthetic-other',name:'合成另一模型'}], provider: 'synthetic', model: 'synthetic-vision' }, video: { allowed: false, reason: '请先开始新一轮。', policy: { windows: ['00:00-24:00'], sessionMinutes: 10 }, session: null }, watch: { running: false, counts: { maxRequests: 30 } }, mode: { silent: false }, spark: { enabled: false, running: false, policy: { windows: ['09:00-22:00'], dailyLimit: 2 }, recipients: [allowed[0]], needsReview: [] }, comments: { enabled: false, policy: { dailyLimit: 3, perSessionLimit: 1 }, daily: { attempts: 0 }, session: { attempts: 0 }, needsReview: [] }, share: { enabled: false, dailyLimit: 3, needsReview: [] }, chat: { running: false, policy: { allowlist: [{ ...allowed[0] }], dailyReplyLimit: 40 }, contacts: [] }, media: { enabled: false, backend: 'local-whisper', backends: { mimo: { credential: { configured:false } }, minimax: { credential: { configured:false } } } }, reports: { date: '2026-10-15', folder: 'C:/合成记忆/reports/videos', reports: [] } };
  state.video.policy = { windows: ['00:00-24:00'], dailyMinutes: 10, dailyRequests: 30 }; state.video.daily = { usedSeconds: 12, requests: 2 };
  state.schedule = { policy: { enabled: false } }; state.interactions = { policy: { enabled: true }, friend: { replyRunning: false, shareEnabled: true, message: '合成好友互动等待就绪。' }, rows: [] };
  state.interactions.presence = { status: 'online', online: true, label: '在线 · 等待消息', reason: '合成后端确认许可会话全部就绪', checkedAt: new Date().toISOString() };
  state.watchOptions = { policy: { mode:'recommend', topics:[], exclude:[] } };
  state.usage = { today: { requests:2,totalTokens:4321,promptTokens:4000,completionTokens:321,cachedTokens:3000,cacheReportedRequests:1,unknownRequests:0 }, groups:[], days:[], note:'合成用量说明' };
  const calls = [], errors = []; let failState = false, failComments = false, failInteractions = false, videoSaveGate = null, chatSaveGate = null, resolveGate = null, listOverride = null, stateVideoOverride = null, stateReadGate = null, startOnConfigure = false;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost'), reply = (value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (url.pathname.startsWith('/api/douyin-browser/')) {
      let raw = ''; for await (const chunk of request) raw += chunk; const input = raw ? JSON.parse(raw) : null;
      calls.push({ route: url.pathname.replace('/api/douyin-browser', ''), method: request.method, body: input, token: request.headers['x-douyin-settings-token'] });
      if (url.pathname.endsWith('/state')) { if (stateReadGate) await stateReadGate.wait; return failState ? reply({ error: '合成原生状态暂不可用。' }, 503) : reply(stateVideoOverride ? { ...state, video: stateVideoOverride } : state); }
      if (request.method === 'POST' && request.headers['x-douyin-settings-token'] !== state.token) return reply({ error: '合成令牌不符。' }, 403);
      const route = url.pathname.replace('/api/douyin-browser', '');
      if (route === '/persona/configure') { if (input.expectedRevision !== state.persona.revision) return reply({ error: '合成人格版本冲突。' }, 409); state.persona = { ...state.persona, manualText: input.content, revision: 'synthetic-v3' }; }
      if (route === '/video/start') { state.video.allowed = true; state.video.reason = ''; state.video.session = { status: 'active' }; }
      if (route === '/watch/start') state.watch.running = true;
      if (route === '/watch/stop') state.watch.running = false;
      if (route === '/spark/configure') { state.spark.enabled = input.enabled; state.spark.policy = input; }
      if (route === '/model/configure') { state.model.provider=input.provider;state.model.model=input.model;state.model.configured=true; }
      if (route === '/media/credentials') { state.media.backends[input.backend].credential={configured:true,source:'shared-env',saved:true,environmentOverride:false}; }
      if (route === '/comments/configure') { if (failComments) return reply({ error: '合成评论设置忙。' }, 409); state.comments.enabled = input.enabled; state.comments.policy = input; }
      if (route === '/diagnostics') return reply({reportId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',checks:[{id:'window',code:'SILENT_WINDOW_VISIBLE',status:'fail',label:'静默窗口实际状态',message:'合成窗口仍显示',resolution:{steps:['合成修复建议']}}],repairableActions:[{id:'reapply_silent',label:'重新应用静默设置'}],note:'合成自检不调用真实服务'});
      if (route === '/diagnostics/repair') { assert.deepEqual(input,{reportId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',action:'reapply_silent'}); return reply({message:'合成修复已回读',after:{reportId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',checks:[{id:'window',code:'SILENT_WINDOW_MINIMIZED',status:'pass',label:'静默窗口实际状态',message:'合成已最小化'}],repairableActions:[]}}); }
      if (route === '/watch/options') state.watchOptions.policy = input;
      if (route === '/video/configure') { state.video.policy = { ...input, windows: [...new Set(input.windows)] }; if (videoSaveGate) { const gate = videoSaveGate; videoSaveGate = null; gate.received(); await gate.wait; } return reply(state.video); }
      if (route === '/watch/schedule') { state.schedule.policy = { enabled: input.enabled }; if (!input.enabled) state.watch.running = false; else if (startOnConfigure) state.watch.running = true; }
      if (route === '/media/configure') { state.media.enabled = input.enabled; state.media.backend = input.backend; return reply(state.media); }
      if (route === '/interactions/configure') { if (failInteractions) return reply({ error: '合成好友互动设置失败。' }, 409); state.interactions.policy.enabled = input.enabled; state.interactions.friend.replyRunning = input.enabled; state.share.enabled = input.enabled; state.chat.running = input.enabled; return reply(state.interactions); }
      if (route === '/chat/configure') { state.chat.policy = { ...state.chat.policy, allowlist: input.recipientIds.map(id => { const contact = allowed.find(item => item.id === id); return { ...contact, authorizationKind: contact.isGroup ? 'existing-group' : 'following' }; }), groupMentionNames: input.groupMentionNames, dailyReplyLimit: null }; if (chatSaveGate) { const gate = chatSaveGate; chatSaveGate = null; gate.received(); await gate.wait; } return reply(state.chat); }
      if (route === '/chat/resolve') { if (resolveGate) { const gate = resolveGate; resolveGate = null; gate.received(); await gate.wait; } state.chat.contacts = state.chat.contacts.map(item => item.id === input.recipientId ? { ...item, status: 'ready', reason: '' } : item); return reply(state.chat); }
      if (route === '/mode/configure') state.mode.silent = input.silent;
      if (route === '/chat/contacts') return reply({ contacts: listOverride || allowed, listDiscovery: { source: 'current-conversation-list', scannedToEnd: false, count: (listOverride || allowed).length, reason: '合成读取预算已到，只返回当前网页会话。' } });
      if (route === '/reports/read' || route === '/reports/generate') return reply({ date: '2026-10-15', markdown: '# 合成观看日报\n只整理已有证据。' });
      return reply({ ok: true });
    }
    if (url.pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/native-theme.css"><link rel="stylesheet" href="/harness.css"></head><body data-ds-dark-theme style="background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);padding:24px"><p style="font-size:12px;color:var(--dsw-alias-label-tertiary)">合成设置页预览：未连接真实联系人、模型或抖音。</p><div id="root"></div><script type="module" src="/harness.js"></script></body></html>'); return; }
    if (url.pathname === '/client.js') { response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); response.end(source); return; }
    if (url.pathname === '/harness.js') { response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); response.end(await fs.readFile(path.join(assets, 'harness.js'))); return; }
    try { const target = path.resolve(assets, url.pathname.slice(1)); if (!target.startsWith(assets + path.sep)) throw new Error(); const content = await fs.readFile(target); response.writeHead(200, { 'content-type': target.endsWith('.css') ? 'text/css' : target.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream' }); response.end(content); } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'douyin-native-client-edge-')), browser = await chromium.launchPersistentContext(profile, { headless: true, channel: 'msedge', viewport: { width: 1100, height: 900 } });
  t.after(async () => { await browser.close(); assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir())); await fs.rm(profile, { recursive: true, force: true }); });
  const page = browser.pages()[0]; page.setDefaultTimeout(8000); page.on('pageerror', error => { errors.push(error.message); t.diagnostic(error.stack || error.message); }); await page.goto(`http://127.0.0.1:${server.address().port}`);
  const persona = page.getByRole('textbox', { name: '大肥鱼人格正文', exact: true }); await persona.waitFor();
  assert.equal(await persona.inputValue(), '合成人格初始正文。'); assert.equal(calls.some(item => item.method === 'POST'), false);
  assert.match(await page.getByRole('button', { name: '查看好友互动状态', exact: true }).innerText(), /在线 · 等待消息/);
  assert.equal(await page.getByRole('button', { name: '查看好友互动状态', exact: true }).getAttribute('title'), '合成后端确认许可会话全部就绪');
  assert.equal(await page.getByRole('tab').count(), 7); assert.equal(await page.getByRole('button', { name: /^保存/ }).count(), 0);
  await persona.fill('合成人格未保存草稿。'); await page.waitForTimeout(250); assert.equal(calls.some(item => item.route === '/persona/configure'), false);
  let releaseState; stateReadGate = { wait: new Promise(resolve => { releaseState = resolve; }) };
  state.persona = { ...state.persona, manualText: '合成外部更新正文。', revision: 'synthetic-v2' }; await persona.press('Tab');
  await page.getByRole('alert').filter({ hasText: '草稿已保留' }).waitFor(); assert.equal(await persona.inputValue(), '合成人格未保存草稿。');
  await page.getByRole('button', { name: '载入最新人格（替换草稿）', exact: true }).click();
  stateReadGate = null; releaseState();
  await page.waitForFunction(() => document.querySelector('[aria-label="大肥鱼人格正文"]').value === '合成外部更新正文。');
  await persona.fill('合成人格明确保存的新正文。'); await persona.press('Tab');
  await page.waitForFunction(() => document.querySelector('[aria-label="大肥鱼人格正文"]').value === '合成人格明确保存的新正文。');
  for (let count = 0; count < 40 && state.persona.revision !== 'synthetic-v3'; count++) await page.waitForTimeout(50);
  assert.equal(state.persona.manualText, '合成人格明确保存的新正文。');
  await page.getByRole('tab', { name: '视频观看', exact: true }).click();
  await page.getByText('高级选项', { exact: true }).click();
  const minutes = page.getByRole('spinbutton', { name: '每日观看上限（分钟）', exact: true });
  await minutes.fill(''); const invalidCount = calls.filter(item => item.route === '/video/configure').length;
  await page.waitForTimeout(750); assert.equal(calls.filter(item => item.route === '/video/configure').length, invalidCount);
  await minutes.fill('25'); await page.waitForTimeout(850); assert.equal(state.video.policy.dailyMinutes, 25); assert.equal(state.video.policy.dailyRequests, 30);
  let releaseVideoSave;
  const saved = new Promise(received => { videoSaveGate = { received, wait: new Promise(resolve => { releaseVideoSave = resolve; }) }; });
  await page.getByRole('checkbox', { name: '不限每日观看时长', exact: true }).click(); await saved;
  await minutes.fill('35'); releaseVideoSave(); await page.waitForTimeout(250);
  assert.equal(await minutes.inputValue(), '35'); assert.equal(state.video.policy.dailyMinutes, null);
  await page.waitForTimeout(700); assert.equal(state.video.policy.dailyMinutes, 35);
  stateVideoOverride = structuredClone(state.video);
  await page.getByRole('checkbox', { name: '不限每日观看时长', exact: true }).click(); await page.waitForTimeout(350);
  assert.equal(state.video.policy.dailyMinutes, null); assert.equal(await minutes.inputValue(), '');
  stateVideoOverride = null; await page.waitForTimeout(250);
  state.video.policy = { ...state.video.policy, dailyMinutes: 45 }; await page.waitForFunction(() => document.querySelector('[aria-label="每日观看上限（分钟）"]').value === '45');
  await page.getByRole('checkbox', { name: '允许自动观看', exact: true }).click(); await page.waitForFunction(() => document.querySelector('[aria-label="允许自动观看"]').checked === true);
  assert.equal(state.schedule.policy.enabled, true); assert.equal(await page.getByRole('button', { name: /开始新一轮|停止自主观看|保存/ }).count(), 0);
  const startViewing = page.getByRole('button', { name: '开始自主观看', exact: true }), pauseViewing = page.getByRole('button', { name: '暂停观看', exact: true });
  assert.equal(await startViewing.isEnabled(), true, '总开关已开启但未运行时，可请求立即检查');
  const dailyBeforeViewing = structuredClone(state.video.daily); startOnConfigure = true; await startViewing.click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '开始自主观看' && button.disabled));
  await pauseViewing.click(); await page.waitForFunction(() => !document.querySelector('[aria-label="允许自动观看"]').checked);
  assert.equal(state.watch.running, false); assert.deepEqual(state.video.daily, dailyBeforeViewing, '开始/暂停不重置每日时长或请求次数'); startOnConfigure = false;
  await page.getByRole('button', { name: '谷时段（DeepSeek）', exact: true }).click(); await page.waitForTimeout(250); assert.deepEqual(state.video.policy.windows, ['00:00-09:00', '12:00-14:00', '18:00-24:00']);
  await page.getByRole('combobox', { name: '观看方式', exact: true }).selectOption('topic'); await page.getByRole('textbox', { name: '想看的主题，每行一个', exact: true }).fill('合成天文'); await page.waitForTimeout(850);
  assert.deepEqual(state.watchOptions.policy.topics, ['合成天文']);
  await page.getByRole('checkbox', { name: '静默观看', exact: true }).click(); await page.waitForTimeout(250); assert.equal(state.mode.silent, true);
  await page.getByRole('tab', { name: '好友互动', exact: true }).click();
  assert.equal(await page.getByRole('checkbox', { name: '允许好友互动', exact: true }).isChecked(), true);
  state.share.recent = [{ operationId: 'synthetic-share-failure', videoId: '11111', status: 'not-sent', failure: { code: 'SHARE_PANEL_UNAVAILABLE', stage: 'open-panel', message: '合成分享面板未显示。' } }, { operationId: 'synthetic-share-legacy', videoId: '22222', status: 'not-sent' }];
  await page.getByRole('button', { name: '刷新插件状态', exact: true }).click();
  await page.getByText('最近分享记录', { exact: true }).click();
  await page.getByText('原因：合成分享面板未显示。', { exact: true }).waitFor();
  await page.getByText('原因：旧记录没有保存详细失败原因。', { exact: true }).waitFor();

  assert.equal(await page.getByRole('spinbutton').count(), 0); assert.equal(await page.getByRole('button', { name: /启用|停止|保存|问候/ }).count(), 0);
  const beforeListSave = calls.filter(item => item.route === '/chat/configure').length;
  await page.getByRole('button', { name: '读取联系人与群聊', exact: true }).click();
  const group = page.getByRole('checkbox', { name: '许可联系人 合成群聊乙', exact: true }); await group.waitFor(); assert.equal(await group.isDisabled(), true);
  assert.equal(calls.filter(item => item.route === '/chat/configure').length, beforeListSave, '读取列表不得自动改名单');
  await page.getByText('当前列表尚未完整读取。', { exact: false }).waitFor();
  await page.getByRole('checkbox', { name: '授权已核对的现有会话', exact: true }).check(); await page.waitForTimeout(100);
  assert.equal(calls.filter(item => item.route === '/chat/configure').length, beforeListSave, '单独授权确认不得先保存空或未变名单');
  await group.check();
  const names = page.getByRole('textbox', { name: '群聊响应昵称（逗号或换行分隔）', exact: true }); await names.fill('大肥鱼,小肥鱼'); await names.press('Tab'); await page.waitForTimeout(300);
  assert.ok(state.chat.policy.allowlist.some(item => item.id === 'conv:' + 'b'.repeat(64))); assert.deepEqual(state.chat.policy.groupMentionNames, ['大肥鱼', '小肥鱼']);
  await group.locator('..').getByText('已许可 · 稳定身份已核对 · 群聊会话', { exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: '许可联系人 合成未知类型', exact: true }).isDisabled(), true);
  const weak = page.getByRole('checkbox', { name: '许可联系人 合成缺少稳定身份', exact: true }); assert.equal(await weak.isDisabled(), true); await weak.locator('..').getByText(/身份信息不足/).waitFor();
  allowed[0].name = '合成许可好友甲新昵称'; const other = stable('d', allowed[0].name); allowed.push(other); const savesBeforeRename = calls.filter(item => item.route === '/chat/configure').length;
  await page.getByRole('button', { name: '读取联系人与群聊', exact: true }).click(); const sameName = page.getByRole('checkbox', { name: `许可联系人 ${allowed[0].name}`, exact: true }); await sameName.nth(1).waitFor(); assert.equal(await sameName.nth(0).isChecked(), true); assert.equal(await sameName.nth(1).isChecked(), false); await sameName.nth(0).locator('..').getByText(/^已许可 · 稳定身份已核对/).waitFor(); assert.equal(calls.filter(item => item.route === '/chat/configure').length, savesBeforeRename, '改昵称和读取同名账号不自动改许可名单'); allowed[0].name = '合成许可好友甲';
  listOverride = allowed.filter(item => item.isGroup === true); const beforePartialRead = calls.filter(item => item.route === '/chat/configure').length;
  await page.getByRole('button', { name: '读取联系人与群聊', exact: true }).click();
  const missingSaved = page.getByRole('checkbox', { name: '许可联系人 合成许可好友甲', exact: true }); await missingSaved.waitFor();
  assert.equal(await missingSaved.isChecked(), true); await missingSaved.locator('..').getByText('已许可 · 稳定身份已核对 · 本次列表未返回', { exact: true }).waitFor();
  assert.equal(calls.filter(item => item.route === '/chat/configure').length, beforePartialRead, '部分会话列表不能导致原许可消失或触发保存');
  listOverride = null;
  state.chat.contacts = [{ id: allowed[0].id, status: 'paused', reason: '合成需要核对' }]; await page.getByRole('button', { name: '刷新插件状态', exact: true }).click();
  const resolve = page.getByRole('button', { name: '已人工核对该会话', exact: true }); await resolve.waitFor();
  let releaseChatSave; const savingChat = new Promise(received => { chatSaveGate = { received, wait: new Promise(resolve => { releaseChatSave = resolve; }) }; });
  await names.fill('大肥鱼,小肥鱼,合成昵称'); await names.press('Tab'); await savingChat; assert.equal(await resolve.isDisabled(), true, '名单保存期间不能并发解除暂停'); releaseChatSave();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '已人工核对该会话' && !button.disabled));
  let releaseResolve; const resolving = new Promise(received => { resolveGate = { received, wait: new Promise(resolve => { releaseResolve = resolve; }) }; });
  await resolve.click(); await resolving; assert.equal(await page.getByRole('button', { name: '处理中…', exact: true }).isDisabled(), true); releaseResolve(); await resolve.waitFor({ state: 'hidden' });
  assert.equal(calls.filter(item => item.route === '/chat/resolve').length, 1);
  state.chat.running = true;
  await page.getByRole('tab', { name: '基础设置', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '大肥鱼人格正文', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('combobox', { name: '模型名称', exact: true }).isEnabled(), true);
  await page.getByRole('tab', { name: '好友互动', exact: true }).click();
  const many = Array.from({ length: 52 }, (_, index) => { const hex = (1000 + index).toString(16).padStart(64, '0'); return { ...stable('f', `合成多选好友${index + 1}`), id: 'conv:' + hex, identityHash: hex, identityBinding: 'binding:' + hex }; });
  allowed.push(...many); state.chat.policy.allowlist = many.slice(0, 51); await page.waitForTimeout(250);
  await page.getByRole('button', { name: '读取联系人与群聊', exact: true }).click();
  const fiftySecond = page.getByRole('checkbox', { name: '许可联系人 合成多选好友52', exact: true }); await fiftySecond.waitFor(); assert.equal(await fiftySecond.isEnabled(), true); await fiftySecond.check(); await page.waitForTimeout(300);
  assert.equal(state.chat.policy.allowlist.length, 52);
  failInteractions = true; await page.getByRole('checkbox', { name: '允许好友互动', exact: true }).click(); await page.getByRole('alert').filter({ hasText: '合成好友互动设置失败' }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: '允许好友互动', exact: true }).isChecked(), true);
  failInteractions = false; await page.getByRole('checkbox', { name: '允许好友互动', exact: true }).click(); await page.waitForFunction(() => !document.querySelector('[aria-label="允许好友互动"]').checked);
  assert.equal(state.share.enabled, false); assert.equal(state.chat.running, false);
  assert.equal(calls.some(item => /^\/spark\/|^\/chat\/(?:start|stop)$|^\/share\/configure$/.test(item.route)), false);
  await page.getByRole('tab', { name: '公开评论', exact: true }).click(); await page.getByRole('checkbox', { name: '允许自主发布评论', exact: true }).check(); await page.waitForTimeout(250);
  assert.equal(state.comments.enabled, true); assert.equal(await page.getByRole('button', { name: '保存评论许可', exact: true }).count(), 0);
  await page.getByRole('tab', { name: '音频与密钥', exact: true }).click();
  const key = page.getByLabel('MiMo API Key', { exact: true }); await key.fill('synthetic-mimo-key'); const beforeBlur = calls.filter(item => item.route === '/media/credentials').length; await page.waitForTimeout(250); assert.equal(calls.filter(item => item.route === '/media/credentials').length, beforeBlur);
  await key.press('Tab'); await page.waitForFunction(() => document.querySelector('[aria-label="MiMo API Key"]').value === '');
  assert.equal(state.media.enabled, false); assert.deepEqual(calls.filter(item => item.route === '/media/credentials').at(-1).body, { backend: 'mimo', apiKey: 'synthetic-mimo-key' });
  assert.equal(await page.getByRole('button', { name: /^保存/ }).count(), 0);
  await page.getByRole('tab', { name: '观看日报', exact: true }).click(); await page.getByRole('button', { name: '读取所选日报', exact: true }).click(); await page.getByLabel('日报内容').filter({ hasText: '合成观看日报' }).waitFor();
  await page.getByRole('tab', { name: '自检与用量', exact: true }).click(); await page.getByText('模型响应 2 次 · 已报告 4321 Token', { exact: true }).waitFor();
  state.usage.today.totalTokens = 6789; await page.getByText('模型响应 2 次 · 已报告 6789 Token', { exact: true }).waitFor();
  failState = true; await page.getByText('正在核实插件状态。', { exact: true }).waitFor(); failState = false;
  await page.getByRole('button', { name: '刷新插件状态', exact: true }).click(); await page.getByText('正在核实插件状态。', { exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '一键自检', exact: true }).click(); await page.getByText('合成修复建议', { exact: true }).waitFor(); await page.getByRole('button', { name: '修复：重新应用静默设置', exact: true }).click(); await page.getByText('合成修复已回读', { exact: true }).waitFor();
  state.watch.running = true; state.interactions.presence = { status: 'attention', online: false, label: '回复未就绪', reason: '合成许可联系人需要核对' };
  await page.getByRole('button', { name: '查看好友互动状态', exact: true }).filter({ hasText: '回复未就绪' }).waitFor(); await page.getByRole('alert').filter({ hasText: '合成许可联系人需要核对' }).waitFor();
  await page.getByRole('button', { name: '查看好友互动状态', exact: true }).click(); assert.equal(await page.getByRole('tab', { name: '好友互动', exact: true }).getAttribute('aria-selected'), 'true');
  state.watch.running = false;
  assert.equal(calls.filter(item => item.method === 'POST').every(item => item.token === state.token), true); assert.deepEqual(errors, []);
});
