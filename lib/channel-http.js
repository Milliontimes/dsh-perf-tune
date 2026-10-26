/**
 * HTTP 只读通道 —— CONTRACT §6.1。
 *
 * - 只允许 http:/https:，host 必须命中 `config.http.allowHosts`（默认只允许本机回环）；
 * - 非 2xx → E_CHANNEL；body 上限 512 KiB，超限截断并置 truncated: true；
 * - 尝试 JSON.parse：成功 → value 为解析结果；失败 → value = null 且 bodyText = 前 4 KiB；
 * - 可选 path 支持 `gpus.0.power_w` 与 `gpus[0].power_w` 两种写法，取不到 → E_NOT_FOUND；
 * - 所有 I/O 遵守 AbortSignal；超时 → E_TIMEOUT，外部取消 → E_IO「已取消」。
 *
 * 安全取舍：fetch 使用 `redirect: 'manual'`，3xx 视为非 2xx 失败。
 * 否则本机端点若 30x 跳到外部 host，会绕过 allowHosts 白名单（契约未明说，已上报 Lead）。
 */

import { PerfError } from './errors.js';

const MAX_BODY_BYTES = 512 * 1024;
const BODY_TEXT_PREVIEW = 4 * 1024;
const ERROR_BODY_PREVIEW = 200;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_ALLOW_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1']);

/** @param {unknown} value */
function errorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}

/** 规范化 URL hostname：去方括号、小写。 */
function normalizeHost(host) {
  return String(host).trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

/** 若 buffer 末尾是被截断的 UTF-8 多字节序列，返回安全解码长度。 */
function utf8SafeEnd(buffer) {
  const len = buffer.length;
  let index = len - 1;
  let continuation = 0;
  while (index >= 0 && continuation < 3 && (buffer[index] & 0xc0) === 0x80) {
    index -= 1;
    continuation += 1;
  }
  if (index < 0) return len;
  const lead = buffer[index];
  let needed;
  if ((lead & 0x80) === 0) needed = 1;
  else if ((lead & 0xe0) === 0xc0) needed = 2;
  else if ((lead & 0xf0) === 0xe0) needed = 3;
  else if ((lead & 0xf8) === 0xf0) needed = 4;
  else return len;
  return len - index >= needed ? len : index;
}

/** @param {Uint8Array} value */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.from(value);
}

/**
 * 限长读取响应体（不把超大 body 全部读进内存）。
 * @param {Response} response
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
async function readLimitedBody(response) {
  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    // 无流响应（如 204）退回 text()。
    if (typeof response?.text === 'function') {
      const text = await response.text();
      const buffer = Buffer.from(text, 'utf8');
      if (buffer.length <= MAX_BODY_BYTES) return { text, truncated: false };
      const clipped = buffer.subarray(0, MAX_BODY_BYTES);
      return { text: clipped.toString('utf8', 0, utf8SafeEnd(clipped)), truncated: true };
    }
    return { text: '', truncated: false };
  }

  const reader = body.getReader();
  /** @type {Buffer[]} */
  const chunks = [];
  let stored = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const chunk = toBuffer(value);
      if (stored + chunk.length > MAX_BODY_BYTES) {
        const take = MAX_BODY_BYTES - stored;
        if (take > 0) {
          chunks.push(chunk.subarray(0, take));
          stored += take;
        }
        truncated = true;
        break;
      }
      chunks.push(chunk);
      stored += chunk.length;
    }
  } finally {
    // 超限后停止读取，主动释放底层连接。
    if (truncated) {
      try {
        await reader.cancel();
      } catch {
        /* 忽略取消失败 */
      }
    }
    try {
      reader.releaseLock?.();
    } catch {
      /* 忽略 */
    }
  }

  const buffer = Buffer.concat(chunks, stored);
  const end = truncated ? utf8SafeEnd(buffer) : buffer.length;
  return { text: buffer.toString('utf8', 0, end), truncated };
}

/**
 * 解析点号/下标路径：`gpus.0.power_w`、`gpus[0].power_w` 都支持。
 * @param {string} path
 * @returns {Array<string>}
 */
function parsePath(path) {
  /** @type {string[]} */
  const segments = [];
  const re = /(?:^|\.)([^.[\]]+)|\[(\d+)\]/g;
  let match;
  while ((match = re.exec(path)) !== null) {
    segments.push(match[1] !== undefined ? match[1] : match[2]);
  }
  return segments;
}

/**
 * 按路径取值；取不到（含 null/undefined）→ E_NOT_FOUND。
 * @param {unknown} root
 * @param {string} path
 */
function resolveJsonPath(root, path) {
  const segments = parsePath(path);
  if (segments.length === 0) {
    throw new PerfError('E_ARGS', `非法的 JSON path：${JSON.stringify(path)}`);
  }
  /** @type {any} */
  let current = root;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== 'object') {
      throw new PerfError('E_NOT_FOUND', `JSON path "${path}" 在响应中不存在（在 "${segment}" 处无值）`);
    }
    const key = Array.isArray(current) && /^\d+$/.test(segment) ? Number(segment) : segment;
    if (!Object.hasOwn(current, key)) {
      throw new PerfError('E_NOT_FOUND', `JSON path "${path}" 在响应中不存在（缺少 "${segment}"）`);
    }
    current = current[key];
  }
  if (current === null || current === undefined) {
    throw new PerfError('E_NOT_FOUND', `JSON path "${path}" 无值（${current === null ? 'null' : 'undefined'}）`);
  }
  return current;
}

/**
 * 创建 HTTP 只读通道。
 * @param {{ config?: any, deps?: { fetch?: Function, now?: () => number } }} [options]
 */
export function createHttpChannel({ config, deps } = {}) {
  const cfg = config ?? {};
  const fetchImpl = deps?.fetch ?? globalThis.fetch;
  const configuredHosts = Array.isArray(cfg.http?.allowHosts) && cfg.http.allowHosts.length > 0
    ? cfg.http.allowHosts
    : DEFAULT_ALLOW_HOSTS;
  const allowHosts = new Set(configuredHosts.map(normalizeHost));

  /**
   * 读取 HTTP JSON/文本（CONTRACT §6.1）。
   * @param {{ url?: string, path?: string, timeoutMs?: number, headers?: Record<string,string> }} [params]
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function read(params = {}, { signal } = {}) {
    const query = params ?? {};
    if (signal?.aborted) throw new PerfError('E_IO', '已取消');

    const urlText = query.url;
    if (typeof urlText !== 'string' || urlText.trim() === '') {
      throw new PerfError('E_ARGS', 'HTTP 通道需要非空 url');
    }
    /** @type {URL} */
    let url;
    try {
      url = new URL(urlText);
    } catch {
      throw new PerfError('E_ARGS', `HTTP url 不合法：${JSON.stringify(urlText)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new PerfError('E_SAFETY', `HTTP 通道只允许 http: / https:，收到 ${url.protocol}//；允许的 host：${[...allowHosts].join(', ')}`);
    }
    const host = normalizeHost(url.hostname);
    if (!allowHosts.has(host)) {
      throw new PerfError(
        'E_SAFETY',
        `HTTP 通道拒绝访问 host "${host}"：只允许 ${[...allowHosts].join(', ')}（配置项 http.allowHosts）`,
      );
    }

    const path = query.path;
    if (path !== undefined && path !== null && typeof path !== 'string') {
      throw new PerfError('E_ARGS', `HTTP path 必须是字符串，收到 ${JSON.stringify(path)}`);
    }

    const timeoutMs = query.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new PerfError('E_ARGS', `timeoutMs 必须是正整数，收到 ${JSON.stringify(query.timeoutMs)}`);
    }

    const headers = query.headers ?? {};
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
      throw new PerfError('E_ARGS', 'HTTP headers 必须是对象');
    }
    if (typeof fetchImpl !== 'function') {
      throw new PerfError('E_UNSUPPORTED', '当前运行环境没有 fetch 实现，HTTP 通道不可用');
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onOuterAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });

    try {
      /** @type {Response} */
      let response;
      try {
        response = await fetchImpl(urlText, {
          method: 'GET',
          headers,
          signal: controller.signal,
          // 拒绝跟随重定向：防止本机端点 30x 到外部 host 绕过 allowHosts。
          redirect: 'manual',
        });
      } catch (error) {
        if (timedOut) throw new PerfError('E_TIMEOUT', `HTTP 请求超时（${timeoutMs}ms）：${urlText}`);
        if (signal?.aborted) throw new PerfError('E_IO', '已取消');
        throw new PerfError('E_CHANNEL', `HTTP 请求失败（${urlText}）：${errorMessage(error)}`);
      }

      const status = Number(response?.status ?? 0);
      const { text, truncated } = await readLimitedBody(response);

      if (status < 200 || status >= 300) {
        const statusText = typeof response?.statusText === 'string' ? response.statusText.trim() : '';
        const preview = text.slice(0, ERROR_BODY_PREVIEW).replace(/\s+/g, ' ').trim();
        throw new PerfError(
          'E_CHANNEL',
          `HTTP 非 2xx：${urlText} 返回 ${status}${statusText ? ` ${statusText}` : ''}${preview ? `；body：${preview}` : ''}`,
        );
      }

      /** @type {any} */
      let value = null;
      let parsed = false;
      try {
        value = JSON.parse(text);
        parsed = true;
      } catch {
        value = null;
        parsed = false;
      }

      const result = {
        kind: 'http',
        url: urlText,
        status,
        value,
        ...(parsed ? {} : { bodyText: text.slice(0, BODY_TEXT_PREVIEW) }),
        truncated,
        warnings: [],
      };

      if (typeof path === 'string' && path !== '') {
        if (!parsed) {
          throw new PerfError('E_NOT_FOUND', `HTTP 响应不是合法 JSON，无法按 path "${path}" 取值`);
        }
        result.value = resolveJsonPath(value, path);
      }

      return result;
    } catch (error) {
      // fetch/body 读取期间的超时或外部取消，统一映射（上面已映射的 PerfError 原样透传）。
      if (error instanceof PerfError) throw error;
      if (timedOut) throw new PerfError('E_TIMEOUT', `HTTP 请求超时（${timeoutMs}ms）：${urlText}`);
      if (signal?.aborted) throw new PerfError('E_IO', '已取消');
      throw new PerfError('E_CHANNEL', `HTTP 请求失败（${urlText}）：${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }

  return { kind: 'http', read };
}
