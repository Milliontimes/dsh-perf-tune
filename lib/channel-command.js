/**
 * 只读命令通道 —— CONTRACT §6.2。
 *
 * 白名单：`config.command.allowPrograms`（basename，不区分大小写）与
 * `config.command.allowPaths`（绝对路径精确匹配）。
 * - program 含路径分隔符（`\` 或 `/`）时**只**匹配 allowPaths；
 * - 否则按 basename 匹配 allowPrograms。
 * 不在白名单 → E_UNSUPPORTED（message 列出已允许项）。
 *
 * 执行走 lib/run.js：shell:false、maxBytes 默认 256 KiB；非零退出**不抛**，
 * 超时返回 timedOut: true（都不抛），把语义交给调用方判断。
 */

import { PerfError } from './errors.js';
import { run as runProcess } from './run.js';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BYTES = 256 * 1024;

/** basename 判定：Windows 下同时支持 `\` 与 `/`。 */
function basename(program) {
  const index = Math.max(program.lastIndexOf('\\'), program.lastIndexOf('/'));
  return index === -1 ? program : program.slice(index + 1);
}

/** program 是否携带路径分隔符。 */
function hasPathSeparator(program) {
  return program.includes('\\') || program.includes('/');
}

/**
 * 创建只读命令通道。
 * @param {{ config?: any, deps?: { run?: Function } }} [options]
 */
export function createCommandChannel({ config, deps } = {}) {
  const cfg = config ?? {};
  const runImpl = deps?.run ?? runProcess;
  const allowPrograms = Array.isArray(cfg.command?.allowPrograms) ? cfg.command.allowPrograms : [];
  const allowPaths = Array.isArray(cfg.command?.allowPaths) ? cfg.command.allowPaths : [];
  const allowedBasenames = new Set(
    allowPrograms.filter((item) => typeof item === 'string').map((item) => item.trim().toLowerCase()),
  );
  const allowedPaths = allowPaths.filter((item) => typeof item === 'string');

  /** 白名单命中判定。 */
  function isAllowed(program) {
    if (hasPathSeparator(program)) return allowedPaths.includes(program);
    return allowedBasenames.has(basename(program).toLowerCase());
  }

  /** 不在白名单时的 E_UNSUPPORTED 消息（列出已允许项）。 */
  function unsupported(program) {
    const allowed = [
      ...(allowedPaths.length > 0 ? [`allowPaths: ${allowedPaths.join(', ')}`] : []),
      ...(allowedBasenames.size > 0 ? [`allowPrograms: ${[...allowedBasenames].join(', ')}`] : []),
    ];
    return new PerfError(
      'E_UNSUPPORTED',
      `命令 ${JSON.stringify(program)} 不在只读命令白名单内${allowed.length > 0 ? `（已允许：${allowed.join('；')}）` : '（当前白名单为空，请配置 command.allowPrograms / command.allowPaths）'}`,
    );
  }

  /**
   * 执行白名单内的只读命令（CONTRACT §6.2）。
   * @param {{ program?: string, args?: unknown, timeoutMs?: number }} [params]
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function read(params = {}, { signal } = {}) {
    const query = params ?? {};
    const program = query.program;
    if (typeof program !== 'string' || program.trim() === '') {
      throw new PerfError('E_ARGS', 'command 通道需要非空 program');
    }
    const args = query.args ?? [];
    if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
      throw new PerfError('E_ARGS', 'command 通道的 args 必须是字符串数组');
    }
    if (query.timeoutMs !== undefined && (!Number.isInteger(query.timeoutMs) || query.timeoutMs <= 0)) {
      throw new PerfError('E_ARGS', `timeoutMs 必须是正整数，收到 ${JSON.stringify(query.timeoutMs)}`);
    }
    if (!isAllowed(program)) throw unsupported(program);

    const result = await runImpl(program, args, {
      timeoutMs: query.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: DEFAULT_MAX_BYTES,
      signal,
    });
    return {
      kind: 'command',
      program,
      args: [...args],
      code: result?.timedOut ? null : (typeof result?.code === 'number' ? result.code : null),
      stdout: typeof result?.stdout === 'string' ? result.stdout : '',
      stderr: typeof result?.stderr === 'string' ? result.stderr : '',
      truncated: Boolean(result?.truncated),
      timedOut: Boolean(result?.timedOut),
    };
  }

  return { kind: 'command', read };
}
