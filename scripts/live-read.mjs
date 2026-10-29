#!/usr/bin/env node
/**
 * live-read.mjs — 真机只读冒烟（Lead 所有）。
 *
 * 验证「通道层对真机能跑通」：nvidia-smi 查询、OEM 控制台 MQTT 总线读取、
 * 本机 MQTT 无害回环（PerfTune/SelfTest）、本机 HTTP 仪表盘（若在跑）、
 * 以及安全包线的纯逻辑检查（不写硬件、不触碰控制面 topic）。
 *
 * 运行：node scripts/live-read.mjs
 * 退出码：0 = 全部预期项通过；1 = 有预期项失败。
 *
 * 安全声明：
 *  - 不执行任何 nvidia-smi 写操作（不 -lgc/-lmc/-pl/-rgc）。
 *  - 不向 OEM 控制面 topic（Fan/Control、Customize/Control）发布任何消息。
 *  - 唯一一次 MQTT 发布发往自建 topic `PerfTune/SelfTest`（OEM 不订阅），
 *    且 retain=false、QoS1，用于验证「发布 → 订阅」链路本身可用。
 */
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadConfig } from '../lib/config.js'
import { checkMqttPublish, checkNvidiaWrite, effectiveLimits } from '../lib/envelope.js'
import { PerfError } from '../lib/errors.js'
import { createMqttChannel } from '../lib/channel-mqtt.js'
import { createNvidiaChannel } from '../lib/channel-nvidia.js'
import { createHttpChannel } from '../lib/channel-http.js'

const DASHBOARD_URL = 'http://127.0.0.1:4014/api/gpus'
const SELF_TEST_TOPIC = 'PerfTune/SelfTest'

/** 记录每个小节的结果。 */
const results = []
function record(section, ok, detail) {
  results.push({ section, ok, detail })
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${section}`)
  if (detail !== undefined) console.log(JSON.stringify(detail, null, 2))
}

/** 把任意错误压成可打印的摘要。 */
function describeError(error) {
  if (error instanceof PerfError) return `${error.code}: ${error.message}`
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** 断言某次调用抛指定错误码。 */
async function expectCode(label, fn, code) {
  try {
    await fn()
    record(label, false, { expected: code, actual: 'no error thrown' })
  } catch (error) {
    const actual = error instanceof PerfError ? error.code : 'NON_PERF_ERROR'
    record(label, actual === code, actual === code ? { code } : { expected: code, actual, message: describeError(error) })
  }
}

async function main() {
  console.log('dsh-perf-tune live read smoke —', new Date().toISOString())
  console.log('注意：本脚本只读；唯一一次 MQTT 发布发往无害自建 topic', SELF_TEST_TOPIC)

  // ── 0. 配置与包线（纯逻辑，不碰真机）──────────────────────────────────
  let loaded
  try {
    loaded = await loadConfig()
    const limits = effectiveLimits(loaded.config)
    record('config.load', true, {
      path: loaded.path,
      source: loaded.source,
      warnings: loaded.warnings,
      limits: {
        nvidiaSmi: limits.nvidiaSmi,
        mqttTopics: limits.mqtt.topics,
        writes: { enabled: limits.writes.enabled, minIntervalMs: limits.writes.minIntervalMs },
      },
    })

    // 包线逻辑：越界的锁频必须被拒（E_SAFETY），合法的通过。
    const okRead = checkNvidiaWrite({ op: 'lock-core', mhz: 1600, gpuIndex: 0 }, limits)
    record('envelope.checkNvidiaWrite(1600MHz)', okRead.limits?.max >= 1600, {
      limits: okRead.limits,
      normalized: okRead.op,
    })
    await expectCode('envelope.checkNvidiaWrite(3000MHz) → E_SAFETY', () => {
      checkNvidiaWrite({ op: 'lock-core', mhz: 3000, gpuIndex: 0 }, limits)
    }, 'E_SAFETY')

    const modeMsg = JSON.stringify({ Action: 'OPERATING_TURBO_MODE' })
    const modeChecked = checkMqttPublish('Fan/Control', modeMsg, limits)
    record('envelope.checkMqttPublish(Fan/Control 模式切换) dry', modeChecked.topic === 'Fan/Control', {
      bytes: modeChecked.bytes,
      checked: modeChecked.checked,
    })
    await expectCode('envelope.checkMqttPublish(未知 topic) → E_SAFETY', () => {
      checkMqttPublish('System/Control', JSON.stringify({ Action: 'X' }), limits)
    }, 'E_SAFETY')
    await expectCode('envelope.checkMqttPublish(TGP=141W) → E_SAFETY', () => {
      checkMqttPublish('Customize/Control', JSON.stringify({ ConfigurableTGPTarget: 141 }), limits)
    }, 'E_SAFETY')

    // ── 1. nvidia-smi 真机读取 ────────────────────────────────────────
    const nvidia = createNvidiaChannel({ config: loaded.config })
    const fields = [
      'name',
      'driver_version',
      'power.draw',
      'temperature.gpu',
      'clocks.gr',
      'clocks.mem',
      'clocks.max.gr',
      'clocks.max.mem',
      'utilization.gpu',
      'pstate',
      'fan.speed',
      'power.limit',
    ]
    try {
      const read = await nvidia.read({ fields, gpuIndex: loaded.config.nvidiaSmi.gpuIndex, timeoutMs: 15000 })
      record('nvidia-smi.read', Array.isArray(read.fields) && read.fields.length > 0, read)
      // 真实通道解析出至少一个数值字段才算真通。
      const numeric = (read.fields ?? []).filter((field) => typeof field.value === 'number')
      record('nvidia-smi.parse', numeric.length >= 3, { numericFields: numeric.map((field) => `${field.name}=${field.value}`) })
    } catch (error) {
      record('nvidia-smi.read', false, describeError(error))
    }

    // ── 2. MQTT 只读：# 收集 retained 状态 ───────────────────────────
    const mqtt = createMqttChannel({ config: loaded.config })
    try {
      const read = await mqtt.read({ topics: ['#'], waitMs: 1500, maxMessages: 200, qos: 0, timeoutMs: 8000 })
      const topics = [...new Set((read.messages ?? []).map((message) => message.topic))]
      record('mqtt.read(#)', topics.length > 0, {
        messageCount: read.messages?.length ?? 0,
        topics: topics.sort(),
        warnings: read.warnings ?? [],
      })
    } catch (error) {
      record('mqtt.read(#)', false, describeError(error))
    }

    // ── 3. MQTT 发布→订阅回环（自建无害 topic）───────────────────────
    try {
      const waitMs = 2500
      const readPromise = mqtt.read({ topics: [SELF_TEST_TOPIC], waitMs, maxMessages: 5, qos: 0, timeoutMs: 8000 })
      await new Promise((resolve) => setTimeout(resolve, 400))
      const payload = JSON.stringify({ probe: 1, ts: Date.now() })
      const published = await mqtt.publish({ topic: SELF_TEST_TOPIC, payload, qos: 1 })
      const read = await readPromise
      const hits = (read.messages ?? []).filter((message) => message.topic === SELF_TEST_TOPIC)
      record('mqtt.publish→subscribe roundtrip', hits.length > 0 && published.sent === true, {
        published,
        received: hits,
      })
    } catch (error) {
      record('mqtt.publish→subscribe roundtrip', false, describeError(error))
    }

    // ── 4. 本机 HTTP 仪表盘（可选：服务没在跑就跳过）─────────────────────
    const http = createHttpChannel({ config: loaded.config })
    try {
      const read = await http.read({ url: DASHBOARD_URL, timeoutMs: 5000 })
      record('http.read(local-dashboard 4014)', read.status === 200, {
        status: read.status,
        sample: JSON.stringify(read.value).slice(0, 400),
      })
    } catch (error) {
      const message = describeError(error)
      const dashboardDown = /ECONNREFUSED|ECONNRESET|E_NOT_FOUND|fetch failed|连接被拒绝/i.test(message)
      record('http.read(local-dashboard 4014)', dashboardDown, { skipped: dashboardDown, reason: message })
    }

    // ── 5. 审计目录可写性（写一条 dry-run 风格自检记录）───────────────
    const scratch = join(tmpdir(), 'dsh-perf-tune-live-read.jsonl')
    try {
      await writeFile(scratch, `${JSON.stringify({ ts: new Date().toISOString(), section: 'live-read', decision: 'probe' })}\n`, 'utf8')
      record('io.tmp-write', true, { path: scratch })
    } catch (error) {
      record('io.tmp-write', false, describeError(error))
    }
  } finally {
    const failed = results.filter((item) => item.ok !== true)
    console.log('\n──────── live-read summary ────────')
    for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.section}`)
    console.log(`总计 ${results.length} 项，失败 ${failed.length} 项`)
    if (failed.length > 0) process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('live-read 脚本自身异常:', describeError(error))
  process.exitCode = 1
})
