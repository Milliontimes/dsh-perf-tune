/**
 * 子进程执行封装 —— CONTRACT §3。
 *
 * 实现说明（与 §1 字面的偏差，已上报 Lead）：
 * §1 要求「执行外部程序一律 child_process.execFile（shell: false）」，
 * 但 §3 要求超过 maxBytes 时**截断结果**并置 truncated: true（进程应正常跑完）。
 * 实测 Node 26 的 execFile 在 maxBuffer 溢出时会直接杀掉子进程
 * （ERR_CHILD_PROCESS_STDIO_MAXBUFFER，退出码丢失），无法同时满足 §3。
 * 因此这里用 child_process.spawn + shell: false 手动收流与截断：
 * 同样不经过 shell、绝不拼 shell 字符串，只是把「收流 + 截断」握在自己手里。
 */

import { spawn, execFile } from 'node:child_process';
import { PerfError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 262144;
const KILL_FALLBACK_DELAY_MS = 300;
const KILL_SETTLE_TIMEOUT_MS = 3000;

/** @param {unknown} value @param {number} fallback @returns {number} */
function normalizeLimit(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

/**
 * 若 buffer 的末尾是「被截断的 UTF-8 多字节序列」，返回可安全解码的长度。
 * @param {Buffer} buffer
 * @returns {number}
 */
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
  else return len; // 非法首字节：交给解码器替换，保持原样
  return len - index >= needed ? len : index;
}

/** 收集字节流，最多保留 maxBytes 字节，并记录是否发生过截断。 */
class ByteCollector {
  /** @param {number} maxBytes */
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    /** @type {Buffer[]} */
    this.chunks = [];
    this.stored = 0;
    this.total = 0;
  }

  /** @param {Buffer|string} chunk */
  push(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.total += buffer.length;
    if (this.stored >= this.maxBytes) return;
    const take = Math.min(this.maxBytes - this.stored, buffer.length);
    this.chunks.push(take === buffer.length ? buffer : buffer.subarray(0, take));
    this.stored += take;
  }

  /** @returns {boolean} */
  get truncated() {
    return this.total > this.stored;
  }

  /** @returns {string} */
  toString() {
    const buffer = Buffer.concat(this.chunks, this.stored);
    const end = this.truncated ? utf8SafeEnd(buffer) : buffer.length;
    return buffer.toString('utf8', 0, end);
  }
}

/**
 * 尽力杀掉子进程；Windows 下用 taskkill /T /F 兜底子进程树。
 * @param {import('node:child_process').ChildProcess|null} child
 */
function terminate(child) {
  if (!child || typeof child.pid !== 'number') return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGKILL');
  } catch {
    /* 进程可能已退出，忽略 */
  }
  if (process.platform !== 'win32') return;
  const fallback = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      const killer = execFile(
        'taskkill',
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true },
        () => {},
      );
      killer.on('error', () => {});
    } catch {
      /* 忽略兜底失败 */
    }
  }, KILL_FALLBACK_DELAY_MS);
  fallback.unref?.();
}

/**
 * 执行外部程序，不经过 shell。
 * 非零退出**不抛错**；超时**不抛错**（返回 timedOut:true, code:null）；取消抛 E_IO。
 *
 * @param {string} program
 * @param {string[]} [args]
 * @param {{ timeoutMs?: number, maxBytes?: number, signal?: AbortSignal, env?: NodeJS.ProcessEnv, cwd?: string }} [options]
 * @returns {Promise<{ program: string, args: string[], code: number|null, stdout: string, stderr: string, timedOut: boolean, truncated: boolean, durationMs: number }>}
 */
export async function run(program, args = [], options = {}) {
  if (typeof program !== 'string' || program.trim() === '') {
    throw new PerfError('E_ARGS', 'run: program 必须是非空字符串');
  }
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
    throw new PerfError('E_ARGS', 'run: args 必须是 string[]');
  }

  const opts = options ?? {};
  const timeoutMs = normalizeLimit(opts.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxBytes = normalizeLimit(opts.maxBytes, DEFAULT_MAX_BYTES);
  const signal = opts.signal;
  if (signal?.aborted) throw new PerfError('E_IO', '已取消');

  const startedAt = Date.now();
  const stdout = new ByteCollector(maxBytes);
  const stderr = new ByteCollector(maxBytes);
  let timedOut = false;

  /** @type {import('node:child_process').ChildProcess} */
  let child;
  try {
    child = spawn(program, args, {
      shell: false,
      windowsHide: true,
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/null byte|invalid.*arg/i.test(message)) {
      throw new PerfError('E_ARGS', `run: 参数不合法（${message}）`, { program });
    }
    throw new PerfError('E_CHANNEL', `启动子进程失败（${program}）：${message}`, { program });
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let killSettleTimer = null;
    /** @type {(() => void)|null} */
    let onAbort = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (killSettleTimer) {
        clearTimeout(killSettleTimer);
        killSettleTimer = null;
      }
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };

    /** @param {(value: any) => void} fn */
    const settle = (fn) => (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const finish = settle((code) => {
      resolve({
        program,
        args: [...args],
        code: timedOut ? null : (typeof code === 'number' ? code : null),
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - startedAt,
      });
    });

    const fail = settle((error) => reject(error));

    const forceKill = () => {
      terminate(child);
      if (killSettleTimer) return;
      // 极端情况下 close 事件可能永远不来：兜底结束等待（结果按已收集数据返回）
      killSettleTimer = setTimeout(() => finish(child.exitCode), KILL_SETTLE_TIMEOUT_MS);
      killSettleTimer.unref?.();
    };

    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));

    timer = setTimeout(() => {
      if (settled) return;
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      forceKill();
    }, timeoutMs);

    onAbort = () => {
      if (settled) return;
      forceKill();
      fail(new PerfError('E_IO', '已取消'));
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    }

    child.once('error', (error) => {
      if (settled) return;
      if (error && /** @type {any} */ (error).code === 'ENOENT') {
        fail(new PerfError('E_NOT_FOUND', `未找到可执行文件：${program}`, { program }));
      } else {
        const message = error instanceof Error ? error.message : String(error);
        fail(new PerfError('E_CHANNEL', `启动子进程失败（${program}）：${message}`, { program }));
      }
    });

    child.once('close', (code) => {
      finish(code);
    });
  });
}
