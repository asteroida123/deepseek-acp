/**
 * MCP `serverName` 的会话前缀隔离（详设 §一 C4 定稿）。
 *
 * **为什么需要前缀**：`dsh-mcp-client` 的 `serverName` 是**进程内全局唯一**的，
 * 而 ACP 的 `mcpServers` 是**每会话**参数。两个会话配同名 server 时后一个
 * `session/new` 直接失败（`serverName "github" is already in use by another
 * mcp-client instance`）。用户开两个编辑器会话、用同一份 MCP 配置是常态，不是
 * 边缘情况。
 * @module
 */

import { createHash } from 'node:crypto'

/** 上游对 `serverName` 的硬校验：`[A-Za-z0-9_-]{1,32}`，33 字符即拒绝。 */
export const SERVER_NAME_MAX = 32

/** 上游允许的字符类。 */
const SAFE_CHAR = /[A-Za-z0-9_-]/

/** 区分同一前缀下不同原名的哈希长度。 */
const HASH_LEN = 4

/**
 * 原名的确定性短哈希。
 * @param userServerName - 客户端给的原始 server 名
 * @returns 4 位十六进制
 */
function shortHash(userServerName: string): string {
  return createHash('sha256').update(userServerName).digest('hex').slice(0, HASH_LEN)
}

/**
 * 把任意字符规整到上游允许的字符类。
 * @param userServerName - 原始名
 * @returns 只含 `[A-Za-z0-9_-]` 的字符串（可能为空）
 */
function normalize(userServerName: string): string {
  return [...userServerName].map((c) => (SAFE_CHAR.test(c) ? c : '_')).join('')
}

/**
 * 计算某会话内某 MCP server 的公开名。
 *
 * 前缀用**连接内单调序号**而非 SessionId：后者是 UUID，36 个字符会直接吃满
 * 32 的预算。会话生命周期内前缀恒定，因此该会话的请求前缀稳定，不影响 KV cache。
 *
 * 附加哈希的条件比详设 §一写的多一条。原文只在**超长**时附哈希，但 ACP 的
 * `McpServer.name` 没有字符集约束，而上游只收 `[A-Za-z0-9_-]`——直接规整会让
 * `a.b` 与 `a b` 双双变成 `a_b`，于是同一会话内第二个 server 挂载失败，正是
 * C4 要解决的那个冲突换了个地方重现。所以**规整改动过内容时同样附哈希**。
 * 已经合法且不超长的名字行为不变，仍是干净的 `a1_github`。
 * @param sessionSeq - 连接内单调递增的会话序号
 * @param userServerName - 客户端给的原始 server 名
 * @returns 合法且会话内唯一的公开名
 */
export function publicServerName(sessionSeq: number, userServerName: string): string {
  const prefix = `a${sessionSeq}_`
  const normalized = normalize(userServerName)
  const exact = normalized === userServerName

  if (exact && prefix.length + normalized.length <= SERVER_NAME_MAX) {
    return prefix + normalized
  }

  // `_` + 4 位哈希占 5 个字符。budget 可能算成负数（前缀本身就很长，例如
  // 第 100000 个会话）——此时截成空串，前缀加哈希仍是合法名。
  const budget = SERVER_NAME_MAX - prefix.length - (HASH_LEN + 1)
  const head = budget > 0 ? normalized.slice(0, budget) : ''
  return `${prefix}${head}_${shortHash(userServerName)}`
}

/**
 * 模型最终看到的工具名前缀，供诊断与文档使用。
 * @param publicName - {@link publicServerName} 的结果
 * @returns 例 `mcp__a1_github__`
 */
export function toolNamePrefix(publicName: string): string {
  return `mcp__${publicName}__`
}
