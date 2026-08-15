/**
 * `session/close` —— 关闭一个会话并释放它占的资源。
 *
 * 没有它，会话只在**断连**时才释放：`SessionTable` 唯一的移除路径是 `drain()`，
 * 而那只在 teardown 里调。编辑器里开十几个会话就是十几个活 agent 常驻，各自
 * 带着 MCP 子进程、会话日志缓冲与订阅——一条长命连接会一路堆下去。
 *
 * 语义按协议：先取消进行中的工作（等同于收到一次 `session/cancel`），再释放。
 * @module
 */

import type { CloseSessionRequest, CloseSessionResponse } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Bridge } from '../bridge.js'
import { invalidParams, internalError } from '../codec/errors.js'
import { settlePrompt } from '../session/table.js'

/**
 * @param bridge - 运行时
 * @param params - ACP 请求
 * @returns 空应答
 * @throws 未知会话 id（invalidParams），或释放失败（internalError）
 */
export async function handleCloseSession(
  bridge: Bridge,
  params: CloseSessionRequest,
): Promise<CloseSessionResponse> {
  bridge.assertOpen()
  // 与 `session/cancel` 不同，这里**不**静默放过未知 id：close 是有应答的请求，
  // 客户端据此认为资源已释放。悄悄成功会让「关了但没关掉」无从发现。
  const record = bridge.table.remove(SessionId(params.sessionId))
  if (record === undefined) throw invalidParams(`unknown session: ${params.sessionId}`)

  // 先摘表、再取消、最后 await 释放。顺序是有意的：摘表是同步的，所以从这一刻
  // 起新到的事件与新的 prompt 都不会再路由到它；而释放期间上游仍可能吐事件。
  bridge.port.driver.cancel(record.handle.agent)
  // 立刻结算在途 prompt。**这不是唯一出口**：`handlePrompt` 挂在 `whenIdle` 上的
  // 回调最终也会把它判成 `cancelled`（走「无相关联的回合结束」那一支）。区别在
  // 时机——那条要等整体静默，也就是要等释放跑完（MCP 子进程退出、日志刷盘）。
  // 那期间客户端的 `session/prompt` 是一个开着的 JSON-RPC 请求，没有理由陪着等。
  // 先结算还顺带把槽位清空，于是后到的 `whenIdle` 回调会看到槽位已换而直接返回，
  // 不会重复 resolve。
  settlePrompt(record, 'cancelled')

  try {
    await record.handle.dispose()
  } catch (error: unknown) {
    // 记录已经摘掉了，不放回去：一个释放失败的会话继续接受 prompt 更糟。
    const detail = error instanceof Error ? error.message : String(error)
    throw internalError(`session teardown failed: ${detail}`)
  }
  return {}
}
