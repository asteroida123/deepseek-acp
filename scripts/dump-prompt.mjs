#!/usr/bin/env node
/**
 * 打印一个会话实际拿到的 system prompt、动态上下文与工具集。
 *
 * 「模型好像不知道自己在哪」这类问题，靠读代码猜是最慢的路径——直接把组装结果
 * 打出来。走的是 port 的建会话路径（而非裸 `agents.create`），因此按会话注册的
 * 章节（工作区事实）也会出现；用后者会看不到，那正是这个脚本第一版踩的坑。
 *
 * 用法：node scripts/dump-prompt.mjs [cwd]
 * @module
 */

import process from 'node:process'
import { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { SessionId } from '@deepseek-ai/dsh-session'
import { boot } from '../lib/launcher/boot.js'
import { createInProcessPort } from '../lib/port/in-process.js'

const cwd = process.argv[2] ?? process.cwd()

const ctx = await boot({ ...process.env, DEEPSEEK_ACP_PROVIDER: 'dump', DEEPSEEK_ACP_MODEL: 'dump' })
const port = createInProcessPort(ctx)
const handle = await port.sessions.create({
  sessionId: SessionId('dump-prompt'),
  cwd,
  provider: 'dump',
  model: 'dump',
})

const assembly = await ctx.systemPrompt.assemble({ scope: handle.agent })

const show = (title, body) => {
  process.stdout.write(`\n\x1b[36m===== ${title} =====\x1b[0m\n`)
  process.stdout.write(`${body.length > 0 ? body : '\x1b[2m(空)\x1b[0m'}\n`)
}

show('SYSTEM PROMPT', renderPrompt(assembly))
show('动态上下文快照', renderContextSnapshot(assembly))
show('工具', assembly.tools.map((t) => t.name).join(', '))

await handle.dispose()
process.exit(0)
