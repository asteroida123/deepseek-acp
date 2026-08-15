/**
 * `available_commands_update` —— 把命令注册表投影成 ACP 的命令目录（US-18）。
 *
 * ACP 这条更新是**全量快照**，不是增量：客户端收到就整体替换自己的缓存。因此
 * 每次都推完整列表，也因此不需要「哪些变了」这种差异计算。
 * @module
 */

import type { AvailableCommand, SessionUpdate } from '@agentclientprotocol/sdk'
import type { Bridge } from '../bridge.js'
import type { CommandInfo } from '../port/types.js'
import type { SessionRecord } from '../session/table.js'

/**
 * 命令元数据 → ACP 发现结构。
 * @param commands - 该会话可见的命令
 * @returns ACP 命令目录
 */
export function toAvailableCommands(commands: readonly CommandInfo[]): AvailableCommand[] {
  return commands.map((command) => ({
    // ACP 的 `name` 不含斜杠 —— 斜杠是客户端输入框的触发符，不是名字的一部分。
    name: command.name,
    description: command.description,
    ...(command.hint === undefined ? {} : { input: { hint: command.hint } }),
  }))
}

/**
 * 某会话当前的命令快照。
 * @param bridge - 运行时
 * @param record - 会话记录
 * @returns 快照更新；组合没挂命令面时 undefined
 */
export function commandsUpdate(bridge: Bridge, record: SessionRecord): SessionUpdate | undefined {
  const commands = bridge.port.commands
  if (commands === undefined) return undefined
  // 按**这个 agent** 解析而非取全局视图：命令可以注册在 agent 作用域上遮蔽同名
  // 全局命令，用错 scope 不会报错，只会给出一份别人的目录。
  return {
    sessionUpdate: 'available_commands_update',
    availableCommands: toAvailableCommands(commands.list(record.handle.agent)),
  }
}

/**
 * 注册表变更后刷新**全部**在册会话。
 *
 * 变更可能是全局的，也可能只影响某一个 agent 的遮蔽层，从这条事件上分辨不出来
 * ——它连参数都没有。逐个会话各自重新解析是唯一正确的做法，代价也只是一次
 * 列表投影。
 * @param bridge - 运行时
 */
export function refreshCommands(bridge: Bridge): void {
  for (const record of bridge.table.values()) {
    const update = commandsUpdate(bridge, record)
    if (update !== undefined) bridge.notify(record.acpSessionId, update)
  }
}
