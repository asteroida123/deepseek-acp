#!/usr/bin/env node
/**
 * 可执行入口。诊断一律走 stderr —— stdout 属于 ACP 协议。
 * @module
 */

import { boot } from './launcher/boot.js'
import { parseCli } from './launcher/cli.js'
import { runSetup } from './launcher/setup.js'

const action = parseCli(process.argv.slice(2))
if (action.kind === 'print') {
  // **写 stdout 不违反 AC-G1**：那条约束是「作为 ACP 服务运行时 stdout 只放
  // 协议帧」，而这条路径根本不起服务，进程随即退出。版本号本来就该能被
  // `deepseek-acp --version` 管道接走。
  process.stdout.write(`${action.text}\n`)
  process.exit(0)
}

if (action.kind === 'setup') {
  // **退出码就是协议**：ACP 的 Terminal Auth 没有带内成功信号，客户端只看这个数
  // 决定「登录成功了吗」。所以异常也要落成 1，而不是让它变成一个未捕获的拒绝
  // ——那样的退出码是 1 没错，但堆栈会盖住 `runSetup` 已经写好的那句人话。
  process.exit(
    await runSetup(process.env).catch((error: unknown) => {
      process.stderr.write(`deepseek-acp: setup failed: ${String(error)}\n`)
      return 1
    }),
  )
}

// 客户端断开即退出。不靠「句柄耗尽自然退出」：组合里任何一个 fs watcher 或
// 长活定时器都会把进程留下来变成孤儿，而编辑器只会一次次新起进程。
boot(process.env, () => process.exit(0)).catch((error: unknown) => {
  process.stderr.write(`deepseek-acp: boot failed: ${String(error)}\n`)
  process.exit(1)
})
