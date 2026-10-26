/**
 * 最小 MQTT 3.1.1 客户端（零依赖，只用 `node:net`）。
 *
 * 契约依据：CONTRACT.md §5.1；协议依据：OEM 控制台逆向结论
 * （OEM 电竞控制台 `GCUBridge.exe` 是 broker，127.0.0.1:13688，MQTT 3.1.1，
 *  本机 broker 按 clientId→username→password 表校验；凭据由调用方/配置提供，插件不内置）。
 *
 * 只实现插件需要的子集：CONNECT/CONNACK、SUBSCRIBE/SUBACK、PUBLISH（QoS 0/1，
 * 收包 QoS1 回 PUBACK）、DISCONNECT。不做 QoS2、不做会话持久化、不重连、不 ping。
 *
 * 硬性约定：
 * - 所有外部 I/O 接受可选 AbortSignal，取消抛 `PerfError('E_IO', '已取消')`；
 * - 超时抛 `E_TIMEOUT`；连接被拒/协议错误/CONNACK 拒绝抛 `E_CHANNEL`；
 * - 参数非法抛 `E_ARGS`；QoS2 发布/订阅抛 `E_UNSUPPORTED`；
 * - 报文长度上限 1 MiB；发布 payload 上限 2048 字节；发布禁止 retain=true；
 * - 函数结束一定关闭 socket（`destroy()`），不把 socket 泄漏给调用方。
 *
 * @module lib/mqtt-client
 */

import net from 'node:net'

import { PerfError } from './errors.js'

/** 默认 broker 端点（OEM 控制台逆向结论）。 */
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 13688

/** 单个 MQTT 报文（Remaining Length）上限：1 MiB。 */
const MAX_PACKET_BYTES = 1024 * 1024

/** 发布 payload 上限（envelope 硬包线同值，客户端先兜住）。 */
const MAX_PAYLOAD_BYTES = 2048

/** topic 字符数上限（契约 §5.1：「每项非空 ≤256 字符」）。 */
const MAX_TOPIC_CHARS = 256

/** MQTT 3.1.1 protocol level。 */
const PROTOCOL_LEVEL = 4

/** 保活秒数（本客户端只做「连上→做事→断开」，不需要 PING）。 */
const KEEP_ALIVE_SECONDS = 60

/** 关闭 socket 时等待对端 FIN 的宽限（毫秒），超时强制 destroy。 */
const DISCONNECT_GRACE_MS = 75

const PACKET_TYPE = Object.freeze({
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  SUBSCRIBE: 8,
  SUBACK: 9,
  PINGRESP: 13,
  DISCONNECT: 14,
})

const DISCONNECT_PACKET = Buffer.from([0xe0, 0x00])

/** CONNACK 返回码含义（契约要求 rc=2/rc=4 必须在 message 里写明）。 */
const CONNACK_HINTS = Object.freeze({
  1: 'broker 不接受该 MQTT 协议版本（CONNACK rc=1）',
  2: 'clientId/username 不匹配（CONNACK rc=2）：本机 broker 按 clientId→username 表校验，请检查配置文件 mqtt.read / mqtt.write 里的身份',
  3: 'broker 服务不可用（CONNACK rc=3）',
  4: '用户名或密码错误（CONNACK rc=4）：请检查配置文件 mqtt.read / mqtt.write 里的密码',
  5: '未授权（CONNACK rc=5）',
})

// ───────────────────────────── 参数校验 ─────────────────────────────

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 截断长文本用于错误消息。 */
function shorten(value, max = 80) {
  const text = String(value)
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 自动生成 clientId（调用方未提供时），避免零长度 clientId 被 broker 直接拒绝。 */
function createDefaultClientId() {
  return `dsh-perf-${Math.random().toString(16).slice(2, 10)}`
}

/**
 * 校验端点 + 连接身份 + 超时，得到统一的连接参数。
 * @returns {{host: string, port: number, clientId: string, username?: string, password?: string, timeoutMs: number}}
 */
function normalizeConnectionParams(params, { defaultTimeoutMs }) {
  if (!isPlainObject(params)) {
    throw new PerfError('E_ARGS', 'MQTT 参数必须是普通对象')
  }

  const host = params.host === undefined ? DEFAULT_HOST : params.host
  if (typeof host !== 'string' || host.length === 0 || host.length > 255) {
    throw new PerfError('E_ARGS', `MQTT host 必须是非空字符串（≤255 字符），收到 ${JSON.stringify(host)}`)
  }

  const port = params.port === undefined ? DEFAULT_PORT : params.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PerfError('E_ARGS', `MQTT port 必须是 1..65535 的整数，收到 ${JSON.stringify(port)}`)
  }

  let clientId = params.clientId
  if (clientId === undefined || clientId === null) {
    clientId = createDefaultClientId()
  } else if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new PerfError('E_ARGS', `MQTT clientId 必须是非空字符串，收到 ${JSON.stringify(clientId)}`)
  } else if (clientId.length > 128) {
    throw new PerfError('E_ARGS', `MQTT clientId 不能超过 128 字符（收到 ${clientId.length} 字符）`)
  }

  let username = params.username
  if (username !== undefined) {
    if (typeof username !== 'string') {
      throw new PerfError('E_ARGS', `MQTT username 必须是字符串，收到 ${JSON.stringify(username)}`)
    }
  }

  let password = params.password
  if (password !== undefined) {
    if (typeof password !== 'string') {
      throw new PerfError('E_ARGS', `MQTT password 必须是字符串`)
    }
    if (username === undefined) {
      throw new PerfError('E_ARGS', 'MQTT password 必须与 username 一起提供')
    }
  }

  const timeoutMs = params.timeoutMs === undefined ? defaultTimeoutMs : params.timeoutMs
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new PerfError('E_ARGS', `MQTT timeoutMs 必须是 >0 的数字，收到 ${JSON.stringify(timeoutMs)}`)
  }

  return { host, port, clientId, username, password, timeoutMs }
}

/**
 * QoS 校验：只支持 0/1；2 明确 `E_UNSUPPORTED`，其它值 `E_ARGS`。
 * @returns {number}
 */
function normalizeQos(value, { fallback, operation }) {
  const qos = value === undefined ? fallback : value
  if (!Number.isInteger(qos) || qos < 0 || qos > 2) {
    throw new PerfError('E_ARGS', `MQTT ${operation} qos 必须是 0、1 或 2 的整数，收到 ${JSON.stringify(value)}`)
  }
  if (qos === 2) {
    throw new PerfError('E_UNSUPPORTED', `MQTT ${operation} 不支持 QoS 2（只实现 QoS 0/1）`)
  }
  return qos
}

/**
 * 单个 topic 校验：非空、≤256 字符、不含 NUL。
 * @param {unknown} topic
 * @param {{allowWildcards: boolean, label: string}} options
 */
function validateTopic(topic, { allowWildcards, label }) {
  if (typeof topic !== 'string') {
    throw new PerfError('E_ARGS', `MQTT ${label} 必须是字符串，收到 ${JSON.stringify(topic)}`)
  }
  if (topic.length === 0) {
    throw new PerfError('E_ARGS', `MQTT ${label} 不能为空字符串`)
  }
  if (topic.length > MAX_TOPIC_CHARS) {
    throw new PerfError('E_ARGS', `MQTT ${label} 超过 ${MAX_TOPIC_CHARS} 字符：${shorten(topic)}`)
  }
  if (topic.includes('\u0000')) {
    throw new PerfError('E_ARGS', `MQTT ${label} 不能包含 NUL 字符：${shorten(topic)}`)
  }
  if (!allowWildcards && (topic.includes('#') || topic.includes('+'))) {
    throw new PerfError('E_ARGS', `MQTT 发布 topic 不能包含通配符 # / +：${shorten(topic)}`)
  }
}

/**
 * mqttRead 的参数校验。
 * @returns {object}
 */
function normalizeReadParams(params) {
  const base = normalizeConnectionParams(params, { defaultTimeoutMs: 8000 })

  const topics = params.topics === undefined ? ['#'] : params.topics
  if (!Array.isArray(topics) || topics.length === 0) {
    throw new PerfError('E_ARGS', 'MQTT topics 必须是非空字符串数组')
  }
  topics.forEach((topic, index) => validateTopic(topic, { allowWildcards: true, label: `topics[${index}]` }))

  const qos = normalizeQos(params.qos, { fallback: 0, operation: '订阅' })

  const waitMs = params.waitMs === undefined ? 1200 : params.waitMs
  if (typeof waitMs !== 'number' || !Number.isFinite(waitMs) || waitMs < 0) {
    throw new PerfError('E_ARGS', `MQTT waitMs 必须是 ≥0 的数字，收到 ${JSON.stringify(waitMs)}`)
  }

  const maxMessages = params.maxMessages === undefined ? 100 : params.maxMessages
  if (!Number.isInteger(maxMessages) || maxMessages < 1) {
    throw new PerfError('E_ARGS', `MQTT maxMessages 必须是 ≥1 的整数，收到 ${JSON.stringify(maxMessages)}`)
  }

  return { ...base, topics, qos, waitMs, maxMessages }
}

/**
 * mqttPublish 的参数校验。
 * @returns {object}
 */
function normalizePublishParams(params) {
  const base = normalizeConnectionParams(params, { defaultTimeoutMs: 5000 })

  const topic = params.topic
  if (topic === undefined) {
    throw new PerfError('E_ARGS', 'MQTT 发布必须提供 topic')
  }
  validateTopic(topic, { allowWildcards: false, label: 'topic' })

  const payload = params.payload
  if (typeof payload !== 'string') {
    throw new PerfError('E_ARGS', `MQTT 发布 payload 必须是字符串（JSON 文本），收到 ${typeof payload}`)
  }
  const payloadBuffer = Buffer.from(payload, 'utf8')
  if (payloadBuffer.length > MAX_PAYLOAD_BYTES) {
    throw new PerfError(
      'E_ARGS',
      `MQTT 发布 payload ${payloadBuffer.length} 字节，超过上限 ${MAX_PAYLOAD_BYTES} 字节（UTF-8 计）`,
    )
  }

  const qos = normalizeQos(params.qos, { fallback: 1, operation: '发布' })

  const retain = params.retain === undefined ? false : params.retain
  if (typeof retain !== 'boolean') {
    throw new PerfError('E_ARGS', `MQTT retain 必须是布尔值，收到 ${JSON.stringify(retain)}`)
  }
  if (retain) {
    throw new PerfError('E_ARGS', 'MQTT 发布不允许 retain=true（本插件只做即时控制面发布，不保留状态）')
  }

  return { ...base, topic, payload, payloadBuffer, qos, retain }
}

// ───────────────────────────── 报文编码 ─────────────────────────────

/** 可变字节整数（Remaining Length）。 */
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
function encodeString(value) {
  const body = Buffer.from(value, 'utf8')
  if (body.length > 0xffff) {
    throw new PerfError('E_ARGS', `MQTT 字符串字段 ${body.length} 字节，超过 65535 字节上限`)
  }
  const prefix = Buffer.alloc(2)
  prefix.writeUInt16BE(body.length, 0)
  return Buffer.concat([prefix, body])
}

/** 拼一个完整 MQTT 报文。 */
function buildPacket(headerByte, body) {
  return Buffer.concat([Buffer.from([headerByte]), encodeRemainingLength(body.length), body])
}

/** 2 字节大端无符号整数。 */
function u16(value) {
  const buffer = Buffer.alloc(2)
  buffer.writeUInt16BE(value & 0xffff, 0)
  return buffer
}

/** CONNECT（cleanSession=1，protocol level 4）。 */
function buildConnectPacket({ clientId, username, password }) {
  const flags = 0x02 | (username !== undefined ? 0x80 : 0) | (password !== undefined ? 0x40 : 0)
  const variableHeader = Buffer.concat([
    encodeString('MQTT'),
    Buffer.from([PROTOCOL_LEVEL, flags]),
    u16(KEEP_ALIVE_SECONDS),
  ])
  const payloadParts = [encodeString(clientId)]
  if (username !== undefined) payloadParts.push(encodeString(username))
  if (password !== undefined) payloadParts.push(encodeString(password))
  return buildPacket(PACKET_TYPE.CONNECT << 4, Buffer.concat([variableHeader, ...payloadParts]))
}

/** SUBSCRIBE（一个报文订阅全部 topics，packetId 由调用方给定）。 */
function buildSubscribePacket({ packetId, topics, qos }) {
  const parts = [u16(packetId)]
  for (const topic of topics) {
    parts.push(encodeString(topic), Buffer.from([qos]))
  }
  return buildPacket((PACKET_TYPE.SUBSCRIBE << 4) | 0x02, Buffer.concat(parts))
}

/** PUBLISH。 */
function buildPublishPacket({ topic, payloadBuffer, qos, retain, packetId }) {
  const headerByte = (PACKET_TYPE.PUBLISH << 4) | (qos << 1) | (retain ? 0x01 : 0)
  const parts = [encodeString(topic)]
  if (qos > 0) parts.push(u16(packetId))
  parts.push(payloadBuffer)
  return buildPacket(headerByte, Buffer.concat(parts))
}

/** PUBACK。 */
function buildPubackPacket(packetId) {
  return buildPacket(PACKET_TYPE.PUBACK << 4, u16(packetId))
}

// ───────────────────────────── 报文解析 ─────────────────────────────

/**
 * 从 `buffer[start]` 起解析 Remaining Length。
 * @returns {{incomplete: true} | {value: number, bytes: number}}
 */
function readRemainingLength(buffer, start) {
  let multiplier = 1
  let value = 0
  let position = start
  for (let index = 0; index < 4; index += 1) {
    if (position >= buffer.length) return { incomplete: true }
    const byte = buffer[position]
    position += 1
    value += (byte & 0x7f) * multiplier
    if ((byte & 0x80) === 0) return { value, bytes: position - start }
    multiplier *= 128
  }
  throw new PerfError('E_CHANNEL', 'MQTT 报文 Remaining Length 非法（超过 4 字节）')
}

/** 解析 CONNACK body。 */
function parseConnack(body) {
  if (body.length < 2) {
    throw new PerfError('E_CHANNEL', `CONNACK 报文长度非法（${body.length} 字节，至少 2 字节）`)
  }
  return { sessionPresent: (body[0] & 0x01) === 1, returnCode: body[1] }
}

/** 解析 PUBLISH（payload 按 UTF-8 解码成字符串）。 */
function parsePublish(body, headerByte) {
  if (body.length < 2) {
    throw new PerfError('E_CHANNEL', 'PUBLISH 报文过短（缺少 topic 长度）')
  }
  let offset = 0
  const topicLength = body.readUInt16BE(0)
  offset = 2
  if (body.length < offset + topicLength) {
    throw new PerfError('E_CHANNEL', 'PUBLISH 报文 topic 长度越界')
  }
  const topic = body.subarray(offset, offset + topicLength).toString('utf8')
  offset += topicLength

  const qos = (headerByte >> 1) & 0x03
  let packetId = null
  if (qos > 0) {
    if (body.length < offset + 2) {
      throw new PerfError('E_CHANNEL', `PUBLISH（QoS ${qos}）报文缺少 packetId`)
    }
    packetId = body.readUInt16BE(offset)
    offset += 2
  }
  return {
    topic,
    payload: body.subarray(offset).toString('utf8'),
    retained: (headerByte & 0x01) === 1,
    qos,
    packetId,
    dup: (headerByte & 0x08) !== 0,
  }
}

/** CONNACK 非 0 → E_CHANNEL（rc=2/rc=4 message 写明含义，契约 §5.1）。 */
function connackError(returnCode, host, port) {
  const hint = CONNACK_HINTS[returnCode] ?? `未知 CONNACK 返回码 ${returnCode}`
  return new PerfError('E_CHANNEL', `MQTT broker ${host}:${port} 拒绝连接：${hint}`)
}

/** 统一把意外错误转成 PerfError。 */
function toPerfError(error) {
  if (error instanceof PerfError) return error
  return new PerfError('E_CHANNEL', `MQTT 协议处理失败：${error instanceof Error ? error.message : String(error)}`)
}

/** TCP 连接阶段的错误映射。 */
function mapConnectError(error, host, port) {
  const code = error?.code
  if (code === 'ECONNREFUSED') {
    return new PerfError(
      'E_CHANNEL',
      `无法连接 MQTT broker ${host}:${port}（ECONNREFUSED）：GCUBridge.exe 可能未运行（机械革命电竞控制台服务）`,
    )
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new PerfError('E_CHANNEL', `无法解析 MQTT broker 主机 ${host}：${error.message}`)
  }
  if (code === 'ETIMEDOUT') {
    return new PerfError('E_TIMEOUT', `连接 MQTT broker ${host}:${port} 超时`)
  }
  return new PerfError('E_CHANNEL', `连接 MQTT broker ${host}:${port} 失败：${error?.message ?? String(error)}`)
}

/** 连接建立后的致命错误映射。 */
function fatalToPerfError(fatal, { host, port, context }) {
  if (fatal.source === 'protocol' && fatal.error instanceof PerfError) return fatal.error
  const where = context ? `（${context}）` : ''
  if (fatal.source === 'close') {
    return new PerfError('E_CHANNEL', `MQTT 连接被 broker 关闭${where}，未收到预期响应`)
  }
  const error = fatal.error
  const code = error?.code
  if (code === 'ECONNREFUSED') {
    return new PerfError('E_CHANNEL', `无法连接 MQTT broker ${host}:${port}（ECONNREFUSED）：GCUBridge.exe 可能未运行`)
  }
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
    return new PerfError('E_CHANNEL', `MQTT 连接中断${where}（${code}）`)
  }
  return new PerfError('E_CHANNEL', `MQTT 连接错误${where}：${error?.message ?? String(error)}`)
}

// ───────────────────────────── TCP + 连接封装 ─────────────────────────────

/**
 * 建立 TCP 连接（带超时与取消）。成功时返回的 socket 上留有永久 noop error 监听，
 * 避免连接移交瞬间的 error 事件变成 uncaught。
 *
 * @returns {Promise<import('node:net').Socket>}
 */
function openTcp({ host, port, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    // 兜底监听：MqttConnection 会另加自己的 error 处理，这里保证任何时刻都不会 uncaught。
    socket.on('error', () => {})

    let settled = false
    let timer = null

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      socket.removeListener('connect', onConnect)
    }

    const onConnect = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(socket)
    }

    const onError = (error) => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(mapConnectError(error, host, port))
    }

    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(new PerfError('E_IO', '已取消'))
    }

    socket.once('connect', onConnect)
    socket.once('error', onError)
    timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(new PerfError('E_TIMEOUT', `连接 MQTT broker ${host}:${port} 超时（${timeoutMs}ms）`))
    }, timeoutMs)

    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

/**
 * 已建立的 MQTT 连接：负责累积收包（处理 TCP 拆包/粘包）、1 MiB 上限、错误归一化。
 */
class MqttConnection {
  constructor(socket) {
    /** @type {import('node:net').Socket} */
    this.socket = socket
    this._buffer = Buffer.alloc(0)
    this._onPacket = null
    this._onFatal = null
    this._failure = null
    this._closed = false
    this._fatalSent = false

    socket.setNoDelay(true)
    socket.on('data', (chunk) => this._handleData(chunk))
    socket.on('error', (error) => this._fail(error, 'socket'))
    socket.on('close', () => {
      this._closed = true
      if (this._failure === null && !this._fatalSent) this._notifyFatal({ source: 'close' })
    })
  }

  /** 设置收包/致命错误处理器（传 null 解除，收尾时用）。 */
  setHandlers({ onPacket, onFatal }) {
    this._onPacket = onPacket ?? null
    this._onFatal = onFatal ?? null
  }

  /** 发送报文。 */
  write(buffer) {
    if (this.socket.destroyed) {
      throw new PerfError('E_CHANNEL', 'MQTT 连接已关闭，无法发送报文')
    }
    this.socket.write(buffer)
  }

  /**
   * 尽力发 DISCONNECT，然后 end + 等 FIN（最多 DISCONNECT_GRACE_MS 后强杀）。
   * 幂等；不会抛错。
   */
  async disconnect() {
    this._onPacket = null
    this._onFatal = null
    if (this.socket.destroyed) return
    try {
      this.socket.write(DISCONNECT_PACKET)
    } catch {
      // socket 已坏，直接走关闭流程
    }
    await new Promise((resolve) => {
      let settled = false
      let timer = null
      const finish = () => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        this.socket.removeListener('close', onClose)
        this.socket.destroy()
        resolve()
      }
      const onClose = () => finish()
      this.socket.once('close', onClose)
      timer = setTimeout(finish, DISCONNECT_GRACE_MS)
      try {
        this.socket.end()
      } catch {
        finish()
      }
    })
  }

  _notifyFatal(fatal) {
    if (this._fatalSent) return
    this._fatalSent = true
    const handler = this._onFatal
    if (handler !== null) handler(fatal)
  }

  _fail(error, source) {
    if (this._fatalSent) return
    this._failure = error
    this.socket.destroy()
    this._notifyFatal({ source, error })
  }

  _handleData(chunk) {
    if (this._fatalSent || this._closed) return
    // 累积字节流：一个 TCP chunk 里可能有 0.5 个、1 个或多个 MQTT 报文。
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk])
    try {
      while (this._buffer.length >= 2) {
        const remaining = readRemainingLength(this._buffer, 1)
        if (remaining.incomplete === true) return
        if (remaining.value > MAX_PACKET_BYTES) {
          throw new PerfError(
            'E_CHANNEL',
            `MQTT 报文长度 ${remaining.value} 字节超过上限 ${MAX_PACKET_BYTES} 字节（1 MiB）`,
          )
        }
        const headerLength = 1 + remaining.bytes
        const total = headerLength + remaining.value
        if (this._buffer.length < total) return
        const headerByte = this._buffer[0]
        const body = this._buffer.subarray(headerLength, total)
        this._buffer = this._buffer.subarray(total)
        const handler = this._onPacket
        if (handler !== null) handler(headerByte, body)
        if (this._fatalSent || this._closed) return
      }
    } catch (error) {
      this._fail(toPerfError(error), 'protocol')
    }
  }
}

/**
 * 通用操作骨架：建连 → 发 CONNECT → 等 CONNACK → 交给 driver 驱动 → 收尾关 socket。
 *
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {number} options.timeoutMs
 * @param {AbortSignal|undefined} options.signal
 * @param {{clientId: string, username?: string, password?: string}} options.connect
 * @param {object} options.driver 见 mqttRead/mqttPublish 内部实现
 * @returns {Promise<any>}
 */
async function runMqttOperation({ host, port, timeoutMs, signal, connect, driver }) {
  if (signal !== undefined && signal.aborted) {
    throw new PerfError('E_IO', '已取消')
  }
  const startedAt = Date.now()
  const socket = await openTcp({ host, port, timeoutMs, signal })
  if (signal !== undefined && signal.aborted) {
    socket.destroy()
    throw new PerfError('E_IO', '已取消')
  }

  const conn = new MqttConnection(socket)
  const timers = new Set()
  let settled = false
  let abortHandler = null
  let resolveOperation = null
  let rejectOperation = null
  const done = new Promise((resolve, reject) => {
    resolveOperation = resolve
    rejectOperation = reject
  })

  const detachAbort = () => {
    if (signal !== undefined && abortHandler !== null) {
      signal.removeEventListener('abort', abortHandler)
      abortHandler = null
    }
  }

  const settle = (kind, value) => {
    if (settled) return
    settled = true
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    detachAbort()
    conn.setHandlers({ onPacket: null, onFatal: null })
    // 先关 socket 再回结果，保证函数返回时连接已经释放；disconnect 自带宽限上限。
    const finish = () => {
      if (kind === 'resolve') resolveOperation(value)
      else rejectOperation(value)
    }
    conn.disconnect().then(finish, finish)
  }

  /** @type {{write: Function, addTimer: Function, resolve: Function, reject: Function, isSettled: Function}} */
  const api = {
    write(buffer) {
      conn.write(buffer)
    },
    /** 注册受管的超时（settle 时统一清理）。 */
    addTimer(callback, ms) {
      const timer = setTimeout(() => {
        timers.delete(timer)
        callback()
      }, Math.max(1, ms))
      timers.add(timer)
      return timer
    },
    resolve(value) {
      settle('resolve', value)
    },
    reject(error) {
      settle('reject', error)
    },
    isSettled() {
      return settled
    },
  }

  abortHandler = () => api.reject(new PerfError('E_IO', '已取消'))
  if (signal !== undefined) signal.addEventListener('abort', abortHandler, { once: true })

  conn.setHandlers({
    onPacket(headerByte, body) {
      if (settled) return
      try {
        driver.onPacket(headerByte, body, api)
      } catch (error) {
        api.reject(toPerfError(error))
      }
    },
    onFatal(fatal) {
      if (settled) return
      try {
        const handled = driver.onFatal !== undefined ? driver.onFatal(fatal, api) : false
        if (handled !== true) api.reject(fatalToPerfError(fatal, { host, port }))
      } catch (error) {
        api.reject(toPerfError(error))
      }
    },
  })

  try {
    conn.write(buildConnectPacket(connect))
  } catch (error) {
    api.reject(toPerfError(error))
    return done
  }

  // 整体兜底超时：从操作开始算，扣掉建连已消耗的时间。
  const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt))
  api.addTimer(() => {
    if (!settled) driver.onDeadline(api)
  }, remaining)

  return done
}

// ───────────────────────────── 对外 API ─────────────────────────────

/**
 * 订阅一批 topic，收集 `waitMs` 内 broker 投递的消息（含 retained 立即投递），
 * 到 `maxMessages` 或 `waitMs` 截止（`timeoutMs` 兜底）后 DISCONNECT 返回。
 *
 * @param {object} [params]
 * @param {string} [params.host='127.0.0.1']
 * @param {number} [params.port=13688]
 * @param {string} [params.clientId]
 * @param {string} [params.username]
 * @param {string} [params.password]
 * @param {string[]} [params.topics=['#']]
 * @param {number} [params.qos=0]
 * @param {number} [params.waitMs=1200]
 * @param {number} [params.maxMessages=100]
 * @param {number} [params.timeoutMs=8000]
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{messages: Array<{topic: string, payload: string, retained: boolean, qos: number}>, warnings: string[]}>}
 */
export async function mqttRead(params = {}, { signal } = {}) {
  const options = normalizeReadParams(params)
  /** @type {Array<{topic: string, payload: string, retained: boolean, qos: number}>} */
  const messages = []
  /** @type {string[]} */
  const warnings = []
  let phase = 'connack'
  let subscriptionTime = null

  const phaseLabel = () => {
    if (phase === 'connack') return '等待 CONNACK'
    if (phase === 'suback') return '等待 SUBACK'
    return '收集消息'
  }

  return runMqttOperation({
    host: options.host,
    port: options.port,
    timeoutMs: options.timeoutMs,
    signal,
    connect: { clientId: options.clientId, username: options.username, password: options.password },
    driver: {
      onPacket(headerByte, body, api) {
        const type = headerByte >> 4

        if (phase === 'connack') {
          if (type !== PACKET_TYPE.CONNACK) return
          const connack = parseConnack(body)
          if (connack.sessionPresent) {
            warnings.push('broker 返回 sessionPresent=1（存在旧的持久会话）')
          }
          if (connack.returnCode !== 0) {
            throw connackError(connack.returnCode, options.host, options.port)
          }
          api.write(buildSubscribePacket({ packetId: 1, topics: options.topics, qos: options.qos }))
          phase = 'suback'
          return
        }

        if (phase === 'suback') {
          if (type !== PACKET_TYPE.SUBACK) return
          if (body.length < 3) {
            throw new PerfError('E_CHANNEL', `SUBACK 报文长度非法（${body.length} 字节，至少 3 字节）`)
          }
          const packetId = body.readUInt16BE(0)
          if (packetId !== 1) {
            throw new PerfError('E_CHANNEL', `SUBACK packetId=${packetId} 与请求的 packetId=1 不一致`)
          }
          const codes = [...body.subarray(2)]
          if (codes.length !== options.topics.length) {
            warnings.push(`SUBACK 返回 ${codes.length} 个授予码，与订阅的 ${options.topics.length} 个 topic 数量不一致`)
          }
          const rejected = codes.filter((code) => code === 0x80).length
          if (codes.length > 0 && rejected === codes.length) {
            throw new PerfError(
              'E_CHANNEL',
              `MQTT 订阅被 broker 拒绝（SUBACK 0x80）：${options.topics.join(', ')}`,
            )
          }
          if (rejected > 0) {
            warnings.push(`有 ${rejected} 个订阅被 broker 拒绝（SUBACK 0x80）`)
          }
          phase = 'collect'
          subscriptionTime = Date.now()
          api.addTimer(() => {
            api.resolve({ messages, warnings })
          }, options.waitMs)
          return
        }

        if (type === PACKET_TYPE.PUBLISH) {
          const message = parsePublish(body, headerByte)
          if (message.qos === 1) {
            if (message.packetId === null) {
              throw new PerfError('E_CHANNEL', '收到的 PUBLISH QoS1 缺少 packetId')
            }
            api.write(buildPubackPacket(message.packetId))
          } else if (message.qos === 2) {
            warnings.push(`收到 QoS2 消息（topic=${message.topic}）：未实现 QoS2 确认流程，按原样返回`)
          }
          messages.push({
            topic: message.topic,
            payload: message.payload,
            retained: message.retained,
            qos: message.qos,
          })
          if (messages.length >= options.maxMessages) {
            api.resolve({ messages, warnings })
          }
          return
        }
        // 其它报文（PINGRESP 等）忽略
      },

      onFatal(fatal, api) {
        if ((fatal.source === 'socket' || fatal.source === 'close') && messages.length > 0) {
          warnings.push(
            fatal.source === 'socket'
              ? `MQTT socket 错误：${fatal.error?.message ?? String(fatal.error)}`
              : 'MQTT 连接在收集期被 broker 关闭',
          )
          api.resolve({ messages, warnings })
          return true
        }
        api.reject(
          fatalToPerfError(fatal, {
            host: options.host,
            port: options.port,
            context: phaseLabel(),
          }),
        )
        return true
      },

      onDeadline(api) {
        if (messages.length > 0) {
          warnings.push(`等待超过 timeoutMs=${options.timeoutMs}ms，提前返回已收到的 ${messages.length} 条消息`)
          api.resolve({ messages, warnings })
        } else if (phase === 'collect') {
          api.reject(
            new PerfError(
              'E_TIMEOUT',
              `MQTT 读取超时（${options.timeoutMs}ms）：订阅成功后 ${Date.now() - subscriptionTime}ms 内未收到任何消息`,
            ),
          )
        } else {
          api.reject(
            new PerfError('E_TIMEOUT', `MQTT 读取超时（${options.timeoutMs}ms）：${phaseLabel()} 未完成`),
          )
        }
      },
    },
  })
}

/**
 * 向 MQTT topic 发布一条字符串 payload（QoS 0/1；retain 只允许 false）。
 *
 * @param {object} params
 * @param {string} [params.host='127.0.0.1']
 * @param {number} [params.port=13688]
 * @param {string} [params.clientId]
 * @param {string} [params.username]
 * @param {string} [params.password]
 * @param {string} params.topic
 * @param {string} params.payload UTF-8 文本（JSON 文本）
 * @param {number} [params.qos=1]
 * @param {boolean} [params.retain=false]
 * @param {number} [params.timeoutMs=5000]
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{sent: true, topic: string, bytes: number}>}
 */
export async function mqttPublish(params = {}, { signal } = {}) {
  const options = normalizePublishParams(params)
  const result = {
    sent: /** @type {true} */ (true),
    topic: options.topic,
    bytes: options.payloadBuffer.length,
  }
  let phase = 'connack'

  return runMqttOperation({
    host: options.host,
    port: options.port,
    timeoutMs: options.timeoutMs,
    signal,
    connect: { clientId: options.clientId, username: options.username, password: options.password },
    driver: {
      onPacket(headerByte, body, api) {
        const type = headerByte >> 4

        if (phase === 'connack') {
          if (type !== PACKET_TYPE.CONNACK) return
          const connack = parseConnack(body)
          if (connack.returnCode !== 0) {
            throw connackError(connack.returnCode, options.host, options.port)
          }
          api.write(
            buildPublishPacket({
              topic: options.topic,
              payloadBuffer: options.payloadBuffer,
              qos: options.qos,
              retain: false,
              packetId: 1,
            }),
          )
          if (options.qos === 0) {
            api.resolve(result)
            return
          }
          phase = 'puback'
          return
        }

        if (type === PACKET_TYPE.PUBACK) {
          if (body.length < 2) {
            throw new PerfError('E_CHANNEL', `PUBACK 报文长度非法（${body.length} 字节）`)
          }
          const packetId = body.readUInt16BE(0)
          if (packetId !== 1) return
          api.resolve(result)
        }
      },

      onFatal(fatal, api) {
        api.reject(
          fatalToPerfError(fatal, {
            host: options.host,
            port: options.port,
            context: phase === 'puback' ? '等待 PUBACK' : '等待 CONNACK',
          }),
        )
        return true
      },

      onDeadline(api) {
        if (phase === 'puback') {
          api.reject(new PerfError('E_TIMEOUT', `MQTT 发布超时（${options.timeoutMs}ms）：未收到 PUBACK`))
        } else {
          api.reject(new PerfError('E_TIMEOUT', `MQTT 发布超时（${options.timeoutMs}ms）：等待 CONNACK 未完成`))
        }
      },
    },
  })
}
