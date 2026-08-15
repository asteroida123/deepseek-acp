/**
 * TC-COMP-* —— 内置组合的断言。
 *
 * 断的是 `composeAgent`（不是 `boot`）：后者会把 bridge 接到真的 stdio 上，
 * 进程内测试碰它就等于抢走 `process.stdin`。
 *
 * 这一批与 harness 里那套是互补的：harness 挂 `bash-local`，让终端卡片的用例
 * 不背平台依赖；**部署真正用的是 `bash-sandbox`**，那个差别只有这里能抓到。
 * 沙箱后端不可用的平台上这些用例会失败——那是对的，组合在那种平台上本来就
 * 起不来，静默降级成无约束执行才是坏结果。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { EXIT_PLAN_MODE } from '@deepseek-ai/dsh-plan-mode'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { PLAN_SECTION, composeAgent } from '../src/launcher/boot.js'
import { createInProcessPort } from '../src/port/in-process.js'
import { waitFor } from './harness.js'

/**
 * 全文件共用一个组合。
 *
 * 装一次要做沙箱平台探测，逐用例重装是纯粹的浪费；而这些用例只读不写，
 * 共用没有串扰风险。Cordis 4 的根 context 没有对外的整体 teardown，进程随
 * vitest 一起结束即可。
 */
let shared: Promise<Context> | undefined
function composed(): Promise<Context> {
  shared ??= (async () => {
    const ctx = new Context()
    // 会话根用临时目录：别把用例跑出来的日志写进用户的 ~/.dsh。
    await composeAgent(ctx, { sessionsRoot: mkdtempSync(join(tmpdir(), 'dsacp-comp-')) })
    await waitFor(() => ctx.tools?.get('bash') !== undefined, 10_000, 'composed tools')
    return ctx
  })()
  return shared
}

/**
 * 一个会话作用域的视角。
 *
 * **文件工具只在会话作用域可见**（US-25）：`dsh-tool-fs` 由 port 装在
 * `agentCtx` 上，因为它捕获自己的挂载 context，只有这样会话级的 `fs` 替换才
 * 生效。全局视角（`ctx.tools.get(name)`）看不到它们——这不是缺陷，而是这些
 * 工具的作用域事实，所以断言也得换到模型实际所处的那个视角。
 */
let sharedScope: Promise<{ ctx: Context; agent: Agent }> | undefined
function scoped(): Promise<{ ctx: Context; agent: Agent }> {
  sharedScope ??= (async () => {
    const ctx = await composed()
    const handle = await createInProcessPort(ctx).sessions.create({
      sessionId: SessionId('tc-comp-fs'),
      cwd: mkdtempSync(join(tmpdir(), 'dsacp-comp-cwd-')),
      // **带上委托**，这样 `DelegatedReadFileSystem` 真的在链路里，下面那条
      // 提权参数断言才顺带覆盖了它对 `sandboxMode` 的转发。恒返回 undefined
      // 表示「客户端给不出，走磁盘」，读写行为与不带委托时一致。
      readDelegate: async () => undefined,
    })
    return { ctx, agent: handle.agent }
  })()
  return sharedScope
}

describe('TC-COMP-01 工具集', () => {
  it('全局作用域挂上了 M1-b 承诺的工具', async () => {
    const ctx = await composed()
    for (const name of ['bash', 'glob', 'grep', 'todo_write']) {
      expect(ctx.tools.get(name), `缺少工具 ${name}`).toBeDefined()
    }
  }, 30_000)

  it('文件工具在会话作用域里 —— 模型看得到，全局视角看不到', async () => {
    const { ctx, agent } = await scoped()
    for (const name of ['read', 'write', 'edit']) {
      expect(ctx.tools.get(name, agent), `会话作用域缺少工具 ${name}`).toBeDefined()
      // 反面同样要钉住：若哪天它们又被装回根上，会话级 fs 替换会静默失效
      // ——工具照跑、读照成功，只是永远读的是磁盘。
      expect(ctx.tools.get(name), `${name} 不该出现在全局作用域`).toBeUndefined()
    }
  }, 30_000)

  it('M1-c 的两个交互工具也在：提问与退出计划模式', async () => {
    const ctx = await composed()
    for (const name of ['ask_user_question', 'exit_plan_mode']) {
      expect(ctx.tools.get(name), `缺少工具 ${name}`).toBeDefined()
    }
  }, 30_000)
})

describe('TC-COMP-04 M1-c 的服务都在', () => {
  it('命令面、plan mode、提问 seam、标题服务均已挂载', async () => {
    const ctx = await composed()
    // bridge 是按 `ctx.get(...)` 决定要不要 advertise 对应能力的：这里少一个，
    // 表现就是编辑器里那个控件整个消失，而 agent 侧一切「正常」。
    for (const service of ['commands', 'planMode', 'userQuestions', 'sessionTitle']) {
      expect(ctx.get(service as never), `缺少服务 ${service}`).toBeDefined()
    }
  }, 30_000)

  it('plan 引导段告诉模型方案要以 # 标题开头 —— 上游会照这条硬校验', () => {
    // `exit_plan_mode` 用 `/^#\s+\S/` 校验方案文本，不满足直接拒绝这次退出。
    // 提示里不写，模型只能撞几次墙才知道；这两处是同一条规则的两半。
    expect(PLAN_SECTION).toContain('# ')
    expect(EXIT_PLAN_MODE).toBe('exit_plan_mode')
    expect(/^#\s+\S/.test('# 方案\n\n先改 A。')).toBe(true)
  })
})

describe('TC-COMP-05 文件工具在沙箱之下', () => {
  it('ctx.fs 报告 workspace-write —— 缺了它，write/edit 全程无约束', async () => {
    const ctx = await composed()
    // `dsh-tool-fs` 是**拿这个值**决定要不要执行策略的：`undefined` 意味着
    // 「后端不做约束」，于是它连 `sandboxPolicy` 都不去取，每次写都是无围栏的
    // `writeText`。`dsh-fs-local` 正好报 undefined —— 曾经挂的就是它，实测下
    // 一次越界写会直接打到内核，只有操作系统的文件权限拦得住。
    expect(ctx.fs.sandboxMode).toBe('workspace-write')
  }, 30_000)

  it('write / edit 都 advertise 了提权参数 —— 与 bash 同一条边界', async () => {
    const { ctx, agent } = await scoped()
    // 这两个字段是「本工具受约束」的可观测证据：`tool-fs` 只在后端确实约束时
    // 才生成它们。少了它们，模型连「这次越界，请授权」都表达不了。
    //
    // 会话作用域取值同时钉住了另一件事：会话里那份 `ctx.fs`（US-25 之后可能
    // 是读改道的装饰器）必须仍然报告 `sandboxMode`。装饰器忘了转发这个 getter
    // 的话，围栏会**静默**整个失效，而这两个字段正好会跟着消失。
    for (const name of ['write', 'edit']) {
      const params = ctx.tools.get(name, agent)?.parameters as { properties?: Record<string, unknown> }
      expect(Object.keys(params.properties ?? {}), `${name} 缺提权参数`).toContain('sandbox_permissions')
    }
  }, 30_000)

  it('read 不带提权参数 —— 任何模式都允许读，给了反而是噪声', async () => {
    const { ctx, agent } = await scoped()
    const params = ctx.tools.get('read', agent)?.parameters as { properties?: Record<string, unknown> }
    expect(Object.keys(params.properties ?? {})).not.toContain('sandbox_permissions')
  }, 30_000)
})

describe('TC-COMP-02 shell 在沙箱之下', () => {
  it('executor 报告 workspace-write —— 与文件工具同一条边界', async () => {
    const ctx = await composed()
    // `sandboxMode` 是「这个 executor 会约束执行」的能力事实：`bash-local`
    // 报 undefined，`bash-sandbox` 报配置的默认模式。工具层也靠它决定要不要
    // 给模型 `sandbox_permissions` 这个提权参数。
    expect(ctx.shell.sandboxMode).toBe('workspace-write')
  }, 30_000)

  it('提权参数已 advertise，模型可以就越界命令发起授权', async () => {
    const ctx = await composed()
    const params = ctx.tools.get('bash')?.parameters as { properties?: Record<string, unknown> }
    expect(Object.keys(params.properties ?? {})).toContain('sandbox_permissions')
  }, 30_000)
})

describe('TC-COMP-03 后台任务关闭', () => {
  it('bash schema 里没有 run_in_background —— ACP 下自发回合无处归属', async () => {
    const ctx = await composed()
    const params = ctx.tools.get('bash')?.parameters as { properties?: Record<string, unknown> }
    // 关掉不只是「不用」：留着 schema 而在执行时拒绝，模型会反复尝试并把
    // 失败当成自己参数写错。
    expect(Object.keys(params.properties ?? {})).not.toContain('run_in_background')
  }, 30_000)
})
