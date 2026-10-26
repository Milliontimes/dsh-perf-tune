/**
 * JSONL 审计日志（CONTRACT.md §9）。
 *
 * - 一行一条 JSON，UTF-8，行尾 `\n`。
 * - 追加前按 `maxBytes` 做**单次**轮转：`audit.jsonl` → `audit.jsonl.1`（覆盖旧 `.1`）。
 * - 单条 entry 序列化后 > 8 KiB 时，对 `request`/`result` 做截断并标记 `_truncated: true`。
 * - 写失败 → `E_IO`（message 含路径），由 index.js 决定是否降级为 warning。
 */

import path from 'node:path';
import * as fsPromises from 'node:fs/promises';

import { PerfError } from './errors.js';
import { dshHomeDir } from './config.js';

const AUDIT_DIR = 'perf-tune';
const AUDIT_FILE = 'audit.jsonl';
const DEFAULT_MAX_BYTES = 1048576; // 1 MiB（与 lib/config.js 默认值一致）
const MAX_ENTRY_BYTES = 8192; // 单条 entry 的字节上限
const TRUNCATE_FIELD_BYTES = 4096; // request/result 保留的字符串化字节数

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} err */
function errorText(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * CONTRACT §1：I/O 函数在 signal abort 时尽快结束，取消错误统一
 * `PerfError('E_IO', '已取消')`。
 *
 * @param {AbortSignal|undefined} signal
 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw new PerfError('E_IO', '已取消');
}

/**
 * 按 UTF-8 字节数截断字符串，且不切断多字节字符。
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateUtf8(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // 回退到 UTF-8 字符起始字节，避免产生替换符。
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/** @param {unknown} value */
function stringifyValue(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 计算审计文件路径：`config.audit.path` 优先，否则
 * `<DSH_HOME 或 ~/.dsh>/perf-tune/audit.jsonl`。
 *
 * @param {object} [config] loadConfig().config
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 * @returns {string} 绝对路径
 */
export function auditPath(config, env = process.env) {
  const configured = isPlainObject(config) && isPlainObject(config.audit) ? config.audit.path : null;
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return path.resolve(configured.trim());
  }
  return path.join(dshHomeDir(env), AUDIT_DIR, AUDIT_FILE);
}

/** @param {object} [config] @returns {number} */
function auditMaxBytes(config) {
  const configured = isPlainObject(config) && isPlainObject(config.audit) ? config.audit.maxBytes : undefined;
  if (typeof configured === 'number' && Number.isInteger(configured) && configured > 0) {
    return configured;
  }
  return DEFAULT_MAX_BYTES;
}

/**
 * 序列化一条 entry；超过 8 KiB 时截断 request/result。
 *
 * @param {object} entry
 * @returns {string} 不含换行的 JSON 文本
 */
function serializeEntry(entry) {
  const full = stringifyValue(entry);
  if (full === undefined) return 'null';
  if (Buffer.byteLength(full, 'utf8') <= MAX_ENTRY_BYTES) return full;

  const truncated = { ...entry, _truncated: true };
  for (const field of ['request', 'result']) {
    const value = truncated[field];
    if (value === undefined || value === null) continue;
    truncated[field] = truncateUtf8(stringifyValue(value), TRUNCATE_FIELD_BYTES);
  }

  let line = stringifyValue(truncated);
  if (Buffer.byteLength(line, 'utf8') <= MAX_ENTRY_BYTES) return line;

  // request + result 各 4 KiB 仍可能超限（例如两者都很长，或 reason 也很长）：
  // 逐级收紧，保证单行始终有界。
  for (const field of ['request', 'result']) {
    if (typeof truncated[field] === 'string' && truncated[field].length > 1024) {
      truncated[field] = truncateUtf8(String(truncated[field]), 1024);
    }
  }
  if (typeof truncated.reason === 'string' && truncated.reason.length > 512) {
    truncated.reason = truncateUtf8(truncated.reason, 512);
  }
  line = stringifyValue(truncated);
  if (Buffer.byteLength(line, 'utf8') <= MAX_ENTRY_BYTES) return line;

  // 最后兜底：只保留固定字段，宁可有损也不让单行无界。
  /** @type {Record<string, unknown>} */
  const minimal = { _truncated: true };
  for (const field of ['ts', 'tool', 'decision', 'channel']) {
    if (entry[field] !== undefined) minimal[field] = entry[field];
  }
  if (typeof entry.reason === 'string') minimal.reason = truncateUtf8(entry.reason, 256);
  return stringifyValue(minimal);
}

/**
 * 追加一条审计记录。
 *
 * @param {object} entry `{ ts, tool, decision, channel, request, reason?, result? }`
 * @param {{ config?: object, env?: Record<string,string|undefined>, fs?: object, signal?: AbortSignal }} [options]
 * @returns {Promise<{path: string, bytes: number}>} bytes = 实际写入的 UTF-8 字节数（含换行）
 */
export async function appendAudit(entry, { config, env = process.env, fs = fsPromises, signal } = {}) {
  throwIfAborted(signal);
  if (!isPlainObject(entry)) {
    throw new PerfError('E_ARGS', '审计 entry 必须是 JSON 对象');
  }

  const filePath = auditPath(config, env);
  const maxBytes = auditMaxBytes(config);
  const payload = `${serializeEntry(entry)}\n`;
  const bytes = Buffer.byteLength(payload, 'utf8');
  const dir = path.dirname(filePath);

  try {
    await fs.mkdir(dir, { recursive: true });
    throwIfAborted(signal);
    await rotateIfNeeded(fs, filePath, bytes, maxBytes);
    throwIfAborted(signal);
    await fs.appendFile(filePath, payload, 'utf8');
  } catch (err) {
    throwIfAborted(signal);
    if (err instanceof PerfError) throw err;
    throw new PerfError('E_IO', `写入审计文件失败 ${filePath}: ${errorText(err)}`, {
      path: filePath,
    });
  }

  return { path: filePath, bytes };
}

/**
 * 当前文件 + 待写入内容是否超过 maxBytes；超过则单次轮转（旧 `.1` 被覆盖）。
 *
 * @param {object} fs
 * @param {string} filePath
 * @param {number} incomingBytes
 * @param {number} maxBytes
 */
async function rotateIfNeeded(fs, filePath, incomingBytes, maxBytes) {
  /** @type {{size:number}|null} */
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') return;
    throw err;
  }
  if (!stat || stat.size === 0) return;
  if (stat.size + incomingBytes <= maxBytes) return;

  const rotatedPath = `${filePath}.1`;
  try {
    await fs.rm(rotatedPath, { force: true });
  } catch (err) {
    if (/** @type {any} */ (err)?.code !== 'ENOENT') throw err;
  }
  await fs.rename(filePath, rotatedPath);
}

/**
 * 读取审计文件尾部，最新在前。文件不存在 → `[]`。
 *
 * @param {{ limit?: number, config?: object, env?: Record<string,string|undefined>, fs?: object, signal?: AbortSignal }} [options]
 * @returns {Promise<object[]>}
 */
export async function readAuditTail({ limit = 10, config, env = process.env, fs = fsPromises, signal } = {}) {
  throwIfAborted(signal);
  let count = 10;
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    count = Math.max(0, Math.floor(limit));
  }
  if (count === 0) return [];

  const filePath = auditPath(config, env);
  /** @type {string} */
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throwIfAborted(signal);
    if (/** @type {any} */ (err)?.code === 'ENOENT') return [];
    throw new PerfError('E_IO', `读取审计文件失败 ${filePath}: ${errorText(err)}`, {
      path: filePath,
    });
  }
  throwIfAborted(signal);

  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  /** @type {object[]} */
  const entries = [];
  for (const line of lines.slice(-count).reverse()) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // 损坏行（例如上次写入被强杀截断）跳过，尽量把有效审计读出来。
    }
  }
  return entries;
}
