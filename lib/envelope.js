/**
 * 硬安全包线 + 配置收窄 + 写入校验（CONTRACT.md §8）。
 *
 * 核心原则：
 * 1. 包线数值来自本文件（OEM 控制台逆向得到的硬件边界），**不可**被配置放宽；
 *    `config.limits` 只能收窄（newMin >= hard.min、newMax <= hard.max、newMin < newMax）。
 * 2. 越界一律 `E_SAFETY`，**绝不静默 clamp**——调用方要看到被拒绝的真实值。
 * 3. MQTT 控制面 topic 精确白名单（不做前缀匹配）；payload 结构/深度/字节数/未知数值 key 全量校验。
 */

import { PerfError } from './errors.js';

/** 数值包线是否整数化后校验（nvidia-smi 频率单位 MHz，整卡功耗单位 W）。 */
const MAX_PAYLOAD_DEPTH = 8;

/** 原型污染键：HTTP JSON / MQTT payload 里出现即拒绝。 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** MQTT payload 中单个字符串值的字符上限（契约 §8.4）。 */
const MAX_STRING_CHARS = 256;

/** 单条 MQTT payload 的字节上限（硬包线，配置不可放大）。 */
const MAX_PAYLOAD_BYTES = 2048;

/** 写入冷却硬下限（毫秒）；config.limits 只能把它调大。 */
const HARD_MIN_INTERVAL_MS = 1000;

/** 允许收窄的 nvidiaSmi 包线键。 */
const NVIDIA_LIMIT_KEYS = Object.freeze(['coreMhz', 'memMhz', 'powerW']);

/**
 * 硬安全包线。**任何配置都不能放大这里的数值。**
 *
 * `mqtt.numeric` 与 CONTRACT.md §8.1 逐项一致：`rule.key` 是配置收窄用的稳定标识，
 * `match` 匹配 payload 里的属性名（首个匹配生效），`min`/`max` 为闭区间。
 */
export const HARD_ENVELOPE = Object.freeze({
  nvidiaSmi: Object.freeze({
    coreMhz: Object.freeze({ min: 300, max: 2500 }), // 核心锁定频率
    memMhz: Object.freeze({ min: 500, max: 9000 }), // 显存锁定频率
    powerW: Object.freeze({ min: 60, max: 140 }), // 整卡功耗（本机 OEM 上限 140W）
  }),
  mqtt: Object.freeze({
    maxPayloadBytes: MAX_PAYLOAD_BYTES,
    topics: Object.freeze(['Fan/Control', 'Customize/Control']), // 控制面硬白名单
    numeric: Object.freeze(
      [
        { key: 'ConfigurableTGPTarget', match: /^ConfigurableTGPTarget$/i, min: 60, max: 140 },
        { key: 'ConfigurableTGPSwitch', match: /^ConfigurableTGPSwitch$/i, min: 0, max: 1 },
        { key: 'DynamicBoost', match: /^DynamicBoost$/i, min: 0, max: 25 },
        { key: 'DynamicBoostSwitch', match: /^DynamicBoostSwitch$/i, min: 0, max: 1 },
        { key: 'TargetTemperature', match: /^TargetTemperature$/i, min: 60, max: 87 },
        { key: 'coreOffset', match: /core.*(offset|freq)/i, min: 0, max: 250 },
        { key: 'memOffset', match: /mem.*(offset|freq)/i, min: -2000, max: 2000 },
        { key: 'fanDuty', match: /fan.*(speed|duty|pwm|percent)/i, min: 0, max: 100 },
        { key: 'pl1pl2', match: /^PL[12]$/i, min: 60, max: 150 },
        { key: 'pl4', match: /^PL4$/i, min: 60, max: 220 },
        { key: 'temperature', match: /temp(erature)?(limit|target)/i, min: 50, max: 87 },
      ].map((rule) => Object.freeze(rule)),
    ),
    unknownNumericKeys: 'reject', // 规则未匹配到的数值型 key → E_SAFETY
  }),
  write: Object.freeze({
    hardMinIntervalMs: HARD_MIN_INTERVAL_MS,
    maxPayloadDepth: MAX_PAYLOAD_DEPTH,
  }),
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {string} */
function describeValue(value) {
  if (typeof value === 'string') return `"${value}"`;
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * @param {string} field
 * @param {unknown} value
 * @param {string} requirement
 */
function configError(field, value, requirement) {
  return new PerfError(
    'E_CONFIG',
    `配置项 ${field} 非法：${requirement}（当前值 ${describeValue(value)}）`,
    { field, requirement },
  );
}

/**
 * 校验一个数值区间是否在硬包线内且非空。
 *
 * 收窄规则：newMin >= hard.min、newMax <= hard.max、newMin < newMax；
 * 只写 min 或只写 max 时，另一侧继承硬包线。
 *
 * @param {string} field 配置路径，用于报错
 * @param {{min:number,max:number}} hard
 * @param {unknown} conf
 * @returns {{min:number,max:number}}
 */
function narrowRange(field, hard, conf) {
  if (!isPlainObject(conf)) {
    throw configError(field, conf, '必须是 { "min": number, "max": number } 对象');
  }
  for (const key of Object.keys(conf)) {
    if (key !== 'min' && key !== 'max') {
      throw configError(`${field}.${key}`, conf[key], '只允许 min 与 max 两个字段');
    }
  }
  if (conf.min === undefined && conf.max === undefined) {
    throw configError(field, conf, '至少需要提供 min 或 max 之一');
  }
  const min = conf.min === undefined ? hard.min : conf.min;
  const max = conf.max === undefined ? hard.max : conf.max;
  if (typeof min !== 'number' || !Number.isFinite(min)) {
    throw configError(`${field}.min`, min, '必须是有限数字');
  }
  if (typeof max !== 'number' || !Number.isFinite(max)) {
    throw configError(`${field}.max`, max, '必须是有限数字');
  }
  if (min < hard.min) {
    throw configError(
      `${field}.min`,
      min,
      `试图放宽硬包线下限（允许范围 ${hard.min}..${hard.max}，min 不得小于 ${hard.min}）`,
    );
  }
  if (max > hard.max) {
    throw configError(
      `${field}.max`,
      max,
      `试图放宽硬包线上限（允许范围 ${hard.min}..${hard.max}，max 不得大于 ${hard.max}）`,
    );
  }
  if (min >= max) {
    throw configError(`${field}`, { min, max }, `收窄后的区间必须满足 min < max（当前 ${min}..${max}）`);
  }
  return { min, max };
}

/** @param {string} field @param {unknown} value */
function requireObject(field, value) {
  if (!isPlainObject(value)) {
    throw configError(field, value, '必须是 JSON 对象');
  }
  return value;
}

/**
 * 解析传入的包线对象。
 *
 * 正常调用路径传的是 `effectiveLimits(config)` 的返回值；为容错也接受只含子树的
 * 部分对象或直接传 `HARD_ENVELOPE`。缺失时退回硬包线（最宽松的**安全**起点）。
 *
 * @param {unknown} limits
 */
function resolveNvidiaLimits(limits) {
  if (isPlainObject(limits) && isPlainObject(limits.nvidiaSmi)) return limits.nvidiaSmi;
  return effectiveLimits().nvidiaSmi;
}

/** @param {unknown} limits */
function resolveMqttLimits(limits) {
  if (isPlainObject(limits) && isPlainObject(limits.mqtt)) return limits.mqtt;
  return effectiveLimits().mqtt;
}

// ---------------------------------------------------------------------------
// 配置收窄
// ---------------------------------------------------------------------------

/**
 * 计算「硬包线 ∩ config.limits」的有效包线。配置若试图放宽硬包线 → `E_CONFIG`。
 *
 * @param {object} [config] 已规范化的配置（loadConfig().config）
 * @returns {{nvidiaSmi: object, mqtt: object, writes: {enabled: boolean, minIntervalMs: number, hardMinIntervalMs: number}}}
 */
export function effectiveLimits(config = {}) {
  const cfg = isPlainObject(config) ? config : {};
  const limits = cfg.limits === undefined ? {} : cfg.limits;
  requireObject('limits', limits);

  for (const key of Object.keys(limits)) {
    if (key !== 'nvidiaSmi' && key !== 'mqtt' && key !== 'writes') {
      throw configError(`limits.${key}`, limits[key], '未知的收窄命名空间（只允许 nvidiaSmi/mqtt/writes）');
    }
  }

  // --- nvidiaSmi：只能收窄 coreMhz / memMhz / powerW -----------------------
  const nvidiaSmi = {
    coreMhz: { ...HARD_ENVELOPE.nvidiaSmi.coreMhz },
    memMhz: { ...HARD_ENVELOPE.nvidiaSmi.memMhz },
    powerW: { ...HARD_ENVELOPE.nvidiaSmi.powerW },
  };
  if (limits.nvidiaSmi !== undefined) {
    const confNvidia = requireObject('limits.nvidiaSmi', limits.nvidiaSmi);
    for (const key of Object.keys(confNvidia)) {
      if (!NVIDIA_LIMIT_KEYS.includes(key)) {
        throw configError(
          `limits.nvidiaSmi.${key}`,
          confNvidia[key],
          `未知的 nvidiaSmi 包线键（只允许 ${NVIDIA_LIMIT_KEYS.join('/')}）`,
        );
      }
      nvidiaSmi[key] = narrowRange(
        `limits.nvidiaSmi.${key}`,
        HARD_ENVELOPE.nvidiaSmi[key],
        confNvidia[key],
      );
    }
  }

  // --- mqtt：只能收窄 numeric 规则 ----------------------------------------
  const mqtt = {
    maxPayloadBytes: HARD_ENVELOPE.mqtt.maxPayloadBytes,
    topics: [...HARD_ENVELOPE.mqtt.topics],
    numeric: HARD_ENVELOPE.mqtt.numeric.map((rule) => ({
      key: rule.key,
      match: rule.match,
      min: rule.min,
      max: rule.max,
    })),
    unknownNumericKeys: HARD_ENVELOPE.mqtt.unknownNumericKeys,
  };
  if (limits.mqtt !== undefined) {
    const confMqtt = requireObject('limits.mqtt', limits.mqtt);
    for (const key of Object.keys(confMqtt)) {
      if (key !== 'numeric') {
        throw configError(
          `limits.mqtt.${key}`,
          confMqtt[key],
          '未知的 mqtt 收窄项（只允许 numeric；topic 白名单与 payload 上限是硬包线，不可配置）',
        );
      }
    }
    if (confMqtt.numeric !== undefined) {
      const confNumeric = requireObject('limits.mqtt.numeric', confMqtt.numeric);
      for (const [ruleKey, range] of Object.entries(confNumeric)) {
        const index = mqtt.numeric.findIndex((rule) => rule.key === ruleKey);
        if (index < 0) {
          throw configError(
            `limits.mqtt.numeric.${ruleKey}`,
            range,
            `未知的数值包线规则名（可用规则：${mqtt.numeric.map((rule) => rule.key).join(', ')}）`,
          );
        }
        const hardRule = HARD_ENVELOPE.mqtt.numeric[index];
        const narrowed = narrowRange(`limits.mqtt.numeric.${ruleKey}`, hardRule, range);
        mqtt.numeric[index] = {
          key: hardRule.key,
          match: hardRule.match,
          min: narrowed.min,
          max: narrowed.max,
        };
      }
    }
  }

  // --- writes：只允许把冷却时间调大 ---------------------------------------
  const confWrites = isPlainObject(cfg.writes) ? cfg.writes : {};
  let minIntervalMs = HARD_ENVELOPE.write.hardMinIntervalMs;
  if (typeof confWrites.minIntervalMs === 'number' && Number.isFinite(confWrites.minIntervalMs)) {
    minIntervalMs = Math.max(minIntervalMs, confWrites.minIntervalMs);
  }
  if (limits.writes !== undefined) {
    const confLimitWrites = requireObject('limits.writes', limits.writes);
    for (const key of Object.keys(confLimitWrites)) {
      if (key !== 'minIntervalMs') {
        throw configError(
          `limits.writes.${key}`,
          confLimitWrites[key],
          '未知的 writes 收窄项（只允许 minIntervalMs）',
        );
      }
    }
    if (confLimitWrites.minIntervalMs !== undefined) {
      const value = confLimitWrites.minIntervalMs;
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < HARD_ENVELOPE.write.hardMinIntervalMs
      ) {
        throw configError(
          'limits.writes.minIntervalMs',
          value,
          `必须是 ≥ ${HARD_ENVELOPE.write.hardMinIntervalMs} 的整数（硬下限不可下调）`,
        );
      }
      minIntervalMs = Math.max(minIntervalMs, value);
    }
  }

  return {
    nvidiaSmi,
    mqtt,
    writes: {
      enabled: confWrites.enabled === undefined ? true : Boolean(confWrites.enabled),
      minIntervalMs,
      hardMinIntervalMs: HARD_ENVELOPE.write.hardMinIntervalMs,
    },
  };
}

// ---------------------------------------------------------------------------
// nvidia-smi 写入校验
// ---------------------------------------------------------------------------

/** @param {number} value @param {string} label */
function formatMhz(value) {
  return `${value} MHz`;
}

/**
 * 数值化并校验单个频率值（Math.round 后做闭区间校验，不 clamp）。
 *
 * @param {unknown} raw
 * @param {string} label
 * @param {{min:number,max:number}} range
 * @param {string} field 参数路径（报错用）
 */
function checkMhzValue(raw, label, range, field) {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new PerfError('E_ARGS', `${field} 必须是有限数字（${label}），当前值 ${describeValue(raw)}`, {
      field,
    });
  }
  const value = Math.round(raw);
  if (value < range.min || value > range.max) {
    throw new PerfError(
      'E_SAFETY',
      `${label} ${formatMhz(value)} 超出允许区间 ${range.min}..${range.max} MHz（配置/硬包线）`,
      { value, min: range.min, max: range.max, label },
    );
  }
  return value;
}

/**
 * 校验 `mhz` 参数：`number` 或 `{ min, max }`；整数化、区间合法且落在包线内。
 *
 * @param {unknown} raw
 * @param {string} label
 * @param {{min:number,max:number}} range
 * @param {string} field
 * @returns {number|{min:number,max:number}}
 */
function checkMhz(raw, label, range, field) {
  if (raw === undefined || raw === null) {
    throw new PerfError('E_ARGS', `${field} 缺少 ${label}值（number 或 { min, max }）`, { field });
  }
  if (typeof raw === 'number') return checkMhzValue(raw, label, range, field);
  if (isPlainObject(raw)) {
    for (const key of Object.keys(raw)) {
      if (key !== 'min' && key !== 'max') {
        throw new PerfError('E_ARGS', `${field} 只允许 min 与 max 两个字段（发现 ${key}）`, {
          field,
        });
      }
    }
    if (raw.min === undefined && raw.max === undefined) {
      throw new PerfError('E_ARGS', `${field} 至少需要提供 min 或 max 之一`, { field });
    }
    const min = checkMhzValue(raw.min, label, range, `${field}.min`);
    const max = checkMhzValue(raw.max, label, range, `${field}.max`);
    if (min > max) {
      throw new PerfError(
        'E_ARGS',
        `${label}区间非法：min ${min} 大于 max ${max}（${field}）`,
        { field, min, max },
      );
    }
    return { min, max };
  }
  throw new PerfError(
    'E_ARGS',
    `${field} 必须是 number 或 { min, max } 对象，当前值 ${describeValue(raw)}`,
    { field },
  );
}

const NVIDIA_WRITE_OPS = new Set([
  'lock-core',
  'lock-mem',
  'reset-core',
  'reset-mem',
  'reset-all',
  'power-limit',
]);

/**
 * 校验并规范化 nvidia-smi 写入操作。越界 → `E_SAFETY`（不 clamp）。
 *
 * @param {object} op 形如 `{ op:'lock-core', mhz:1600, gpuIndex:0 }`
 * @param {object} [limits] `effectiveLimits(config)` 的返回值
 * @returns {{op: object, limits: {min:number,max:number}|null}}
 */
export function checkNvidiaWrite(op, limits) {
  if (!isPlainObject(op)) {
    throw new PerfError(
      'E_ARGS',
      'nvidia-smi 写入操作必须是对象，例如 { "op": "lock-core", "mhz": 1600 }',
    );
  }
  const name = op.op;
  if (typeof name !== 'string' || name.length === 0) {
    throw new PerfError('E_ARGS', 'nvidia-smi 写入操作缺少 op 字段', { op });
  }
  if (!NVIDIA_WRITE_OPS.has(name)) {
    throw new PerfError(
      'E_ARGS',
      `不支持的 nvidia-smi 写入操作 "${name}"（支持：${[...NVIDIA_WRITE_OPS].join('/')}）`,
      { op: name },
    );
  }

  const nvidiaLimits = resolveNvidiaLimits(limits);

  switch (name) {
    case 'lock-core':
    case 'lock-mem': {
      const isCore = name === 'lock-core';
      const range = isCore ? nvidiaLimits.coreMhz : nvidiaLimits.memMhz;
      const label = isCore ? '核心锁频' : '显存锁频';
      const value = checkMhz(op.mhz, label, range, 'mhz');
      return {
        op: { ...op, op: name, mhz: value },
        limits: { min: range.min, max: range.max },
      };
    }
    case 'power-limit': {
      const range = nvidiaLimits.powerW;
      const watts = op.watts;
      if (typeof watts !== 'number' || !Number.isFinite(watts)) {
        throw new PerfError(
          'E_ARGS',
          `power-limit 的 watts 必须是有限数字，当前值 ${describeValue(watts)}`,
          { watts },
        );
      }
      if (watts < range.min || watts > range.max) {
        throw new PerfError(
          'E_SAFETY',
          `整卡功耗上限 ${watts} W 超出允许区间 ${range.min}..${range.max} W（配置/硬包线）`,
          { value: watts, min: range.min, max: range.max },
        );
      }
      return {
        op: { ...op, op: name, watts },
        limits: { min: range.min, max: range.max },
      };
    }
    default: {
      // reset-core / reset-mem / reset-all：无目标数值，不做区间校验。
      return { op: { ...op, op: name }, limits: null };
    }
  }
}

// ---------------------------------------------------------------------------
// MQTT 发布校验
// ---------------------------------------------------------------------------

/**
 * 取 payload 路径的「叶子键名」：数组元素继承其所在属性的键名。
 *
 * `GPU.FanDuty` → `FanDuty`；`FanDuty[0]` → `FanDuty`；`Values[0][1]` → `Values`。
 *
 * @param {string} path
 */
function leafKeyOf(path) {
  const name = path.replace(/(\[\d+\])+$/, '');
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1) : name;
}

/**
 * 在规则表里找首个匹配 payload 属性名的数值包线规则。
 *
 * @param {string} key 属性名
 * @param {{key:string, match:RegExp, min:number, max:number}[]} rules
 */
function matchNumericRule(key, rules) {
  for (const rule of rules) {
    rule.match.lastIndex = 0; // 防 /g 状态；硬包线规则本身无 /g
    if (rule.match.test(key)) return rule;
  }
  return null;
}

/**
 * 递归校验 payload 容器（对象/数组）。深度从 1 开始计（根容器 = 1）。
 *
 * @param {object|any[]} container
 * @param {number} depth 当前容器深度
 * @param {string} path 当前路径（报错用）
 * @param {object} ctx
 */
function walkContainer(container, depth, path, ctx) {
  if (depth > HARD_ENVELOPE.write.maxPayloadDepth) {
    const where = path || 'payload 根';
    throw new PerfError(
      'E_SAFETY',
      `${where} 的嵌套深度 ${depth} 超过硬上限 ${HARD_ENVELOPE.write.maxPayloadDepth} 层`,
      { path: where, depth, maxDepth: HARD_ENVELOPE.write.maxPayloadDepth },
    );
  }
  if (Array.isArray(container)) {
    for (let index = 0; index < container.length; index += 1) {
      walkValue(container[index], depth, `${path}[${index}]`, ctx);
    }
    return;
  }
  for (const key of Object.keys(container)) {
    if (UNSAFE_KEYS.has(key)) {
      const where = path ? `${path}.${key}` : key;
      throw new PerfError(
        'E_SAFETY',
        `payload 含被禁止的键 "${key}"（${where}），疑似原型污染`,
        { path: where, key },
      );
    }
    walkValue(container[key], depth, path ? `${path}.${key}` : key, ctx);
  }
}

/**
 * 校验单个 payload 值。
 *
 * @param {unknown} value
 * @param {number} parentDepth 父容器深度（子容器深度 = parentDepth + 1）
 * @param {string} path
 * @param {{rules: object[], checked: object[], unknownNumericKeys: string[]}} ctx
 */
function walkValue(value, parentDepth, path, ctx) {
  if (Array.isArray(value) || isPlainObject(value)) {
    walkContainer(value, parentDepth + 1, path, ctx);
    return;
  }
  if (value === null) return;
  if (typeof value === 'number' || typeof value === 'boolean') {
    const numeric = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    if (!Number.isFinite(numeric)) {
      throw new PerfError('E_SAFETY', `payload 字段 ${path} 不是有限数值（${describeValue(value)}）`, {
        path,
      });
    }
    const rule = matchNumericRule(leafKeyOf(path), ctx.rules);
    if (!rule) {
      ctx.unknownNumericKeys.push(path);
      return;
    }
    if (numeric < rule.min || numeric > rule.max) {
      throw new PerfError(
        'E_SAFETY',
        `payload 字段 ${path}=${describeValue(value)} 超出允许区间 ${rule.min}..${rule.max}（规则 ${rule.key}）`,
        { path, value: numeric, min: rule.min, max: rule.max, rule: rule.key },
      );
    }
    ctx.checked.push({ key: rule.key, value: numeric, min: rule.min, max: rule.max });
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_CHARS) {
      throw new PerfError(
        'E_SAFETY',
        `payload 字段 ${path} 字符串长度 ${value.length} 超过硬上限 ${MAX_STRING_CHARS} 字符`,
        { path, length: value.length, max: MAX_STRING_CHARS },
      );
    }
    return;
  }
  throw new PerfError(
    'E_SAFETY',
    `payload 字段 ${path} 类型不被支持（${typeof value}）`,
    { path },
  );
}

/**
 * 校验 MQTT 控制面发布：topic 精确白名单、payload 字节上限、JSON 结构、数值包线。
 *
 * @param {string} topic
 * @param {string} payloadJson 待发布的 JSON 字符串
 * @param {object} [limits] `effectiveLimits(config)` 的返回值
 * @returns {{topic: string, payload: object, bytes: number, checked: {key:string,value:number,min:number,max:number}[]}}
 */
export function checkMqttPublish(topic, payloadJson, limits) {
  const mqttLimits = resolveMqttLimits(limits);

  if (typeof topic !== 'string' || topic.length === 0) {
    throw new PerfError('E_ARGS', 'MQTT topic 必须是非空字符串', { topic });
  }
  const allowedTopics = Array.isArray(mqttLimits.topics) ? mqttLimits.topics : HARD_ENVELOPE.mqtt.topics;
  if (!allowedTopics.includes(topic)) {
    throw new PerfError(
      'E_SAFETY',
      `MQTT topic "${topic}" 不在控制面硬白名单内（仅允许精确匹配：${allowedTopics.join(', ')}）`,
      { topic, allowedTopics: [...allowedTopics] },
    );
  }

  if (typeof payloadJson !== 'string') {
    throw new PerfError(
      'E_ARGS',
      `MQTT payload 必须是 JSON 字符串，当前类型 ${typeof payloadJson}`,
    );
  }

  const bytes = Buffer.byteLength(payloadJson, 'utf8');
  const maxPayloadBytes = mqttLimits.maxPayloadBytes ?? HARD_ENVELOPE.mqtt.maxPayloadBytes;
  if (bytes > maxPayloadBytes) {
    throw new PerfError(
      'E_SAFETY',
      `MQTT payload ${bytes} 字节超过硬上限 ${maxPayloadBytes} 字节`,
      { bytes, maxPayloadBytes },
    );
  }

  /** @type {unknown} */
  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (err) {
    throw new PerfError(
      'E_ARGS',
      `MQTT payload 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isPlainObject(payload)) {
    throw new PerfError('E_SAFETY', 'MQTT payload 根节点必须是 JSON 对象', {
      rootType: Array.isArray(payload) ? 'array' : typeof payload,
    });
  }

  const rules =
    Array.isArray(mqttLimits.numeric) && mqttLimits.numeric.length > 0
      ? mqttLimits.numeric
      : HARD_ENVELOPE.mqtt.numeric;
  const ctx = { rules, checked: [], unknownNumericKeys: [] };
  walkContainer(payload, 1, '', ctx);

  if (ctx.unknownNumericKeys.length > 0) {
    throw new PerfError(
      'E_SAFETY',
      `MQTT payload 含未定义包线的数值字段：${ctx.unknownNumericKeys.join(', ')}` +
        `（未匹配任何 envelope.numeric 规则；可用规则：${rules.map((rule) => rule.key).join(', ')}）`,
      { unknownKeys: ctx.unknownNumericKeys },
    );
  }

  return { topic, payload, bytes, checked: ctx.checked };
}
