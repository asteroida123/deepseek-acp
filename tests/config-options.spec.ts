/**
 * TC-CFG-* —— 会话配置项（US-16 模型 / US-17 权限）。
 *
 * ACP 没有「支持配置项」的能力位：声明方式就是在 `session/new` / `session/load`
 * 的应答里带回 `configOptions`。因此这里既测「有没有声明」，也测「设了之后
 * 应答里的值有没有跟着变」——客户端只能靠后者重绘控件。
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { MODEL_OPTION, SANDBOX_OPTION, configOptions } from '../src/config/options.js'
import type { SessionControls } from '../src/port/types.js'
import { FAKE_MODEL, FAKE_MODEL_ALT } from './fake-llm.js'
import { createHarness, waitFor } from './harness.js'

function realTempDir(prefix = 'dsacp-cfg-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/** 取某个配置项。 */
function option(options: readonly SessionConfigOption[] | null | undefined, id: string) {
  return (options ?? []).find((o) => o.id === id)
}

/** 某个 select 的候选值。 */
function values(o: SessionConfigOption | undefined): string[] {
  if (o === undefined || o.type !== 'select') return []
  return o.options.flatMap((e) => ('group' in e ? e.options.map((x) => x.value) : [e.value]))
}

describe('TC-CFG-01 权限预设（US-17）', () => {
  it('session/new 声明沙箱配置项，当前值为部署默认', async () => {
    const h = await createHarness({ shell: 'sandbox' })
    const created = await h.acp.request('session/new', { cwd: realTempDir(), mcpServers: [] })

    const sandbox = option(created.configOptions, SANDBOX_OPTION)
    expect(sandbox?.type).toBe('select')
    // harness 的 sandbox 组合默认 read-only
    expect(sandbox?.type === 'select' ? sandbox.currentValue : undefined).toBe('read-only')
    expect(values(sandbox)).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
    h.disposeBridge()
  }, 30_000)

  it('设置后应答里的 currentValue 立即反映新值', async () => {
    const h = await createHarness({ shell: 'sandbox' })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir(), mcpServers: [] })

    const set = await h.acp.request('session/set_config_option', {
      sessionId: sessionId as never,
      configId: SANDBOX_OPTION as never,
      value: 'workspace-write' as never,
    })
    const sandbox = option(set.configOptions, SANDBOX_OPTION)
    expect(sandbox?.type === 'select' ? sandbox.currentValue : undefined).toBe('workspace-write')
    h.disposeBridge()
  }, 30_000)

  it('切换后命令真的在新模式下执行 —— 控件不能只是装饰', async () => {
    const h = await createHarness({ shell: 'sandbox' })

    /** 在某会话里写一个文件，返回模型可见的结果文本。 */
    const writeFile = async (sessionId: string, callId: string): Promise<string> => {
      const raw: Record<string, unknown>[] = []
      h.onUpdate((u) => raw.push(u as Record<string, unknown>))
      h.llm.toolCall = {
        id: callId,
        name: 'bash',
        args: JSON.stringify({ command: `echo ok > ${callId}.txt`, description: 'write a file' }),
      }
      await h.acp.request('session/prompt', {
        sessionId: sessionId as never,
        prompt: [{ type: 'text', text: '写个文件' }],
      })
      await waitFor(
        () => raw.some((u) => u['sessionUpdate'] === 'tool_call_update' && u['toolCallId'] === callId),
        20_000,
        `result ${callId}`,
      )
      const done = raw.find((u) => u['sessionUpdate'] === 'tool_call_update' && u['toolCallId'] === callId)
      return JSON.stringify(done?.['content'] ?? '')
    }

    // 反向对照：不切模式时同样的命令**必须**被拒。没有这一半，即便切换完全
    // 没生效，「没有 denied」也可能因为别的原因成立，用例就是空过的。
    const before = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cfgws-'), mcpServers: [] })
    expect(await writeFile(String(before.sessionId), 'cfg-denied')).toContain('denied')

    const after = await h.acp.request('session/new', { cwd: realTempDir('dsacp-cfgws-'), mcpServers: [] })
    await h.acp.request('session/set_config_option', {
      sessionId: after.sessionId as never,
      configId: SANDBOX_OPTION as never,
      value: 'workspace-write' as never,
    })
    expect(await writeFile(String(after.sessionId), 'cfg-allowed')).not.toContain('denied')
    h.disposeBridge()
  }, 60_000)

  it('切换只影响本会话', async () => {
    const h = await createHarness({ shell: 'sandbox' })
    const a = await h.acp.request('session/new', { cwd: realTempDir(), mcpServers: [] })
    const b = await h.acp.request('session/new', { cwd: realTempDir(), mcpServers: [] })

    await h.acp.request('session/set_config_option', {
      sessionId: a.sessionId as never,
      configId: SANDBOX_OPTION as never,
      value: 'danger-full-access' as never,
    })
    // B 不受影响 —— 沙箱覆盖写在**各自的**会话日志里
    const bAgain = await h.acp.request('session/set_config_option', {
      sessionId: b.sessionId as never,
      configId: SANDBOX_OPTION as never,
      value: 'read-only' as never,
    })
    const sandbox = option(bAgain.configOptions, SANDBOX_OPTION)
    expect(sandbox?.type === 'select' ? sandbox.currentValue : undefined).toBe('read-only')
    h.disposeBridge()
  }, 30_000)

  it('沙箱覆盖随 session/load 一起恢复', async () => {
    const root = realTempDir('dsacp-cfgroot-')
    const cwd = realTempDir('dsacp-cfgws-')
    const rec = await createHarness({ shell: 'sandbox', sessionsRoot: root })
    const { sessionId } = await rec.acp.request('session/new', { cwd, mcpServers: [] })
    await rec.acp.request('session/set_config_option', {
      sessionId: sessionId as never,
      configId: SANDBOX_OPTION as never,
      value: 'danger-full-access' as never,
    })
    // 得先有内容才会落盘（懒物化）；设置本身就产生了一条 sandbox/mode 事件
    rec.disposeBridge()
    await waitFor(() => !rec.hasAgent(String(sessionId)), 5_000, 'teardown')
    await rec.waitPersisted(String(sessionId))

    const loader = await createHarness({ shell: 'sandbox', sessionsRoot: root })
    const loaded = await loader.acp.request('session/load', {
      sessionId: sessionId as never,
      cwd,
      mcpServers: [],
    })
    // 恢复一个当初放宽过权限的会话，控件要如实显示放宽后的状态 —— 显示成部署
    // 默认（read-only）会让用户以为是安全的，而模型实际仍在 full-access 下跑。
    const sandbox = option(loaded.configOptions, SANDBOX_OPTION)
    expect(sandbox?.type === 'select' ? sandbox.currentValue : undefined).toBe('danger-full-access')
    loader.disposeBridge()
  }, 40_000)
})

describe('TC-CFG-04 模型切换（US-16）', () => {
  it('声明模型项，当前值为建会话时用的那个', async () => {
    const h = await createHarness()
    const created = await h.acp.request('session/new', { cwd: realTempDir(), mcpServers: [] })
    const model = option(created.configOptions, MODEL_OPTION)
    expect(model?.type === 'select' ? model.currentValue : undefined).toBe(FAKE_MODEL)
    expect(values(model)).toEqual([FAKE_MODEL, FAKE_MODEL_ALT])
    h.disposeBridge()
  }, 30_000)

  it('切换后下一次请求真的发给新模型 —— 只改显示值等于没切', async () => {
    const h = await createHarness()
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir(), mcpServers: [] })

    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '第一轮' }],
    })
    expect(h.llm.modelsUsed.at(-1)).toBe(FAKE_MODEL)

    await h.acp.request('session/set_config_option', {
      sessionId: sessionId as never,
      configId: MODEL_OPTION as never,
      value: FAKE_MODEL_ALT as never,
    })
    await h.acp.request('session/prompt', {
      sessionId: sessionId as never,
      prompt: [{ type: 'text', text: '第二轮' }],
    })
    expect(h.llm.modelsUsed.at(-1)).toBe(FAKE_MODEL_ALT)
    h.disposeBridge()
  }, 30_000)

  it('切换只影响本会话', async () => {
    const h = await createHarness()
    const a = await h.acp.request('session/new', { cwd: realTempDir(), mcpServers: [] })
    const b = await h.acp.request('session/new', { cwd: realTempDir(), mcpServers: [] })

    await h.acp.request('session/set_config_option', {
      sessionId: a.sessionId as never,
      configId: MODEL_OPTION as never,
      value: FAKE_MODEL_ALT as never,
    })

    await h.acp.request('session/prompt', {
      sessionId: b.sessionId as never,
      prompt: [{ type: 'text', text: 'B 这一轮' }],
    })
    // B 仍用原模型：选择 ref 是**按 agent 作用域**装的，不是进程级共享
    expect(h.llm.modelsUsed.at(-1)).toBe(FAKE_MODEL)
    h.disposeBridge()
  }, 30_000)
})

describe('TC-CFG-02 校验', () => {
  it('未知 configId 被拒 —— 静默接受会让客户端以为生效了', async () => {
    const h = await createHarness({ shell: 'sandbox' })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir(), mcpServers: [] })
    await expect(
      h.acp.request('session/set_config_option', {
        sessionId: sessionId as never,
        configId: 'nope' as never,
        value: 'x' as never,
      }),
    ).rejects.toThrow(/unknown config option/)
    h.disposeBridge()
  }, 30_000)

  it('不在候选里的值被拒 —— 否则拼错的模型 id 会一路带到下一次请求', async () => {
    const h = await createHarness({ shell: 'sandbox' })
    const { sessionId } = await h.acp.request('session/new', { cwd: realTempDir(), mcpServers: [] })
    await expect(
      h.acp.request('session/set_config_option', {
        sessionId: sessionId as never,
        configId: SANDBOX_OPTION as never,
        value: 'yolo-mode' as never,
      }),
    ).rejects.toThrow(/no value/)
    h.disposeBridge()
  }, 30_000)

  it('未知会话被拒', async () => {
    const h = await createHarness({ shell: 'sandbox' })
    await expect(
      h.acp.request('session/set_config_option', {
        sessionId: 'nope' as never,
        configId: SANDBOX_OPTION as never,
        value: 'read-only' as never,
      }),
    ).rejects.toThrow(/unknown session/)
    h.disposeBridge()
  }, 30_000)
})

describe('TC-CFG-03 组合决定声明什么', () => {
  it('没挂 sandboxPolicy 时不声明权限项', async () => {
    // 默认 harness 不挂沙箱
    const h = await createHarness()
    const created = await h.acp.request('session/new', { cwd: realTempDir(), mcpServers: [] })
    expect(option(created.configOptions, SANDBOX_OPTION)).toBeUndefined()
    h.disposeBridge()
  }, 30_000)

  it('模型只有一个候选时不声明模型项 —— 选不动的下拉框没有意义', () => {
    const controls: SessionControls = {
      model: () => 'only-one',
      setModel: () => {},
      contextWindow: () => undefined,
      reasoningEffort: () => undefined,
      setReasoningEffort: () => {},
      sandboxMode: () => undefined,
      setSandboxMode: () => {},
    }
    expect(configOptions({ controls, models: [{ id: 'only-one', name: 'Only' }], sandboxModes: [] })).toEqual([])
  })

  it('两个以上候选才声明模型项，当前值为已选模型', () => {
    const controls: SessionControls = {
      model: () => 'b',
      setModel: () => {},
      contextWindow: () => undefined,
      reasoningEffort: () => undefined,
      setReasoningEffort: () => {},
      sandboxMode: () => undefined,
      setSandboxMode: () => {},
    }
    const options = configOptions({
      controls,
      models: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ],
      sandboxModes: [],
    })
    const model = option(options, MODEL_OPTION)
    expect(model?.type === 'select' ? model.currentValue : undefined).toBe('b')
    expect(values(model)).toEqual(['a', 'b'])
  })

  it('provider/model 缺失时不声明模型项', () => {
    const controls: SessionControls = {
      model: () => undefined,
      setModel: () => {},
      contextWindow: () => undefined,
      reasoningEffort: () => undefined,
      setReasoningEffort: () => {},
      sandboxMode: () => undefined,
      setSandboxMode: () => {},
    }
    expect(configOptions({ controls, models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], sandboxModes: [] })).toEqual([])
  })
})
