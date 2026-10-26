/**
 * nvidia-smi 通道 —— CONTRACT §4。
 *
 * 只读查询（--query-gpu 泛化，不内置字段白名单 / CSV 解析）
 * + 写操作（-lgc / -rgc / -lmc / -rmc / reset-all / -pl）
 * + 写后回读校验（verify）+ 错误码映射（E_ADMIN_REQUIRED / E_UNSUPPORTED / E_CHANNEL）。
 *
 * 本层**不做数值安全包线校验**：包线由 index.js 调 lib/envelope.js 完成，
 * 这里只负责「执行 + 如实回报」，仅拒绝明显非法输入（如 mhz 非正数）。
 *
 * deps 可注入 `{ run, now, sleep }`，便于测试；默认用 lib/run.js 与真实计时。
 */

import { PerfError } from './errors.js';
import { run as runProcess } from './run.js';

/** nvidia-smi 字段名合法字符（字母/数字/下划线/点）。 */
const FIELD_RE = /^[A-Za-z0-9_.]+$/;
const MAX_FIELDS = 64;
const DEFAULT_QUERY_TIMEOUT_MS = 15000;

/** 回读校验轮询参数（CONTRACT §4.2：最多 3 秒，间隔 300ms）。 */
const VERIFY_DEADLINE_MS = 3000;
const VERIFY_POLL_INTERVAL_MS = 300;
const VERIFY_MAX_ATTEMPTS = Math.ceil(VERIFY_DEADLINE_MS / VERIFY_POLL_INTERVAL_MS) + 2;

/** power-limit 回读容差（W）。 */
const POWER_LIMIT_TOLERANCE_W = 2;

/** 写操作名（与 CONTRACT §4.2 表格一致）。 */
export const NVIDIA_WRITE_OPS = Object.freeze([
  'lock-core',
  'reset-core',
  'lock-mem',
  'reset-mem',
  'reset-all',
  'power-limit',
]);

const WRITE_OPS = new Set(NVIDIA_WRITE_OPS);

/** @param {unknown} value */
function errorMessage(value) {
  return value instanceof Error ? value.message : String(value);
}

/** 取字符串头部 n 个字符（非字符串安全）。 */
function headText(value, length) {
  return typeof value === 'string' ? value.slice(0, length) : '';
}

/**
 * 权限类失败（NVML 退出码 4 = NO_PERMISSION，或 stderr 明确要求管理员）时，
 * 在错误消息末尾补一句可执行的重试建议：本机 shell 非管理员，但 `sudo.exe` 可提权重跑。
 * @param {{ code?: number|null, stderr?: string }} result
 * @returns {string}
 */
function sudoRetryHint(result) {
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  const permissionClass =
    result?.code === 4 ||
    /insufficient permissions|permission denied|requires? administrator|\badmin\b/i.test(stderr);
  return permissionClass ? ' Try run again with sudo.exe' : '';
}

/** @param {{ stdout?: string, stderr?: string, code?: number|null, truncated?: boolean, timedOut?: boolean }} result */
function stderrHead(result, length = 300) {
  return headText(result?.stderr, length).trim();
}

/** nvidia-smi 通道默认程序路径（config.nvidiaSmi.path 可覆盖）。 */
function resolveProgram(config) {
  const configured = config?.nvidiaSmi?.path;
  return typeof configured === 'string' && configured.trim() !== '' ? configured : 'nvidia-smi';
}

/**
 * gpuIndex 解析：参数优先，缺省取 config.nvidiaSmi.gpuIndex，默认 0。
 * @param {any} config
 * @param {unknown} value
 * @returns {number}
 */
function resolveGpuIndex(config, value) {
  const raw = value === undefined || value === null ? (config?.nvidiaSmi?.gpuIndex ?? 0) : value;
  if (!Number.isInteger(raw) || raw < 0) {
    throw new PerfError('E_ARGS', `nvidia-smi 的 gpuIndex 必须是非负整数，收到 ${JSON.stringify(value)}`);
  }
  return raw;
}

/**
 * fields 校验：非空 string[]，每项 /^[A-Za-z0-9_.]+$/，最多 64 个。
 * 不内置字段白名单——nvidia-smi 自己不认识的字段会报错，这里只把 stderr 转成 E_CHANNEL。
 * @param {unknown} fields
 * @returns {string[]}
 */
function validateFields(fields) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new PerfError('E_ARGS', 'read 需要非空 fields 数组（nvidia-smi --query-gpu 字段名）');
  }
  if (fields.length > MAX_FIELDS) {
    throw new PerfError('E_ARGS', `fields 最多 ${MAX_FIELDS} 个，收到 ${fields.length} 个`);
  }
  return fields.map((field) => {
    if (typeof field !== 'string' || !FIELD_RE.test(field)) {
      throw new PerfError('E_ARGS', `非法 nvidia-smi 字段名 ${JSON.stringify(field)}（只允许字母、数字、下划线、点）`);
    }
    return field;
  });
}

/** 去掉 CSV 单元格两端的空白与一层引号。 */
function stripQuotes(text) {
  let value = text.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

/** 「纯数字」判定：含正负号、小数、科学计数法。 */
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * CSV 单元格 → 值：
 * - `[N/A]` / `N/A` / `[Not Supported]` → null
 * - 纯数字 → Number
 * - 其它 → 原样字符串
 * @param {string} raw
 * @returns {number|string|null}
 */
function parseCsvValue(raw) {
  const value = stripQuotes(raw);
  if (/^\[?\s*N\/A\s*\]?$/i.test(value)) return null;
  if (/^\[?\s*not supported\s*\]?$/i.test(value)) return null;
  if (NUMBER_RE.test(value)) return Number(value);
  return value;
}

/**
 * 只读查询失败的映射：非零退出 → E_CHANNEL；stderr 含权限关键字 → E_ADMIN_REQUIRED。
 * @param {any} result
 * @returns {PerfError}
 */
function readFailure(result) {
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  const head = stderrHead(result, 300);
  const message = `nvidia-smi 查询失败（退出码 ${result?.code ?? 'null'}）${head ? `：${head}` : ''}`;
  if (/insufficient permissions|permission denied|requires? administrator|\badmin\b/i.test(stderr)) {
    return new PerfError('E_ADMIN_REQUIRED', message);
  }
  return new PerfError('E_CHANNEL', message);
}

/**
 * 写操作失败的映射（lock-* / power-limit）：
 * stderr 含权限 → E_ADMIN_REQUIRED；含 not supported/unsupported → E_UNSUPPORTED；否则 E_CHANNEL。
 * @param {string} opName
 * @param {any} result
 * @returns {PerfError}
 */
function writeFailure(opName, result) {
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  const head = stderrHead(result, 300);
  const message = `nvidia-smi ${opName} 失败（退出码 ${result?.code ?? 'null'}）${head ? `：${head}` : ''}${sudoRetryHint(result)}`;
  if (/insufficient permissions|permission denied|requires? administrator|\badmin\b/i.test(stderr)) {
    return new PerfError('E_ADMIN_REQUIRED', message);
  }
  if (/not supported|unsupported|not applicable|not permitted/i.test(stderr)) {
    return new PerfError('E_UNSUPPORTED', message);
  }
  return new PerfError('E_CHANNEL', message);
}

/** reset-* 失败统一 E_CHANNEL（CONTRACT §4.2）。 */
function resetFailure(opName, result) {
  const head = stderrHead(result, 300);
  return new PerfError(
    'E_CHANNEL',
    `nvidia-smi ${opName} 复位失败（退出码 ${result?.code ?? 'null'}）${head ? `：${head}` : ''}${sudoRetryHint(result)}`,
  );
}

/**
 * `mhz` 归一化：number 或 { min, max }（本层不查包线，只拒绝非正/非有限/区间倒挂）。
 * @param {unknown} mhz
 * @param {string} opName
 * @returns {{ spec: string, lower: number }}
 */
function normalizeMhzSpec(mhz, opName) {
  const isPositiveFinite = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (typeof mhz === 'number') {
    if (!isPositiveFinite(mhz)) {
      throw new PerfError('E_ARGS', `${opName} 的 mhz 必须是正有限数字，收到 ${JSON.stringify(mhz)}`);
    }
    return { spec: String(mhz), lower: mhz };
  }
  if (mhz !== null && typeof mhz === 'object' && !Array.isArray(mhz)) {
    const plain = /** @type {{ min?: unknown, max?: unknown }} */ (mhz);
    if (!isPositiveFinite(plain.min) || !isPositiveFinite(plain.max)) {
      throw new PerfError(
        'E_ARGS',
        `${opName} 的 mhz 区间必须是 { min, max } 且两者均为正有限数字，收到 ${JSON.stringify(mhz)}`,
      );
    }
    if (plain.min > plain.max) {
      throw new PerfError('E_ARGS', `${opName} 的 mhz 区间非法：min ${plain.min} 大于 max ${plain.max}`);
    }
    return { spec: `${plain.min},${plain.max}`, lower: plain.min };
  }
  throw new PerfError('E_ARGS', `${opName} 需要 mhz（正数）或 { min, max }（正数且 min <= max），收到 ${JSON.stringify(mhz)}`);
}

/**
 * 从 read 结果里抽出 `{ fieldName: value }`，便于 verify.observed。
 * @param {{ fields: Array<{ name: string, value: number|string|null }> }} readResult
 */
function observedFrom(readResult) {
  /** @type {Record<string, number|string|null>} */
  const observed = {};
  for (const field of readResult?.fields ?? []) observed[field.name] = field.value;
  return observed;
}

/**
 * 按顺序取第一个数值字段。
 * @param {Record<string, number|string|null>} observed
 * @param {string[]} names
 * @returns {{ name: string, value: number }|null}
 */
function firstNumeric(observed, names) {
  for (const name of names) {
    const value = observed?.[name];
    if (typeof value === 'number' && Number.isFinite(value)) return { name, value };
  }
  return null;
}

/**
 * 创建 nvidia-smi 通道。
 *
 * @param {{ config?: any, deps?: { run?: Function, now?: () => number, sleep?: (ms: number) => Promise<void> } }} [options]
 */
export function createNvidiaChannel({ config, deps } = {}) {
  const cfg = config ?? {};
  const runImpl = deps?.run ?? runProcess;
  const now = deps?.now ?? (() => Date.now());
  const sleep = deps?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const program = resolveProgram(cfg);

  /**
   * 读指标（CONTRACT §4.1）。
   * @param {{ fields?: unknown, gpuIndex?: unknown, timeoutMs?: number }} [params]
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function read(params = {}, { signal } = {}) {
    const query = params ?? {};
    const fields = validateFields(query.fields);
    const gpuIndex = resolveGpuIndex(cfg, query.gpuIndex);
    const args = [
      '--query-gpu=' + fields.join(','),
      '--format=csv,noheader,nounits',
      '-i',
      String(gpuIndex),
    ];
    const result = (await runImpl(program, args, { timeoutMs: query.timeoutMs, signal })) ?? {};

    if (result.timedOut) {
      throw new PerfError('E_TIMEOUT', `nvidia-smi 查询超时（${fields.join(',')}，gpuIndex=${gpuIndex}）`);
    }
    if (result.code !== 0) throw readFailure(result);

    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const firstLine = stdout.split(/\r?\n/).find((line) => line.trim() !== '');
    if (firstLine === undefined) {
      throw new PerfError('E_CHANNEL', 'nvidia-smi 未返回任何数据行（查询无输出）');
    }
    const cells = firstLine.split(',');
    if (cells.length !== fields.length) {
      const head = stderrHead(result, 300);
      throw new PerfError(
        'E_CHANNEL',
        `nvidia-smi 返回字段数与请求不一致：请求 ${fields.length} 个（${fields.join(',')}），实际 ${cells.length} 个（${firstLine.trim()}）${head ? `；stderr：${head}` : ''}`,
      );
    }

    const warnings = [];
    if (result.truncated) warnings.push('nvidia-smi 输出超过 maxBytes 限制，已截断');
    if (typeof result.stderr === 'string' && result.stderr.trim() !== '') {
      warnings.push(`nvidia-smi stderr：${headText(result.stderr, 300).trim()}`);
    }

    return {
      kind: 'nvidia-smi',
      gpuIndex,
      fields: fields.map((name, index) => {
        const raw = stripQuotes(cells[index]);
        return { name, raw, value: parseCsvValue(cells[index]) };
      }),
      warnings,
    };
  }

  /**
   * 轮询时钟字段，直到拿到数值或到达 3 秒截止（CONTRACT §4.2）。
   * @param {string[]} fields
   * @param {AbortSignal|undefined} signal
   * @param {number} gpuIndex
   */
  async function pollClocks(fields, signal, gpuIndex) {
    const startedAt = now();
    let observed = {};
    for (let attempt = 0; attempt < VERIFY_MAX_ATTEMPTS; attempt += 1) {
      const readResult = await read({ fields, gpuIndex }, { signal });
      observed = observedFrom(readResult);
      if (firstNumeric(observed, fields) !== null) return observed;
      if (now() - startedAt + VERIFY_POLL_INTERVAL_MS >= VERIFY_DEADLINE_MS) return observed;
      await sleep(VERIFY_POLL_INTERVAL_MS);
    }
    return observed;
  }

  /**
   * lock-core 回读校验：空闲时实测核心时钟可能低于锁定下限，
   * 故「实测值 >= 下限 × 0.5」记 true，否则如实记 false 并提示需负载复验。
   */
  async function verifyLockCore(lowerMhz, signal, gpuIndex) {
    try {
      const observed = await pollClocks(['clocks.gr', 'clocks.max.gr'], signal, gpuIndex);
      const candidate = firstNumeric(observed, ['clocks.gr', 'clocks.max.gr']);
      if (candidate === null) {
        return {
          checked: true,
          ok: false,
          observed,
          note: `回读 ${VERIFY_DEADLINE_MS / 1000} 秒内未取到数值核心时钟，需负载下复验`,
        };
      }
      const threshold = lowerMhz * 0.5;
      const ok = candidate.value >= threshold;
      return {
        checked: true,
        ok,
        observed,
        note: ok
          ? '核心时钟回读正常；空闲降频属正常现象，最终以负载下复验为准'
          : `实测核心时钟 ${candidate.value} MHz 低于锁定下限×0.5（${threshold} MHz）；空闲降频属正常，需负载下复验`,
      };
    } catch (error) {
      return { checked: false, ok: null, observed: null, note: `回读失败：${errorMessage(error)}` };
    }
  }

  /** lock-mem 回读校验：ok = 实测显存时钟 > 0。 */
  async function verifyLockMem(signal, gpuIndex) {
    try {
      const observed = await pollClocks(['clocks.mem'], signal, gpuIndex);
      const candidate = firstNumeric(observed, ['clocks.mem']);
      if (candidate === null) {
        return {
          checked: true,
          ok: false,
          observed,
          note: `回读 ${VERIFY_DEADLINE_MS / 1000} 秒内未取到数值显存时钟，需负载下复验`,
        };
      }
      return {
        checked: true,
        ok: candidate.value > 0,
        observed,
        note: '显存时钟已回读；显存降频属省电策略，最终以负载下复验为准',
      };
    } catch (error) {
      return { checked: false, ok: null, observed: null, note: `回读失败：${errorMessage(error)}` };
    }
  }

  /** reset-* 回读校验：ok = null（nvidia-smi 无法区分「已解锁」与「仍在锁定」）。 */
  async function verifyReset(fields, signal, gpuIndex) {
    try {
      const readResult = await read({ fields, gpuIndex }, { signal });
      return {
        checked: true,
        ok: null,
        observed: observedFrom(readResult),
        note: '复位命令已执行；nvidia-smi 无法区分「已解锁」与「仍在锁定」，请对比复位前后的 clocks 变化判断',
      };
    } catch (error) {
      return { checked: false, ok: null, observed: null, note: `回读失败：${errorMessage(error)}` };
    }
  }

  /** power-limit 回读校验（契约未规定，按 power.limit 是否接近目标值如实回报）。 */
  async function verifyPowerLimit(watts, signal, gpuIndex) {
    try {
      const readResult = await read({ fields: ['power.limit'], gpuIndex }, { signal });
      const observed = observedFrom(readResult);
      const limit = observed['power.limit'];
      if (typeof limit !== 'number') {
        return {
          checked: true,
          ok: null,
          observed,
          note: 'nvidia-smi 回读的 power.limit 不是数值（本机驱动常返回 [N/A]），请用 nvidia-smi -q -d POWER 人工复核',
        };
      }
      const ok = Math.abs(limit - watts) <= POWER_LIMIT_TOLERANCE_W;
      return {
        checked: true,
        ok,
        observed,
        note: ok
          ? `已回读 power.limit=${limit} W，与目标一致`
          : `回读 power.limit=${limit} W 与目标 ${watts} W 不一致（可能被驱动钳制）`,
      };
    } catch (error) {
      return { checked: false, ok: null, observed: null, note: `回读失败：${errorMessage(error)}` };
    }
  }

  /**
   * 写操作（CONTRACT §4.2）。
   * @param {{ op?: string, mhz?: number|{min:number,max:number}, watts?: number, gpuIndex?: number }} op
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function write(op, { signal } = {}) {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      throw new PerfError('E_ARGS', 'write(op): op 必须是对象，例如 { op: "lock-core", mhz: 1600 }');
    }
    const name = /** @type {{ op?: unknown }} */ (op).op;
    if (typeof name !== 'string' || !WRITE_OPS.has(name)) {
      throw new PerfError(
        'E_ARGS',
        `不支持的 nvidia-smi 写操作 ${JSON.stringify(name)}；支持：${NVIDIA_WRITE_OPS.join(', ')}`,
      );
    }
    const gpuIndex = resolveGpuIndex(cfg, /** @type {{ gpuIndex?: unknown }} */ (op).gpuIndex);
    /** @type {Array<{ args: string[], code: number|null, stdout: string, stderr: string }>} */
    const commands = [];
    /** @type {string[]} */
    const warnings = [];

    /** 执行单条写命令并记录（非零退出不抛，交给调用点决定语义）。 */
    const runWrite = async (argv) => {
      const args = ['-i', String(gpuIndex), ...argv];
      const result = (await runImpl(program, args, { timeoutMs: /** @type {any} */ (op).timeoutMs, signal })) ?? {};
      commands.push({
        args,
        code: result.timedOut ? null : (typeof result.code === 'number' ? result.code : null),
        stdout: headText(result.stdout, 200),
        stderr: headText(result.stderr, 300),
      });
      if (result.truncated) {
        warnings.push(`nvidia-smi ${argv.join(' ')} 输出超过 maxBytes 限制，已截断`);
      }
      if (typeof result.stderr === 'string' && result.stderr.trim() !== '') {
        warnings.push(`nvidia-smi ${argv.join(' ')} stderr：${headText(result.stderr, 300).trim()}`);
      }
      return result;
    };

    const throwIfTimeout = (result) => {
      if (result.timedOut) {
        throw new PerfError('E_TIMEOUT', `nvidia-smi ${name} 超时，无法确认写入是否生效`);
      }
    };

    /** @type {{ checked: boolean, ok: boolean|null, observed: object|null, note: string }} */
    let verify;

    switch (name) {
      case 'lock-core': {
        const spec = normalizeMhzSpec(/** @type {any} */ (op).mhz, 'lock-core');
        const result = await runWrite(['-lgc', spec.spec]);
        throwIfTimeout(result);
        if (result.code !== 0) throw writeFailure('lock-core', result);
        verify = await verifyLockCore(spec.lower, signal, gpuIndex);
        break;
      }
      case 'lock-mem': {
        const spec = normalizeMhzSpec(/** @type {any} */ (op).mhz, 'lock-mem');
        const result = await runWrite(['-lmc', spec.spec]);
        throwIfTimeout(result);
        if (result.code !== 0) throw writeFailure('lock-mem', result);
        verify = await verifyLockMem(signal, gpuIndex);
        break;
      }
      case 'reset-core': {
        const result = await runWrite(['-rgc']);
        throwIfTimeout(result);
        if (result.code !== 0) throw resetFailure('reset-core', result);
        verify = await verifyReset(['clocks.gr'], signal, gpuIndex);
        break;
      }
      case 'reset-mem': {
        const result = await runWrite(['-rmc']);
        throwIfTimeout(result);
        if (result.code !== 0) throw resetFailure('reset-mem', result);
        verify = await verifyReset(['clocks.mem'], signal, gpuIndex);
        break;
      }
      case 'reset-all': {
        // 两条都尝试；失败信息合并后抛错（CONTRACT §4.2）。
        /** @type {Array<{ label: string, result: any, timedOut: boolean }>} */
        const failures = [];
        const first = await runWrite(['-rgc']);
        if (first.timedOut) failures.push({ label: '-rgc', result: first, timedOut: true });
        else if (first.code !== 0) failures.push({ label: '-rgc', result: first, timedOut: false });
        const second = await runWrite(['-rmc']);
        if (second.timedOut) failures.push({ label: '-rmc', result: second, timedOut: true });
        else if (second.code !== 0) failures.push({ label: '-rmc', result: second, timedOut: false });

        if (failures.length > 0) {
          const parts = failures.map(({ label, result, timedOut }) => {
            if (timedOut) return `${label}: 超时`;
            const head = stderrHead(result, 300);
            return `${label}: 退出码 ${result.code ?? 'null'}${head ? `（${head}）` : ''}`;
          });
          const message = `nvidia-smi reset-all 失败（两条命令均已尝试）：${parts.join('；')}${failures.map((failure) => sudoRetryHint(failure.result)).find((hint) => hint !== '') ?? ''}`;
          if (failures.every((failure) => failure.timedOut)) {
            throw new PerfError('E_TIMEOUT', message);
          }
          throw new PerfError('E_CHANNEL', message);
        }
        verify = await verifyReset(['clocks.gr', 'clocks.mem'], signal, gpuIndex);
        break;
      }
      case 'power-limit': {
        const watts = /** @type {any} */ (op).watts;
        if (typeof watts !== 'number' || !Number.isFinite(watts) || watts <= 0) {
          throw new PerfError('E_ARGS', `power-limit 的 watts 必须是正有限数字，收到 ${JSON.stringify(watts)}`);
        }
        const result = await runWrite(['-pl', String(watts)]);
        throwIfTimeout(result);
        if (result.code !== 0) throw writeFailure('power-limit', result);
        verify = await verifyPowerLimit(watts, signal, gpuIndex);
        break;
      }
      default: {
        // WRITE_OPS 已校验，理论上不可达。
        throw new PerfError('E_ARGS', `不支持的 nvidia-smi 写操作 ${JSON.stringify(name)}`);
      }
    }

    return {
      op: name,
      applied: true,
      commands,
      verify,
      warnings,
    };
  }

  return { kind: 'nvidia-smi', read, write };
}
