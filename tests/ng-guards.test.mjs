// tests/ng-guards.test.mjs — ng 重建（2026-10-26）纯函数判定的边界单测。
// 覆盖 chat-browser sameWatermark（本地补丁 v2.2 语义）与观看决策契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWatermark, validateWatchDecisionShape } from '../lib/guards.mjs';

const fp = n => `f${String(n).padStart(64, '0')}`;

test('前缀被虚拟列表裁掉、后缀完整 → 放行', () => {
  const verdict = checkWatermark({
    expectedIds: ['a', 'b', 'c'], expectedFingerprints: [fp(1), fp(2), fp(3)],
    ids: ['b', 'c'], fingerprints: [fp(2), fp(3)]
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.matchedUntil, 0);
});

test('头部补载旧历史 + 尾部新消息 → 都放行', () => {
  const verdict = checkWatermark({
    expectedIds: ['a', 'b'], expectedFingerprints: [fp(1), fp(2)],
    ids: ['old1', 'a', 'b', 'new1'], fingerprints: [fp(9), fp(1), fp(2), fp(8)]
  });
  assert.equal(verdict.ok, true);
});

test('完全一致 → 放行', () => {
  const verdict = checkWatermark({
    expectedIds: ['a', 'b'], expectedFingerprints: [fp(1), fp(2)],
    ids: ['a', 'b'], fingerprints: [fp(1), fp(2)]
  });
  assert.equal(verdict.ok, true);
});

test('锚点（expected 最新一条）缺失 → 拦下', () => {
  const verdict = checkWatermark({
    expectedIds: ['a', 'b'], expectedFingerprints: [fp(1), fp(2)],
    ids: ['a'], fingerprints: [fp(1)]
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'anchor-missing-or-changed');
});

test('空列表 → 拦下', () => {
  const verdict = checkWatermark({ expectedIds: ['a'], expectedFingerprints: [fp(1)], ids: [], fingerprints: [] });
  assert.equal(verdict.ok, false);
});

test('非锚点既有消息指纹变化 → 拦下', () => {
  const verdict = checkWatermark({
    expectedIds: ['a', 'b'], expectedFingerprints: [fp(1), fp(2)],
    ids: ['a', 'b'], fingerprints: [fp(7), fp(2)]
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'known-fingerprint-changed');
});

test('锚点自身指纹变化 → 拦下（anchor-missing-or-changed）', () => {
  const verdict = checkWatermark({
    expectedIds: ['a', 'b'], expectedFingerprints: [fp(1), fp(2)],
    ids: ['a', 'b'], fingerprints: [fp(1), fp(7)]
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'anchor-missing-or-changed');
});

test('expected 的 id 出现在后缀之外（乱序/重复出现）→ 拦下', () => {
  const verdict = checkWatermark({
    expectedIds: ['a', 'b', 'c'], expectedFingerprints: [fp(1), fp(2), fp(3)],
    ids: ['a', 'x', 'c'], fingerprints: [fp(1), fp(9), fp(3)]
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'expected-id-outside-suffix');
});

test('头部新消息 + 后缀匹配 → 放行（认人不认水位：新消息不拦）', () => {
  const verdict = checkWatermark({
    expectedIds: ['a', 'b'], expectedFingerprints: [fp(1), fp(2)],
    ids: ['b2', 'b'], fingerprints: [fp(9), fp(2)]
  });
  assert.equal(verdict.ok, true);
});

test('requireIds 缺失目标消息 → 拦下（撤回兜底）', () => {
  const verdict = checkWatermark({
    expectedIds: ['target', 'out1'], expectedFingerprints: [fp(1), fp(2)],
    ids: ['out1', 'later'], fingerprints: [fp(2), fp(5)],
    requireIds: ['target']
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'required-id-missing');
});

test('requireIds 在场且指纹一致 → 放行', () => {
  const verdict = checkWatermark({
    expectedIds: ['target', 'out1'], expectedFingerprints: [fp(1), fp(2)],
    ids: ['target', 'out1'], fingerprints: [fp(1), fp(2)],
    requireIds: ['target']
  });
  assert.equal(verdict.ok, true);
});

test('观看决策契约：合法 stay', () => {
  const verdict = validateWatchDecisionShape({ action: 'stay', reason: '看着有意思', topics: [{ topic: '鱼缸', signal: '画面出现鱼' }], reflection: '多看一会', seconds: 5 });
  assert.equal(verdict.ok, true);
});

test('观看决策契约：stay 缺 seconds 拦下', () => {
  const verdict = validateWatchDecisionShape({ action: 'stay', reason: 'r', topics: [], reflection: 'x' });
  assert.equal(verdict.ok, false);
});

test('观看决策契约：share 不带白名单 recipientId 拦下', () => {
  const verdict = validateWatchDecisionShape({ action: 'share', reason: 'r', topics: [], reflection: 'x', recipientId: 'conv:other' }, { shareRecipientIds: ['conv:main'] });
  assert.equal(verdict.ok, false);
});

test('观看决策契约：seconds 越界拦下', () => {
  const verdict = validateWatchDecisionShape({ action: 'stay', reason: 'r', topics: [], reflection: 'x', seconds: 11 });
  assert.equal(verdict.ok, false);
});
