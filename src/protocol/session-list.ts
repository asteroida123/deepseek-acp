/**
 * `session/list` —— 列出可恢复的会话（US-15）。
 * @module
 */

import { isAbsolute } from 'node:path'
import type { ListSessionsRequest, ListSessionsResponse, SessionInfo } from '@agentclientprotocol/sdk'
import type { Bridge } from '../bridge.js'
import { invalidParams, methodNotFound } from '../codec/errors.js'
import type { SessionSummary } from '../port/types.js'

/**
 * 摘要 → ACP `SessionInfo`。
 *
 * **没有 cwd 的会话直接丢弃**：`SessionInfo.cwd` 是必填的绝对路径，编不出来。
 * 拿 `process.cwd()` 顶上会把一条无处安放的历史标成属于当前项目，客户端据此
 * 恢复就是错的工作区。
 *
 * 排序键是**最后活动时间**（缺失时退回创建时间）：会话选择器是按「最近在做
 * 什么」翻的，按创建时间排会把今天一直在聊的老会话压到末尾。
 * @param summaries - 持久化摘要
 * @param cwd - 可选的工作区过滤
 * @returns 按最后活动时间倒序的会话信息
 */
export function toSessionInfos(
  summaries: readonly SessionSummary[],
  cwd?: string | null,
): SessionInfo[] {
  const activity = (s: SessionSummary): number => s.updatedAt ?? s.createdAt
  return summaries
    .filter((s): s is SessionSummary & { cwd: string } => s.cwd !== undefined)
    .filter((s) => cwd === undefined || cwd === null || s.cwd === cwd)
    .sort((a, b) => activity(b) - activity(a))
    .map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      // 缺字段客户端会退回显示 id —— 比显示一个编出来的标题好。
      ...(s.title === undefined ? {} : { title: s.title }),
      ...(s.updatedAt === undefined ? {} : { updatedAt: new Date(s.updatedAt).toISOString() }),
    }))
}

/**
 * @param bridge - 运行时
 * @param params - ACP 请求
 * @returns 全部可恢复会话，最新在前
 */
export async function handleListSessions(
  bridge: Bridge,
  params: ListSessionsRequest,
): Promise<ListSessionsResponse> {
  bridge.assertOpen()
  const catalog = bridge.port.catalog
  if (catalog === undefined) {
    throw methodNotFound('session/list requires a session-persistence backend')
  }
  if (params.cwd !== undefined && params.cwd !== null && !isAbsolute(params.cwd)) {
    throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  }
  // 不分页：返回的是元数据（id + 路径），一次给全比让客户端管游标简单得多。
  // 若日后真要截断，必须同时实现 `nextCursor`——静默截断会让客户端以为
  // 「就这么多会话」，而那正是列表这个功能唯一要回答的问题。
  if (params.cursor !== undefined && params.cursor !== null) {
    throw invalidParams('pagination is not supported: session/list returns every session at once')
  }
  return { sessions: toSessionInfos(await catalog.list(), params.cwd) }
}
