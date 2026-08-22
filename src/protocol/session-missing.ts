/**
 * 「这条会话不存在」与「agent 坏了」的分诊。
 *
 * `session/load` / `session/resume` / `session/fork` 三者恢复失败的原因五花八门
 * ——日志损坏、版本不认识、盘满、权限——而其中最常见的那个（会话根本不在了）
 * 是唯一一个**客户端能自己处理**的：把陈旧 id 从会话列表里摘掉就是了。上游把
 * 它们一并抛成裸 `Error`，落到线上全是 `-32603 Internal error`，于是编辑器只
 * 能对着一条自己删掉的会话弹故障框。
 *
 * 分诊放在**失败之后**而不是操作之前：恢复本来就要建 agent、挂 MCP、读整份
 * 日志，在前面再加一次目录扫描是给每一次成功的恢复付钱，买的却只是同一个答案
 * ——而且成功路径上还是有 TOCTOU 窗口，挡不住什么。
 * @module
 */

import { RequestError } from '@agentclientprotocol/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Bridge } from '../bridge.js'
import { resourceNotFound } from '../codec/errors.js'
import type { SessionPresence } from '../port/types.js'

/**
 * 把一次恢复失败翻成合适的协议错误。
 *
 * 只有确认「这个 id 没有落盘日志」时才改判，其余一律把原错误原样抛回去——
 * 一次真正的内部故障报成 `-32002`，客户端会安静地把会话摘掉，用户则会以为
 * 自己的历史被删了。宁可继续报 `-32603`。
 * @param bridge - 运行时
 * @param sessionId - 请求指名的会话（fork 时是**父**会话）
 * @param error - 恢复过程中抛出的原始错误
 * @returns 从不正常返回：必定抛出
 */
export async function rethrowMissingSession(
  bridge: Bridge,
  sessionId: SessionId,
  error: unknown,
): Promise<never> {
  // 已经是协议错误说明是本层自己造的（cwd 不符、连接已关…），码早就选好了。
  // 顺带省掉那次探测。
  if (error instanceof RequestError) throw error
  // 开着的会话当然存在，磁盘上有没有它都一样。少了这一句，`session/fork` 的
  // 子会话装配失败（比如 MCP server 起不来）会被报成「**父**会话没了」，客户端
  // 据此把一条正开着的会话从列表里摘掉——而父会话很可能确实不在盘上：写入是按
  // 窗口批量合并的，刚聊完的那几条还在缓冲里；一个事件都还没有的会话则根本没有
  // 物件（上游惰性物化）。
  if (bridge.port.sessions.hasLive(sessionId)) throw error
  const catalog = bridge.port.catalog
  // 没挂持久化就无从查证。这条路径上「不存在」也不可能是这里发现的——协议层
  // 更早就拦住了。
  if (catalog === undefined) throw error
  // 只有**确认**不存在才改判。查不出来（`unknown`）与探测自己抛错，要的都是
  // 保持原样：拿我们这边的故障去指认用户的数据没了，比多报一个内部错误坏得多。
  const presence = await catalog.presence(sessionId).catch((): SessionPresence => 'unknown')
  if (presence !== 'absent') throw error
  throw resourceNotFound(sessionId)
}
