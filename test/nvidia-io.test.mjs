/**
 * T2 单元测试：lib/run.js、lib/channel-nvidia.js、lib/channel-http.js、lib/channel-command.js。
 *
 * 契约依据：CONTRACT.md §3、§4、§6、§11（T2 覆盖点）。
 * - 通道测试全部注入 mock `run` / mock `fetch`，不碰真实硬件、不联网；
 * - run.js 用本机 node 子进程做行为验证（本地进程，不涉及 GPU / 网络）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { PerfError } from '../lib/errors.js';
import { run } from '../lib/run.js';
import { createNvidiaChannel } from '../lib/channel-nvidia.js';
import { createHttpChannel } from '../lib/channel-http.js';
import { createCommandChannel } from '../lib/channel-command.js';

// ────────────────────────────── 通用断言辅助 ──────────────────────────────

/** 执行 action 并返回其抛出的错误；若未抛错则失败。 */
async function captureError(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  assert.fail('期望抛出错误，但函数正常返回');
}

/** 断言错误是 PerfError 且 code/message 符合预期。 */
function assertPerfError(error, code, messagePart) {
  assert.ok(
    error instanceof PerfError,
    `期望 PerfError，实际 ${error?.constructor?.name ?? typeof error}: ${error?.message}`,
  );
  assert.equal(error.code, code, `错误码不符：期望 ${code}，实际 ${error.code}（${error.message}）`);
  if (messagePart !== undefined) {
    assert.ok(
      String(error.message).includes(messagePart),
      `错误消息应包含 ${JSON.stringify(messagePart)}，实际：${error.message}`,
    );
  }
  return error;
}

/** await + 断言：action 必须抛出指定 code 的 PerfError。 */
async function expectPerfError(action, code, messagePart) {
  return assertPerfError(await captureError(action), code, messagePart);
}

/** 可注入的假时钟：sleep 推进 now，使回读轮询测试不必真的等 3 秒。 */
function createFakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
    advance: (ms) => {
      current += ms;
    },
    get time() {
      return current;
    },
  };
}

/** 构造通用的 run mock（返回 CONTRACT §3 形状的结果对象）。 */
function createRunMock(handler) {
  const calls = [];
  const runMock = async (program, args = [], options = {}) => {
    calls.push({ program, args: [...args], options });
    const overrides = (await handler?.(program, args, options)) ?? {};
    return {
      program,
      args: [...args],
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
      durationMs: 1,
      ...overrides,
    };
  };
  runMock.calls = calls;
  return runMock;
}

// ────────────────────────────── lib/run.js ──────────────────────────────

test('run: 捕获 stdout / 退出码 0，返回完整结果形状', async () => {
  const result = await run(process.execPath, ['-e', 'process.stdout.write("hello")']);
  assert.equal(result.program, process.execPath);
  assert.deepEqual(result.args, ['-e', 'process.stdout.write("hello")']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.stderr, '');
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
});

test('run: 捕获 stderr，非零退出不抛错', async () => {
  const result = await run(process.execPath, [
    '-e',
    'process.stdout.write("out"); process.stderr.write("err"); process.exit(2)',
  ]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.timedOut, false);
});

test('run: 参数原样传递，不经过 shell（含空格的参数不被拆分）', async () => {
  const result = await run(process.execPath, [
    '-e',
    'process.stdout.write(process.argv[1] ?? "")',
    'a b;c&d|e',
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'a b;c&d|e');
});

test('run: ENOENT → E_NOT_FOUND，details 带 program', async () => {
  const program = 'nvio-no-such-program-xyz-12345';
  const error = await expectPerfError(() => run(program, []), 'E_NOT_FOUND', '未找到可执行文件');
  assert.equal(error.details?.program, program);
});

test('run: 超时杀进程，返回 timedOut:true / code:null（不抛错）', async () => {
  const startedAt = Date.now();
  const result = await run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 200 });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.ok(elapsed >= 100 && elapsed < 4000, `超时后应尽快返回，实际 ${elapsed}ms`);
});

test('run: 超过 maxBytes 截断并置 truncated:true（进程正常结束）', async () => {
  const result = await run(process.execPath, ['-e', 'process.stdout.write("x".repeat(400))'], {
    maxBytes: 100,
  });
  assert.equal(result.code, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.stdout.length, 100);
  assert.equal(result.stdout, 'x'.repeat(100));
});

test('run: 截断按 UTF-8 字符边界，不产生半个中文字符', async () => {
  const result = await run(process.execPath, ['-e', 'process.stdout.write("你".repeat(100))'], {
    maxBytes: 100,
  });
  assert.equal(result.truncated, true);
  assert.equal(result.stdout, '你'.repeat(33));
});

test('run: env / cwd 选项生效', async () => {
  const envResult = await run(process.execPath, ['-e', 'process.stdout.write(process.env.NVIO_TEST_VALUE ?? "")'], {
    env: { ...process.env, NVIO_TEST_VALUE: '42' },
  });
  assert.equal(envResult.stdout, '42');

  const cwdResult = await run(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], {
    cwd: os.tmpdir(),
  });
  assert.equal(path.resolve(cwdResult.stdout).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
});

test('run: AbortSignal 取消 → E_IO「已取消」', async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const startedAt = Date.now();
  const error = await expectPerfError(
    () => run(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { signal: controller.signal }),
    'E_IO',
    '已取消',
  );
  assert.ok(Date.now() - startedAt < 3000);
  assert.equal(error.code, 'E_IO');
});

test('run: 已取消的 signal 立即抛 E_IO', async () => {
  const controller = new AbortController();
  controller.abort();
  await expectPerfError(
    () => run(process.execPath, ['-e', ''], { signal: controller.signal }),
    'E_IO',
    '已取消',
  );
});

test('run: 参数校验 E_ARGS', async () => {
  await expectPerfError(() => run('', []), 'E_ARGS');
  await expectPerfError(() => run(123, []), 'E_ARGS');
  await expectPerfError(() => run(process.execPath, 'not-an-array'), 'E_ARGS');
  await expectPerfError(() => run(process.execPath, ['-e', 1]), 'E_ARGS');
});

// ──────────────────────── lib/channel-nvidia.js：read ────────────────────────

const NVIDIA_CONFIG = { nvidiaSmi: { path: null, gpuIndex: 0 } };

/** nvidia-smi run mock：按 `--query-gpu=` 与写操作标记区分行为。 */
function createNvidiaRunMock(options = {}) {
  const calls = [];
  const stats = { queryCalls: 0, writeCalls: 0 };
  const defaultFieldValues = {
    'clocks.gr': '1650',
    'clocks.max.gr': '1650',
    'clocks.mem': '8001',
    'power.limit': '115',
  };
  const runMock = async (program, args = [], runOptions = {}) => {
    calls.push({ program, args: [...args], options: runOptions });
    let overrides = {};
    if (typeof args[0] === 'string' && args[0].startsWith('--query-gpu=')) {
      stats.queryCalls += 1;
      const fields = args[0].slice('--query-gpu='.length).split(',');
      if (typeof options.query === 'function') {
        overrides = await options.query({ fields, gpuIndex: args[3], call: stats.queryCalls });
      }
      if (options.csv !== undefined) {
        const stdout = typeof options.csv === 'function' ? options.csv(fields, stats.queryCalls) : options.csv;
        overrides = { ...overrides, stdout };
      } else if (typeof options.query !== 'function') {
        const stdout = fields.map((field) => defaultFieldValues[field] ?? '1').join(', ') + '\n';
        overrides = { ...overrides, stdout };
      }
    } else {
      stats.writeCalls += 1;
      if (typeof options.write === 'function') overrides = await options.write(args, stats.writeCalls);
    }
    return {
      program,
      args: [...args],
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
      durationMs: 1,
      ...overrides,
    };
  };
  return { runMock, calls, stats };
}

function makeNvidiaChannel({ config = NVIDIA_CONFIG, runMock, clock } = {}) {
  const fakeClock = clock ?? createFakeClock();
  const channel = createNvidiaChannel({
    config,
    deps: { run: runMock, now: fakeClock.now, sleep: fakeClock.sleep },
  });
  return { channel, clock: fakeClock };
}

test('nvidia read: CSV 解析 [N/A] / 小数 / 负号 / 字符串 / 去引号', async () => {
  const csv =
    'NVIDIA GeForce RTX 4070 Laptop GPU, 45.67, [N/A], -1, 210, "N/A", [Not Supported], 8001.5\n';
  const fields = [
    'name',
    'power.draw',
    'temperature.gpu',
    'clocks.gr',
    'clocks.mem',
    'fan.speed',
    'clocks.max.gr',
    'power.limit',
  ];
  const { runMock, calls } = createNvidiaRunMock({ csv });
  const { channel } = makeNvidiaChannel({ runMock });

  const result = await channel.read({ fields });
  assert.equal(result.kind, 'nvidia-smi');
  assert.equal(result.gpuIndex, 0);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.fields.map((field) => field.name),
    fields,
  );
  const values = Object.fromEntries(result.fields.map((field) => [field.name, field.value]));
  assert.equal(values.name, 'NVIDIA GeForce RTX 4070 Laptop GPU');
  assert.equal(values['power.draw'], 45.67);
  assert.equal(values['temperature.gpu'], null);
  assert.equal(values['clocks.gr'], -1);
  assert.equal(values['clocks.mem'], 210);
  assert.equal(values['fan.speed'], null);
  assert.equal(values['clocks.max.gr'], null);
  assert.equal(values['power.limit'], 8001.5);
  assert.equal(result.fields[2].raw, '[N/A]');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, 'nvidia-smi');
  assert.deepEqual(calls[0].args, [
    '--query-gpu=' + fields.join(','),
    '--format=csv,noheader,nounits',
    '-i',
    '0',
  ]);
});

test('nvidia read: 多行输出只解析第一行，stderr 变成 warnings', async () => {
  const clock = createFakeClock();
  const base = createNvidiaRunMock({ csv: '1, 2\r\n3, 4\r\n' });
  const runMock = async (program, args, options) => {
    const result = await base.runMock(program, args, options);
    return { ...result, stderr: 'Warning: something\n' };
  };
  const channel = createNvidiaChannel({
    config: NVIDIA_CONFIG,
    deps: { run: runMock, now: clock.now, sleep: clock.sleep },
  });
  const result = await channel.read({ fields: ['a', 'b'] });
  assert.deepEqual(result.fields.map((field) => field.value), [1, 2]);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes('Warning: something'));
});

test('nvidia read: 字段数不匹配 → E_CHANNEL', async () => {
  const { runMock } = createNvidiaRunMock({ csv: 'a, b\n' });
  const { channel } = makeNvidiaChannel({ runMock });
  await expectPerfError(() => channel.read({ fields: ['a', 'b', 'c'] }), 'E_CHANNEL', '字段数');
});

test('nvidia read: 非零退出 → E_CHANNEL，message 带 stderr 头部', async () => {
  const { runMock } = createNvidiaRunMock({
    query: () => ({ code: 1, stderr: 'Field "nope" is not a valid field to query.' }),
  });
  const { channel } = makeNvidiaChannel({ runMock });
  const error = await expectPerfError(() => channel.read({ fields: ['nope'] }), 'E_CHANNEL');
  assert.ok(error.message.includes('not a valid field'));
});

test('nvidia read: stderr 含 Insufficient Permissions → E_ADMIN_REQUIRED', async () => {
  const { runMock } = createNvidiaRunMock({
    query: () => ({ code: 1, stderr: 'Insufficient Permissions' }),
  });
  const { channel } = makeNvidiaChannel({ runMock });
  await expectPerfError(() => channel.read({ fields: ['name'] }), 'E_ADMIN_REQUIRED', 'Insufficient Permissions');
});

test('nvidia read: 超时 → E_TIMEOUT', async () => {
  const { runMock } = createNvidiaRunMock({ query: () => ({ timedOut: true, code: null }) });
  const { channel } = makeNvidiaChannel({ runMock });
  await expectPerfError(() => channel.read({ fields: ['name'] }), 'E_TIMEOUT');
});

test('nvidia read: 无输出 → E_CHANNEL', async () => {
  const { runMock } = createNvidiaRunMock({ csv: '  \n\n' });
  const { channel } = makeNvidiaChannel({ runMock });
  await expectPerfError(() => channel.read({ fields: ['name'] }), 'E_CHANNEL');
});

test('nvidia read: deps.run 的 E_NOT_FOUND 原样透传', async () => {
  const runMock = createRunMock(() => {
    throw new PerfError('E_NOT_FOUND', '未找到可执行文件：nvidia-smi', { program: 'nvidia-smi' });
  });
  const { channel } = makeNvidiaChannel({ runMock });
  await expectPerfError(() => channel.read({ fields: ['name'] }), 'E_NOT_FOUND', 'nvidia-smi');
});

test('nvidia read: fields / gpuIndex / timeoutMs 校验与优先级', async () => {
  const { runMock, calls } = createNvidiaRunMock();
  const { channel } = makeNvidiaChannel({ runMock, config: { nvidiaSmi: { path: null, gpuIndex: 1 } } });

  await expectPerfError(() => channel.read({}), 'E_ARGS');
  await expectPerfError(() => channel.read({ fields: [] }), 'E_ARGS');
  await expectPerfError(() => channel.read({ fields: 'name' }), 'E_ARGS');
  await expectPerfError(() => channel.read({ fields: ['bad-field'] }), 'E_ARGS');
  await expectPerfError(() => channel.read({ fields: ['a b'] }), 'E_ARGS');
  await expectPerfError(
    () => channel.read({ fields: Array.from({ length: 65 }, (_, index) => `field${index}`) }),
    'E_ARGS',
  );
  await expectPerfError(() => channel.read({ fields: ['name'], gpuIndex: -1 }), 'E_ARGS');

  await channel.read({ fields: ['name'], timeoutMs: 1234 });
  assert.deepEqual(calls.at(-1).args.slice(-2), ['-i', '1']);
  assert.equal(calls.at(-1).options.timeoutMs, 1234);

  await channel.read({ fields: ['name'], gpuIndex: 2 });
  assert.deepEqual(calls.at(-1).args.slice(-2), ['-i', '2']);
});

// ──────────────────────── lib/channel-nvidia.js：write ────────────────────────

test('nvidia write lock-core(number)：-lgc args 拼装 + 回读 ok=true', async () => {
  const { runMock, calls } = createNvidiaRunMock({ csv: '1650, 1650', write: () => ({ stdout: 'ok' }) });
  const { channel } = makeNvidiaChannel({ runMock });

  const result = await channel.write({ op: 'lock-core', mhz: 1600 });
  assert.equal(result.op, 'lock-core');
  assert.equal(result.applied, true);
  assert.equal(result.verify.checked, true);
  assert.equal(result.verify.ok, true);
  assert.equal(result.verify.observed['clocks.gr'], 1650);
  assert.deepEqual(result.commands, [{ args: ['-i', '0', '-lgc', '1600'], code: 0, stdout: 'ok', stderr: '' }]);
  assert.deepEqual(calls[0].args, ['-i', '0', '-lgc', '1600']);
});

test('nvidia write lock-core(区间)：-lgc min,max 写法', async () => {
  const { runMock, calls } = createNvidiaRunMock({ csv: '1700, 1750' });
  const { channel } = makeNvidiaChannel({ runMock });

  const result = await channel.write({ op: 'lock-core', mhz: { min: 1650, max: 1800 } });
  assert.deepEqual(calls[0].args, ['-i', '0', '-lgc', '1650,1800']);
  assert.equal(result.verify.ok, true); // 1700 >= 1650 * 0.5
});

test('nvidia write lock-core：回读轮询（先 [N/A]，拿到数值即停）', async () => {
  const clock = createFakeClock();
  const { runMock, stats } = createNvidiaRunMock({
    query: ({ call }) => ({ stdout: call < 3 ? 'N/A, N/A' : '1600, 1800' }),
  });
  const { channel } = makeNvidiaChannel({ runMock, clock });

  const result = await channel.write({ op: 'lock-core', mhz: 1600 });
  assert.equal(stats.queryCalls, 3);
  assert.equal(result.verify.checked, true);
  assert.equal(result.verify.ok, true);
  assert.equal(result.verify.observed['clocks.gr'], 1600);
  assert.ok(clock.time >= 600);
});

test('nvidia write lock-core：3 秒内始终无数值 → ok=false 且提示需负载复验', async () => {
  const clock = createFakeClock();
  const { runMock, stats } = createNvidiaRunMock({ query: () => ({ stdout: 'N/A, N/A' }) });
  const { channel } = makeNvidiaChannel({ runMock, clock });

  const result = await channel.write({ op: 'lock-core', mhz: 1600 });
  assert.equal(result.verify.checked, true);
  assert.equal(result.verify.ok, false);
  assert.ok(result.verify.note.includes('复验'));
  assert.ok(clock.time >= 2700 && clock.time <= 3000);
  assert.ok(stats.queryCalls >= 5 && stats.queryCalls <= 12);
});

test('nvidia write lock-core：回读失败不影响写入结论（checked:false / ok:null）', async () => {
  const { runMock } = createNvidiaRunMock({
    query: () => {
      throw new PerfError('E_CHANNEL', '回读 boom');
    },
  });
  const { channel } = makeNvidiaChannel({ runMock });

  const result = await channel.write({ op: 'lock-core', mhz: 1600 });
  assert.equal(result.applied, true);
  assert.equal(result.verify.checked, false);
  assert.equal(result.verify.ok, null);
  assert.equal(result.verify.observed, null);
  assert.ok(result.verify.note.includes('回读失败'));
  assert.ok(result.verify.note.includes('boom'));
});

test('nvidia write lock-core：非零退出按 stderr 映射 E_ADMIN_REQUIRED / E_UNSUPPORTED / E_CHANNEL', async () => {
  const admin = createNvidiaRunMock({
    write: () => ({ code: 1, stderr: 'Insufficient Permissions' }),
  });
  await expectPerfError(
    () => makeNvidiaChannel({ runMock: admin.runMock }).channel.write({ op: 'lock-core', mhz: 1600 }),
    'E_ADMIN_REQUIRED',
    'Insufficient Permissions',
  );

  const unsupported = createNvidiaRunMock({
    write: () => ({ code: 1, stderr: 'Setting GPU clocks is not supported on this device' }),
  });
  await expectPerfError(
    () => makeNvidiaChannel({ runMock: unsupported.runMock }).channel.write({ op: 'lock-core', mhz: 1600 }),
    'E_UNSUPPORTED',
  );

  const other = createNvidiaRunMock({ write: () => ({ code: 9, stderr: 'unknown failure' }) });
  await expectPerfError(
    () => makeNvidiaChannel({ runMock: other.runMock }).channel.write({ op: 'lock-core', mhz: 1600 }),
    'E_CHANNEL',
    'unknown failure',
  );
});

test('nvidia write lock-mem：NVML 退出码 4（无 stderr）→ E_CHANNEL，消息末尾提示 sudo.exe 重试', async () => {
  const { runMock } = createNvidiaRunMock({ write: () => ({ code: 4, stderr: '' }) });
  const { channel } = makeNvidiaChannel({ runMock });

  const error = await expectPerfError(() => channel.write({ op: 'lock-mem', mhz: 7000 }), 'E_CHANNEL');
  assert.equal(error.message, 'nvidia-smi lock-mem 失败（退出码 4） Try run again with sudo.exe');
});

test('nvidia write 复位：权限类失败追加 sudo.exe 提示，非权限失败不追加', async () => {
  const denied = createNvidiaRunMock({ write: () => ({ code: 4 }) });
  const deniedError = await expectPerfError(
    () => makeNvidiaChannel({ runMock: denied.runMock }).channel.write({ op: 'reset-mem' }),
    'E_CHANNEL',
  );
  assert.ok(deniedError.message.endsWith('Try run again with sudo.exe'));

  const other = createNvidiaRunMock({ write: () => ({ code: 9, stderr: 'unknown failure' }) });
  const otherError = await expectPerfError(
    () => makeNvidiaChannel({ runMock: other.runMock }).channel.write({ op: 'reset-mem' }),
    'E_CHANNEL',
  );
  assert.equal(otherError.message.includes('sudo.exe'), false);
});

test('nvidia write lock-mem：-lmc args + clocks.mem 回读', async () => {
  const { runMock, calls } = createNvidiaRunMock({ csv: '8001' });
  const { channel } = makeNvidiaChannel({ runMock });

  const result = await channel.write({ op: 'lock-mem', mhz: 8001 });
  assert.deepEqual(calls[0].args, ['-i', '0', '-lmc', '8001']);
  assert.equal(result.verify.checked, true);
  assert.equal(result.verify.ok, true);
  assert.equal(result.verify.observed['clocks.mem'], 8001);
  assert.ok(result.verify.note.includes('复验'));
});

test('nvidia write lock-mem：区间写法', async () => {
  const { runMock, calls } = createNvidiaRunMock({ csv: '8001' });
  const { channel } = makeNvidiaChannel({ runMock });
  await channel.write({ op: 'lock-mem', mhz: { min: 500, max: 8001 } });
  assert.deepEqual(calls[0].args, ['-i', '0', '-lmc', '500,8001']);
});

test('nvidia write reset-core / reset-mem：args 与 ok=null 回读语义', async () => {
  const core = createNvidiaRunMock({ csv: '210' });
  const coreResult = await makeNvidiaChannel({ runMock: core.runMock }).channel.write({ op: 'reset-core' });
  assert.deepEqual(core.calls[0].args, ['-i', '0', '-rgc']);
  assert.equal(coreResult.verify.checked, true);
  assert.equal(coreResult.verify.ok, null);
  assert.equal(coreResult.verify.observed['clocks.gr'], 210);
  assert.ok(String(coreResult.verify.note).includes('无法区分'));

  const mem = createNvidiaRunMock({ csv: '8001' });
  const memResult = await makeNvidiaChannel({ runMock: mem.runMock }).channel.write({ op: 'reset-mem' });
  assert.deepEqual(mem.calls[0].args, ['-i', '0', '-rmc']);
  assert.equal(memResult.verify.ok, null);
  assert.equal(memResult.verify.observed['clocks.mem'], 8001);
});

test('nvidia write reset-all：先 -rgc 再 -rmc 两条都执行', async () => {
  const { runMock, calls } = createNvidiaRunMock({ csv: '1650, 8001' });
  const { channel } = makeNvidiaChannel({ runMock });

  const result = await channel.write({ op: 'reset-all' });
  assert.deepEqual(
    calls.slice(0, 2).map((call) => call.args),
    [
      ['-i', '0', '-rgc'],
      ['-i', '0', '-rmc'],
    ],
  );
  assert.deepEqual(
    result.commands.map((command) => command.args),
    [
      ['-i', '0', '-rgc'],
      ['-i', '0', '-rmc'],
    ],
  );
  assert.equal(result.verify.ok, null);
  assert.equal(result.verify.observed['clocks.gr'], 1650);
  assert.equal(result.verify.observed['clocks.mem'], 8001);
});

test('nvidia write reset-all：一条失败仍尝试另一条，错误信息合并 → E_CHANNEL', async () => {
  const { runMock, calls } = createNvidiaRunMock({
    write: (args) =>
      args.includes('-rmc') ? { code: 1, stderr: 'rmc boom' } : { code: 0 },
  });
  const { channel } = makeNvidiaChannel({ runMock });

  const error = await expectPerfError(() => channel.write({ op: 'reset-all' }), 'E_CHANNEL');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['-i', '0', '-rgc']);
  assert.deepEqual(calls[1].args, ['-i', '0', '-rmc']);
  assert.ok(error.message.includes('-rmc'));
  assert.ok(error.message.includes('rmc boom'));
});

test('nvidia write reset-all：两条都超时 → E_TIMEOUT', async () => {
  const { runMock } = createNvidiaRunMock({ write: () => ({ timedOut: true, code: null }) });
  const { channel } = makeNvidiaChannel({ runMock });
  await expectPerfError(() => channel.write({ op: 'reset-all' }), 'E_TIMEOUT');
});

test('nvidia write power-limit：-pl args；驱动拒绝 → E_UNSUPPORTED（stderr 透传）', async () => {
  const stderr = 'Changing power management limit is not supported in current scope.';
  const { runMock, calls } = createNvidiaRunMock({ write: () => ({ code: 1, stderr }) });
  const { channel } = makeNvidiaChannel({ runMock });

  const error = await expectPerfError(() => channel.write({ op: 'power-limit', watts: 115 }), 'E_UNSUPPORTED');
  assert.deepEqual(calls[0].args, ['-i', '0', '-pl', '115']);
  assert.ok(error.message.includes('not supported in current scope'));
});

test('nvidia write power-limit：成功时回读 power.limit', async () => {
  const { runMock, calls } = createNvidiaRunMock({ csv: '115' });
  const { channel } = makeNvidiaChannel({ runMock });

  const result = await channel.write({ op: 'power-limit', watts: 115 });
  assert.deepEqual(calls[0].args, ['-i', '0', '-pl', '115']);
  assert.equal(result.verify.checked, true);
  assert.equal(result.verify.ok, true);
  assert.equal(result.verify.observed['power.limit'], 115);
});

test('nvidia write: op.gpuIndex 覆盖配置，命令一律带 -i 前缀', async () => {
  const { runMock, calls } = createNvidiaRunMock({ csv: '1650' });
  const { channel } = makeNvidiaChannel({ runMock, config: { nvidiaSmi: { path: null, gpuIndex: 0 } } });
  await channel.write({ op: 'reset-core', gpuIndex: 1 });
  assert.deepEqual(calls[0].args, ['-i', '1', '-rgc']);
});

test('nvidia write: 命令输出只保留头部（stdout 200 / stderr 300 字符）', async () => {
  const { runMock } = createNvidiaRunMock({
    csv: '1650, 1650',
    write: () => ({ stdout: 'y'.repeat(500), stderr: 'e'.repeat(500) }),
  });
  const { channel } = makeNvidiaChannel({ runMock });
  const result = await channel.write({ op: 'lock-core', mhz: 1600 });
  assert.equal(result.commands[0].stdout.length, 200);
  assert.equal(result.commands[0].stderr.length, 300);
  assert.ok(result.warnings.some((warning) => warning.includes('stderr')));
});

test('nvidia write: 命令超时 → E_TIMEOUT 且 commands.code=null', async () => {
  const { runMock } = createNvidiaRunMock({ write: () => ({ timedOut: true, code: null }) });
  const { channel } = makeNvidiaChannel({ runMock });
  await expectPerfError(() => channel.write({ op: 'lock-core', mhz: 1600 }), 'E_TIMEOUT');
});

test('nvidia write: 非法 mhz / watts / op → E_ARGS，且不执行任何命令', async () => {
  const { runMock, calls } = createNvidiaRunMock({ csv: '1650' });
  const { channel } = makeNvidiaChannel({ runMock });

  for (const mhz of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, '1600', null, { min: 0, max: 100 }, { min: 1800, max: 1650 }, {}]) {
    await expectPerfError(() => channel.write({ op: 'lock-core', mhz }), 'E_ARGS');
  }
  await expectPerfError(() => channel.write({ op: 'lock-mem', mhz: -1 }), 'E_ARGS');
  await expectPerfError(() => channel.write({ op: 'power-limit', watts: 0 }), 'E_ARGS');
  await expectPerfError(() => channel.write({ op: 'power-limit', watts: '115' }), 'E_ARGS');
  await expectPerfError(() => channel.write({ op: 'overclock' }), 'E_ARGS');
  await expectPerfError(() => channel.write(null), 'E_ARGS');
  await expectPerfError(() => channel.write({}), 'E_ARGS');
  assert.equal(calls.length, 0);
});

test('nvidia write: 写失败时不做 verify 回读', async () => {
  const { runMock, stats } = createNvidiaRunMock({ write: () => ({ code: 1, stderr: 'nope' }) });
  const { channel } = makeNvidiaChannel({ runMock });
  await expectPerfError(() => channel.write({ op: 'lock-core', mhz: 1600 }), 'E_CHANNEL');
  assert.equal(stats.queryCalls, 0);
});

// ────────────────────────────── lib/channel-http.js ──────────────────────────────

/** 记录调用的 fetch mock：按队列返回响应（也接受 Error / 函数）。 */
function createFetchMock(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchMock = async (url, init = {}) => {
    calls.push({ url, init });
    if (queue.length === 0) throw new Error('fetch mock 没有更多响应');
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, init);
    return next;
  };
  fetchMock.calls = calls;
  return fetchMock;
}

/** 构造 Response（JSON body）。 */
function jsonResponse(value, { status = 200, statusText = 'OK' } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

/** 挂起直到被 AbortSignal 中止的 fetch mock。 */
function hangingFetch() {
  return (url, init = {}) =>
    new Promise((resolve, reject) => {
      const signal = init.signal;
      if (signal?.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
}

test('http: 非白名单 host → E_SAFETY（列出允许 host，且不发起请求）', async () => {
  const fetchMock = createFetchMock([jsonResponse({})]);
  const channel = createHttpChannel({ config: {}, deps: { fetch: fetchMock } });
  const error = await expectPerfError(() => channel.read({ url: 'http://example.com/metrics' }), 'E_SAFETY');
  assert.ok(error.message.includes('127.0.0.1'));
  assert.ok(error.message.includes('localhost'));
  assert.equal(fetchMock.calls.length, 0);
});

test('http: 只允许 http/https 协议 → E_SAFETY；非法 URL → E_ARGS', async () => {
  const fetchMock = createFetchMock([jsonResponse({})]);
  const channel = createHttpChannel({ config: {}, deps: { fetch: fetchMock } });
  await expectPerfError(() => channel.read({ url: 'ftp://127.0.0.1/x' }), 'E_SAFETY');
  await expectPerfError(() => channel.read({ url: 'not a url' }), 'E_ARGS');
  await expectPerfError(() => channel.read({}), 'E_ARGS');
});

test('http: localhost / 127.0.0.1（含端口）解析 JSON', async () => {
  const payload = { gpus: [{ power_w: 42, temp: 55 }] };
  const fetchMock = createFetchMock([jsonResponse(payload), jsonResponse(payload)]);
  const channel = createHttpChannel({ config: {}, deps: { fetch: fetchMock } });

  const first = await channel.read({ url: 'http://localhost:9999/metrics' });
  assert.equal(first.kind, 'http');
  assert.equal(first.status, 200);
  assert.deepEqual(first.value, payload);
  assert.equal(first.truncated, false);
  assert.deepEqual(first.warnings, []);
  assert.ok(!('bodyText' in first), 'JSON 解析成功时不应返回 bodyText');

  const second = await channel.read({ url: 'https://127.0.0.1:4014/api/gpus' });
  assert.deepEqual(second.value, payload);
  assert.equal(fetchMock.calls[0].init.method, 'GET');
  assert.equal(fetchMock.calls[0].init.redirect, 'manual');
});

test('http: 非 2xx → E_CHANNEL（message 含 status 与 body 前 200 字）', async () => {
  const fetchMock = createFetchMock([
    new Response('boom body ' + 'z'.repeat(500), { status: 500, statusText: 'Internal Server Error' }),
  ]);
  const channel = createHttpChannel({ config: {}, deps: { fetch: fetchMock } });
  const error = await expectPerfError(() => channel.read({ url: 'http://127.0.0.1:1/x' }), 'E_CHANNEL');
  assert.ok(error.message.includes('500'));
  assert.ok(error.message.includes('boom body'));
  assert.ok(error.message.length < 500);
});

test('http: 3xx 重定向不跟随（redirect: manual）→ E_CHANNEL', async () => {
  const fetchMock = createFetchMock([new Response('', { status: 302, statusText: 'Found' })]);
  const channel = createHttpChannel({ config: {}, deps: { fetch: fetchMock } });
  await expectPerfError(() => channel.read({ url: 'http://127.0.0.1:1/redirect' }), 'E_CHANNEL', '302');
  assert.equal(fetchMock.calls[0].init.redirect, 'manual');
});

test('http: 非 JSON → value=null + bodyText 前 4 KiB', async () => {
  const text = 'x'.repeat(5000);
  const fetchMock = createFetchMock([new Response(text, { status: 200 })]);
  const channel = createHttpChannel({ config: {}, deps: { fetch: fetchMock } });
  const result = await channel.read({ url: 'http://127.0.0.1:1/plain' });
  assert.equal(result.value, null);
  assert.equal(result.bodyText.length, 4096);
  assert.equal(result.truncated, false);
});

test('http: body 超过 512 KiB → 截断并置 truncated:true', async () => {
  const text = 'x'.repeat(600 * 1024);
  const fetchMock = createFetchMock([new Response(text, { status: 200 })]);
  const channel = createHttpChannel({ config: {}, deps: { fetch: fetchMock } });
  const result = await channel.read({ url: 'http://127.0.0.1:1/big' });
  assert.equal(result.truncated, true);
  assert.equal(result.value, null);
  assert.equal(result.bodyText.length, 4096);
});

test('http: JSON path 支持点号与下标两种写法', async () => {
  const payload = { gpus: [{ power_w: 42, name: 'gpu0' }] };
  const fetchMock = createFetchMock([jsonResponse(payload), jsonResponse(payload)]);
  const channel = createHttpChannel({ config: {}, deps: { fetch: fetchMock } });

  const dotted = await channel.read({ url: 'http://127.0.0.1:1/x', path: 'gpus.0.power_w' });
  assert.equal(dotted.value, 42);

  const bracketed = await channel.read({ url: 'http://127.0.0.1:1/x', path: 'gpus[0].power_w' });
  assert.equal(bracketed.value, 42);
});

test('http: JSON path 取不到 → E_NOT_FOUND', async () => {
  const payload = { gpus: [{ power_w: 42 }], nothing: null };
  const fetchMock = createFetchMock([jsonResponse(payload), jsonResponse(payload), jsonResponse(payload)]);
  const channel = createHttpChannel({ config: {}, deps: { fetch: fetchMock } });

  await expectPerfError(
    () => channel.read({ url: 'http://127.0.0.1:1/x', path: 'gpus.9.power_w' }),
    'E_NOT_FOUND',
  );
  await expectPerfError(() => channel.read({ url: 'http://127.0.0.1:1/x', path: 'nothing' }), 'E_NOT_FOUND');
  await expectPerfError(() => channel.read({ url: 'http://127.0.0.1:1/x', path: 'gpus.0.missing' }), 'E_NOT_FOUND');
});

test('http: 响应不是 JSON 但给了 path → E_NOT_FOUND', async () => {
  const fetchMock = createFetchMock([new Response('plain text', { status: 200 })]);
  const channel = createHttpChannel({ config: {}, deps: { fetch: fetchMock } });
  await expectPerfError(
    () => channel.read({ url: 'http://127.0.0.1:1/x', path: 'anything' }),
    'E_NOT_FOUND',
    '不是合法 JSON',
  );
});

test('http: 超时 → E_TIMEOUT', async () => {
  const channel = createHttpChannel({ config: {}, deps: { fetch: hangingFetch() } });
  await expectPerfError(() => channel.read({ url: 'http://127.0.0.1:1/x', timeoutMs: 25 }), 'E_TIMEOUT');
});

test('http: 外部 AbortSignal 取消 → E_IO「已取消」', async () => {
  const controller = new AbortController();
  const channel = createHttpChannel({ config: {}, deps: { fetch: hangingFetch() } });
  setTimeout(() => controller.abort(), 20);
  await expectPerfError(
    () => channel.read({ url: 'http://127.0.0.1:1/x' }, { signal: controller.signal }),
    'E_IO',
    '已取消',
  );

  const aborted = new AbortController();
  aborted.abort();
  await expectPerfError(
    () => channel.read({ url: 'http://127.0.0.1:1/x' }, { signal: aborted.signal }),
    'E_IO',
    '已取消',
  );
});

test('http: fetch 抛错 → E_CHANNEL；path / headers 校验 E_ARGS', async () => {
  const fetchMock = createFetchMock([new TypeError('fetch failed')]);
  const channel = createHttpChannel({ config: {}, deps: { fetch: fetchMock } });
  await expectPerfError(() => channel.read({ url: 'http://127.0.0.1:1/x' }), 'E_CHANNEL', 'fetch failed');

  const okFetch = createFetchMock([jsonResponse({ a: 1 })]);
  const okChannel = createHttpChannel({ config: {}, deps: { fetch: okFetch } });
  await expectPerfError(() => okChannel.read({ url: 'http://127.0.0.1:1/x', path: 42 }), 'E_ARGS');
  await expectPerfError(() => okChannel.read({ url: 'http://127.0.0.1:1/x', headers: 'x' }), 'E_ARGS');
  await expectPerfError(() => okChannel.read({ url: 'http://127.0.0.1:1/x', timeoutMs: -1 }), 'E_ARGS');
});

// ──────────────────────── lib/channel-command.js ────────────────────────

function makeCommandChannel({ config, runMock }) {
  return createCommandChannel({ config, deps: { run: runMock } });
}

test('command: allowPrograms 按 basename 匹配且不区分大小写', async () => {
  const runMock = createRunMock(() => ({ stdout: 'v26.0.0' }));
  const channel = makeCommandChannel({ config: { command: { allowPrograms: ['node'], allowPaths: [] } }, runMock });

  const result = await channel.read({ program: 'NODE', args: ['--version'] });
  assert.equal(result.kind, 'command');
  assert.equal(result.program, 'NODE');
  assert.deepEqual(result.args, ['--version']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'v26.0.0');
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);

  assert.equal(runMock.calls.length, 1);
  assert.equal(runMock.calls[0].program, 'NODE');
  assert.deepEqual(runMock.calls[0].args, ['--version']);
  assert.equal(runMock.calls[0].options.timeoutMs, 10000);
  assert.equal(runMock.calls[0].options.maxBytes, 262144);
});

test('command: 不在白名单 → E_UNSUPPORTED（列出已允许项，且不执行）', async () => {
  const runMock = createRunMock();
  const channel = makeCommandChannel({ config: { command: { allowPrograms: ['node'] } }, runMock });
  const error = await expectPerfError(() => channel.read({ program: 'powershell' }), 'E_UNSUPPORTED');
  assert.ok(error.message.includes('node'));
  assert.equal(runMock.calls.length, 0);
});

test('command: 默认白名单为空 → 全部 E_UNSUPPORTED', async () => {
  const runMock = createRunMock();
  const channel = createCommandChannel({ config: {}, deps: { run: runMock } });
  await expectPerfError(() => channel.read({ program: 'node' }), 'E_UNSUPPORTED');
});

test('command: 含路径分隔符时只匹配 allowPaths（不回退 basename 白名单）', async () => {
  const runMock = createRunMock(() => ({ code: 0 }));
  const config = {
    command: {
      allowPrograms: ['x.exe'],
      allowPaths: ['C:\\tools\\x.exe'],
    },
  };
  const channel = makeCommandChannel({ config, runMock });

  const allowed = await channel.read({ program: 'C:\\tools\\x.exe', args: ['--read'] });
  assert.equal(allowed.code, 0);
  assert.equal(runMock.calls.length, 1);

  await expectPerfError(() => channel.read({ program: 'C:\\other\\x.exe' }), 'E_UNSUPPORTED');
  await expectPerfError(() => channel.read({ program: '.\\x.exe' }), 'E_UNSUPPORTED');
  assert.equal(runMock.calls.length, 1);
});

test('command: 非零退出不抛、超时返回 timedOut:true 不抛', async () => {
  const failing = createRunMock(() => ({ code: 3, stderr: 'bad' }));
  const failResult = await makeCommandChannel({ config: { command: { allowPrograms: ['node'] } }, runMock: failing }).read(
    { program: 'node', args: [] },
  );
  assert.equal(failResult.code, 3);
  assert.equal(failResult.stderr, 'bad');

  const timingOut = createRunMock(() => ({ timedOut: true, code: null }));
  const timeoutResult = await makeCommandChannel({
    config: { command: { allowPrograms: ['node'] } },
    runMock: timingOut,
  }).read({ program: 'node', args: [], timeoutMs: 500 });
  assert.equal(timeoutResult.timedOut, true);
  assert.equal(timeoutResult.code, null);
  assert.equal(timingOut.calls[0].options.timeoutMs, 500);
});

test('command: 参数校验 E_ARGS', async () => {
  const runMock = createRunMock();
  const channel = makeCommandChannel({ config: { command: { allowPrograms: ['node'] } }, runMock });
  await expectPerfError(() => channel.read({ program: '' }), 'E_ARGS');
  await expectPerfError(() => channel.read({ program: 123 }), 'E_ARGS');
  await expectPerfError(() => channel.read({ program: 'node', args: 'x' }), 'E_ARGS');
  await expectPerfError(() => channel.read({ program: 'node', args: [1] }), 'E_ARGS');
  await expectPerfError(() => channel.read({ program: 'node', timeoutMs: 0 }), 'E_ARGS');
  assert.equal(runMock.calls.length, 0);
});
