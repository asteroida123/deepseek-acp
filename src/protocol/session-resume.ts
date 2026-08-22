/**
 * `session/resume` —— 恢复一个会话但**不回放**历史（对比 `session/load`）。
 *
 * 两者的差别只有这一条：`load` 把整段转录经 `session/update` 流回客户端，
 * `resume` 不流。客户端要它的场景很具体——转录它自己就有（当初就是它画出来
 * 的），重开只需要 agent 侧活过来；走 `load` 的话，一个几百轮的会话要重放几千
 * 条更新，让客户端把已有的内容再画一遍。
 *
 * 恢复段与 `load` 共用 {@link restoreSession}：cwd 校验、seq 分配、MCP 挂载、
 * 会话登记全都一样，写成两份迟早只改一边。
 * @module
 */

import type { ResumeSessionRequest, ResumeSessionResponse } from '@agentclientprotocol/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Bridge } from '../bridge.js'
import { methodNotFound } from '../codec/errors.js'
import { modeStateFor } from '../config/modes.js'
import { commandsUpdate } from './session-commands.js'
import { optionsFor } from './session-config.js'
import { restoreSession, validateRestore } from './session-load.js'
import { rethrowMissingSession } from './session-missing.js'

/**
 * @param bridge - 运行时
 * @param params - ACP 请求
 * @returns 模式与配置项（与 `session/new` 同构）
 */
export async function handleResumeSession(
  bridge: Bridge,
  params: ResumeSessionRequest,
): Promise<ResumeSessionResponse> {
  bridge.assertOpen()
  if (bridge.port.catalog === undefined) {
    // 组合没挂持久化，没有可恢复的东西。理论上不该走到这里（`initialize` 不会
    // advertise `sessionCapabilities.resume`），但客户端可以无视能力声明直接调。
    throw methodNotFound('session/resume requires a session-persistence backend')
  }
  validateRestore(params)

  // 与 `load` 不同，这里**不**预取事件日志：不回放就没有用处，而会话不存在时
  // `sessions.resume` 自己会失败——同样是在发布 agent 之前。代价是那句失败埋在
  // agent 工厂深处、且是个裸 `Error`，所以「不存在」要在这里另行分诊。
  const record = await restoreSession(bridge, params, 'session/resume').catch(
    async (error: unknown) =>
      await rethrowMissingSession(bridge, params.sessionId as SessionId, error),
  )

  // 命令目录仍要推：它是**当前**注册表的快照，与历史无关，而客户端刚建立这条
  // 会话的运行时视图，不给就只有一个空的命令面。会话 id 是客户端自己给的，
  // 不需要 `session/new` 那套延后。
  const commands = await commandsUpdate(bridge, record)
  if (commands !== undefined) await bridge.notifyAwaited(record.acpSessionId, [commands])

  // 沙箱模式与 plan 状态写在会话日志里，因此这里读到的是**恢复出来的**状态，
  // 而不是部署默认。
  const options = await optionsFor(bridge, record)
  const modes = modeStateFor(bridge.port.modes, record.handle.agent)
  return {
    ...(options.length > 0 ? { configOptions: options } : {}),
    ...(modes === undefined ? {} : { modes }),
  }
}
