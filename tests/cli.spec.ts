/**
 * TC-CLI-* —— 命令行解析与 `--setup`（ACP 的 Terminal Auth）。
 *
 * 分两层：`parseCli` / `readSecret` 是纯函数与纯流处理，进程内直接测；写盘那条必须
 * 起**真实子进程**——`--setup` 的契约是「退出码 0 即登录成功」，而退出码只有真进程
 * 才有。凭据落点由 `DSH_HOME` 指到临时目录，绝不碰开发者自己的 `~/.dsh`。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_INFO } from '../src/protocol/initialize.js'
import { parseCli } from '../src/launcher/cli.js'
import { readSecret } from '../src/launcher/setup.js'

const BIN = fileURLToPath(new URL('../lib/bin.js', import.meta.url))

describe('TC-CLI-01 parseCli', () => {
  it('无参数起服务', () => {
    expect(parseCli([]).kind).toBe('serve')
  })

  it('--version / -v 打印版本', () => {
    for (const flag of ['--version', '-v']) {
      const action = parseCli([flag])
      expect(action.kind).toBe('print')
      expect(action.kind === 'print' && action.text).toBe(AGENT_INFO.version)
    }
  })

  it('--help / -h 打印帮助', () => {
    for (const flag of ['--help', '-h']) {
      const action = parseCli([flag])
      expect(action.kind).toBe('print')
      expect(action.kind === 'print' && action.text).toContain('--setup')
    }
  })

  it('--setup 走登录', () => {
    expect(parseCli(['--setup']).kind).toBe('setup')
  })

  it('未知参数照常起服务 —— 不为此拒绝启动', () => {
    // 编辑器可能出于自己的理由多传点什么；为此拒绝启动会把一个能跑的集成变成
    // 一句「连接失败」。子进程级的同名用例在 `stdout-guard.spec.ts`。
    expect(parseCli(['--what-is-this']).kind).toBe('serve')
    expect(parseCli(['--setup-ish']).kind).toBe('serve')
  })

  it('「只想看一眼」的开关优先于登录', () => {
    // 同时传时先打印再退出：`--version` 之类不该被一个交互式登录劫持。
    expect(parseCli(['--setup', '--version']).kind).toBe('print')
    expect(parseCli(['--setup', '--help']).kind).toBe('print')
  })
})

describe('TC-CLI-02 readSecret 不回显', () => {
  /** 收集写出去的内容。 */
  function sink(): { stream: NodeJS.WritableStream; text: () => string } {
    let text = ''
    const stream = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        text += String(chunk)
        callback()
      },
    })
    return { stream: stream as unknown as NodeJS.WritableStream, text: () => text }
  }

  it('终端下提示照出，但击键回显被吞掉', async () => {
    const out = sink()
    const key = await readSecret(
      { input: Readable.from(['sk-secret-value\n']) as unknown as NodeJS.ReadableStream, output: out.stream, isTty: true },
      'KEY: ',
    )

    expect(key).toBe('sk-secret-value')
    expect(out.text()).toContain('KEY: ')
    // 这条才是重点：密钥不能出现在输出里。回显一旦漏出来，它会留在用户的终端
    // 回滚缓冲区里，也会被编辑器的终端面板原样收走。
    expect(out.text()).not.toContain('sk-secret-value')
  })

  it('非终端时原样读一行', async () => {
    const out = sink()
    const key = await readSecret(
      { input: Readable.from(['sk-piped\n']) as unknown as NodeJS.ReadableStream, output: out.stream, isTty: false },
      'KEY: ',
    )
    expect(key).toBe('sk-piped')
  })
})

describe('TC-CLI-03 --setup 写盘（子进程）', () => {
  let home: string | undefined

  afterEach(() => {
    if (home !== undefined) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  /** 起一次 `--setup`，把 `stdin` 喂进去，等它自己退出。 */
  async function runSetupBin(
    dshHome: string,
    stdin: string,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, '--setup'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, DSH_HOME: dshHome },
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      child.on('error', reject)
      child.stdin.write(stdin)
      child.stdin.end()
      const cap = setTimeout(() => child.kill(), 15_000)
      child.on('close', (code) => {
        clearTimeout(cap)
        resolve({ code, stdout, stderr })
      })
    })
  }

  it('读到 Key 就写进 .credentials.yaml，退出码 0', async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-setup-'))
    const run = await runSetupBin(home, 'sk-test-abc123\n')

    // 退出码 0 是 Terminal Auth 唯一的成功信号：客户端只看这个数就去重连了。
    expect(run.code, `stderr=${run.stderr.slice(0, 400)}`).toBe(0)

    const doc = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    expect(doc).toContain('DEEPSEEK_API_KEY')
    expect(doc).toContain('sk-test-abc123')
  }, 30_000)

  it('stdout 一个字都不写 —— 提示与结果全走 stderr', async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-setup-'))
    const run = await runSetupBin(home, 'sk-test-abc123\n')
    // `--setup` 不起服务，写 stdout 不违反 AC-G1，但保持同一条约定：排查时不必
    // 先想「这次是哪种模式」。
    expect(run.stdout).toBe('')
  }, 30_000)

  it('空输入不写盘，退出码非 0', async () => {
    home = mkdtempSync(join(tmpdir(), 'dsh-setup-'))
    const run = await runSetupBin(home, '\n')

    // 报成功却没存下东西，客户端会重连然后在第一个回合莫名失败——那种失败离
    // 「登录」已经很远，用户无从联想。
    expect(run.code).not.toBe(0)
    expect(() => readFileSync(join(home as string, '.credentials.yaml'), 'utf8')).toThrow()
  }, 30_000)
})
