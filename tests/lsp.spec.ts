/**
 * TC-LSP-* —— 语言服务器的发现与组合。
 *
 * 发现这一段值得单独测，因为它拦的是一个**会让整个 agent 起不来**的失败：上游
 * `lsp-stdio` 在插件加载时解析每一项的可执行文件，任何一项找不到，所有 provider
 * 都注册不上（README 原话是「a bad later entry prevents every provider from
 * registering」）。用户机器上少装一个 gopls 就连不上编辑器，这是不能接受的。
 *
 * 所以下面这些用例**不依赖本机装了什么**：PATH 是造出来的，可执行文件是写出来的。
 * 唯一一条真跑语言服务器的用例在最后，本机没有 `typescript-language-server` 时
 * 自动跳过——它证明的是「这条链真的通」，而不是发现逻辑对不对。
 */

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { LSP_SERVERS_ENV, discoverLspServers } from '../src/composition/lsp.js'
import { composeAgent } from '../src/launcher/boot.js'
import { createInProcessPort } from '../src/port/in-process.js'
import { waitFor } from './harness.js'

/** 造一个只含指定命令的 PATH 目录，返回目录路径。 */
function fakeBinDir(commands: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsacp-bin-'))
  for (const command of commands) {
    const file = join(dir, command)
    writeFileSync(file, '#!/bin/sh\nexit 0\n')
    chmodSync(file, 0o755)
  }
  return dir
}

/** 本机是否装了 typescript-language-server —— 端到端那条用例的前提。 */
async function hasRealTypescriptServer(): Promise<boolean> {
  return (await discoverLspServers(process.env))?.['typescript'] !== undefined
}

describe('TC-LSP-01 按 PATH 筛候选', () => {
  it('只留下这台机器上真的存在的那几项', async () => {
    // 只放 gopls：内置候选表里另外三项都该被筛掉，而不是原样交给上游。
    const servers = await discoverLspServers({ PATH: fakeBinDir(['gopls']) })
    expect(Object.keys(servers ?? {})).toEqual(['go'])
  })

  it('一个都找不到时返回 undefined —— 整套插件不该挂', async () => {
    // 这是绝大多数机器的状态。返回一张空表会让上游以「servers 至少要有一项」
    // 拒绝加载，那正是我们要避开的启动失败。
    expect(await discoverLspServers({ PATH: fakeBinDir([]) })).toBeUndefined()
    expect(await discoverLspServers({})).toBeUndefined()
  })

  it('交出去的是绝对路径，不是命令名', async () => {
    // 让上游再解析一次 PATH 等于把「我们筛过了」交还给运气：子进程的 PATH 与
    // 这里读到的可以不一样。
    const dir = fakeBinDir(['rust-analyzer'])
    const servers = await discoverLspServers({ PATH: dir })
    const command = servers?.['rust']?.command ?? ''
    expect(isAbsolute(command)).toBe(true)
    expect(command).toBe(join(dir, 'rust-analyzer'))
  })

  it('PATH 上有多个目录时按顺序取第一个命中的', async () => {
    const first = fakeBinDir(['gopls'])
    const second = fakeBinDir(['gopls'])
    const servers = await discoverLspServers({ PATH: [first, second].join(delimiter) })
    expect(servers?.['go']?.command).toBe(join(first, 'gopls'))
  })

  it('存在但不可执行的文件不算数', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsacp-bin-'))
    writeFileSync(join(dir, 'gopls'), 'not executable')
    chmodSync(join(dir, 'gopls'), 0o644)
    expect(await discoverLspServers({ PATH: dir })).toBeUndefined()
  })
})

describe('TC-LSP-02 显式配置', () => {
  it('设了环境变量就整表替换 —— 合并语义下无法表达「不要内置的那条」', async () => {
    const dir = fakeBinDir(['my-server', 'gopls'])
    const servers = await discoverLspServers({
      PATH: dir,
      [LSP_SERVERS_ENV]: JSON.stringify({
        mine: { command: 'my-server', args: ['--stdio'], extensionToLanguage: { '.q': 'q' } },
      }),
    })
    // gopls 明明在 PATH 上，但显式配置里没有它 —— 于是它不该出现。
    expect(Object.keys(servers ?? {})).toEqual(['mine'])
    expect(servers?.['mine']?.args).toEqual(['--stdio'])
  })

  it('显式配置里找不到的命令被跳过，并说出原因', async () => {
    const warnings: string[] = []
    const servers = await discoverLspServers(
      {
        PATH: fakeBinDir(['present']),
        [LSP_SERVERS_ENV]: JSON.stringify({
          ok: { command: 'present', extensionToLanguage: { '.a': 'a' } },
          missing: { command: 'nowhere-to-be-found', extensionToLanguage: { '.b': 'b' } },
        }),
      },
      (message) => warnings.push(message),
    )
    // 跳过而不是让启动失败；但**要出声**——用户明确配了它。
    expect(Object.keys(servers ?? {})).toEqual(['ok'])
    expect(warnings.join('\n')).toContain('nowhere-to-be-found')
  })

  it('内置候选找不到时不出声 —— 那是常态，报出来只会变成噪声', async () => {
    const warnings: string[] = []
    await discoverLspServers({ PATH: fakeBinDir(['gopls']) }, (message) => warnings.push(message))
    expect(warnings).toEqual([])
  })

  it('环境变量不是合法 JSON 时回落到内置表，并说出原因', async () => {
    const warnings: string[] = []
    const servers = await discoverLspServers(
      { PATH: fakeBinDir(['gopls']), [LSP_SERVERS_ENV]: '{ 这不是 JSON' },
      (message) => warnings.push(message),
    )
    // 一个配错的环境变量不该让 agent 起不来。
    expect(Object.keys(servers ?? {})).toEqual(['go'])
    expect(warnings.join('\n')).toContain(LSP_SERVERS_ENV)
  })
})

describe('TC-LSP-03 组合', () => {
  /** 装配一份组合，返回它的会话作用域视角。 */
  async function composedWith(lspServers?: Record<string, never>): Promise<{ ctx: Context; agent: unknown }> {
    const ctx = new Context()
    await composeAgent(ctx, {
      sessionsRoot: mkdtempSync(join(tmpdir(), 'dsacp-lsp-')),
      ...(lspServers === undefined ? {} : { lspServers }),
    })
    await waitFor(() => ctx.tools?.get('bash') !== undefined, 15_000, 'composed tools')
    const handle = await createInProcessPort(ctx).sessions.create({
      sessionId: SessionId('tc-lsp'),
      cwd: mkdtempSync(join(tmpdir(), 'dsacp-lsp-cwd-')),
    })
    return { ctx, agent: handle.agent }
  }

  it('不给 servers 表时 lsp 工具不存在 —— 必然报错的工具比没有工具更坏', async () => {
    const { ctx } = await composedWith()
    expect(ctx.tools.get('lsp')).toBeUndefined()
  }, 40_000)

  it('给了表就挂上 lsp 工具', async () => {
    const dir = fakeBinDir(['fake-server'])
    const { ctx } = await composedWith({
      fake: {
        command: join(dir, 'fake-server'),
        extensionToLanguage: { '.q': 'q' },
      },
    } as never)
    // 服务器进程是**惰性**起的（第一次查询才 spawn），所以这里挂上工具并不会
    // 真的跑那个假脚本。
    expect(ctx.tools.get('lsp')).toBeDefined()
  }, 40_000)
})

describe('TC-LSP-04 端到端', () => {
  it('用真的 typescript-language-server 跑一次 goToDefinition', async () => {
    if (!(await hasRealTypescriptServer())) {
      // 本机没装就跳过。这条用例证明的是「链路通」，不是发现逻辑对不对——后者
      // 上面已经用造出来的 PATH 测过，不该因为 CI 机器没装而失去覆盖。
      console.warn('跳过：本机没有 typescript-language-server')
      return
    }
    const cwd = mkdtempSync(join(tmpdir(), 'dsacp-lsp-ws-'))
    writeFileSync(
      join(cwd, 'sample.ts'),
      ['export function target(): number {', '  return 1', '}', '', 'const value = target()', ''].join('\n'),
    )

    const discovered = await discoverLspServers(process.env)
    const ctx = new Context()
    await composeAgent(ctx, {
      sessionsRoot: mkdtempSync(join(tmpdir(), 'dsacp-lsp-')),
      // 只挂 TypeScript 那一条：本机可能还装着别的语言服务器，它们与这条用例
      // 无关，挂上只是多几个待启动的进程。
      lspServers: { typescript: discovered?.['typescript'] } as never,
    })
    await waitFor(() => ctx.tools?.get('lsp') !== undefined, 15_000, 'lsp tool')
    const handle = await createInProcessPort(ctx).sessions.create({ sessionId: SessionId('tc-lsp-e2e'), cwd })

    const tool = ctx.tools.get('lsp', handle.agent)
    expect(tool).toBeDefined()
    // 光标落在 `const value = target()` 里的 `target` 上：第 5 行第 15 列（一基，
    // 这是模型侧的坐标系）。
    const result = (await tool?.execute(
      { operation: 'goToDefinition', file_path: join(cwd, 'sample.ts'), line: 5, character: 15 } as never,
      { agent: handle.agent, signal: new AbortController().signal } as never,
    )) as { kind: string; locations: { uri: string; range: { start: { line: number; character: number } } }[] }

    // 断具体坐标而不是「有结果」：坐标换算错了照样会返回非空结果，那种错误在
    // 「能不能跑通」这个层面完全看不出来。
    //
    // 工具的**规范结果**是零基的（渲染出来给模型看的那份才转成一基），所以第 1
    // 行的定义在这里是 `line: 0`；`export function ` 正好 16 个字符，于是 `target`
    // 从第 16 列开始。
    expect(result.kind).toBe('locations')
    expect(result.locations[0]?.uri).toContain('sample.ts')
    expect(result.locations[0]?.range.start).toEqual({ line: 0, character: 16 })
    await handle.dispose()
  }, 120_000)
})
