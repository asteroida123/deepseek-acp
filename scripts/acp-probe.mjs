#!/usr/bin/env node
/**
 * 最小 ACP 客户端 —— 不依赖任何编辑器，直接把 `lib/bin.js` 当子进程驱动一遍。
 *
 * 存在的理由：codeg / Zed 里跑挂了，你看到的只是一句「连接失败」；这里能看到
 * 完整的 stdout 帧与 stderr。接入编辑器之前先用它确认协议本身是通的。
 *
 * 用法：
 *   node scripts/acp-probe.mjs "你的问题"
 *   ACP_PROBE_RAW=1 node scripts/acp-probe.mjs "..."        # 逐帧打印原始 JSON
 *   ACP_PROBE_NO_ELICIT=1 node scripts/acp-probe.mjs "..."  # 不声明表单能力，走降级通道
 *   ACP_PROBE_FS_READ=1 node scripts/acp-probe.mjs "..."    # 声明 fs.readTextFile，走读改道
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const BIN = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const RAW = process.env['ACP_PROBE_RAW'] === '1'
// 装成一个没有表单征询的客户端（codeg 就是这样）：提问与计划评审会降级到
// `session/request_permission`，这个开关就是本地跑通那条路径的唯一办法。
const NO_ELICIT = process.env['ACP_PROBE_NO_ELICIT'] === '1'
// 装成一个实现了 `fs/read_text_file` 的客户端（codeg 就是这样）：文件读会改道
// 过来，本探针在内容前面加一行 `BUFFER_MARK` 冒充未保存的缓冲区。模型读出来的
// 东西里有这行，就说明 US-25 那条链是通的。
const FS_READ = process.env['ACP_PROBE_FS_READ'] === '1'
const BUFFER_MARK = '// [探针注入] 这一行只在编辑器缓冲区里，磁盘上没有'
const PROMPT = process.argv[2] ?? '用一句话介绍你自己。'

const child = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })

let nextId = 0
const pending = new Map()

// 子进程可能在启动期就死掉（凭据文件权限、组合装配失败…）。不把它变成
// 显式失败，等待中的请求就只会挂到进程退出，报个 unsettled top-level await
// ——那正是编辑器里「连接失败」四个字背后什么都看不见的原因。
child.on('exit', (code, signal) => {
  const why = new Error(`agent 进程提前退出（code=${code} signal=${signal}）——看上面的 stderr`)
  for (const [id, slot] of pending) {
    pending.delete(id)
    slot.reject(why)
  }
})

/** 发一个请求，等它的应答。 */
function call(method, params) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

/** 一行提示信息，与助手正文区分开。 */
function note(text) {
  process.stdout.write(`\n\x1b[36m[${text}]\x1b[0m\n`)
}

/** 把 session/update 渲染成人眼可读的一行；未知类型原样打出来，避免静默吞掉。 */
function render(update) {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      process.stdout.write(update.content?.text ?? '')
      return
    case 'agent_thought_chunk':
      process.stdout.write(`\x1b[2m${update.content?.text ?? ''}\x1b[0m`)
      return
    case 'available_commands_update':
      note(`命令目录：${update.availableCommands.map((c) => `/${c.name}`).join(' ') || '（空）'}`)
      return
    case 'current_mode_update':
      note(`模式 → ${update.currentModeId}`)
      return
    case 'session_info_update':
      note(`标题 → ${update.title ?? '（清空）'}`)
      return
    case 'usage_update':
      note(`上下文 ${update.used} / ${update.size}（${((update.used / update.size) * 100).toFixed(1)}%）`)
      return
    case 'tool_call':
      note(`工具 ${update.title ?? update.toolCallId}`)
      return
    case 'tool_call_update':
      return
    default:
      process.stdout.write(`\n\x1b[33m[未映射的 update: ${update.sessionUpdate}]\x1b[0m\n`)
  }
}

/**
 * 自动作答一次表单征询：每个字段取第一个候选。
 *
 * 探针没有交互界面，但**不能不答**——`ask_user_question` 与 `exit_plan_mode`
 * 都会一直等下去，表现成「跑一半卡住」而看不出原因。
 */
function autoAnswer(params) {
  const content = {}
  for (const [key, property] of Object.entries(params.requestedSchema?.properties ?? {})) {
    if (property.type === 'array') {
      const first = property.items?.anyOf?.[0]?.const ?? property.items?.enum?.[0]
      content[key] = first === undefined ? [] : [first]
    } else {
      content[key] = property.oneOf?.[0]?.const ?? '（探针自动作答）'
    }
  }
  note(`表单征询「${params.message}」→ 自动选 ${JSON.stringify(content)}`)
  return { action: 'accept', content }
}

let buffer = ''
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  let nl
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (line.length === 0) continue
    if (RAW) process.stderr.write(`\x1b[36m< ${line}\x1b[0m\n`)

    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      // stdout 出现非 JSON 行 = AC-G1 被破坏，比任何功能缺陷都严重。
      process.stderr.write(`\x1b[31m[stdout 污染] ${line}\x1b[0m\n`)
      continue
    }

    if (frame.id !== undefined && pending.has(frame.id)) {
      const slot = pending.get(frame.id)
      pending.delete(frame.id)
      if (frame.error) slot.reject(new Error(`${frame.error.message}: ${JSON.stringify(frame.error.data ?? {})}`))
      else slot.resolve(frame.result)
    } else if (frame.method === 'session/update') {
      render(frame.params.update)
    } else if (frame.method === 'elicitation/create') {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: autoAnswer(frame.params) })}\n`)
    } else if (frame.method === 'fs/read_text_file') {
      // 扮演一个「手里有未保存缓冲区」的编辑器：在磁盘内容前面加一行标记。
      // 模型读出来的东西里有这行，就说明委托整条链是通的。
      note(`文本读委托 ${frame.params.path}`)
      let result
      try {
        const onDisk = readFileSync(frame.params.path, 'utf8')
        result = { content: `${BUFFER_MARK}\n${onDisk}` }
      } catch {
        // 读不到就报错回去，正好顺带验证 agent 侧的回落：它应当安静地改走磁盘。
        result = undefined
      }
      child.stdin.write(
        `${JSON.stringify(
          result === undefined
            ? { jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: 'no buffer for this file' } }
            : { jsonrpc: '2.0', id: frame.id, result },
        )}\n`,
      )
    } else if (frame.method === 'session/request_permission') {
      // **取第一个选项，不硬编码 optionId**：工具授权用的是 `allow-once`，而
      // 降级过来的提问用的是 `opt-N`；写死一个的话，另一条路径会收到一个未知
      // 选项，表现成「探针答了但 agent 说没答」。
      const options = frame.params.options ?? []
      const first = options[0]?.optionId
      note(
        `授权请求 ${frame.params.toolCall?.title ?? frame.params.toolCall?.toolCallId}`
        + `：${options.map((o) => o.name).join(' | ') || '（无选项）'} → 选 ${first ?? '（无从选择）'}`,
      )
      child.stdin.write(
        `${JSON.stringify(
          first === undefined
            ? { jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'cancelled' } } }
            : { jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'selected', optionId: first } } },
        )}\n`,
      )
    } else if (frame.id !== undefined) {
      // 其余反向请求（`fs/write_text_file`、终端…）本探针不声明也不实现；
      // 出现即说明 agent 侧的能力判定与声明脱节了。
      process.stderr.write(`\x1b[33m[未处理的 agent→client 请求: ${frame.method}]\x1b[0m\n`)
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'probe does not implement this' } })}\n`,
      )
    }
  }
})

try {
  const init = await call('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      // 写**始终**不声明：委托写会绕开 `dsh-fs-sandbox` 的围栏（见 US-25）。
      fs: { readTextFile: FS_READ, writeTextFile: false },
      // 默认声明支持表单征询：这是 `ask_user_question` 与 `exit_plan_mode` 的
      // 首选路径。`ACP_PROBE_NO_ELICIT=1` 去掉它，就能在本地复现 codeg 的能力
      // 面并跑通授权通道那条降级。
      ...(NO_ELICIT ? {} : { elicitation: { form: {} } }),
    },
  })
  process.stderr.write(`  表单征询: ${NO_ELICIT ? '不声明（走降级通道）' : '已声明'}\n`)
  process.stderr.write(`  文本读委托: ${FS_READ ? '已声明（读改道到探针）' : '不声明（全走磁盘）'}\n`)
  process.stderr.write(`\x1b[32m✓ initialize\x1b[0m ${JSON.stringify(init.agentInfo ?? {})}\n`)

  const created = await call('session/new', { cwd: process.cwd(), mcpServers: [] })
  const { sessionId } = created
  process.stderr.write(`\x1b[32m✓ session/new\x1b[0m ${sessionId}\n`)
  process.stderr.write(`  模式: ${created.modes?.currentModeId ?? '（未声明）'}\n`)
  process.stderr.write(
    `  配置项: ${(created.configOptions ?? []).map((o) => `${o.id}=${o.currentValue}`).join('  ') || '（无）'}\n\n`,
  )

  const started = Date.now()
  const res = await call('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: PROMPT }],
  })
  process.stderr.write(`\n\n\x1b[32m✓ session/prompt\x1b[0m stopReason=${res.stopReason} (${Date.now() - started}ms)\n`)
  process.exitCode = 0
} catch (error) {
  process.stderr.write(`\n\x1b[31m✗ ${String(error)}\x1b[0m\n`)
  process.exitCode = 1
} finally {
  child.stdin.end()
  child.kill()
}
