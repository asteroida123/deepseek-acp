/**
 * `session/new` 与 `session/load` 共用的 `mcpServers` 处理。
 *
 * 单独一个文件是为了让两条路径**共用同一段翻译**：两处各写一遍，迟早会出现
 * 「新建支持 http、恢复不支持」这种只在恢复时才暴露的分叉。
 * @module
 */

import type { McpServer } from '@agentclientprotocol/sdk'
import { invalidParams } from '../codec/errors.js'
import { UnsupportedMcpServer, toMountSpecs, type McpMountSpec } from '../mcp/spec.js'

/**
 * 翻译请求里的 MCP server 声明。
 *
 * 不支持的传输映射为 `invalidParams` 而非内部错误：这是客户端可以改的东西
 * （换个传输、或不给这个 server），错误码要如实反映这一点。
 * @param servers - ACP 请求里的声明
 * @param sessionSeq - 连接内会话序号，用于前缀隔离
 * @returns 挂载配置；无 server 时为空数组
 */
export function mountSpecs(servers: readonly McpServer[], sessionSeq: number): McpMountSpec[] {
  try {
    return toMountSpecs(servers, sessionSeq)
  } catch (error) {
    if (error instanceof UnsupportedMcpServer) throw invalidParams(error.message)
    throw error
  }
}
