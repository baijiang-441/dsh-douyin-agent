// lib/guards.mjs — 纯函数判定逻辑（ng 重建新增，2026-10-26）。
// 把 chat-browser 里的 sameWatermark 判定（本地补丁 v2.2 语义）与观看决策的契约校验抽成
// 无副作用纯函数，供 chat-browser 调用并用 node --test 单测覆盖边界。
// 语义说明（v2.2，「认人不认水位」）：
//   只拦两类情况——既有消息指纹变化、expected 后缀不再连续出现；
//   新消息（头部补载/尾部新到）不拦；锚点为 expected 最新一条，锚点缺失即拦。

export function checkWatermark({ expectedIds, expectedFingerprints, ids, fingerprints, requireIds = [] }) {
  const fail = (reason, matchedUntil = expectedIds.length - 1) => ({ ok: false, reason, matchedUntil });
  if (!Array.isArray(expectedIds) || !expectedIds.length || !Array.isArray(expectedFingerprints) || expectedIds.length !== expectedFingerprints.length
    || !Array.isArray(ids) || !Array.isArray(fingerprints) || ids.length !== fingerprints.length) return fail('invalid-input');
  const known = new Map(expectedIds.map((id, index) => [id, expectedFingerprints[index]]));
  const anchor = expectedIds[expectedIds.length - 1];
  const anchorIndex = ids.indexOf(anchor);
  if (!ids.length || anchorIndex < 0 || fingerprints[anchorIndex] !== known.get(anchor)) return fail('anchor-missing-or-changed');
  const mismatchIndex = ids.findIndex((id, index) => known.has(id) && fingerprints[index] !== known.get(id));
  if (mismatchIndex >= 0) return fail('known-fingerprint-changed');
  const indexOfExpected = new Map(expectedIds.map((id, index) => [id, index]));
  let ei = expectedIds.length - 1, mi = anchorIndex;
  while (ei >= 0 && mi >= 0 && ids[mi] === expectedIds[ei]) { ei--; mi--; }
  if (ei === expectedIds.length - 1) return fail('no-overlap');
  const outside = ids.findIndex((id) => { const index = indexOfExpected.get(id); return index !== undefined && index <= ei; });
  if (outside >= 0) return fail('expected-id-outside-suffix');
  for (const required of requireIds) {
    const index = ids.indexOf(required);
    if (index < 0) return fail('required-id-missing');
    if (known.has(required) && fingerprints[index] !== known.get(required)) return fail('required-id-changed');
  }
  return { ok: true, reason: '', matchedUntil: ei };
}

// 观看决策契约（§4 的镜像，用于单测与双重核对；运行时仍以上游 parseWatchDecision 为准）。
export function validateWatchDecisionShape(decision, { shareRecipientIds = [] } = {}) {
  const problems = [];
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return { ok: false, problems: ['决策必须是对象。'] };
  const { action, reason, topics, reflection, seconds, query, recipientId } = decision;
  if (!['stay', 'skip', 'search', 'share', 'stop'].includes(action)) problems.push('action 必须是 stay/skip/search/share/stop。');
  if (typeof reason !== 'string' || !reason.trim()) problems.push('reason 必须是非空文本。');
  if (!Array.isArray(topics) || topics.some(item => !item || typeof item.topic !== 'string' || typeof item.signal !== 'string')) problems.push('topics 必须是 {topic, signal} 数组。');
  if (typeof reflection !== 'string' || !reflection.trim()) problems.push('reflection 必须是非空文本。');
  if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 1 || seconds > 10)) problems.push('seconds 若给出必须是 1-10。');
  if (action === 'stay' && !Number.isInteger(seconds)) problems.push('stay 必须带 seconds。');
  if (query !== undefined && (typeof query !== 'string' || !query.trim())) problems.push('query 若给出必须是非空文本。');
  if (action === 'search' && (typeof query !== 'string' || !query.trim())) problems.push('search 必须带 query。');
  if (action === 'share') {
    if (typeof recipientId !== 'string' || !recipientId.trim()) problems.push('share 必须带 recipientId。');
    else if (shareRecipientIds.length && !shareRecipientIds.includes(recipientId)) problems.push('share 的 recipientId 不在许可名单。');
  }
  return { ok: problems.length === 0, problems };
}
