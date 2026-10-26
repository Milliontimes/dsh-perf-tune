/**
 * 配置加载与校验（CONTRACT.md §7）。
 *
 * 设计要点：
 * - 默认配置逐字段与契约一致；文件与默认值「对象逐键深合并、数组整体替换」。
 * - 未知键允许出现，但会从规范化结果中剔除并记入 warnings。
 * - 配置只能通过 config.limits 收窄硬包线（收窄合法性由 lib/envelope.js 校验）。
 * - 每次都重新读文件，不缓存（记忆系统改配置无需重启）。
 */

import path from 'node:path';
import os from 'node:os';
import * as fsPromises from 'node:fs/promises';

import { PerfError } from './errors.js';

const CONFIG_FILE = 'config.json';
const PERF_TUNE_DIR = 'perf-tune';

/** MQTT 读/写凭据字段（两段结构相同） */
const CREDENTIAL_KEYS = Object.freeze(['clientId', 'username', 'password']);

/** 允许出现在配置里的键（用于未知键告警）；null 表示该子树不检查（limits 由 envelope 严格校验）。 */
const KNOWN_KEYS = Object.freeze({
  mqtt: Object.freeze({
    host: true,
    port: true,
    read: Object.freeze({ clientId: true, username: true, password: true }),
    write: Object.freeze({ clientId: true, username: true, password: true }),
  }),
  nvidiaSmi: Object.freeze({ path: true, gpuIndex: true }),
  http: Object.freeze({ allowHosts: true }),
  command: Object.freeze({ allowPrograms: true, allowPaths: true }),
  writes: Object.freeze({ enabled: true, minIntervalMs: true }),
  audit: Object.freeze({ path: true, maxBytes: true }),
  limits: null,
});

/** @type {ReadonlySet<string>} */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/**
 * DSH 主目录：`env.DSH_HOME` 优先，否则 `~/.dsh`。
 *
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 * @returns {string} 绝对路径
 */
export function dshHomeDir(env = process.env) {
  const explicit = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), '.dsh');
}

/**
 * 配置文件路径：`env.DSH_PERF_TUNE_CONFIG` 优先，
 * 否则 `<DSH_HOME 或 ~/.dsh>/perf-tune/config.json`。
 *
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 * @returns {string} 绝对路径
 */
export function configPath(env = process.env) {
  const explicit = typeof env?.DSH_PERF_TUNE_CONFIG === 'string' ? env.DSH_PERF_TUNE_CONFIG.trim() : '';
  if (explicit) return path.resolve(explicit);
  return path.join(dshHomeDir(env), PERF_TUNE_DIR, CONFIG_FILE);
}

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

/**
 * 内置默认配置（CONTRACT.md §7 的表，逐字段一致）。每次返回全新对象。
 *
 * @returns {object}
 */
export function defaultConfig() {
  return {
    mqtt: {
      host: '127.0.0.1',
      port: 13688,
      // 凭据不内置：不同机型/控制台版本的 broker 凭据可能不同，必须在配置文件里自行填写。
      // 未配置时 MQTT 通道报 E_CONFIG；nvidia-smi / HTTP / command 通道不受影响。
      read: null,
      write: null,
    },
    nvidiaSmi: { path: null, gpuIndex: 0 },
    http: { allowHosts: ['127.0.0.1', 'localhost', '::1'] },
    command: { allowPrograms: [], allowPaths: [] },
    writes: { enabled: true, minIntervalMs: 1500 },
    limits: {},
    audit: { path: null, maxBytes: 1048576 },
  };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 深拷贝（跳过原型污染键）。 @param {unknown} value */
function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) continue;
      out[key] = cloneValue(val);
    }
    return out;
  }
  return value;
}

/** @param {unknown} err */
function errorText(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** @param {unknown} value @returns {string} */
function describeValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** @param {string} field @param {unknown} value */
function configError(field, value, requirement) {
  return new PerfError(
    'E_CONFIG',
    `配置字段 ${field} 非法：${requirement}（当前值 ${describeValue(value)}）`,
    { field, requirement },
  );
}

/** @param {unknown} value @param {string} field @param {boolean} [allowEmpty] */
function requireString(value, field, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw configError(field, value, allowEmpty ? '必须是字符串' : '必须是非空字符串');
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function requireStringOrNull(value, field) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw configError(field, value, '必须是 null 或非空字符串');
  }
  return value;
}

/** @param {unknown} value @param {string} field @param {number} min @param {number} max */
function requireIntegerInRange(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw configError(field, value, `必须是 ${min}..${max} 之间的整数`);
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function requireBoolean(value, field) {
  if (typeof value !== 'boolean') throw configError(field, value, '必须是布尔值');
  return value;
}

/** @param {unknown} value */
function validateGpuIndex(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw configError('nvidiaSmi.gpuIndex', value, '必须是非负整数');
  }
  return value;
}

/**
 * CONTRACT §1：所有 I/O 函数在 signal abort 时尽快结束，取消错误统一
 * `PerfError('E_IO', '已取消')`。
 *
 * @param {AbortSignal|undefined} signal
 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw new PerfError('E_IO', '已取消');
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string[]}
 */
function requireStringArray(value, field) {
  if (!Array.isArray(value)) throw configError(field, value, '必须是字符串数组');
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.length === 0) {
      throw configError(`${field}[${index}]`, item, '必须是非空字符串');
    }
    return item;
  });
}

// ---------------------------------------------------------------------------
// 未知键告警
// ---------------------------------------------------------------------------

/**
 * 收集 raw 中不在 KNOWN_KEYS 白名单内的键（支持点号路径），写入 out。
 *
 * @param {Record<string, unknown>} raw
 * @param {Record<string, unknown>|null} spec
 * @param {string} prefix
 * @param {string[]} out
 */
function collectUnknownKeys(raw, spec, prefix, out) {
  if (!isPlainObject(raw) || spec === null) return;
  for (const [key, value] of Object.entries(raw)) {
    const full = prefix ? `${prefix}.${key}` : key;
    const childSpec = spec[key];
    if (childSpec === undefined) {
      out.push(`未知配置键 ${full}，已忽略`);
      continue;
    }
    if (isPlainObject(childSpec) && isPlainObject(value)) {
      collectUnknownKeys(value, childSpec, full, out);
    }
  }
}

// ---------------------------------------------------------------------------
// 校验 / 规范化
// ---------------------------------------------------------------------------

/**
 * 用默认值补全并校验 raw，返回规范化后的配置（未知键被剔除）。
 * 非法 → `E_CONFIG`。
 *
 * @param {unknown} raw
 * @returns {object}
 */
export function validateConfig(raw) {
  if (raw === undefined) raw = {};
  if (!isPlainObject(raw)) {
    throw new PerfError('E_CONFIG', '配置必须是 JSON 对象', { valueType: typeof raw });
  }

  const defaults = defaultConfig();
  /** @type {Record<string, any>} */
  const src = /** @type {any} */ (raw);

  const mqtt = isPlainObject(src.mqtt) ? src.mqtt : {};
  const read = isPlainObject(mqtt.read) ? mqtt.read : {};
  const write = isPlainObject(mqtt.write) ? mqtt.write : {};
  const nvidiaSmi = isPlainObject(src.nvidiaSmi) ? src.nvidiaSmi : {};
  const http = isPlainObject(src.http) ? src.http : {};
  const command = isPlainObject(src.command) ? src.command : {};
  const writes = isPlainObject(src.writes) ? src.writes : {};
  const audit = isPlainObject(src.audit) ? src.audit : {};

  // limits 是可选键（缺省 = 纯硬包线，不做任何收窄）。
  if (src.limits !== undefined && src.limits !== null && !isPlainObject(src.limits)) {
    throw configError('limits', src.limits, '必须是 JSON 对象');
  }

  const normalized = {
    mqtt: {
      host: requireString(mqtt.host ?? defaults.mqtt.host, 'mqtt.host'),
      port: requireIntegerInRange(mqtt.port ?? defaults.mqtt.port, 'mqtt.port', 1, 65535),
      read: normalizeCredentials(read, 'mqtt.read'),
      write: normalizeCredentials(write, 'mqtt.write'),
    },
    nvidiaSmi: {
      path: requireStringOrNull(nvidiaSmi.path ?? defaults.nvidiaSmi.path, 'nvidiaSmi.path'),
      gpuIndex: validateGpuIndex(nvidiaSmi.gpuIndex ?? defaults.nvidiaSmi.gpuIndex),
    },
    http: {
      allowHosts: requireStringArray(http.allowHosts ?? defaults.http.allowHosts, 'http.allowHosts'),
    },
    command: {
      allowPrograms: requireStringArray(
        command.allowPrograms ?? defaults.command.allowPrograms,
        'command.allowPrograms',
      ),
      allowPaths: requireStringArray(
        command.allowPaths ?? defaults.command.allowPaths,
        'command.allowPaths',
      ),
    },
    writes: {
      enabled: requireBoolean(writes.enabled ?? defaults.writes.enabled, 'writes.enabled'),
      minIntervalMs: validateMinIntervalMs(
        writes.minIntervalMs ?? defaults.writes.minIntervalMs,
      ),
    },
    limits: src.limits === undefined || src.limits === null ? {} : cloneValue(src.limits),
    audit: {
      path: requireStringOrNull(audit.path ?? defaults.audit.path, 'audit.path'),
      maxBytes: validateAuditMaxBytes(audit.maxBytes ?? defaults.audit.maxBytes),
    },
  };

  return normalized;
}

/**
 * 凭据段：未提供（undefined/null/空对象）→ null；提供时 clientId 必填，
 * username/password 允许空字符串（MQTT 协议允许无认证）。
 *
 * 插件不内置任何凭据：不同机型/控制台版本的 broker 凭据可能不同，
 * 未配置时由 MQTT 通道报 E_CONFIG（见 lib/channel-mqtt.js）。
 *
 * @param {Record<string, unknown>} raw
 * @param {string} fieldPrefix
 * @returns {{clientId: string, username: string, password: string}|null}
 */
function normalizeCredentials(raw, fieldPrefix) {
  const hasAny = CREDENTIAL_KEYS.some((key) => raw[key] !== undefined && raw[key] !== null);
  if (!hasAny) return null;

  return {
    clientId: requireString(raw.clientId, `${fieldPrefix}.clientId`),
    username: requireString(raw.username ?? '', `${fieldPrefix}.username`, true),
    password: requireString(raw.password ?? '', `${fieldPrefix}.password`, true),
  };
}

/**
 * 契约 §7：`writes.minIntervalMs` 整数 ≥ 1000；低于 1000 **直接抛 E_CONFIG**
 * （不静默 clamp——"限定安全范围"优先于宽容）。
 *
 * @param {unknown} value
 */
function validateMinIntervalMs(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1000) {
    throw configError('writes.minIntervalMs', value, '必须是 ≥ 1000 的整数（硬下限 1000ms）');
  }
  return value;
}

/** @param {unknown} value */
function validateAuditMaxBytes(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 4096) {
    throw configError('audit.maxBytes', value, '必须是 ≥ 4096 的整数');
  }
  return value;
}

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

/**
 * 加载配置：
 * - 文件不存在 → 默认配置 + warning（`source:'default'`）。
 * - JSON 解析失败 / 字段非法 → `E_CONFIG`。
 * - 读写失败（非 ENOENT）→ `E_IO`；signal abort → `E_IO('已取消')`。
 *
 * @param {{ env?: NodeJS.ProcessEnv|Record<string,string|undefined>, fs?: object, signal?: AbortSignal }} [options]
 * @returns {Promise<{config: object, source: 'file'|'default', path: string, warnings: string[]}>}
 */
export async function loadConfig({ env = process.env, fs = fsPromises, signal } = {}) {
  throwIfAborted(signal);
  const filePath = configPath(env);

  /** @type {string} */
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    throwIfAborted(signal);
    if (/** @type {any} */ (err)?.code === 'ENOENT') {
      return {
        config: validateConfig(defaultConfig()),
        source: 'default',
        path: filePath,
        warnings: [`未找到配置文件 ${filePath}，使用内置默认值`],
      };
    }
    throw new PerfError('E_IO', `读取配置文件失败 ${filePath}: ${errorText(err)}`, {
      path: filePath,
    });
  }
  throwIfAborted(signal);

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PerfError(
      'E_CONFIG',
      `配置文件 ${filePath} JSON 解析失败: ${errorText(err)}`,
      { path: filePath },
    );
  }

  if (!isPlainObject(parsed)) {
    throw new PerfError('E_CONFIG', `配置文件 ${filePath} 根节点必须是 JSON 对象`, {
      path: filePath,
    });
  }

  const warnings = [];
  collectUnknownKeys(parsed, KNOWN_KEYS, '', warnings);

  return {
    config: validateConfig(parsed),
    source: 'file',
    path: filePath,
    warnings,
  };
}
