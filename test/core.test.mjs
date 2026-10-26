/**
 * T3 核心安全层测试：errors / config / envelope / audit。
 *
 * 覆盖 CONTRACT.md §11「T3」全部覆盖点：
 * 默认配置深合并、坏 JSON、放宽包线拒绝、收窄成功、nvidia op 越界、
 * mqtt topic 白名单、未知数值 key 拒绝、深度/大小限制、audit 追加+尾部读取+轮转。
 *
 * 所有文件 I/O 都在 `os.tmpdir()` 下的临时目录里做（mkdtemp），**不碰真实 ~/.dsh**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  PerfError,
  isPerfError,
  isErrorCode,
  ERROR_CODES,
  ERROR_CODE,
} from '../lib/errors.js';
import { configPath, dshHomeDir, defaultConfig, loadConfig, validateConfig } from '../lib/config.js';
import {
  HARD_ENVELOPE,
  effectiveLimits,
  checkNvidiaWrite,
  checkMqttPublish,
} from '../lib/envelope.js';
import { auditPath, appendAudit, readAuditTail } from '../lib/audit.js';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/** 建临时目录，测试结束自动删除。 */
async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-perf-tune-core-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 写文件（自动建父目录）。 */
async function writeTestFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

/** 写 JSON 配置文件（对象或原始文本）。 */
async function writeConfigFile(filePath, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return writeTestFile(filePath, text);
}

/** 已校验的默认配置（等同 loadConfig 无文件时的 config）。 */
function defaultValidConfig() {
  return validateConfig(defaultConfig());
}

/** 同步断言：抛 PerfError 且 code / message 匹配。返回该错误。 */
function assertPerfError(fn, code, messagePattern) {
  let caught;
  assert.throws(fn, (err) => {
    caught = err;
    return true;
  });
  assert.ok(isPerfError(caught), `期望 PerfError，实际是 ${caught}`);
  assert.equal(caught.code, code);
  if (messagePattern) assert.match(caught.message, messagePattern);
  return caught;
}

/** 异步断言：抛 PerfError 且 code / message 匹配。返回该错误。 */
async function assertPerfErrorAsync(fn, code, messagePattern) {
  let caught;
  await assert.rejects(fn, (err) => {
    caught = err;
    return true;
  });
  assert.ok(isPerfError(caught), `期望 PerfError，实际是 ${caught}`);
  assert.equal(caught.code, code);
  if (messagePattern) assert.match(caught.message, messagePattern);
  return caught;
}

const DEFAULT_LIMITS = effectiveLimits(defaultValidConfig());

// ---------------------------------------------------------------------------
// lib/errors.js
// ---------------------------------------------------------------------------

test('errors: PerfError 结构、code、message、details', () => {
  const details = { value: 3000, min: 300, max: 2500 };
  const err = new PerfError('E_SAFETY', '核心锁频 3000 MHz 超出硬包线 300..2500 MHz', details);

  assert.ok(err instanceof Error);
  assert.ok(err instanceof PerfError);
  assert.equal(err.name, 'PerfError');
  assert.equal(err.code, 'E_SAFETY');
  assert.equal(err.message, '核心锁频 3000 MHz 超出硬包线 300..2500 MHz');
  assert.deepEqual(err.details, details);
  assert.equal(isPerfError(err), true);

  const noDetails = new PerfError('E_ARGS', '参数不合法');
  assert.equal('details' in noDetails, false);
  assert.equal(isPerfError(noDetails), true);
});

test('errors: isPerfError 判定与固定错误码表完整', () => {
  assert.deepEqual(ERROR_CODES, [
    'E_ARGS',
    'E_CONFIG',
    'E_CHANNEL',
    'E_NOT_FOUND',
    'E_TIMEOUT',
    'E_SAFETY',
    'E_WRITE_DISABLED',
    'E_COOLDOWN',
    'E_ADMIN_REQUIRED',
    'E_UNSUPPORTED',
    'E_IO',
  ]);
  assert.equal(ERROR_CODE.E_SAFETY, 'E_SAFETY');
  assert.equal(ERROR_CODE.E_IO, 'E_IO');
  assert.equal(isErrorCode('E_SAFETY'), true);
  assert.equal(isErrorCode('E_NOPE'), false);
  assert.equal(isErrorCode(undefined), false);

  assert.equal(isPerfError(null), false);
  assert.equal(isPerfError(undefined), false);
  assert.equal(isPerfError('E_SAFETY'), false);
  assert.equal(isPerfError(new Error('普通错误')), false);
  assert.equal(isPerfError({ code: 'E_NOT_A_REAL_CODE', message: 'x' }), false);
  // 鸭子类型：同 code 表的 Error 也能被识别（跨模块包装场景）
  assert.equal(isPerfError({ code: 'E_SAFETY', message: '越界' }), true);
});

test('errors: PerfError 可 JSON 序列化并保留 code', () => {
  const err = new PerfError('E_CONFIG', '配置非法', { field: 'mqtt.port' });
  const plain = JSON.parse(JSON.stringify(err));
  assert.deepEqual(plain, {
    code: 'E_CONFIG',
    message: '配置非法',
    details: { field: 'mqtt.port' },
  });
});

// ---------------------------------------------------------------------------
// lib/config.js
// ---------------------------------------------------------------------------

test('config: defaultConfig 与契约逐字段一致且每次返回新对象（不含任何凭据）', () => {
  assert.deepEqual(defaultConfig(), {
    mqtt: {
      host: '127.0.0.1',
      port: 13688,
      read: null,
      write: null,
    },
    nvidiaSmi: { path: null, gpuIndex: 0 },
    http: { allowHosts: ['127.0.0.1', 'localhost', '::1'] },
    command: { allowPrograms: [], allowPaths: [] },
    writes: { enabled: true, minIntervalMs: 1500 },
    limits: {},
    audit: { path: null, maxBytes: 1048576 },
  });

  const first = defaultConfig();
  const second = defaultConfig();
  assert.notEqual(first, second);
  assert.notEqual(first.mqtt, second.mqtt);
  assert.equal(first.mqtt.read, null);
  assert.equal(second.mqtt.read, null);
  assert.notEqual(first.http.allowHosts, second.http.allowHosts);
});

test('config: configPath 优先级（DSH_PERF_TUNE_CONFIG / DSH_HOME / ~/.dsh）', async (t) => {
  const dir = await tempDir(t);
  const customFile = path.join(dir, 'custom.json');
  const home = path.join(dir, 'home');

  assert.equal(
    configPath({ DSH_PERF_TUNE_CONFIG: customFile }),
    path.resolve(customFile),
  );
  // 两者同时存在时自定义文件优先
  assert.equal(
    configPath({ DSH_PERF_TUNE_CONFIG: customFile, DSH_HOME: home }),
    path.resolve(customFile),
  );
  assert.equal(
    configPath({ DSH_HOME: home }),
    path.join(home, 'perf-tune', 'config.json'),
  );
  // 都没有 → ~/.dsh/perf-tune/config.json（仅计算路径，不读文件）
  assert.equal(
    configPath({}),
    path.join(os.homedir(), '.dsh', 'perf-tune', 'config.json'),
  );
  assert.equal(dshHomeDir({ DSH_HOME: home }), path.resolve(home));
  assert.equal(dshHomeDir({}), path.join(os.homedir(), '.dsh'));
});

test('config: 文件不存在 → 默认配置 + warning', async (t) => {
  const dir = await tempDir(t);
  const missing = path.join(dir, 'no-such-dir', 'config.json');

  const result = await loadConfig({ env: { DSH_PERF_TUNE_CONFIG: missing } });
  assert.equal(result.source, 'default');
  assert.equal(result.path, path.resolve(missing));
  assert.deepEqual(result.config, defaultValidConfig());
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /未找到配置文件/);
  assert.match(result.warnings[0], /config\.json/);
});

test('config: 与默认值深合并且数组整体替换', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config.json');
  await writeConfigFile(file, {
    mqtt: { port: 1883, write: { clientId: 'CustomWriter' } },
    nvidiaSmi: { gpuIndex: 1 },
    http: { allowHosts: ['only.local'] },
    writes: { minIntervalMs: 2000 },
    audit: { maxBytes: 8192 },
  });

  const result = await loadConfig({ env: { DSH_PERF_TUNE_CONFIG: file } });
  assert.equal(result.source, 'file');
  assert.equal(result.path, path.resolve(file));
  assert.deepEqual(result.warnings, []);

  const { config } = result;
  assert.equal(config.mqtt.port, 1883);
  // 未覆盖的字段保留默认值（深合并）
  assert.equal(config.mqtt.host, '127.0.0.1');
  assert.equal(config.mqtt.read, null);
  assert.equal(config.mqtt.write.clientId, 'CustomWriter');
  assert.equal(config.mqtt.write.username, '');
  assert.equal(config.mqtt.write.password, '');
  assert.equal(config.nvidiaSmi.gpuIndex, 1);
  assert.equal(config.writes.minIntervalMs, 2000);
  // 数组整体替换，不做逐项合并
  assert.deepEqual(config.http.allowHosts, ['only.local']);
  assert.equal(config.audit.maxBytes, 8192);
});

test('config: MQTT 凭据未配置为 null；提供时 clientId 必填、username/password 可空', () => {
  const absent = validateConfig({});
  assert.equal(absent.mqtt.read, null);
  assert.equal(absent.mqtt.write, null);

  // 显式 null 也视为未配置
  const explicitNull = validateConfig({ mqtt: { read: null, write: null } });
  assert.equal(explicitNull.mqtt.read, null);
  assert.equal(explicitNull.mqtt.write, null);

  const partial = validateConfig({
    mqtt: {
      read: { clientId: 'test-reader' },
      write: { clientId: 'test-writer', username: 'u', password: 'p' },
    },
  });
  assert.deepEqual(partial.mqtt.read, { clientId: 'test-reader', username: '', password: '' });
  assert.deepEqual(partial.mqtt.write, { clientId: 'test-writer', username: 'u', password: 'p' });

  // 只有 username/password 而没有 clientId → E_CONFIG
  assertPerfError(
    () => validateConfig({ mqtt: { read: { username: 'u', password: 'p' } } }),
    'E_CONFIG',
    /mqtt\.read\.clientId/,
  );
  assertPerfError(
    () => validateConfig({ mqtt: { write: { clientId: '' } } }),
    'E_CONFIG',
    /mqtt\.write\.clientId/,
  );
});

test('config: 最小配置文件 {} 可加载（limits 等可选键缺省）', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config.json');
  await writeConfigFile(file, '{}');

  const result = await loadConfig({ env: { DSH_PERF_TUNE_CONFIG: file } });
  assert.equal(result.source, 'file'); // 文件存在 → source 为 file
  assert.deepEqual(result.config, defaultValidConfig()); // 其余字段用默认值补齐
  assert.equal(result.config.writes.minIntervalMs, 1500);
  assert.deepEqual(result.config.limits, {});
  assert.deepEqual(result.warnings, []);

  // 只有单个字段也应成功（不要求必须带 limits）
  await writeConfigFile(file, '{"writes":{"enabled":false}}');
  const partial = await loadConfig({ env: { DSH_PERF_TUNE_CONFIG: file } });
  assert.equal(partial.source, 'file');
  assert.equal(partial.config.writes.enabled, false);
  assert.equal(partial.config.mqtt.port, 13688);
});

test('config: DSH_HOME 下的默认路径会被加载', async (t) => {
  const dir = await tempDir(t);
  const home = path.join(dir, 'home');
  await writeConfigFile(path.join(home, 'perf-tune', 'config.json'), {
    mqtt: { port: 1999 },
  });

  const result = await loadConfig({ env: { DSH_HOME: home } });
  assert.equal(result.source, 'file');
  assert.equal(result.path, path.join(home, 'perf-tune', 'config.json'));
  assert.equal(result.config.mqtt.port, 1999);
});

test('config: 坏 JSON → E_CONFIG（message 含路径与解析错误）', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config.json');
  await writeConfigFile(file, '{ "mqtt": { "port": 1883, } }'); // 尾逗号

  const err = await assertPerfErrorAsync(
    () => loadConfig({ env: { DSH_PERF_TUNE_CONFIG: file } }),
    'E_CONFIG',
    /JSON 解析失败/,
  );
  assert.match(err.message, /config\.json/);
});

test('config: 根节点不是对象 → E_CONFIG', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config.json');

  await writeConfigFile(file, '[]');
  await assertPerfErrorAsync(
    () => loadConfig({ env: { DSH_PERF_TUNE_CONFIG: file } }),
    'E_CONFIG',
    /根节点必须是 JSON 对象/,
  );

  await writeConfigFile(file, '"just a string"');
  await assertPerfErrorAsync(
    () => loadConfig({ env: { DSH_PERF_TUNE_CONFIG: file } }),
    'E_CONFIG',
  );
});

test('config: 字段校验（port / gpuIndex / minIntervalMs / audit.maxBytes / enabled）', () => {
  assertPerfError(() => validateConfig({ mqtt: { port: 0 } }), 'E_CONFIG', /mqtt\.port/);
  assertPerfError(() => validateConfig({ mqtt: { port: 70000 } }), 'E_CONFIG', /mqtt\.port/);
  assertPerfError(() => validateConfig({ mqtt: { port: 1.5 } }), 'E_CONFIG', /mqtt\.port/);
  assertPerfError(() => validateConfig({ mqtt: { port: '1883' } }), 'E_CONFIG', /mqtt\.port/);
  assertPerfError(() => validateConfig({ nvidiaSmi: { gpuIndex: -1 } }), 'E_CONFIG', /gpuIndex/);
  assertPerfError(() => validateConfig({ nvidiaSmi: { gpuIndex: 1.5 } }), 'E_CONFIG', /gpuIndex/);

  // 契约 §7：minIntervalMs < 1000 直接抛 E_CONFIG（不静默 clamp）
  assertPerfError(() => validateConfig({ writes: { minIntervalMs: 999 } }), 'E_CONFIG', /minIntervalMs/);
  assertPerfError(() => validateConfig({ writes: { minIntervalMs: 500 } }), 'E_CONFIG', /1000/);
  assertPerfError(() => validateConfig({ writes: { minIntervalMs: 1000.5 } }), 'E_CONFIG', /minIntervalMs/);
  assert.equal(validateConfig({ writes: { minIntervalMs: 1000 } }).writes.minIntervalMs, 1000);
  assertPerfError(() => validateConfig({ writes: { enabled: 'yes' } }), 'E_CONFIG', /enabled/);

  assertPerfError(() => validateConfig({ audit: { maxBytes: 4095 } }), 'E_CONFIG', /audit\.maxBytes/);
  assertPerfError(() => validateConfig({ audit: { maxBytes: '4096' } }), 'E_CONFIG', /audit\.maxBytes/);
  assert.equal(validateConfig({ audit: { maxBytes: 4096 } }).audit.maxBytes, 4096);

  assertPerfError(() => validateConfig({ mqtt: { host: '' } }), 'E_CONFIG', /mqtt\.host/);
  assertPerfError(() => validateConfig({ http: { allowHosts: '127.0.0.1' } }), 'E_CONFIG', /allowHosts/);
  assertPerfError(() => validateConfig({ http: { allowHosts: ['ok', 42] } }), 'E_CONFIG', /allowHosts\[1\]/);
  assertPerfError(() => validateConfig({ nvidiaSmi: { path: 123 } }), 'E_CONFIG', /nvidiaSmi\.path/);
  assertPerfError(() => validateConfig({ limits: [] }), 'E_CONFIG', /limits/);
  assertPerfError(() => validateConfig('not-an-object'), 'E_CONFIG');

  // 合法边界值可通过
  const ok = validateConfig({ mqtt: { port: 65535 }, nvidiaSmi: { gpuIndex: 0 } });
  assert.equal(ok.mqtt.port, 65535);
  assert.equal(ok.nvidiaSmi.gpuIndex, 0);
  // gpuIndex 只要求非负整数（不额外设上限）
  assert.equal(validateConfig({ nvidiaSmi: { gpuIndex: 5000 } }).nvidiaSmi.gpuIndex, 5000);
});

test('config: 未知键只进 warnings，不进入规范化配置', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config.json');
  await writeConfigFile(file, {
    mqtt: { port: 1884 },
    unknownTop: 1,
    writes: { mystery: true },
  });

  const result = await loadConfig({ env: { DSH_PERF_TUNE_CONFIG: file } });
  assert.equal(result.config.mqtt.port, 1884);
  assert.equal('unknownTop' in result.config, false);
  assert.equal('mystery' in result.config.writes, false);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.some((w) => w.includes('unknownTop')), result.warnings.join('|'));
  assert.ok(result.warnings.some((w) => w.includes('writes.mystery')), result.warnings.join('|'));

  // validateConfig 直接调用也不保留未知键
  assert.equal('unknownTop' in validateConfig({ unknownTop: 1 }), false);
});

test('config: __proto__ / constructor 等污染键不会污染原型', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config.json');
  // 手工构造，避免 JSON.stringify 丢掉 __proto__
  await writeConfigFile(
    file,
    '{"__proto__": {"polluted": true}, "constructor": {"bad": 1}, "mqtt": {"port": 1884}}',
  );

  const result = await loadConfig({ env: { DSH_PERF_TUNE_CONFIG: file } });
  assert.equal(result.config.mqtt.port, 1884);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(result.config), Object.prototype);
  assert.equal(Object.hasOwn(result.config, '__proto__'), false);
  assert.notEqual({}.constructor, { bad: 1 });
});

test('config: 读取失败（非 ENOENT）→ E_IO', async (t) => {
  const dir = await tempDir(t);
  const failingFs = {
    readFile: async () => {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      throw err;
    },
  };
  await assertPerfErrorAsync(
    () =>
      loadConfig({
        env: { DSH_PERF_TUNE_CONFIG: path.join(dir, 'config.json') },
        fs: failingFs,
      }),
    'E_IO',
    /读取配置文件失败/,
  );
});

test('config: signal 已 abort → E_IO 已取消（CONTRACT §1）', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config.json');
  await writeConfigFile(file, '{}');

  await assertPerfErrorAsync(
    () =>
      loadConfig({
        env: { DSH_PERF_TUNE_CONFIG: file },
        signal: AbortSignal.abort(),
      }),
    'E_IO',
    /已取消/,
  );
});

// ---------------------------------------------------------------------------
// lib/envelope.js —— 硬包线
// ---------------------------------------------------------------------------

test('envelope: HARD_ENVELOPE 数值与契约逐项一致且被冻结', () => {
  assert.deepEqual(HARD_ENVELOPE.nvidiaSmi, {
    coreMhz: { min: 300, max: 2500 },
    memMhz: { min: 500, max: 9000 },
    powerW: { min: 60, max: 140 },
  });
  assert.equal(HARD_ENVELOPE.mqtt.maxPayloadBytes, 2048);
  assert.deepEqual([...HARD_ENVELOPE.mqtt.topics], ['Fan/Control', 'Customize/Control']);
  assert.equal(HARD_ENVELOPE.mqtt.unknownNumericKeys, 'reject');
  assert.equal(HARD_ENVELOPE.write.hardMinIntervalMs, 1000);
  assert.equal(HARD_ENVELOPE.write.maxPayloadDepth, 8);

  assert.ok(Object.isFrozen(HARD_ENVELOPE));
  assert.ok(Object.isFrozen(HARD_ENVELOPE.nvidiaSmi));
  assert.ok(Object.isFrozen(HARD_ENVELOPE.nvidiaSmi.coreMhz));
  assert.ok(Object.isFrozen(HARD_ENVELOPE.mqtt));
  assert.ok(Object.isFrozen(HARD_ENVELOPE.mqtt.topics));
  assert.ok(Object.isFrozen(HARD_ENVELOPE.mqtt.numeric));
  assert.ok(HARD_ENVELOPE.mqtt.numeric.every((rule) => Object.isFrozen(rule)));
  assert.ok(Object.isFrozen(HARD_ENVELOPE.write));
});

test('envelope: numeric 规则表 key/match/min/max 与契约逐项一致', () => {
  const expected = [
    ['ConfigurableTGPTarget', 60, 140],
    ['ConfigurableTGPSwitch', 0, 1],
    ['DynamicBoost', 0, 25],
    ['DynamicBoostSwitch', 0, 1],
    ['TargetTemperature', 60, 87],
    ['coreOffset', 0, 250],
    ['memOffset', -2000, 2000],
    ['fanDuty', 0, 100],
    ['pl1pl2', 60, 150],
    ['pl4', 60, 220],
    ['temperature', 50, 87],
  ];
  assert.equal(HARD_ENVELOPE.mqtt.numeric.length, expected.length);
  HARD_ENVELOPE.mqtt.numeric.forEach((rule, index) => {
    assert.equal(rule.key, expected[index][0], `rule[${index}].key`);
    assert.equal(rule.min, expected[index][1], `rule[${index}].min`);
    assert.equal(rule.max, expected[index][2], `rule[${index}].max`);
    assert.ok(rule.match instanceof RegExp, `rule[${index}].match 必须是 RegExp`);
  });

  // 「按 key 匹配」的样例（payload 里真实可能出现的字段名）
  const samples = [
    ['ConfigurableTGPTarget', 'ConfigurableTGPTarget'],
    ['ConfigurableTGPSwitch', 'ConfigurableTGPSwitch'],
    ['DynamicBoost', 'DynamicBoost'],
    ['DynamicBoostSwitch', 'DynamicBoostSwitch'],
    ['TargetTemperature', 'TargetTemperature'],
    ['GpuCoreFreqOffset', 'coreOffset'],
    ['CoreOffset', 'coreOffset'],
    ['GpuMemFreqOffset', 'memOffset'],
    ['FanDuty', 'fanDuty'],
    ['FanSpeed', 'fanDuty'],
    ['PL1', 'pl1pl2'],
    ['PL2', 'pl1pl2'],
    ['PL4', 'pl4'],
    ['temperatureLimit', 'temperature'],
  ];
  for (const [sample, expectedKey] of samples) {
    const rule = HARD_ENVELOPE.mqtt.numeric.find((candidate) => candidate.match.test(sample));
    assert.equal(rule?.key, expectedKey, `字段 ${sample} 应命中规则 ${expectedKey}`);
  }
});

test('envelope: effectiveLimits 默认值（硬包线 + config.writes）', () => {
  const limits = DEFAULT_LIMITS;
  assert.deepEqual(limits.nvidiaSmi, {
    coreMhz: { min: 300, max: 2500 },
    memMhz: { min: 500, max: 9000 },
    powerW: { min: 60, max: 140 },
  });
  assert.equal(limits.mqtt.maxPayloadBytes, 2048);
  assert.deepEqual(limits.mqtt.topics, ['Fan/Control', 'Customize/Control']);
  assert.equal(limits.mqtt.numeric.length, 11);
  assert.equal(limits.writes.enabled, true);
  assert.equal(limits.writes.minIntervalMs, 1500);
  assert.equal(limits.writes.hardMinIntervalMs, 1000);

  // 无配置时退回硬包线（最安全起点）
  const bare = effectiveLimits();
  assert.deepEqual(bare.nvidiaSmi.coreMhz, { min: 300, max: 2500 });
  assert.equal(bare.writes.enabled, true);
  assert.equal(bare.writes.minIntervalMs, 1000);
});

test('envelope: 配置收窄成功且不修改硬包线', () => {
  const config = validateConfig({
    limits: {
      nvidiaSmi: { coreMhz: { min: 800, max: 2000 }, powerW: { max: 120 } },
      writes: { minIntervalMs: 5000 },
      mqtt: { numeric: { ConfigurableTGPTarget: { max: 115 } } },
    },
  });
  const limits = effectiveLimits(config);

  assert.deepEqual(limits.nvidiaSmi.coreMhz, { min: 800, max: 2000 });
  assert.deepEqual(limits.nvidiaSmi.powerW, { min: 60, max: 120 }); // 只给 max → min 继承硬包线
  assert.deepEqual(limits.nvidiaSmi.memMhz, { min: 500, max: 9000 }); // 未收窄
  assert.equal(limits.writes.minIntervalMs, 5000);

  const tgp = limits.mqtt.numeric.find((rule) => rule.key === 'ConfigurableTGPTarget');
  assert.deepEqual({ min: tgp.min, max: tgp.max }, { min: 60, max: 115 });
  const boost = limits.mqtt.numeric.find((rule) => rule.key === 'DynamicBoost');
  assert.equal(boost.max, 25); // 其它规则不受影响

  // 硬包线常量绝不能被配置改写
  assert.equal(HARD_ENVELOPE.mqtt.numeric[0].max, 140);
  assert.equal(HARD_ENVELOPE.nvidiaSmi.coreMhz.min, 300);
  assert.equal(HARD_ENVELOPE.nvidiaSmi.powerW.max, 140);
});

test('envelope: 配置试图放宽硬包线 → E_CONFIG', () => {
  const withLimits = (limits) => validateConfig({ limits });

  assertPerfError(
    () => effectiveLimits(withLimits({ nvidiaSmi: { coreMhz: { min: 100 } } })),
    'E_CONFIG',
    /硬包线下限/,
  );
  assertPerfError(
    () => effectiveLimits(withLimits({ nvidiaSmi: { coreMhz: { max: 2600 } } })),
    'E_CONFIG',
    /硬包线上限/,
  );
  assertPerfError(
    () => effectiveLimits(withLimits({ nvidiaSmi: { memMhz: { min: 500, max: 9500 } } })),
    'E_CONFIG',
  );
  assertPerfError(
    () => effectiveLimits(withLimits({ nvidiaSmi: { powerW: { min: 200, max: 140 } } })),
    'E_CONFIG',
  );
  assertPerfError(
    () => effectiveLimits(withLimits({ nvidiaSmi: { coreMhz: { min: 2000, max: 1500 } } })),
    'E_CONFIG',
    /min < max/,
  );
  assertPerfError(
    () => effectiveLimits(withLimits({ writes: { minIntervalMs: 500 } })),
    'E_CONFIG',
    /硬下限/,
  );
  assertPerfError(
    () => effectiveLimits(withLimits({ mqtt: { numeric: { ConfigurableTGPTarget: { max: 150 } } } })),
    'E_CONFIG',
    /硬包线上限/,
  );
  assertPerfError(
    () => effectiveLimits(withLimits({ mqtt: { numeric: { DynamicBoost: { min: -1 } } } })),
    'E_CONFIG',
  );

  // 与硬包线相等（不收窄）是允许的
  assert.deepEqual(
    effectiveLimits(withLimits({ nvidiaSmi: { coreMhz: { min: 300, max: 2500 } } })).nvidiaSmi.coreMhz,
    { min: 300, max: 2500 },
  );
});

test('envelope: limits 未知键 / 未知规则名 / 类型非法 → E_CONFIG', () => {
  const withLimits = (limits) => validateConfig({ limits });

  assertPerfError(
    () => effectiveLimits(withLimits({ foo: {} })),
    'E_CONFIG',
    /limits\.foo/,
  );
  assertPerfError(
    () => effectiveLimits(withLimits({ nvidiaSmi: { clockMHz: { min: 800 } } })),
    'E_CONFIG',
    /clockMHz/,
  );
  assertPerfError(
    () => effectiveLimits(withLimits({ nvidiaSmi: { coreMhz: { min: '800' } } })),
    'E_CONFIG',
    /有限数字/,
  );
  assertPerfError(
    () => effectiveLimits(withLimits({ nvidiaSmi: { coreMhz: { max: 2000, mystery: 1 } } })),
    'E_CONFIG',
    /mystery/,
  );
  assertPerfError(
    () => effectiveLimits(withLimits({ mqtt: { numeric: { UnknownRule: { max: 100 } } } })),
    'E_CONFIG',
    /UnknownRule/,
  );
  assertPerfError(
    () => effectiveLimits(withLimits({ mqtt: { topics: ['Fan/Control'] } })),
    'E_CONFIG',
    /topics/,
  );
  assertPerfError(
    () => effectiveLimits(withLimits({ writes: { enabled: true } })),
    'E_CONFIG',
    /enabled/,
  );
  assertPerfError(
    () => effectiveLimits(withLimits({ nvidiaSmi: { coreMhz: { min: 800, max: 700 } } })),
    'E_CONFIG',
    /min < max/,
  );
});

test('envelope: 配置文件里的 limits 经 loadConfig 后生效', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'config.json');
  await writeConfigFile(file, {
    limits: {
      nvidiaSmi: { powerW: { max: 120 } },
      mqtt: { numeric: { DynamicBoost: { max: 20 } } },
    },
  });

  const { config } = await loadConfig({ env: { DSH_PERF_TUNE_CONFIG: file } });
  const limits = effectiveLimits(config);
  assert.deepEqual(limits.nvidiaSmi.powerW, { min: 60, max: 120 });
  const boost = limits.mqtt.numeric.find((rule) => rule.key === 'DynamicBoost');
  assert.equal(boost.max, 20);
});

// ---------------------------------------------------------------------------
// lib/envelope.js —— checkNvidiaWrite
// ---------------------------------------------------------------------------

test('envelope: checkNvidiaWrite lock-core / lock-mem 正常路径与取整', () => {
  let result = checkNvidiaWrite({ op: 'lock-core', mhz: 1600 }, DEFAULT_LIMITS);
  assert.deepEqual(result.op, { op: 'lock-core', mhz: 1600 });
  assert.deepEqual(result.limits, { min: 300, max: 2500 });

  // Math.round 整数化，其余字段透传
  result = checkNvidiaWrite({ op: 'lock-core', mhz: 1600.6, gpuIndex: 0 }, DEFAULT_LIMITS);
  assert.equal(result.op.mhz, 1601);
  assert.equal(result.op.gpuIndex, 0);
  assert.equal(result.op.op, 'lock-core');

  // 区间形式
  result = checkNvidiaWrite({ op: 'lock-core', mhz: { min: 1650, max: 1800 } }, DEFAULT_LIMITS);
  assert.deepEqual(result.op.mhz, { min: 1650, max: 1800 });
  assert.deepEqual(result.limits, { min: 300, max: 2500 });

  result = checkNvidiaWrite({ op: 'lock-mem', mhz: { min: 600, max: 8000 } }, DEFAULT_LIMITS);
  assert.deepEqual(result.op, { op: 'lock-mem', mhz: { min: 600, max: 8000 } });
  assert.deepEqual(result.limits, { min: 500, max: 9000 });
});

test('envelope: checkNvidiaWrite 越界 → E_SAFETY，绝不 clamp', () => {
  const err = assertPerfError(
    () => checkNvidiaWrite({ op: 'lock-core', mhz: 3000 }, DEFAULT_LIMITS),
    'E_SAFETY',
    /3000/,
  );
  assert.match(err.message, /300\.\.2500/); // message 必须给出允许区间
  assert.deepEqual(err.details, { value: 3000, min: 300, max: 2500, label: '核心锁频' });

  assertPerfError(
    () => checkNvidiaWrite({ op: 'lock-core', mhz: 299 }, DEFAULT_LIMITS),
    'E_SAFETY',
  );
  assertPerfError(
    () => checkNvidiaWrite({ op: 'lock-core', mhz: { min: 1650, max: 2600 } }, DEFAULT_LIMITS),
    'E_SAFETY',
  );
  assertPerfError(
    () => checkNvidiaWrite({ op: 'lock-mem', mhz: 20000 }, DEFAULT_LIMITS),
    'E_SAFETY',
    /20000/,
  );
  assertPerfError(
    () => checkNvidiaWrite({ op: 'lock-mem', mhz: 499 }, DEFAULT_LIMITS),
    'E_SAFETY',
  );
  assertPerfError(
    () => checkNvidiaWrite({ op: 'power-limit', watts: 150 }, DEFAULT_LIMITS),
    'E_SAFETY',
    /150/,
  );
  assertPerfError(
    () => checkNvidiaWrite({ op: 'power-limit', watts: 59 }, DEFAULT_LIMITS),
    'E_SAFETY',
  );
});

test('envelope: checkNvidiaWrite power-limit / reset-*', () => {
  const power = checkNvidiaWrite({ op: 'power-limit', watts: 120 }, DEFAULT_LIMITS);
  assert.deepEqual(power.op, { op: 'power-limit', watts: 120 });
  assert.deepEqual(power.limits, { min: 60, max: 140 });

  assert.deepEqual(checkNvidiaWrite({ op: 'power-limit', watts: 140 }, DEFAULT_LIMITS).limits, {
    min: 60,
    max: 140,
  });
  assert.deepEqual(checkNvidiaWrite({ op: 'power-limit', watts: 60 }, DEFAULT_LIMITS).limits, {
    min: 60,
    max: 140,
  });

  // reset-* 无目标数值 → limits 为 null
  for (const name of ['reset-core', 'reset-mem', 'reset-all']) {
    const result = checkNvidiaWrite({ op: name }, DEFAULT_LIMITS);
    assert.deepEqual(result, { op: { op: name }, limits: null });
  }
});

test('envelope: checkNvidiaWrite 参数非法 → E_ARGS', () => {
  assertPerfError(() => checkNvidiaWrite(null, DEFAULT_LIMITS), 'E_ARGS');
  assertPerfError(() => checkNvidiaWrite('lock-core', DEFAULT_LIMITS), 'E_ARGS');
  assertPerfError(() => checkNvidiaWrite({}, DEFAULT_LIMITS), 'E_ARGS', /op/);
  assertPerfError(() => checkNvidiaWrite({ op: 'overclock' }, DEFAULT_LIMITS), 'E_ARGS', /overclock/);
  assertPerfError(() => checkNvidiaWrite({ op: 'lock-core' }, DEFAULT_LIMITS), 'E_ARGS', /mhz/);
  assertPerfError(
    () => checkNvidiaWrite({ op: 'lock-core', mhz: '1600' }, DEFAULT_LIMITS),
    'E_ARGS',
    /number/,
  );
  assertPerfError(
    () => checkNvidiaWrite({ op: 'lock-core', mhz: Number.NaN }, DEFAULT_LIMITS),
    'E_ARGS',
  );
  assertPerfError(
    () => checkNvidiaWrite({ op: 'lock-core', mhz: { min: 1800, max: 1600 } }, DEFAULT_LIMITS),
    'E_ARGS',
    /min/,
  );
  assertPerfError(
    () => checkNvidiaWrite({ op: 'lock-core', mhz: { min: 1600, max: 1800, extra: 1 } }, DEFAULT_LIMITS),
    'E_ARGS',
    /extra/,
  );
  assertPerfError(
    () => checkNvidiaWrite({ op: 'power-limit', watts: '120' }, DEFAULT_LIMITS),
    'E_ARGS',
  );
  assertPerfError(() => checkNvidiaWrite({ op: 'power-limit' }, DEFAULT_LIMITS), 'E_ARGS');
});

test('envelope: checkNvidiaWrite 使用收窄后的包线', () => {
  const narrowed = effectiveLimits(
    validateConfig({ limits: { nvidiaSmi: { coreMhz: { min: 800, max: 2000 } } } }),
  );
  const err = assertPerfError(
    () => checkNvidiaWrite({ op: 'lock-core', mhz: 700 }, narrowed),
    'E_SAFETY',
    /800\.\.2000/,
  );
  assert.match(err.message, /700/);
  assert.equal(checkNvidiaWrite({ op: 'lock-core', mhz: 2000 }, narrowed).op.mhz, 2000);
});

// ---------------------------------------------------------------------------
// lib/envelope.js —— checkMqttPublish
// ---------------------------------------------------------------------------

test('envelope: checkMqttPublish topic 精确白名单（不做前缀匹配）', () => {
  const payload = JSON.stringify({ DynamicBoost: 25 });

  const result = checkMqttPublish('Fan/Control', payload, DEFAULT_LIMITS);
  assert.equal(result.topic, 'Fan/Control');
  assert.deepEqual(result.payload, { DynamicBoost: 25 });
  assert.equal(result.bytes, Buffer.byteLength(payload, 'utf8'));
  assert.deepEqual(result.checked, [{ key: 'DynamicBoost', value: 25, min: 0, max: 25 }]);

  checkMqttPublish('Customize/Control', payload, DEFAULT_LIMITS);

  for (const badTopic of ['Fan', 'Fan/', 'Fan/Control/', 'fan/control', 'Fan/Control/Extra', 'Customize']) {
    assertPerfError(
      () => checkMqttPublish(badTopic, payload, DEFAULT_LIMITS),
      'E_SAFETY',
      /白名单/,
    );
  }
  assertPerfError(() => checkMqttPublish('', payload, DEFAULT_LIMITS), 'E_ARGS');
  assertPerfError(() => checkMqttPublish(123, payload, DEFAULT_LIMITS), 'E_ARGS');
});

test('envelope: checkMqttPublish payload 字节上限 2048', () => {
  const core = '{"DynamicBoost":25}';
  const exactly2048 = core + ' '.repeat(2048 - core.length);
  assert.equal(Buffer.byteLength(exactly2048, 'utf8'), 2048);
  const ok = checkMqttPublish('Fan/Control', exactly2048, DEFAULT_LIMITS);
  assert.equal(ok.bytes, 2048);
  assert.deepEqual(ok.payload, { DynamicBoost: 25 });

  const tooBig = `${exactly2048} `;
  const err = assertPerfError(
    () => checkMqttPublish('Fan/Control', tooBig, DEFAULT_LIMITS),
    'E_SAFETY',
    /2048/,
  );
  assert.match(err.message, /2049/);

  // 多字节字符按 UTF-8 字节数计算
  const multibyte = JSON.stringify({ Action: '中'.repeat(700) }); // 2100+ 字节
  assert.ok(Buffer.byteLength(multibyte, 'utf8') > 2048);
  assertPerfError(
    () => checkMqttPublish('Fan/Control', multibyte, DEFAULT_LIMITS),
    'E_SAFETY',
    /字节/,
  );
});

test('envelope: checkMqttPublish JSON 非法 / 根类型 / 原型污染键', () => {
  assertPerfError(
    () => checkMqttPublish('Fan/Control', '{not json', DEFAULT_LIMITS),
    'E_ARGS',
    /JSON/,
  );
  assertPerfError(
    () => checkMqttPublish('Fan/Control', '[1,2,3]', DEFAULT_LIMITS),
    'E_SAFETY',
    /根节点/,
  );
  assertPerfError(
    () => checkMqttPublish('Fan/Control', 'null', DEFAULT_LIMITS),
    'E_SAFETY',
    /根节点/,
  );
  assertPerfError(
    () => checkMqttPublish('Fan/Control', '"plain string"', DEFAULT_LIMITS),
    'E_SAFETY',
    /根节点/,
  );

  assertPerfError(
    () => checkMqttPublish('Fan/Control', '{"__proto__":{"polluted":true}}', DEFAULT_LIMITS),
    'E_SAFETY',
    /禁止/,
  );
  assertPerfError(
    () => checkMqttPublish('Fan/Control', '{"constructor":{"x":1}}', DEFAULT_LIMITS),
    'E_SAFETY',
    /constructor/,
  );
  assertPerfError(
    () => checkMqttPublish('Fan/Control', '{"prototype":{"x":1}}', DEFAULT_LIMITS),
    'E_SAFETY',
    /prototype/,
  );
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);

  assertPerfError(
    () => checkMqttPublish('Fan/Control', { DynamicBoost: 25 }, DEFAULT_LIMITS),
    'E_ARGS',
    /JSON 字符串/,
  );
});

test('envelope: checkMqttPublish 嵌套深度上限 8', () => {
  /** 生成 levels 层嵌套对象（叶子是合法数值字段）。 */
  function nest(levels) {
    let node = { DynamicBoost: 25 };
    for (let i = 1; i < levels; i += 1) node = { nest: node };
    return node;
  }

  const okPayload = JSON.stringify(nest(8));
  const ok = checkMqttPublish('Fan/Control', okPayload, DEFAULT_LIMITS);
  assert.equal(ok.checked.length, 1);
  assert.deepEqual(ok.checked[0], { key: 'DynamicBoost', value: 25, min: 0, max: 25 });

  const deepPayload = JSON.stringify(nest(9));
  const err = assertPerfError(
    () => checkMqttPublish('Fan/Control', deepPayload, DEFAULT_LIMITS),
    'E_SAFETY',
    /嵌套深度/,
  );
  assert.match(err.message, /8/);
});

test('envelope: checkMqttPublish 未知数值 key → E_SAFETY（message 列出 key）', () => {
  const err = assertPerfError(
    () => checkMqttPublish('Fan/Control', '{"FanControlMode":2}', DEFAULT_LIMITS),
    'E_SAFETY',
    /FanControlMode/,
  );
  assert.match(err.message, /未定义包线/);

  assertPerfError(
    () => checkMqttPublish('Fan/Control', JSON.stringify({ GPU: { MysteryValue: 3 } }), DEFAULT_LIMITS),
    'E_SAFETY',
    /GPU\.MysteryValue/,
  );

  // 数组元素里的未知数值字段同样拒绝
  assertPerfError(
    () => checkMqttPublish('Fan/Control', JSON.stringify({ List: [{ Mystery: 1 }] }), DEFAULT_LIMITS),
    'E_SAFETY',
    /List\[0\]\.Mystery/,
  );

  // 多个未知 key 一次性列出
  const multi = assertPerfError(
    () => checkMqttPublish('Fan/Control', JSON.stringify({ Foo: 1, Bar: 2 }), DEFAULT_LIMITS),
    'E_SAFETY',
  );
  assert.match(multi.message, /Foo/);
  assert.match(multi.message, /Bar/);
});

test('envelope: checkMqttPublish 已知字段全表通过并返回 checked/bytes/payload', () => {
  const payload = {
    ConfigurableTGPTarget: 140,
    ConfigurableTGPSwitch: 1,
    DynamicBoost: 25,
    DynamicBoostSwitch: 0,
    TargetTemperature: 87,
    GpuCoreFreqOffset: 200,
    GpuMemFreqOffset: -1500,
    FanDuty: 80,
    PL1: 130,
    PL2: 150,
    PL4: 200,
    temperatureLimit: 85,
  };
  const text = JSON.stringify(payload);
  assert.ok(Buffer.byteLength(text, 'utf8') <= 2048);

  const result = checkMqttPublish('Customize/Control', text, DEFAULT_LIMITS);
  assert.equal(result.topic, 'Customize/Control');
  assert.deepEqual(result.payload, payload);
  assert.equal(result.bytes, Buffer.byteLength(text, 'utf8'));
  assert.equal(result.checked.length, 12);

  /** @type {Record<string, any>} */
  const byKey = {};
  for (const entry of result.checked) byKey[entry.key] = entry;
  assert.deepEqual(byKey.ConfigurableTGPTarget, {
    key: 'ConfigurableTGPTarget',
    value: 140,
    min: 60,
    max: 140,
  });
  assert.deepEqual(byKey.DynamicBoost, { key: 'DynamicBoost', value: 25, min: 0, max: 25 });
  assert.deepEqual(byKey.coreOffset, { key: 'coreOffset', value: 200, min: 0, max: 250 });
  assert.deepEqual(byKey.memOffset, { key: 'memOffset', value: -1500, min: -2000, max: 2000 });
  assert.deepEqual(byKey.fanDuty, { key: 'fanDuty', value: 80, min: 0, max: 100 });
  assert.deepEqual(byKey.pl1pl2, { key: 'pl1pl2', value: 150, min: 60, max: 150 });
  assert.equal(byKey.pl4.value, 200);
  assert.deepEqual(byKey.temperature, { key: 'temperature', value: 85, min: 50, max: 87 });
});

test('envelope: checkMqttPublish 已知字段越界 → E_SAFETY', () => {
  const cases = [
    [{ ConfigurableTGPTarget: 141 }, /141/],
    [{ ConfigurableTGPTarget: 59 }],
    [{ ConfigurableTGPSwitch: 2 }],
    [{ DynamicBoost: 26 }],
    [{ DynamicBoost: -1 }],
    [{ DynamicBoostSwitch: 2 }],
    [{ TargetTemperature: 88 }],
    [{ TargetTemperature: 59 }],
    [{ GpuCoreFreqOffset: 251 }],
    [{ GpuCoreFreqOffset: -1 }],
    [{ GpuMemFreqOffset: 2001 }],
    [{ GpuMemFreqOffset: -2001 }],
    [{ FanDuty: 101 }],
    [{ FanSpeed: -1 }],
    [{ PL1: 59 }],
    [{ PL2: 151 }],
    [{ PL4: 221 }],
    [{ temperatureLimit: 49 }],
    [{ temperatureLimit: 88 }],
  ];
  for (const [payload, pattern] of cases) {
    assertPerfError(
      () => checkMqttPublish('Fan/Control', JSON.stringify(payload), DEFAULT_LIMITS),
      'E_SAFETY',
      pattern,
    );
  }
});

test('envelope: checkMqttPublish 布尔 / 数组 / 字符串上限', () => {
  const boolResult = checkMqttPublish(
    'Fan/Control',
    JSON.stringify({ ConfigurableTGPSwitch: true, DynamicBoostSwitch: false }),
    DEFAULT_LIMITS,
  );
  assert.deepEqual(boolResult.checked, [
    { key: 'ConfigurableTGPSwitch', value: 1, min: 0, max: 1 },
    { key: 'DynamicBoostSwitch', value: 0, min: 0, max: 1 },
  ]);

  // 数组元素递归校验（元素为对象时按自身 key 匹配）
  const arrayResult = checkMqttPublish(
    'Fan/Control',
    JSON.stringify({ Values: [{ DynamicBoost: 25 }, { TargetTemperature: 80 }] }),
    DEFAULT_LIMITS,
  );
  assert.deepEqual(
    arrayResult.checked.map((entry) => entry.key),
    ['DynamicBoost', 'TargetTemperature'],
  );

  // 数字数组继承父属性名做规则匹配
  const fanArray = checkMqttPublish('Fan/Control', JSON.stringify({ FanDuty: [40, 80] }), DEFAULT_LIMITS);
  assert.deepEqual(fanArray.checked, [
    { key: 'fanDuty', value: 40, min: 0, max: 100 },
    { key: 'fanDuty', value: 80, min: 0, max: 100 },
  ]);

  // 字符串字段不校验内容，但单个字符串 > 256 字符 → E_SAFETY
  const action256 = JSON.stringify({ Action: 'a'.repeat(256) });
  const okAction = checkMqttPublish('Fan/Control', action256, DEFAULT_LIMITS);
  assert.deepEqual(okAction.checked, []); // 字符串不产生 checked 项
  assertPerfError(
    () => checkMqttPublish('Fan/Control', JSON.stringify({ Action: 'a'.repeat(257) }), DEFAULT_LIMITS),
    'E_SAFETY',
    /256/,
  );

  // JSON 数字溢出为 Infinity → 拒绝（非有限数值）
  assertPerfError(
    () => checkMqttPublish('Fan/Control', '{"DynamicBoost":1e999}', DEFAULT_LIMITS),
    'E_SAFETY',
    /有限数值/,
  );
});

test('envelope: checkMqttPublish 使用收窄后的数值包线', () => {
  const config = validateConfig({
    limits: { mqtt: { numeric: { ConfigurableTGPTarget: { max: 115 } } } },
  });
  const narrowed = effectiveLimits(config);

  const err = assertPerfError(
    () => checkMqttPublish('Fan/Control', JSON.stringify({ ConfigurableTGPTarget: 120 }), narrowed),
    'E_SAFETY',
    /60\.\.115/,
  );
  assert.match(err.message, /120/);

  const ok = checkMqttPublish(
    'Fan/Control',
    JSON.stringify({ ConfigurableTGPTarget: 115 }),
    narrowed,
  );
  assert.deepEqual(ok.checked, [{ key: 'ConfigurableTGPTarget', value: 115, min: 60, max: 115 }]);
});

// ---------------------------------------------------------------------------
// lib/audit.js
// ---------------------------------------------------------------------------

test('audit: auditPath 优先 config.audit.path，否则 <DSH_HOME>/perf-tune/audit.jsonl', async (t) => {
  const dir = await tempDir(t);
  const home = path.join(dir, 'home');
  const customAudit = path.join(dir, 'custom', 'audit.jsonl');

  assert.equal(
    auditPath({ audit: { path: customAudit, maxBytes: 1048576 } }, { DSH_HOME: home }),
    path.resolve(customAudit),
  );
  assert.equal(
    auditPath(defaultValidConfig(), { DSH_HOME: home }),
    path.join(home, 'perf-tune', 'audit.jsonl'),
  );
  assert.equal(
    auditPath(undefined, { DSH_HOME: home }),
    path.join(home, 'perf-tune', 'audit.jsonl'),
  );
});

test('audit: appendAudit 建目录写 JSONL 并返回 bytes', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'nested', 'logs', 'audit.jsonl');
  const config = { audit: { path: file, maxBytes: 1048576 } };
  const entry = {
    ts: '2026-10-26T19:40:00.000Z',
    tool: 'perf_tune',
    decision: 'dry-run',
    channel: 'nvidia-smi',
    request: { op: 'lock-core', mhz: 1600 },
    reason: '测试',
  };

  const result = await appendAudit(entry, { config, env: { DSH_HOME: path.join(dir, 'unused') } });
  assert.equal(result.path, path.resolve(file));
  assert.ok(result.bytes > 0);

  const text = await fs.readFile(result.path, 'utf8');
  assert.ok(text.endsWith('\n'));
  const lines = text.split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), entry);
  assert.equal(result.bytes, Buffer.byteLength(text, 'utf8'));
});

test('audit: readAuditTail 最新在前 / limit / 文件不存在', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'audit.jsonl');
  const config = { audit: { path: file, maxBytes: 1048576 } };

  const entries = [1, 2, 3].map((n) => ({
    ts: `2026-10-26T19:40:0${n}.000Z`,
    tool: 'perf_tune',
    decision: 'applied',
    channel: 'mqtt',
    request: { n },
  }));
  for (const entry of entries) await appendAudit(entry, { config });

  const tail2 = await readAuditTail({ limit: 2, config });
  assert.deepEqual(tail2.map((entry) => entry.ts), [entries[2].ts, entries[1].ts]);

  const all = await readAuditTail({ config });
  assert.deepEqual(all.map((entry) => entry.ts), [entries[2].ts, entries[1].ts, entries[0].ts]);

  assert.deepEqual(await readAuditTail({ limit: 0, config }), []);

  const missing = { audit: { path: path.join(dir, 'none', 'audit.jsonl'), maxBytes: 1048576 } };
  assert.deepEqual(await readAuditTail({ config: missing }), []);

  // 读取失败（非 ENOENT）→ E_IO
  const failingFs = {
    readFile: async () => {
      const err = new Error('denied');
      err.code = 'EACCES';
      throw err;
    },
  };
  await assertPerfErrorAsync(
    () => readAuditTail({ config, fs: failingFs }),
    'E_IO',
    /读取审计文件失败/,
  );
});

test('audit: 超过 maxBytes 时单次轮转 audit.jsonl.1', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'audit.jsonl');
  const config = { audit: { path: file, maxBytes: 4096 } };

  const makeEntry = (n) => ({
    ts: `2026-10-26T19:40:0${n}.000Z`,
    tool: 'perf_tune',
    decision: 'applied',
    channel: 'nvidia-smi',
    request: { note: 'x'.repeat(2000) },
  });
  const first = makeEntry(1);
  const second = makeEntry(2);

  await appendAudit(first, { config });
  const firstSize = (await fs.stat(file)).size;
  assert.ok(firstSize < 4096, `第一条应小于 maxBytes，实际 ${firstSize}`);

  await appendAudit(second, { config });

  const rotated = await fs.readFile(`${file}.1`, 'utf8');
  assert.deepEqual(JSON.parse(rotated.trim()), first); // 旧文件被轮转为 .1
  const current = await fs.readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(current.trim()), second); // 新文件只含最新一条
  assert.deepEqual((await readAuditTail({ config })).map((entry) => entry.ts), [second.ts]);
});

test('audit: 单条 entry > 8 KiB 时截断 request/result 并标记 _truncated', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'audit.jsonl');
  const config = { audit: { path: file, maxBytes: 1048576 } };
  const entry = {
    ts: '2026-10-26T19:40:00.000Z',
    tool: 'perf_tune',
    decision: 'applied',
    channel: 'mqtt',
    request: { note: 'y'.repeat(20000) },
    result: { ok: true },
    reason: '超大 entry',
  };

  await appendAudit(entry, { config });
  const text = await fs.readFile(file, 'utf8');
  const line = text.replace(/\n$/, '');
  assert.ok(Buffer.byteLength(line, 'utf8') <= 8192, `单行字节数 ${Buffer.byteLength(line)} 应 ≤ 8192`);

  const parsed = JSON.parse(line);
  assert.equal(parsed._truncated, true);
  assert.equal(parsed.ts, entry.ts);
  assert.equal(parsed.tool, 'perf_tune');
  assert.equal(parsed.decision, 'applied');
  assert.equal(parsed.channel, 'mqtt');
  assert.equal(typeof parsed.request, 'string');
  assert.ok(Buffer.byteLength(parsed.request, 'utf8') <= 4096);
  assert.ok(parsed.request.includes('yyyy'));
  // 截断后仍是合法 JSON，尾部读取可解析
  const tail = await readAuditTail({ config });
  assert.equal(tail.length, 1);
  assert.equal(tail[0]._truncated, true);
});

test('audit: 写失败 → E_IO（message 含路径）', async (t) => {
  const dir = await tempDir(t);
  const blocker = path.join(dir, 'blocker');
  await fs.writeFile(blocker, 'this is a file, not a directory', 'utf8');
  const badPath = path.join(blocker, 'audit.jsonl');
  const entry = {
    ts: '2026-10-26T19:40:00.000Z',
    tool: 'perf_tune',
    decision: 'rejected',
    channel: 'nvidia-smi',
    request: {},
  };

  const err = await assertPerfErrorAsync(
    () => appendAudit(entry, { config: { audit: { path: badPath, maxBytes: 1048576 } } }),
    'E_IO',
    /写入审计文件失败/,
  );
  assert.match(err.message, /audit\.jsonl/);
});

test('audit: signal 已 abort → E_IO 已取消（CONTRACT §1）', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'audit.jsonl');
  const config = { audit: { path: file, maxBytes: 1048576 } };
  const entry = {
    ts: '2026-10-26T19:40:00.000Z',
    tool: 'perf_tune',
    decision: 'applied',
    channel: 'nvidia-smi',
    request: {},
  };

  await assertPerfErrorAsync(
    () => appendAudit(entry, { config, signal: AbortSignal.abort() }),
    'E_IO',
    /已取消/,
  );
  await assertPerfErrorAsync(
    () => readAuditTail({ config, signal: AbortSignal.abort() }),
    'E_IO',
    /已取消/,
  );
  // abort 时不应产生审计文件
  await assert.rejects(() => fs.stat(file));
});

test('audit: loadConfig 得到的 audit.path 会被 appendAudit 使用', async (t) => {
  const dir = await tempDir(t);
  const home = path.join(dir, 'home');
  const auditFile = path.join(dir, 'from-config', 'audit.jsonl');
  await writeConfigFile(path.join(home, 'perf-tune', 'config.json'), {
    audit: { path: auditFile, maxBytes: 4096 },
  });

  const loaded = await loadConfig({ env: { DSH_HOME: home } });
  await appendAudit(
    {
      ts: '2026-10-26T19:40:00.000Z',
      tool: 'perf_tune',
      decision: 'applied',
      channel: 'nvidia-smi',
      request: { op: 'reset-core' },
    },
    { config: loaded.config, env: { DSH_HOME: path.join(dir, 'other-home') } },
  );

  const stat = await fs.stat(auditFile);
  assert.ok(stat.size > 0);
  assert.equal(
    auditPath(loaded.config, { DSH_HOME: path.join(dir, 'other-home') }),
    path.resolve(auditFile),
  );
});
