/**
 * TC-SBX-* —— 沙箱拒绝与提权授权（US-10 / US-13 的交汇）。
 *
 * 这里测的是**两个子系统的接缝**：平台 shell 工具的提权在执行前解析
 * `ctx.approval`，而 bridge 的应答器把它翻成 `session/request_permission`。
 * 两边各自都有用例，但接缝本身是静默失败的——应答器只认领带 `callId` 的问题，
 * 上游若不带就落到链尾的 fail-closed，用户永远等不到那个弹窗，只看到「被拒绝」。
 *
 * 用真沙箱，因此依赖平台后端（macOS Seatbelt / Linux Landlock 或 bwrap /
 * Windows ACL restricted-token runner）。
 * 后端不可用时组合本身就起不来，这些用例失败是对的信号。
 */

import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { SANDBOX_OPTION } from '../src/config/options.js'
import { createHarness, waitFor, type TestHarness } from './harness.js'
import { NATIVE_SHELL_TOOL, writeFileCommand } from './native-shell.js'

function realTempDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'dsacp-sbx-')))
}

/** 起会话并跑一条平台 shell 命令，回合结算后返回。 */
async function run(
  h: TestHarness,
  args: Record<string, unknown>,
  mode?: 'read-only' | 'workspace-write' | 'danger-full-access',
): Promise<{ cards: Record<string, unknown>[]; cwd: string }> {
  const cwd = realTempDir()
  const { sessionId } = await h.acp.request('session/new', { cwd, mcpServers: [] })
  if (mode !== undefined) {
    await h.acp.request('session/set_config_option', {
      sessionId: sessionId as never,
      configId: SANDBOX_OPTION as never,
      value: mode as never,
    })
  }
  const raw: Record<string, unknown>[] = []
  h.onUpdate((u) => raw.push(u as Record<string, unknown>))

  h.llm.toolCall = { id: 'sbx-1', name: NATIVE_SHELL_TOOL, args: JSON.stringify(args) }
  await h.acp.request('session/prompt', {
    sessionId: sessionId as never,
    prompt: [{ type: 'text', text: '跑一下' }],
  })
  await waitFor(() => raw.some((u) => u['sessionUpdate'] === 'tool_call_update'), 20_000, 'result card')
  return { cards: raw.filter((u) => String(u['sessionUpdate']).startsWith('tool_call')), cwd }
}

/** 结果卡片里模型可见的文本。 */
function resultText(cards: Record<string, unknown>[]): string {
  const done = cards.find((u) => u['sessionUpdate'] === 'tool_call_update')
  const blocks = (done?.['content'] ?? []) as { content?: { text?: string } }[]
  return blocks.map((b) => b.content?.text ?? '').join('\n')
}

describe('TC-SBX-01 拒绝是结果事实', () => {
  it('read-only 下写文件被拒，卡片仍然完成 —— 拒绝要让模型读到，不是工具故障', async () => {
    const h = await createHarness({ shell: 'sandbox' })
    const { cards, cwd } = await run(h, {
      command: writeFileCommand('blocked.txt', 'x'),
      description: 'write a file',
    })

    const done = cards.find((u) => u['sessionUpdate'] === 'tool_call_update')
    expect(done?.['status']).toBe('completed')
    expect(resultText(cards)).toContain('sandbox')
    expect(existsSync(join(cwd, 'blocked.txt'))).toBe(false)
    h.disposeBridge()
  }, 40_000)
})

describe('TC-SBX-02 提权走 ACP 授权弹窗', () => {
  it('拓宽模式的调用会向客户端发起 session/request_permission', async () => {
    const h = await createHarness({ shell: 'sandbox' })
    const seen: RequestPermissionRequest[] = []
    h.setPermissionResponder((request) => {
      seen.push(request)
      return { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    })

    const { cards, cwd } = await run(h, {
      command: writeFileCommand('allowed.txt', 'escalated'),
      description: 'write a file',
      sandbox_permissions: 'workspace-write',
      justification: '需要在工作区里落一个文件',
    })

    // 接缝断言：问题真的到了客户端。上游若不带 callId，应答器就不认领，
    // 这里会是 0 —— 而命令仍然「被拒绝」，表面上像是沙箱在正常工作。
    expect(seen.length, '未收到授权请求：提权被静默 fail-closed 了').toBe(1)
    // 挂在**发起这次提权的那张卡片**上；错了的话弹窗会飘到别的工具调用旁边
    expect(seen[0]?.toolCall.toolCallId).toBe('sbx-1')

    // 授权后命令真的以更宽的模式跑了
    const done = cards.find((u) => u['sessionUpdate'] === 'tool_call_update')
    expect(done?.['status']).toBe('completed')
    expect(resultText(cards)).not.toContain('file access denied')
    expect(existsSync(join(cwd, 'allowed.txt'))).toBe(true)
    h.disposeBridge()
  }, 40_000)

  it('用户拒绝则什么都不执行', async () => {
    const h = await createHarness({ shell: 'sandbox' })
    // harness 默认就是拒绝；这里显式写出来，因为这条用例正是在测拒绝语义。
    h.setPermissionResponder(() => ({ outcome: { outcome: 'selected', optionId: 'reject-once' } }))

    const { cards, cwd } = await run(h, {
      command: writeFileCommand('rejected.txt', 'nope'),
      description: 'write a file',
      sandbox_permissions: 'workspace-write',
      justification: '想写个文件',
    })

    expect(h.permissionRequests.length).toBe(1)
    // 被拒绝的提权不得退回到「按原模式再跑一次」——那样用户点了拒绝，
    // 命令照样执行了（只是换个模式），拒绝就成了摆设。
    const done = cards.find((u) => u['sessionUpdate'] === 'tool_call_update')
    expect(done?.['status']).toBe('failed')
    expect(existsSync(join(cwd, 'rejected.txt'))).toBe(false)
    h.disposeBridge()
  }, 40_000)
})

describe('TC-SBX-03 完全访问模式', () => {
  it('显式切换后可以写会话工作区之外的调用方自有目录', async () => {
    const outside = mkdtempSync(join(process.cwd(), '.dsacp-full-access-'))
    const target = join(outside, 'allowed.txt')
    const h = await createHarness({ shell: 'sandbox' })
    try {
      const { cards } = await run(
        h,
        { command: writeFileCommand(target, 'full access'), description: 'write outside the workspace' },
        'danger-full-access',
      )
      const done = cards.find((u) => u['sessionUpdate'] === 'tool_call_update')
      expect(done?.['status']).toBe('completed')
      expect(existsSync(target)).toBe(true)
    } finally {
      h.disposeBridge()
      rmSync(outside, { recursive: true, force: true })
    }
  }, 40_000)
})
