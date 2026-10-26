/**
 * MQTT 通道封装（契约 §5.2）。
 *
 * 把 `lib/mqtt-client.js` 的 `mqttRead` / `mqttPublish` 包装成通道对象：
 * - 端点与凭据默认取 `config.mqtt`：读用 `config.mqtt.read`，写用 `config.mqtt.write`；
 * - 调用参数可逐字段覆盖（测试/临时端点用），未传（undefined）的字段不会覆盖默认值；
 * - `deps` 可注入 `mqttRead` / `mqttPublish`，便于测试与替换实现；
 * - publish 的 `payload` 是**字符串**（JSON 文本），本层不做数值包线（由 `lib/envelope.js` 做），
 *   但拒绝 `retain: true` 与 `qos: 2`；
 * - 本层不重试、不 retain；`signal` 原样透传给底层客户端。
 *
 * @module lib/channel-mqtt
 */

import { PerfError } from './errors.js'
import { mqttPublish, mqttRead } from './mqtt-client.js'

/** MQTT 通道默认端点（OEM 控制台逆向结论：GCUBridge.exe）。 */
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 13688

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取普通对象，否则回退空对象（配置可能缺字段/类型不对，交由下游报错）。 */
function asObject(value) {
  return isPlainObject(value) ? value : {}
}

/**
 * 用显式提供的覆盖值合并基础参数：只有 `!== undefined` 才覆盖，
 * 这样 `channel.read({ topics: ['#'], qos: undefined })` 不会把配置里的值擦掉。
 */
function mergeParams(base, overrides) {
  const merged = { ...base }
  for (const [key, value] of Object.entries(asObject(overrides))) {
    if (value !== undefined) merged[key] = value
  }
  return merged
}

/** 读身份默认参数：config.mqtt.{host,port} + config.mqtt.read 凭据。 */
function readBaseParams(config) {
  const mqtt = asObject(config?.mqtt)
  const credentials = asObject(mqtt.read)
  return {
    host: mqtt.host ?? DEFAULT_HOST,
    port: mqtt.port ?? DEFAULT_PORT,
    clientId: credentials.clientId,
    username: credentials.username,
    password: credentials.password,
  }
}

/** 写身份默认参数：config.mqtt.{host,port} + config.mqtt.write 凭据。 */
function writeBaseParams(config) {
  const mqtt = asObject(config?.mqtt)
  const credentials = asObject(mqtt.write)
  return {
    host: mqtt.host ?? DEFAULT_HOST,
    port: mqtt.port ?? DEFAULT_PORT,
    clientId: credentials.clientId,
    username: credentials.username,
    password: credentials.password,
  }
}

/**
 * 校验 MQTT 身份已配置。凭据不内置（不同机型/控制台版本可能不同），
 * 未配置时给可执行的 E_CONFIG，而不是让 broker 用 rc=2 拒绝。
 *
 * @param {Record<string, unknown>} merged
 * @param {'mqtt.read'|'mqtt.write'} configField
 */
function requireConfiguredCredentials(merged, configField) {
  if (typeof merged.clientId !== 'string' || merged.clientId.length === 0) {
    throw new PerfError(
      'E_CONFIG',
      `未配置 MQTT 凭据：请在配置文件的 ${configField} 中填写 {clientId, username, password}（插件不内置凭据；不同机型/控制台版本的凭据可能不同）`,
      { field: configField },
    )
  }
}

/**
 * 创建 MQTT 通道。
 *
 * @param {object} [options]
 * @param {object} [options.config] 插件配置（`config.mqtt`）
 * @param {{mqttRead?: Function, mqttPublish?: Function}} [options.deps] 可注入实现
 * @returns {{
 *   kind: 'mqtt',
 *   read: (params?: object, options?: {signal?: AbortSignal}) => Promise<object>,
 *   publish: (params?: object, options?: {signal?: AbortSignal}) => Promise<object>,
 * }}
 */
export function createMqttChannel({ config, deps } = {}) {
  const readImpl = typeof deps?.mqttRead === 'function' ? deps.mqttRead : mqttRead
  const publishImpl = typeof deps?.mqttPublish === 'function' ? deps.mqttPublish : mqttPublish

  return {
    kind: 'mqtt',

    /**
     * 订阅并收集消息。参数同 `mqttRead`；端点/身份默认取 `config.mqtt.read`。
     * @returns {Promise<{kind: 'mqtt', messages: Array<object>, warnings: string[]}>}
     */
    async read(params = {}, { signal } = {}) {
      const merged = mergeParams(readBaseParams(config), params)
      requireConfiguredCredentials(merged, 'mqtt.read')
      const result = await readImpl(merged, { signal })
      return { ...asObject(result), kind: 'mqtt' }
    },

    /**
     * 发布一条 JSON 文本到控制面 topic。参数同 `mqttPublish`；端点/身份默认取
     * `config.mqtt.write`。本层拒绝 `retain: true` 与 `qos: 2`。
     * @returns {Promise<{kind: 'mqtt', sent: true, topic: string, bytes: number}>}
     */
    async publish(params = {}, { signal } = {}) {
      const input = asObject(params)

      const payload = input.payload
      if (typeof payload !== 'string') {
        throw new PerfError(
          'E_ARGS',
          `MQTT 发布 payload 必须是字符串（JSON 文本），收到 ${payload === null ? 'null' : typeof payload}`,
        )
      }

      if (input.retain === true) {
        throw new PerfError('E_ARGS', 'MQTT 发布不允许 retain=true（本插件只做即时控制面发布，不保留状态）')
      }
      if (input.retain !== undefined && typeof input.retain !== 'boolean') {
        throw new PerfError('E_ARGS', `MQTT retain 必须是布尔值，收到 ${JSON.stringify(input.retain)}`)
      }

      if (input.qos === 2) {
        throw new PerfError('E_UNSUPPORTED', 'MQTT 发布不支持 QoS 2（只实现 QoS 0/1）')
      }
      if (input.qos !== undefined && (!Number.isInteger(input.qos) || input.qos < 0 || input.qos > 2)) {
        throw new PerfError('E_ARGS', `MQTT 发布 qos 必须是 0、1 或 2 的整数，收到 ${JSON.stringify(input.qos)}`)
      }

      const merged = mergeParams(writeBaseParams(config), input)
      requireConfiguredCredentials(merged, 'mqtt.write')
      const result = await publishImpl(merged, { signal })
      return { ...asObject(result), kind: 'mqtt' }
    },
  }
}
