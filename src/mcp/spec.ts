/**
 * ACP `McpServer` → `dsh-mcp-client` 挂载配置（US-20）。
 *
 * 两侧的传输词表不重合，这里是那道翻译层，也是**显式拒绝**不支持传输的地方。
 * @module
 */

import type { McpServer } from '@agentclientprotocol/sdk'
import { publicServerName } from './naming.js'

/** 一个待挂载的 MCP server，已翻译成上游插件的配置形状。 */
export type McpMountSpec =
  | {
      readonly transport: 'stdio'
      readonly serverName: string
      readonly command: string
      readonly args: string[]
      readonly env: Record<string, string>
      readonly failOnStartupError: true
    }
  | {
      readonly transport: 'streamable-http'
      readonly serverName: string
      readonly url: string
      readonly headers: Record<string, string>
      readonly failOnStartupError: true
    }

/** 翻译失败：客户端送来了本部署无法承载的 server。 */
export class UnsupportedMcpServer extends Error {}

/** `[{name, value}]` → `{name: value}`。 */
function toRecord(pairs: readonly { name: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of pairs) out[pair.name] = pair.value
  return out
}

/**
 * 翻译一个 ACP MCP server 声明。
 *
 * `failOnStartupError` 恒为 true：MCP server 起不来时，客户端配了工具而模型看不见
 * 它们，表现是「模型莫名其妙不会用 github」——比 `session/new` 直接失败难查得多。
 * @param server - ACP 侧声明
 * @param sessionSeq - 连接内会话序号，用于前缀隔离
 * @returns 上游插件配置
 * @throws {UnsupportedMcpServer} 传输方式不受支持时
 */
export function toMountSpec(server: McpServer, sessionSeq: number): McpMountSpec {
  const serverName = publicServerName(sessionSeq, server.name)

  // stdio 是无 `type` 标签的那个变体（ACP 把它当基线）。
  if (!('type' in server)) {
    return {
      transport: 'stdio',
      serverName,
      command: server.command,
      args: [...server.args],
      env: toRecord(server.env),
      failOnStartupError: true,
    }
  }

  if (server.type === 'http') {
    return {
      transport: 'streamable-http',
      serverName,
      url: server.url,
      headers: toRecord(server.headers),
      failOnStartupError: true,
    }
  }

  // `sse`：上游 `dsh-mcp-client` 只有 stdio 与 streamable-http 两种传输。SSE 是
  // MCP 的旧式传输，规范已标为 deprecated，上游不实现是合理的。
  //
  // `acp`：MCP 报文经 ACP 连接本身代理（客户端替 agent 跑那个 server）。它需要
  // 一个把 `mcp/message` 往返桥接到 mcp-client 的自研传输，不是配置能解决的。
  //
  // 两者都**显式拒绝**而非静默跳过：客户端送来 server 就是指望这些工具可用，
  // 假装接受只会让模型看不见它们，而故障现场离原因很远。
  throw new UnsupportedMcpServer(
    `MCP transport "${server.type}" is not supported (server "${server.name}"); ` +
      `this agent supports stdio and http`,
  )
}

/**
 * 批量翻译。
 * @param servers - ACP 侧声明
 * @param sessionSeq - 连接内会话序号
 * @returns 上游插件配置数组
 * @throws {UnsupportedMcpServer} 任一不受支持即整体失败
 */
export function toMountSpecs(servers: readonly McpServer[], sessionSeq: number): McpMountSpec[] {
  return servers.map((server) => toMountSpec(server, sessionSeq))
}
