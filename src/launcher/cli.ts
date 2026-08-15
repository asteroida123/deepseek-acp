/**
 * CLI 参数：`--version` / `--help`。
 *
 * 存在的理由：编辑器 spawn 这个二进制时不带参数，一切正常；**人手敲一下想确认
 * 装的是哪个版本时，它会照常起 ACP 服务然后静静地等 stdin**——看起来就是卡死。
 * 这两个开关把「我想确认它能跑」变成一秒钟的事。
 *
 * 纯函数（不碰 `process`），因此可以直接单测。
 * @module
 */

import { AGENT_INFO } from '../protocol/initialize.js'
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from './boot.js'

/** 解析结果：要么打印一段文本就退出，要么照常起服务。 */
export type CliAction = { kind: 'print'; text: string } | { kind: 'serve' }

/** `--help` 的正文。列出的环境变量就是 {@link readEnv} 与 {@link sessionsRoot} 真正读的那几个。 */
function helpText(): string {
  return [
    `${AGENT_INFO.name} ${AGENT_INFO.version} —— DeepSeek Harness 的 ACP 适配器`,
    '',
    '这个程序说 ACP（Agent Client Protocol），走 stdio。它不是给人直接用的：',
    '由编辑器（Zed / codeg 等）以子进程方式拉起，stdout 是协议通道，诊断走 stderr。',
    '',
    '用法：',
    '  deepseek-acp              以 ACP 服务运行（等编辑器在 stdin 上说话）',
    '  deepseek-acp --version    打印版本后退出',
    '  deepseek-acp --help       打印本帮助后退出',
    '',
    '环境变量：',
    `  DEEPSEEK_API_KEY              模型凭据；也可由 dsh 的凭据服务提供`,
    `  DEEPSEEK_ACP_PROVIDER         provider 路由（默认 ${DEFAULT_PROVIDER}）`,
    `  DEEPSEEK_ACP_MODEL            模型（默认 ${DEFAULT_MODEL}）`,
    '  DEEPSEEK_ACP_SESSIONS_ROOT    会话日志目录（默认 $DSH_HOME/sessions）',
    '',
    '想在没有编辑器的情况下确认协议是通的，用仓库里的探针：',
    '  node scripts/acp-probe.mjs "你好"',
  ].join('\n')
}

/**
 * 解析命令行。
 *
 * **只认这两个开关，其余一律照常起服务**：未知参数不报错，因为编辑器可能出于
 * 自己的理由多传点什么，为此拒绝启动会把一个能跑的集成变成「连接失败」。
 * @param argv - `process.argv.slice(2)`
 * @returns 该打印什么，或者该起服务
 */
export function parseCli(argv: readonly string[]): CliAction {
  if (argv.includes('--version') || argv.includes('-v')) {
    return { kind: 'print', text: AGENT_INFO.version }
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    return { kind: 'print', text: helpText() }
  }
  return { kind: 'serve' }
}
