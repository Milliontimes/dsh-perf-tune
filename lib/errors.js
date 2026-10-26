/**
 * DSH perf-tune 插件统一错误类型与固定错误码表。
 *
 * 契约依据：CONTRACT.md §2。
 * 其它模块只能从本文件取错误码，禁止临时发明 code。
 */

/** 固定错误码表（顺序与 CONTRACT.md §2 表格一致） */
export const ERROR_CODES = Object.freeze([
  'E_ARGS', // 参数不合法（缺失/类型错/互斥字段冲突）
  'E_CONFIG', // 配置文件缺失、JSON 解析失败、字段非法、配置试图放宽硬包线
  'E_CHANNEL', // 通道执行失败（外部程序非零退出、HTTP 非 2xx、MQTT CONNACK 拒绝等）
  'E_NOT_FOUND', // 目标不存在（nvidia-smi 不存在、JSON path 无值、topic 无 retained）
  'E_TIMEOUT', // 超时
  'E_SAFETY', // 写入值越界或被硬包线拒绝
  'E_WRITE_DISABLED', // writes.enabled 为 false
  'E_COOLDOWN', // 距上次写入太近
  'E_ADMIN_REQUIRED', // 需要管理员权限（nvidia-smi 写操作典型）
  'E_UNSUPPORTED', // 该操作/字段/能力不被当前环境支持
  'E_IO', // 本地 I/O（审计文件、配置文件读写）失败；也用于取消
]);

/** 以对象形式暴露同一张表，便于书写 `ERROR_CODE.E_SAFETY` */
export const ERROR_CODE = Object.freeze(
  Object.fromEntries(ERROR_CODES.map((code) => [code, code])),
);

const KNOWN_CODES = new Set(ERROR_CODES);

/**
 * 本插件的唯一错误类型。
 *
 * `message` 必须自解释：工具层最终只把 `message` 展示给模型，`details` 不会外露。
 * 例：`new PerfError('E_SAFETY', '核心锁频 3000 MHz 超出硬包线 300..2500 MHz')`
 */
export class PerfError extends Error {
  /**
   * @param {string} code 固定错误码（见 ERROR_CODES）
   * @param {string} message 面向模型的、自解释的错误说明
   * @param {object} [details] 仅供内部诊断，不会展示给模型
   */
  constructor(code, message, details) {
    const text = message === undefined || message === null ? String(code) : String(message);
    super(text);
    this.name = 'PerfError';
    /** @type {string} */
    this.code = code;
    if (details !== undefined) {
      /** @type {object} */
      this.details = details;
    }
    // 保持栈信息指向真正抛错处（V8 中已由 super 捕获，这里无需额外处理）。
  }

  /** 序列化时保留 code（Error.message 默认不可枚举，审计/日志里常被丢掉）。 */
  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

/**
 * 判断一个值是否为 PerfError。
 *
 * 主判定用 `instanceof`；额外接受同 realm 内「带已知 code 的 Error」的鸭子类型，
 * 以便跨模块/被包装后仍能识别。
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPerfError(value) {
  if (value instanceof PerfError) return true;
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (/** @type {any} */ (value).code) === 'string' &&
    typeof (/** @type {any} */ (value).message) === 'string' &&
    KNOWN_CODES.has(/** @type {any} */ (value).code)
  );
}

/**
 * 判断字符串是否为固定错误码之一（供模块自检，不抛错）。
 *
 * @param {unknown} code
 * @returns {boolean}
 */
export function isErrorCode(code) {
  return typeof code === 'string' && KNOWN_CODES.has(code);
}
