/**
 * 最小 MCP stdio server —— 不依赖 `@modelcontextprotocol/sdk`。
 *
 * MCP over stdio 就是换行分隔的 JSON-RPC，自己写四十行比为一个测试夹具引入
 * 一整个 SDK 划算，也让握手的每一步都摆在明面上（出问题时不必去翻 SDK 源码）。
 *
 * 环境变量：
 *   MCP_TOOL_NAME  暴露的工具名，默认 `ping`；用于验证两会话挂不同 server 的隔离
 *   MCP_FAIL       置位则启动即退出，用于验证 `failOnStartupError`
 */

import process from 'node:process'
import { createInterface } from 'node:readline'

if (process.env.MCP_FAIL !== undefined) {
  process.stderr.write('mock-mcp: deliberate startup failure\n')
  process.exit(1)
}

const TOOL = process.env.MCP_TOOL_NAME ?? 'ping'

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

const reply = (id, result) => {
  send({ jsonrpc: '2.0', id, result })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim().length === 0) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  // 通知没有 id，也不该有应答。
  if (message.id === undefined) return

  switch (message.method) {
    case 'initialize':
      reply(message.id, {
        // 回声客户端请求的版本：夹具不参与版本协商，那不是它要验证的东西。
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '0.0.1' },
      })
      return
    case 'tools/list':
      reply(message.id, {
        tools: [
          {
            name: TOOL,
            description: `mock tool ${TOOL}`,
            inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
          },
        ],
      })
      return
    case 'tools/call':
      reply(message.id, {
        content: [{ type: 'text', text: `${TOOL}:${message.params?.arguments?.msg ?? ''}` }],
      })
      return
    default:
      // 未实现的方法要**回错误**而不是沉默：客户端等应答会一直挂着。
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `no method ${message.method}` } })
  }
})
