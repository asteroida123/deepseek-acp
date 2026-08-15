/**
 * Bridge 运行时状态：协议处理器共享的一切。
 *
 * 处理器不直接持有连接对象，只经由 `notify` 发送更新——保持协议层对传输的
 * 无知，也让处理器可在无连接的条件下单测。
 * @module
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ClientTextReader } from './composition/session-fs.js'
import type { HarnessPort } from './port/types.js'
import type { SessionTable } from './session/table.js'

/** 插件配置。 */
export interface AcpBridgeConfig {
  /** 创建会话使用的 provider 路由 */
  provider?: string
  /** 创建会话使用的模型 */
  model?: string
}

/** 处理器共享的运行时。 */
export interface Bridge {
  readonly port: HarnessPort
  readonly table: SessionTable
  readonly config: AcpBridgeConfig
  /**
   * 客户端是否支持 Zed 的终端 `_meta` 约定，在 `initialize` 时确定。
   *
   * 可变是有意的：握手先于建会话，而握手结果对所有会话生效。
   */
  terminalOutput: boolean
  /** 客户端是否支持表单式 elicitation（US-21）；同样在 `initialize` 时确定 */
  elicitation: boolean
  /**
   * 取这个会话的文本读委托（US-25）；客户端没声明 `fs.readTextFile` 时返回
   * `undefined`，会话就全程走磁盘。
   *
   * **按会话取而不是全局一个**：`fs/read_text_file` 的入参带 `sessionId`，
   * 拿别的会话的 id 去读是在线路上说谎——对 codeg 今天无害（它的 fs 策略是
   * 按连接的），对一个按会话记账的客户端就是错的。
   */
  readonly readDelegate: (sessionId: SessionId) => ClientTextReader | undefined
  /** 发送 session/update；失败被隔离，不得让消失的客户端破坏 agent 回合 */
  readonly notify: (sessionId: SessionId, update: SessionUpdate) => void
  /**
   * 发送 session/update 并**等待写出**。
   *
   * 历史重放专用：`session/load` 的应答必须排在全部重放更新之后，否则客户端
   * 会在还没收到历史时就把会话当成已就绪。发起顺序即写出顺序，所以按序发起、
   * 一并等待即可。失败在这里要**抛出**——重放不完整而应答成功，客户端会拿着
   * 一份残缺的对话继续，比直接失败糟糕得多。
   */
  readonly notifyAwaited: (sessionId: SessionId, updates: readonly SessionUpdate[]) => Promise<void>
  /**
   * 在**当前请求的应答写出之后**再发送 session/update。
   *
   * `session/new` 专用：会话 id 是服务端生成的，客户端第一次知道它是在应答里。
   * 抢在应答前面发的更新指向一个客户端还不认识的会话，多数客户端会直接丢弃，
   * 表现为「命令目录时有时无」。
   */
  readonly notifyAfterResponse: (sessionId: SessionId, update: SessionUpdate) => void
  /** 已进入 teardown 时抛错（不变量 I3） */
  readonly assertOpen: () => void
  readonly warn: (message: string) => void
}
