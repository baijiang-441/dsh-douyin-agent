// lib/store.mjs — 统一持久化层（ng 重建新增，2026-10-26）。
// 目标：把散落各模块的落盘写入收敛到这里。写失败（EPERM 等平台层拦截）先退避重试；
// 重试仍失败进入 degraded：写入进内存环形缓冲，调用方继续运行（私信回复优先于记账），
// 由 flush() 周期回放，存储恢复后自动回到 ok。逻辑性错误（参数、容量）仍然抛出，不被吞掉。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const WAIT = new Int32Array(new SharedArrayBuffer(4));
const STATE_RETRY_DELAYS = [250, 1000, 4000];
const DEGRADABLE_CODES = new Set(['EPERM', 'EACCES', 'EROFS', 'ENOSPC', 'EBUSY', 'ETXTBSY', 'EIO']);
const RING_LIMIT = 2000;
const FLUSH_BATCH = 50;

export const boot = { phase: 'init', detail: '', startedAt: Date.now() };

function sleepSync(ms) { Atomics.wait(WAIT, 0, 0, ms); }

function isDegradable(error) { return DEGRADABLE_CODES.has(error?.code); }

export class Store {
  constructor({ ringLimit = RING_LIMIT, retryDelays = STATE_RETRY_DELAYS, now = Date.now } = {}) {
    this.ringLimit = ringLimit; this.retryDelays = retryDelays; this.now = now;
    this.health = 'ok'; this.lastError = null; this.ring = [];
    this.retried = 0; this.dropped = 0; this.flushing = false; this.lastOkAt = now();
  }
  healthSnapshot() {
    return {
      health: this.health, lastError: this.lastError && { code: this.lastError.code || null, message: this.lastError.message, path: this.lastError.path || null },
      pendingWrites: this.ring.length, retried: this.retried, dropped: this.dropped, lastOkAt: new Date(this.lastOkAt).toISOString()
    };
  }
  #atomic(file, raw) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      fs.writeFileSync(temporary, raw, { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  // 状态文件写入：短退避重试后仍失败 → 进环形缓冲并返回 false，不抛 degradable 错误。
  writeSync(file, raw) {
    for (let attempt = 0; attempt <= this.retryDelays.length; attempt++) {
      if (attempt > 0) sleepSync(this.retryDelays[attempt - 1]);
      try { this.#atomic(file, raw); this.#recovered(); return true; }
      catch (error) { if (!isDegradable(error)) throw error; this.lastError = error; this.retried++; }
    }
    this.#degrade(file, { kind: 'file', file, raw });
    return false;
  }
  writeJSONSync(file, value) { return this.writeSync(file, JSON.stringify(value, null, 2) + '\n'); }
  // 事件日志追加：只试一次，失败进环形缓冲，绝不阻塞主循环。
  appendLineSync(file, line) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, line + '\n', { mode: 0o600 }); this.#recovered(); return true; }
    catch (error) {
      if (!isDegradable(error)) throw error;
      this.lastError = error; this.#degrade(file, { kind: 'line', file, raw: line });
      return false;
    }
  }
  #degrade(file, item) {
    if (this.health === 'ok') this.health = 'degraded';
    // 同一路径的状态文件只保留最新一份，回放时后写覆盖先写。
    if (item.kind === 'file') { const index = this.ring.findIndex(entry => entry.kind === 'file' && entry.file === item.file); if (index >= 0) this.ring.splice(index, 1); }
    this.ring.push(item);
    const overflow = this.ring.length - this.ringLimit;
    if (overflow > 0) { this.ring.splice(0, overflow); this.dropped += overflow; }
  }
  // 供调用方在自管写入（如带 CAS 的人格卡）遇 degradable 错误时手动转入缓冲。
  deferWrite(file, raw) { this.#degrade(file, { kind: 'file', file, raw }); }
  #recovered() { this.lastOkAt = this.now(); this.health = 'ok'; }
  async flush() {
    if (this.flushing || !this.ring.length) return;
    this.flushing = true;
    try {
      const batch = this.ring.splice(0, FLUSH_BATCH);
      for (const item of batch) {
        try {
          if (item.kind === 'line') { fs.mkdirSync(path.dirname(item.file), { recursive: true }); fs.appendFileSync(item.file, item.raw + '\n', { mode: 0o600 }); }
          else this.#atomic(item.file, item.raw);
        } catch (error) { if (!isDegradable(error)) throw error; this.lastError = error; this.ring.push(item); }
      }
      if (this.health === 'degraded' && this.ring.length === 0) this.health = 'ok';
    } finally { this.flushing = false; }
  }
  startFlushLoop(intervalMs = 10_000) {
    const timer = setInterval(() => { void this.flush().catch(() => {}); }, intervalMs);
    timer.unref?.();
    return timer;
  }
  // 启动探针：能建目录、能写、能删才算存储可用；返回 {ok, code}。
  probeSync(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `.probe-${process.pid}-${Date.now()}.tmp`);
      fs.writeFileSync(file, 'probe', { mode: 0o600 });
      fs.unlinkSync(file);
      return { ok: true, code: null };
    } catch (error) { return { ok: false, code: error.code || String(error?.message || error) }; }
  }
}

export const store = new Store();
