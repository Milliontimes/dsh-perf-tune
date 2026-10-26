/**
 * T1 测试：MQTT 3.1.1 客户端（lib/mqtt-client.js）+ 通道（lib/channel-mqtt.js）。
 *
 * 契约依据：CONTRACT.md §5、§11。
 * 全部测试使用**本进程内 loopback 假 broker**（`127.0.0.1:0` 随机端口），
 * 不依赖网络、不碰真实 13688 端口、不发布任何控制面消息到真实 broker。
 */

import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { createMqttChannel } from '../lib/channel-mqtt.js'
import { PerfError } from '../lib/errors.js'
import { mqttPublish, mqttRead } from '../lib/mqtt-client.js'

// ───────────────────────────── 测试工具：错误断言 ─────────────────────────────

/**
 * 生成 assert.rejects 的谓词：要求 PerfError + 固定 code + message 匹配。
 * @param {string} code
 * @param {RegExp} [pattern]
 */
function expectPerfError(code, pattern) {
  return (error) => {
    assert.ok(error instanceof PerfError, `期望 PerfError，实际 ${error?.name ?? typeof error}: ${error?.message ?? error}`)
    assert.equal(error.code, code, `错误码应为 ${code}，实际 ${error.code}（message: ${error.message}）`)
    if (pattern !== undefined) assert.match(error.message, pattern)
    return true
  }
}

// ───────────────────────────── 测试工具：MQTT 报文编码 ─────────────────────────────

/** 2 字节大端无符号整数。 */
function u16(value) {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16BE(value & 0xffff, 0)
  return buffer
}

/** MQTT Remaining Length（可变字节整数）。 */
function encodeRemainingLength(length) {
  const bytes = []
  let remaining = length
  do {
    let digit = remaining % 128
    remaining = Math.floor(remaining / 128)
    if (remaining > 0) digit |= 0x80
    bytes.push(digit)
  } while (remaining > 0)
  return Buffer.from(bytes)
}

/** MQTT UTF-8 字符串（2 字节长度前缀）。 */
function mqttString(value) {
  const body = Buffer.from(value, 'utf8')
  return Buffer.concat([u16(body.length), body])
}

/** 拼完整 MQTT 报文。 */
function mqttPacket(headerByte, body) {
  return Buffer.concat([Buffer.from([headerByte]), encodeRemainingLength(body.length), body])
}

function connackPacket(returnCode, { sessionPresent = false } = {}) {
  return Buffer.from([0x20, 0x02, sessionPresent ? 0x01 : 0x00, returnCode])
}

function subackPacket(packetId, codes) {
  return mqttPacket(0x90, Buffer.concat([u16(packetId), Buffer.from(codes)]))
}

function publishPacket({ topic, payload = '', qos = 0, retained = false, packetId = 1, dup = false }) {
  const headerByte = 0x30 | (dup ? 0x08 : 0) | (qos << 1) | (retained ? 0x01 : 0)
  const parts = [mqttString(topic)]
  if (qos > 0) parts.push(u16(packetId))
  parts.push(Buffer.from(payload, 'utf8'))
  return mqttPacket(headerByte, Buffer.concat(parts))
}

function pubackPacket(packetId) {
  return mqttPacket(0x40, u16(packetId))
}

/** 一个 chunk 里按 1 字节/`chunkSize` 字节拆开发（模拟 TCP 拆包），每次间隔 `delayMs`。 */
async function writeInChunks(socket, buffer, chunkSize, delayMs) {
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    if (socket.destroyed) return
    socket.write(buffer.subarray(offset, offset + chunkSize))
    await sleep(delayMs)
  }
}

// ───────────────────────────── 测试工具：报文解析（假 broker 侧） ─────────────────────────────

/** 从字节流中切出完整 MQTT 报文，剩下的留给下一次 data 事件（处理粘包/拆包）。 */
function splitPackets(buffer) {
  const packets = []
  let offset = 0
  while (buffer.length - offset >= 2) {
    let multiplier = 1
    let remaining = 0
    let position = offset + 1
    let lengthBytes = 0
    let completeLength = false
    while (lengthBytes < 4) {
      if (position >= buffer.length) break
      const byte = buffer[position]
      position += 1
      lengthBytes += 1
      remaining += (byte & 0x7f) * multiplier
      if ((byte & 0x80) === 0) {
        completeLength = true
        break
      }
      multiplier *= 128
    }
    if (!completeLength) break
    const headerLength = 1 + lengthBytes
    if (buffer.length - offset < headerLength + remaining) break
    packets.push({
      headerByte: buffer[offset],
      body: buffer.subarray(offset + headerLength, offset + headerLength + remaining),
    })
    offset += headerLength + remaining
  }
  return { packets, rest: buffer.subarray(offset) }
}

function parseConnectBody(body) {
  let offset = 0
  const readString = () => {
    const length = body.readUInt16BE(offset)
    offset += 2
    const value = body.subarray(offset, offset + length).toString('utf8')
    offset += length
    return value
  }
  const protocolName = readString()
  const protocolLevel = body[offset]
  offset += 1
  const flags = body[offset]
  offset += 1
  const keepAlive = body.readUInt16BE(offset)
  offset += 2
  const clientId = readString()
  const info = {
    protocolName,
    protocolLevel,
    flags,
    keepAlive,
    clientId,
    cleanSession: (flags & 0x02) !== 0,
    username: null,
    password: null,
  }
  if ((flags & 0x80) !== 0) info.username = readString()
  if ((flags & 0x40) !== 0) info.password = readString()
  return info
}

function parseSubscribeBody(body) {
  const packetId = body.readUInt16BE(0)
  const topics = []
  let offset = 2
  while (offset < body.length) {
    const length = body.readUInt16BE(offset)
    offset += 2
    const topic = body.subarray(offset, offset + length).toString('utf8')
    offset += length
    const qos = body[offset]
    offset += 1
    topics.push({ topic, qos })
  }
  return { packetId, topics }
}

function parsePublishBody(body, headerByte) {
  const topicLength = body.readUInt16BE(0)
  let offset = 2
  const topic = body.subarray(offset, offset + topicLength).toString('utf8')
  offset += topicLength
  const qos = (headerByte >> 1) & 0x03
  const retained = (headerByte & 0x01) === 1
  let packetId = null
  if (qos > 0) {
    packetId = body.readUInt16BE(offset)
    offset += 2
  }
  return {
    topic,
    qos,
    retained,
    dup: (headerByte & 0x08) !== 0,
    packetId,
    payload: body.subarray(offset).toString('utf8'),
  }
}

// ───────────────────────────── 测试工具：本进程假 broker ─────────────────────────────

/**
 * 启动 loopback 假 MQTT broker（127.0.0.1:0）。
 *
 * @param {{
 *   connect?: (socket: net.Socket, info: object, state: object) => void,
 *   subscribe?: (socket: net.Socket, info: object, state: object) => void,
 *   publish?: (socket: net.Socket, info: object, state: object) => void,
 *   puback?: (socket: net.Socket, packetId: number, state: object) => void,
 *   disconnect?: (socket: net.Socket, state: object) => void,
 * }} [handlers] 每个钩子覆盖对应报文的默认响应；未提供时走最小默认行为
 *   （CONNECT→CONNACK rc=0，SUBSCRIBE→SUBACK，QoS1 PUBLISH→PUBACK）。
 */
async function startFakeBroker(handlers = {}) {
  /** @type {{connections: number, connects: object[], subscribes: object[], publishes: object[], pubacks: number[], disconnects: number, pings: number, errors: Error[]}} */
  const state = {
    connections: 0,
    connects: [],
    subscribes: [],
    publishes: [],
    pubacks: [],
    disconnects: 0,
    pings: 0,
    errors: [],
  }
  const sockets = new Set()

  const handlePacket = (packet, socket) => {
    const type = packet.headerByte >> 4
    if (type === 1) {
      const info = parseConnectBody(packet.body)
      state.connects.push(info)
      if (handlers.connect !== undefined) handlers.connect(socket, info, state)
      else socket.write(connackPacket(0))
      return
    }
    if (type === 8) {
      const info = parseSubscribeBody(packet.body)
      state.subscribes.push(info)
      if (handlers.subscribe !== undefined) handlers.subscribe(socket, info, state)
      else socket.write(subackPacket(info.packetId, info.topics.map((entry) => entry.qos)))
      return
    }
    if (type === 3) {
      const info = parsePublishBody(packet.body, packet.headerByte)
      state.publishes.push(info)
      if (handlers.publish !== undefined) handlers.publish(socket, info, state)
      else if (info.qos > 0) socket.write(pubackPacket(info.packetId))
      return
    }
    if (type === 4) {
      const packetId = packet.body.readUInt16BE(0)
      state.pubacks.push(packetId)
      if (handlers.puback !== undefined) handlers.puback(socket, packetId, state)
      return
    }
    if (type === 14) {
      state.disconnects += 1
      if (handlers.disconnect !== undefined) handlers.disconnect(socket, state)
      return
    }
    if (type === 12) {
      state.pings += 1
      socket.write(Buffer.from([0xd0, 0x00]))
    }
  }

  const server = net.createServer((socket) => {
    state.connections += 1
    sockets.add(socket)
    let buffer = Buffer.alloc(0)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      let parsed
      try {
        parsed = splitPackets(buffer)
      } catch (error) {
        state.errors.push(error)
        socket.destroy()
        return
      }
      buffer = parsed.rest
      for (const packet of parsed.packets) {
        try {
          handlePacket(packet, socket)
        } catch (error) {
          state.errors.push(error)
          socket.destroy()
          return
        }
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object', '假 broker 未能取得监听端口')

  return {
    server,
    port: address.port,
    state,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** broker 侧解析错误应始终为空（发现即说明客户端发了畸形报文）。 */
function assertNoBrokerErrors(broker) {
  assert.deepEqual(
    broker.state.errors.map((error) => error.message),
    [],
    '假 broker 解析报文出错（客户端报文畸形）',
  )
}

// ═════════════════════════════ mqttRead ═════════════════════════════

test('mqttRead：CONNACK rc=0，retained 消息立即投递，CONNECT/SUBSCRIBE/DISCONNECT 报文正确', async (t) => {
  const broker = await startFakeBroker({
    subscribe(socket, info) {
      socket.write(
        Buffer.concat([
          subackPacket(info.packetId, info.topics.map((entry) => entry.qos)),
          publishPacket({ topic: 'Keyboard/Status', payload: '{"Mode":"office"}', retained: true }),
          publishPacket({ topic: 'Customize/SupportInfo', payload: '{"ok":true}', retained: true }),
        ]),
      )
    },
  })
  t.after(() => broker.close())

  const result = await mqttRead({
    port: broker.port,
    clientId: 'fake-reader-client',
    username: 'fake-reader-user',
    password: 'fake-reader-password',
    topics: ['#'],
    waitMs: 120,
    timeoutMs: 2000,
  })

  assert.deepEqual(result.messages, [
    { topic: 'Keyboard/Status', payload: '{"Mode":"office"}', retained: true, qos: 0 },
    { topic: 'Customize/SupportInfo', payload: '{"ok":true}', retained: true, qos: 0 },
  ])
  assert.deepEqual(result.warnings, [])

  // CONNECT 报文：MQTT 3.1.1、cleanSession=1、硬编码身份完整
  const connect = broker.state.connects[0]
  assert.equal(connect.protocolName, 'MQTT')
  assert.equal(connect.protocolLevel, 4)
  assert.equal(connect.clientId, 'fake-reader-client')
  assert.equal(connect.username, 'fake-reader-user')
  assert.equal(connect.password, 'fake-reader-password')
  assert.equal(connect.cleanSession, true)
  assert.ok(connect.keepAlive > 0)

  // SUBSCRIBE：一个报文订阅全部 topics、packetId=1、qos 按参数
  assert.equal(broker.state.subscribes.length, 1)
  const subscribe = broker.state.subscribes[0]
  assert.equal(subscribe.packetId, 1)
  assert.deepEqual(subscribe.topics, [{ topic: '#', qos: 0 }])

  // DISCONNECT：收尾必须发（且连接被关闭）
  assert.equal(broker.state.disconnects, 1)
  assertNoBrokerErrors(broker)
})

test('mqttRead：多个 topic 打包进一个 SUBSCRIBE（qos=1）', async (t) => {
  const broker = await startFakeBroker()
  t.after(() => broker.close())

  const result = await mqttRead({
    port: broker.port,
    topics: ['Fan/Status', 'System/Control'],
    qos: 1,
    waitMs: 40,
    timeoutMs: 2000,
  })
  assert.deepEqual(result.messages, [])
  assert.equal(broker.state.subscribes.length, 1)
  assert.equal(broker.state.subscribes[0].packetId, 1)
  assert.deepEqual(broker.state.subscribes[0].topics, [
    { topic: 'Fan/Status', qos: 1 },
    { topic: 'System/Control', qos: 1 },
  ])
})

test('mqttRead：粘包（一个 TCP chunk 含 SUBACK + 3 条 PUBLISH）全部解析', async (t) => {
  const broker = await startFakeBroker({
    subscribe(socket, info) {
      socket.write(
        Buffer.concat([
          subackPacket(info.packetId, [0]),
          publishPacket({ topic: 'System/GpuInfo', payload: '{"power":140}', retained: true }),
          publishPacket({ topic: 'System/CpuInfo', payload: '{"temp":72}', retained: true }),
          publishPacket({ topic: 'Fan/Status', payload: '{"fan":4200}', retained: true }),
        ]),
      )
    },
  })
  t.after(() => broker.close())

  const result = await mqttRead({ port: broker.port, topics: ['#'], maxMessages: 3, waitMs: 500, timeoutMs: 2000 })
  assert.equal(result.messages.length, 3)
  assert.deepEqual(
    result.messages.map((message) => message.topic),
    ['System/GpuInfo', 'System/CpuInfo', 'Fan/Status'],
  )
  assert.deepEqual(result.messages[0].payload, '{"power":140}')
})

test('mqttRead：拆包（报文逐字节到达）也能正确重组', async (t) => {
  const broker = await startFakeBroker({
    subscribe(socket, info) {
      const payload = Buffer.concat([
        subackPacket(info.packetId, [0]),
        publishPacket({ topic: 'Split/Topic', payload: '拆包-中文-OK', retained: true }),
      ])
      // 2 字节一个 chunk、间隔 1ms：跨越固定头/长度/主题/载荷多个边界
      writeInChunks(socket, payload, 2, 1).catch(() => {})
    },
  })
  t.after(() => broker.close())

  const result = await mqttRead({ port: broker.port, topics: ['#'], maxMessages: 1, waitMs: 400, timeoutMs: 2000 })
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].topic, 'Split/Topic')
  assert.equal(result.messages[0].payload, '拆包-中文-OK')
  assert.equal(result.messages[0].retained, true)
})

test('mqttRead：收包 QoS1 回 PUBACK（packetId 与 broker 一致）', async (t) => {
  const broker = await startFakeBroker({
    subscribe(socket, info) {
      socket.write(
        Buffer.concat([
          subackPacket(info.packetId, [1]),
          publishPacket({ topic: 'QoS1/Topic', payload: 'hello', qos: 1, packetId: 42 }),
        ]),
      )
    },
  })
  t.after(() => broker.close())

  const result = await mqttRead({ port: broker.port, topics: ['QoS1/Topic'], qos: 1, maxMessages: 1, waitMs: 400, timeoutMs: 2000 })
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].qos, 1)
  assert.equal(result.messages[0].payload, 'hello')
  // 客户端必须在收到 QoS1 PUBLISH 后回 PUBACK(42)；resolve 时已随 DISCONNECT 一并送达
  assert.deepEqual(broker.state.pubacks, [42])
})

test('mqttRead：maxMessages 达到即提前返回（不等满 waitMs）', async (t) => {
  const broker = await startFakeBroker({
    subscribe(socket, info) {
      socket.write(
        Buffer.concat([
          subackPacket(info.packetId, [0]),
          publishPacket({ topic: 'T/1', payload: '1' }),
          publishPacket({ topic: 'T/2', payload: '2' }),
          publishPacket({ topic: 'T/3', payload: '3' }),
        ]),
      )
    },
  })
  t.after(() => broker.close())

  const startedAt = Date.now()
  const result = await mqttRead({ port: broker.port, topics: ['#'], maxMessages: 2, waitMs: 3000, timeoutMs: 5000 })
  const elapsed = Date.now() - startedAt
  assert.equal(result.messages.length, 2)
  assert.ok(elapsed < 1500, `应在收到 maxMessages 后立即返回，实际耗时 ${elapsed}ms`)
})

test('mqttRead：waitMs 内无消息 → 返回空数组 + 空 warnings', async (t) => {
  const broker = await startFakeBroker()
  t.after(() => broker.close())

  const startedAt = Date.now()
  const result = await mqttRead({ port: broker.port, topics: ['#'], waitMs: 90, timeoutMs: 2000 })
  const elapsed = Date.now() - startedAt
  assert.deepEqual(result.messages, [])
  assert.deepEqual(result.warnings, [])
  assert.ok(elapsed >= 50, `应至少等满 waitMs，实际耗时 ${elapsed}ms`)
})

test('mqttRead：CONNACK rc=2 → E_CHANNEL（message 说明 clientId/username 不匹配）', async (t) => {
  const broker = await startFakeBroker({
    connect(socket) {
      socket.write(connackPacket(2))
    },
  })
  t.after(() => broker.close())

  await assert.rejects(
    mqttRead({ port: broker.port, clientId: 'Wrong', username: 'WrongUser', password: 'x', topics: ['#'], waitMs: 100 }),
    expectPerfError('E_CHANNEL', /rc=2[\s\S]*clientId[\s\S]*username/),
  )
  assert.equal(broker.state.subscribes.length, 0, 'CONNACK 被拒后不应再发 SUBSCRIBE')
})

test('mqttRead：CONNACK rc=4 → E_CHANNEL（message 说明密码错误）', async (t) => {
  const broker = await startFakeBroker({
    connect(socket) {
      socket.write(connackPacket(4))
    },
  })
  t.after(() => broker.close())

  await assert.rejects(
    mqttRead({ port: broker.port, clientId: 'fake-reader-client', username: 'fake-reader-user', password: 'bad', topics: ['#'], waitMs: 100 }),
    expectPerfError('E_CHANNEL', /rc=4[\s\S]*密码|密码[\s\S]*rc=4/),
  )
})

test('mqttRead：等 CONNACK 超时 → E_TIMEOUT', async (t) => {
  const broker = await startFakeBroker({
    connect() {
      // 故意不回 CONNACK
    },
  })
  t.after(() => broker.close())

  const startedAt = Date.now()
  await assert.rejects(
    mqttRead({ port: broker.port, topics: ['#'], waitMs: 50, timeoutMs: 150 }),
    expectPerfError('E_TIMEOUT', /CONNACK/),
  )
  assert.ok(Date.now() - startedAt >= 100, '超时前不应提前返回')
})

test('mqttRead：ECONNREFUSED → E_CHANNEL（message 提示 GCUBridge 未运行）', async () => {
  const broker = await startFakeBroker()
  const port = broker.port
  await broker.close()

  await assert.rejects(
    mqttRead({ port, topics: ['#'], waitMs: 50, timeoutMs: 2000 }),
    expectPerfError('E_CHANNEL', /ECONNREFUSED[\s\S]*GCUBridge/),
  )
})

test('mqttRead：AbortSignal 取消 → E_IO「已取消」（含已 abort 的情况）', async (t) => {
  const broker = await startFakeBroker({
    connect() {
      // 故意不回 CONNACK，让读取停在等待阶段
    },
  })
  t.after(() => broker.close())

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 50)
  timer.unref()
  await assert.rejects(
    mqttRead({ port: broker.port, topics: ['#'], waitMs: 50, timeoutMs: 5000 }, { signal: controller.signal }),
    expectPerfError('E_IO', /已取消/),
  )

  const preAborted = new AbortController()
  preAborted.abort()
  await assert.rejects(
    mqttRead({ port: broker.port, topics: ['#'], waitMs: 50, timeoutMs: 2000 }, { signal: preAborted.signal }),
    expectPerfError('E_IO', /已取消/),
  )
})

test('mqttRead：收集期 broker 关闭连接 → 返回已收消息 + warning（不丢数据）', async (t) => {
  const broker = await startFakeBroker({
    subscribe(socket, info) {
      socket.write(
        Buffer.concat([
          subackPacket(info.packetId, [0]),
          publishPacket({ topic: 'Close/Topic', payload: '{"x":1}', retained: true }),
        ]),
      )
      socket.end()
    },
  })
  t.after(() => broker.close())

  const result = await mqttRead({ port: broker.port, topics: ['#'], maxMessages: 100, waitMs: 2000, timeoutMs: 3000 })
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].topic, 'Close/Topic')
  assert.ok(result.warnings.some((warning) => /关闭/.test(warning)), `warnings 应说明连接被关闭：${result.warnings}`)
})

test('mqttRead：报文 Remaining Length 超过 1 MiB → E_CHANNEL', async (t) => {
  const broker = await startFakeBroker({
    subscribe(socket) {
      // 只发固定头 + 声称 2 MiB 的 Remaining Length，从不发 body
      socket.write(Buffer.concat([Buffer.from([0x30]), encodeRemainingLength(2 * 1024 * 1024)]))
    },
  })
  t.after(() => broker.close())

  const startedAt = Date.now()
  await assert.rejects(
    mqttRead({ port: broker.port, topics: ['#'], waitMs: 2000, timeoutMs: 3000 }),
    expectPerfError('E_CHANNEL', /1 MiB|超过上限/),
  )
  assert.ok(Date.now() - startedAt < 2000, '应在解析到超长报文头时立即失败')
})

test('mqttRead：waitMs > timeoutMs 时 timeoutMs 兜底（已有消息则带 warning 返回）', async (t) => {
  const broker = await startFakeBroker({
    subscribe(socket, info) {
      socket.write(
        Buffer.concat([
          subackPacket(info.packetId, [0]),
          publishPacket({ topic: 'Fast/Topic', payload: '{"n":1}', retained: true }),
        ]),
      )
    },
  })
  t.after(() => broker.close())

  const result = await mqttRead({ port: broker.port, topics: ['#'], maxMessages: 10, waitMs: 5000, timeoutMs: 150 })
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].topic, 'Fast/Topic')
  assert.ok(result.warnings.some((warning) => /timeoutMs/.test(warning)), `warnings 应说明 timeoutMs 兜底：${result.warnings}`)
})

test('mqttRead：参数校验（topics/qos/waitMs/maxMessages/port）', async () => {
  await assert.rejects(mqttRead({ topics: [] }), expectPerfError('E_ARGS', /topics/))
  await assert.rejects(mqttRead({ topics: [42] }), expectPerfError('E_ARGS', /topics\[0\]/))
  await assert.rejects(mqttRead({ topics: [''] }), expectPerfError('E_ARGS', /不能为空/))
  await assert.rejects(mqttRead({ topics: ['x'.repeat(257)] }), expectPerfError('E_ARGS', /256/))
  await assert.rejects(mqttRead({ topics: ['a\u0000b'] }), expectPerfError('E_ARGS', /NUL/))
  await assert.rejects(mqttRead({ topics: ['#'], qos: 2 }), expectPerfError('E_UNSUPPORTED', /QoS 2/))
  await assert.rejects(mqttRead({ topics: ['#'], qos: 3 }), expectPerfError('E_ARGS', /qos/))
  await assert.rejects(mqttRead({ topics: ['#'], waitMs: -1 }), expectPerfError('E_ARGS', /waitMs/))
  await assert.rejects(mqttRead({ topics: ['#'], maxMessages: 0 }), expectPerfError('E_ARGS', /maxMessages/))
  await assert.rejects(mqttRead({ topics: ['#'], port: 0 }), expectPerfError('E_ARGS', /port/))
  await assert.rejects(mqttRead({ topics: ['#'], port: 65536 }), expectPerfError('E_ARGS', /port/))
  await assert.rejects(mqttRead({ topics: ['#'], timeoutMs: 0 }), expectPerfError('E_ARGS', /timeoutMs/))
  await assert.rejects(mqttRead({ password: 'p', topics: ['#'] }), expectPerfError('E_ARGS', /username/))
  await assert.rejects(mqttRead(null), expectPerfError('E_ARGS', /对象/))
})

// ═════════════════════════════ mqttPublish ═════════════════════════════

test('mqttPublish：QoS1 成功（CONNECT 身份正确、PUBLISH 字段正确、等到 PUBACK 才返回）', async (t) => {
  const broker = await startFakeBroker()
  t.after(() => broker.close())

  const payload = '{"Action":"OPERATING_OFFICE_MODE"}'
  const result = await mqttPublish({
    port: broker.port,
    clientId: 'fake-writer-client',
    username: 'fake-writer-user',
    password: 'fake-writer-password',
    topic: 'Fan/Control',
    payload,
    qos: 1,
    timeoutMs: 2000,
  })

  assert.deepEqual(result, { sent: true, topic: 'Fan/Control', bytes: Buffer.byteLength(payload, 'utf8') })

  const connect = broker.state.connects[0]
  assert.equal(connect.protocolLevel, 4)
  assert.equal(connect.clientId, 'fake-writer-client')
  assert.equal(connect.username, 'fake-writer-user')
  assert.equal(connect.password, 'fake-writer-password')

  assert.equal(broker.state.publishes.length, 1)
  const publish = broker.state.publishes[0]
  assert.equal(publish.topic, 'Fan/Control')
  assert.equal(publish.payload, payload)
  assert.equal(publish.qos, 1)
  assert.equal(publish.retained, false, '发布绝不能带 retain 标志')
  assert.equal(publish.packetId, 1)
  assert.equal(broker.state.pubacks.length, 0, 'broker 不应收到 PUBACK（本端只发 PUBLISH）')
  assert.equal(broker.state.disconnects, 1)
  assertNoBrokerErrors(broker)
})

test('mqttPublish：QoS0 不等 PUBACK，payload 中文按 UTF-8 计字节', async (t) => {
  const broker = await startFakeBroker()
  t.after(() => broker.close())

  const payload = '{"Action":"狂暴模式"}'
  const result = await mqttPublish({ port: broker.port, topic: 'Fan/Control', payload, qos: 0, timeoutMs: 2000 })
  assert.equal(result.bytes, Buffer.byteLength(payload, 'utf8'))
  assert.ok(result.bytes > payload.length, 'UTF-8 中文的字节数必须大于字符数')
  assert.equal(broker.state.publishes[0].qos, 0)
  assert.equal(broker.state.publishes[0].payload, payload)
})

test('mqttPublish：payload 2048 字节硬上限（UTF-8 边界）', async (t) => {
  const broker = await startFakeBroker()
  t.after(() => broker.close())

  const ascii = 'x'.repeat(2048)
  const resultAscii = await mqttPublish({ port: broker.port, topic: 'Fan/Control', payload: ascii, qos: 0, timeoutMs: 2000 })
  assert.equal(resultAscii.bytes, 2048)

  const chinese = '中'.repeat(682) // 2046 字节
  const resultChinese = await mqttPublish({ port: broker.port, topic: 'Fan/Control', payload: chinese, qos: 0, timeoutMs: 2000 })
  assert.equal(resultChinese.bytes, 2046)
  assert.equal(broker.state.publishes[1].payload, chinese)

  await assert.rejects(
    mqttPublish({ port: broker.port, topic: 'Fan/Control', payload: 'x'.repeat(2049), qos: 0, timeoutMs: 2000 }),
    expectPerfError('E_ARGS', /2048/),
  )
  await assert.rejects(
    mqttPublish({ port: broker.port, topic: 'Fan/Control', payload: '中'.repeat(683), qos: 0, timeoutMs: 2000 }),
    expectPerfError('E_ARGS', /2048/),
  )
})

test('mqttPublish：参数校验（retain/qos/payload/topic/port）', async () => {
  await assert.rejects(mqttPublish({ payload: '{}' }), expectPerfError('E_ARGS', /topic/))
  await assert.rejects(mqttPublish({ topic: '', payload: '{}' }), expectPerfError('E_ARGS', /不能为空/))
  await assert.rejects(mqttPublish({ topic: 'a/+/b', payload: '{}' }), expectPerfError('E_ARGS', /通配符/))
  await assert.rejects(mqttPublish({ topic: 'a/#', payload: '{}' }), expectPerfError('E_ARGS', /通配符/))
  await assert.rejects(mqttPublish({ topic: 'a\u0000b', payload: '{}' }), expectPerfError('E_ARGS', /NUL/))
  await assert.rejects(mqttPublish({ topic: 'x'.repeat(257), payload: '{}' }), expectPerfError('E_ARGS', /256/))
  await assert.rejects(mqttPublish({ topic: 'T', payload: {} }), expectPerfError('E_ARGS', /字符串/))
  await assert.rejects(mqttPublish({ topic: 'T', payload: null }), expectPerfError('E_ARGS', /字符串/))
  await assert.rejects(mqttPublish({ topic: 'T', payload: '{}', retain: true }), expectPerfError('E_ARGS', /retain/))
  await assert.rejects(mqttPublish({ topic: 'T', payload: '{}', retain: 'yes' }), expectPerfError('E_ARGS', /retain/))
  await assert.rejects(mqttPublish({ topic: 'T', payload: '{}', qos: 2 }), expectPerfError('E_UNSUPPORTED', /QoS 2/))
  await assert.rejects(mqttPublish({ topic: 'T', payload: '{}', qos: 3 }), expectPerfError('E_ARGS', /qos/))
  await assert.rejects(mqttPublish({ topic: 'T', payload: '{}', port: 0 }), expectPerfError('E_ARGS', /port/))
  await assert.rejects(mqttPublish({ topic: 'T', payload: '{}', timeoutMs: -5 }), expectPerfError('E_ARGS', /timeoutMs/))
  await assert.rejects(mqttPublish(null), expectPerfError('E_ARGS', /对象/))
})

test('mqttPublish：CONNACK 拒绝 → E_CHANNEL', async (t) => {
  const broker = await startFakeBroker({
    connect(socket) {
      socket.write(connackPacket(4))
    },
  })
  t.after(() => broker.close())

  await assert.rejects(
    mqttPublish({ port: broker.port, topic: 'Fan/Control', payload: '{}', qos: 1, timeoutMs: 2000 }),
    expectPerfError('E_CHANNEL', /rc=4/),
  )
  assert.equal(broker.state.publishes.length, 0, 'CONNACK 被拒后不应发 PUBLISH')
})

test('mqttPublish：QoS1 等 PUBACK 超时 → E_TIMEOUT', async (t) => {
  const broker = await startFakeBroker({
    publish() {
      // 故意不回 PUBACK
    },
  })
  t.after(() => broker.close())

  await assert.rejects(
    mqttPublish({ port: broker.port, topic: 'Fan/Control', payload: '{"a":1}', qos: 1, timeoutMs: 150 }),
    expectPerfError('E_TIMEOUT', /PUBACK/),
  )
})

test('mqttPublish：AbortSignal 取消 → E_IO「已取消」', async (t) => {
  const broker = await startFakeBroker({
    publish() {
      // 故意不回 PUBACK，让发布停在等待阶段
    },
  })
  t.after(() => broker.close())

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 50)
  timer.unref()
  await assert.rejects(
    mqttPublish({ port: broker.port, topic: 'Fan/Control', payload: '{}', qos: 1, timeoutMs: 5000 }, { signal: controller.signal }),
    expectPerfError('E_IO', /已取消/),
  )
})

// ═════════════════════════════ createMqttChannel ═════════════════════════════

test('createMqttChannel：默认 config 合并（读/写身份分开）、调用参数覆盖端点、signal 透传', async () => {
  /** @type {Array<{kind: string, params: object, options: object}>} */
  const calls = []
  const deps = {
    mqttRead: async (params, options) => {
      calls.push({ kind: 'read', params, options })
      return { messages: [], warnings: ['stub-warning'] }
    },
    mqttPublish: async (params, options) => {
      calls.push({ kind: 'publish', params, options })
      return { sent: true, topic: params.topic, bytes: Buffer.byteLength(params.payload, 'utf8') }
    },
  }
  const config = {
    mqtt: {
      host: '127.0.0.1',
      port: 13688,
      read: { clientId: 'fake-reader-client', username: 'fake-reader-user', password: 'fake-reader-password' },
      write: { clientId: 'fake-writer-client', username: 'fake-writer-user', password: 'fake-writer-password' },
    },
  }
  const channel = createMqttChannel({ config, deps })
  assert.equal(channel.kind, 'mqtt')

  const readResult = await channel.read({ topics: ['#'], waitMs: 10, qos: 0 })
  assert.equal(readResult.kind, 'mqtt')
  assert.deepEqual(readResult.messages, [])
  assert.deepEqual(readResult.warnings, ['stub-warning'])

  const readCall = calls[0]
  assert.equal(readCall.kind, 'read')
  assert.equal(readCall.params.host, '127.0.0.1')
  assert.equal(readCall.params.port, 13688)
  assert.equal(readCall.params.clientId, 'fake-reader-client')
  assert.equal(readCall.params.username, 'fake-reader-user')
  assert.equal(readCall.params.password, 'fake-reader-password')
  assert.deepEqual(readCall.params.topics, ['#'])
  assert.equal(readCall.params.waitMs, 10)
  assert.equal(readCall.params.qos, 0)

  const publishResult = await channel.publish({ topic: 'Fan/Control', payload: '{"Action":"OPERATING_OFFICE_MODE"}', qos: 1 })
  assert.equal(publishResult.kind, 'mqtt')
  assert.equal(publishResult.sent, true)
  assert.equal(publishResult.topic, 'Fan/Control')
  assert.equal(publishResult.bytes, Buffer.byteLength('{"Action":"OPERATING_OFFICE_MODE"}', 'utf8'))

  const publishCall = calls[1]
  assert.equal(publishCall.kind, 'publish')
  assert.equal(publishCall.params.host, '127.0.0.1')
  assert.equal(publishCall.params.port, 13688)
  assert.equal(publishCall.params.clientId, 'fake-writer-client')
  assert.equal(publishCall.params.username, 'fake-writer-user')
  assert.equal(publishCall.params.password, 'fake-writer-password')
  assert.equal(publishCall.params.topic, 'Fan/Control')
  assert.equal(publishCall.params.qos, 1)

  // 调用参数逐字段覆盖配置端点
  await channel.read({ topics: ['x'], host: '10.0.0.9', port: 1999 })
  assert.equal(calls[2].params.host, '10.0.0.9')
  assert.equal(calls[2].params.port, 1999)
  assert.equal(calls[2].params.clientId, 'fake-reader-client', '覆盖端点不应丢掉配置里的读身份')

  // AbortSignal 原样透传给底层客户端
  const controller = new AbortController()
  await channel.read({ topics: ['#'] }, { signal: controller.signal })
  assert.equal(calls[3].options.signal, controller.signal)
  assert.equal(channel.kind, 'mqtt')
})

test('createMqttChannel：未配置凭据 → E_CONFIG（不触网、不调用底层实现）', async () => {
  let called = 0
  const channel = createMqttChannel({
    deps: {
      mqttRead: async () => {
        called += 1
        return { messages: [], warnings: [] }
      },
      mqttPublish: async () => {
        called += 1
        return { sent: true, topic: '', bytes: 0 }
      },
    },
  })
  await assert.rejects(channel.read({ topics: ['#'] }), expectPerfError('E_CONFIG', /mqtt\.read/))
  await assert.rejects(
    channel.publish({ topic: 'Fan/Control', payload: '{}' }),
    expectPerfError('E_CONFIG', /mqtt\.write/),
  )
  assert.equal(called, 0, '未配置凭据时不应调用底层实现')
})

test('createMqttChannel：无 config 但显式传 clientId 时端点回退 127.0.0.1:13688', async () => {
  let captured = null
  const channel = createMqttChannel({
    deps: {
      mqttRead: async (params) => {
        captured = params
        return { messages: [], warnings: [] }
      },
    },
  })
  await channel.read({ topics: ['#'], clientId: 'ad-hoc-client' })
  assert.equal(captured.host, '127.0.0.1')
  assert.equal(captured.port, 13688)
  assert.equal(captured.clientId, 'ad-hoc-client')
})

test('createMqttChannel：publish 拒绝 retain=true / qos=2 / 非字符串 payload（不调用底层实现）', async () => {
  let called = 0
  const channel = createMqttChannel({
    deps: {
      mqttPublish: async (params) => {
        called += 1
        return { sent: true, topic: params.topic, bytes: 0 }
      },
    },
  })
  await assert.rejects(channel.publish({ topic: 'Fan/Control', payload: '{}', retain: true }), expectPerfError('E_ARGS', /retain/))
  await assert.rejects(channel.publish({ topic: 'Fan/Control', payload: '{}', qos: 2 }), expectPerfError('E_UNSUPPORTED', /QoS 2/))
  await assert.rejects(channel.publish({ topic: 'Fan/Control', payload: { Action: 'x' } }), expectPerfError('E_ARGS', /字符串/))
  await assert.rejects(channel.publish({ topic: 'Fan/Control', payload: '{}', qos: 3 }), expectPerfError('E_ARGS', /qos/))
  await assert.rejects(channel.publish({ topic: 'Fan/Control', payload: '{}', retain: 'yes' }), expectPerfError('E_ARGS', /retain/))
  assert.equal(called, 0, '参数被通道层拒绝时不应调用底层 mqttPublish')
})

test('createMqttChannel：底层 PerfError 原样透传', async () => {
  const timeoutError = new PerfError('E_TIMEOUT', 'MQTT 读取超时（测试桩）')
  const channel = createMqttChannel({
    deps: {
      mqttRead: async () => {
        throw timeoutError
      },
      mqttPublish: async () => {
        throw new PerfError('E_CHANNEL', 'broker 拒绝（测试桩）')
      },
    },
  })
  await assert.rejects(channel.read({ topics: ['#'], clientId: 'test-client' }), (error) => {
    assert.equal(error, timeoutError, '透传时应保持同一个 PerfError 实例')
    return true
  })
  await assert.rejects(
    channel.publish({ topic: 'Fan/Control', payload: '{}', clientId: 'test-client' }),
    expectPerfError('E_CHANNEL', /broker 拒绝/),
  )
})

test('createMqttChannel：默认实现下参数错误在联网前被拒绝（不触真实 broker）', async () => {
  const channel = createMqttChannel()
  await assert.rejects(channel.read({ topics: [], clientId: 'test-client' }), expectPerfError('E_ARGS', /topics/))
  await assert.rejects(channel.publish({ topic: 'Fan/Control', payload: '{}', retain: true }), expectPerfError('E_ARGS', /retain/))
})

test('createMqttChannel：端到端跑通假 broker（读/写身份分别生效）', async (t) => {
  let broker = null
  broker = await startFakeBroker({
    subscribe(socket, info) {
      socket.write(
        Buffer.concat([
          subackPacket(info.packetId, info.topics.map((entry) => entry.qos)),
          publishPacket({ topic: 'Keyboard/Status', payload: '{"Mode":"turbo"}', retained: true }),
        ]),
      )
    },
  })
  t.after(() => broker.close())

  const config = {
    mqtt: {
      host: '127.0.0.1',
      port: broker.port,
      read: { clientId: 'fake-reader-client', username: 'fake-reader-user', password: 'fake-reader-password' },
      write: { clientId: 'fake-writer-client', username: 'fake-writer-user', password: 'fake-writer-password' },
    },
  }
  const channel = createMqttChannel({ config })

  const readResult = await channel.read({ topics: ['#'], waitMs: 120 })
  assert.equal(readResult.kind, 'mqtt')
  assert.equal(readResult.messages.length, 1)
  assert.equal(readResult.messages[0].topic, 'Keyboard/Status')
  assert.equal(readResult.messages[0].retained, true)
  assert.equal(broker.state.connects[0].clientId, 'fake-reader-client')

  const publishResult = await channel.publish({ topic: 'Fan/Control', payload: '{"Action":"OPERATING_TURBO_MODE"}', qos: 1 })
  assert.equal(publishResult.kind, 'mqtt')
  assert.equal(publishResult.sent, true)
  assert.equal(publishResult.bytes, Buffer.byteLength('{"Action":"OPERATING_TURBO_MODE"}', 'utf8'))
  assert.equal(broker.state.publishes[0].topic, 'Fan/Control')
  assert.equal(broker.state.publishes[0].payload, '{"Action":"OPERATING_TURBO_MODE"}')
  const publishConnect = broker.state.connects[1]
  assert.equal(publishConnect.clientId, 'fake-writer-client', '发布必须使用 config.mqtt.write 身份')
  assert.equal(publishConnect.username, 'fake-writer-user')
  assertNoBrokerErrors(broker)
})
