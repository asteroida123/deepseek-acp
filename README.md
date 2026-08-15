# deepseek-acp

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 接成一个**面向编辑器的完整编码 Agent**，
通过 [Agent Client Protocol](https://agentclientprotocol.com)（ACP）与客户端通话。

**可用客户端**：任何实现 ACP 的编辑器。开发期在 **[codeg](https://github.com/xintaofei/codeg)** 里实测；
**[Zed](https://zed.dev)** 走同一套协议、配置方式见下，但尚未逐项验收过。

---

## 为什么存在

DeepSeek Harness 自带一个 ACP server（`@deepseek-ai/dsh-acp`），但它的定位是
**automation-only**——给程序用的，不是给人用的。上游自己的说明写得很直白：

> This package is a transport adapter, not a UI integration or a capability seam.
> It does not expose editor navigation, transcript replay, commands, modes,
> configuration pickers, elicitation, reasoning, plans, titles, or tool presentation.

它的主要客户端是 `dsh-subagent-acp`——一个父 harness 派生子 agent 的通道。对这个用途，
它的设计是对的：只发**已提交**的助手消息，不漏未提交的中间态，拿到的是干净的自动化结果。

但同一套设计放进编辑器就不成立了：

- **看不到模型在干什么。** 工具调用、命令输出、文件改动全部只留在会话日志里，界面上
  只有最后一段文字。模型改了你的文件，你得自己去 `git diff` 才知道。
- **没有逐字流式。** 只在整段消息提交后才推一次，长回答期间界面是静止的。
- **一次性会话。** 关掉就没了——没有恢复、没有列表、没有标题。
- **控制面全无。** 换模型、调文件权限、开计划模式、执行 slash 命令，都没有入口。
- **拒绝 MCP。** `mcpServers` 只要非空就直接报错。

官方其实实现过一版完整的编辑器向 bridge，又在 2026-07-24 主动删掉了——理由是产品定位，
不是技术不可行。**本项目填的就是这块被让出的生态位**：同一个 harness 内核，换一张
为人准备的协议面。

---

## 与内置 ACP 的能力对比

| | `@deepseek-ai/dsh-acp`（内置） | **deepseek-acp**（本项目） |
|---|---|---|
| 定位 | automation-only 传输适配器 | 面向编辑器的完整 Agent |
| 回复流式 | 仅整段提交后推送 | 逐 token |
| 思考过程 | ✗ 留在日志里 | ✅ `agent_thought_chunk` |
| 工具调用 | ✗ 不呈现 | ✅ 卡片 + 状态流转 |
| 文件 diff | ✗ | ✅ 编辑器原生 diff 视图 |
| 终端输出 | ✗ | ✅ 终端卡片（Zed `_meta` 约定） |
| 待办计划 | ✗ | ✅ `plan` + 计划模式 |
| 会话恢复 / 列表 | ✗ 关掉即消失 | ✅ `load` / `list` / `resume` / `close`，带标题 |
| 会话内换模型 | ✗ | ✅ 模型、推理档位、文件权限三个选择器 |
| slash 命令 | ✗ | ✅ 命令目录，不进模型 |
| 模型向你提问 | ✗ | ✅ 表单征询；客户端不支持时降级成按钮 |
| MCP server | ✗ 非空即拒绝 | ✅ 按会话挂载，stdio + HTTP，会话间隔离 |
| 上下文用量 | ✗ | ✅ `usage_update` 进度条 |
| 读未保存的缓冲区 | ✗ | ✅ `fs/read_text_file` 改道到编辑器 |
| 内嵌上下文（@ 文件） | ✗ `embeddedContext: false` | ✅ 整段内联 |
| 授权提示 | ✅ 一次性 allow / reject | ✅ 同左，另含沙箱越界提权 |
| 多会话 | ✅ | ✅ |

**沙箱。** 命令与文件操作同在一道围栏之下（默认 `workspace-write`，可写集是
`{会话 cwd, /tmp, 系统临时目录}`），bash 与文件工具共用同一份定义。越界会被拒绝，
模型可以就该次操作发起提权，提示走 `session/request_permission`。

**内置工具**：`bash`、`read`、`write`、`edit`、`glob`、`grep`、`todo_write`、
`ask_user_question`、`exit_plan_mode`。

**刻意不做的**：`fs/write_text_file` 委托（会绕开沙箱围栏，让「文件权限」选择器形同虚设）、
后台任务（自发回合发出的更新没有对应的 `stopReason` 归属）。**受阻于上游的**：图片输入、
`session/delete`、MCP 的 `sse` / `acp` 传输。

---

## 注册到编辑器

可执行文件是 `deepseek-acp`，通过 stdio 说 ACP。**起服务不需要任何参数**——编辑器直接
拉起即可；`--setup` / `--version` / `--help` 三个开关都是「跑完就退」，不进服务模式，
其余参数一律照常起服务（编辑器可能出于自己的理由多传点什么，为此拒绝启动会把一个
能跑的集成变成一句「连接失败」）。

API Key 有两条路，二选一：

- **`deepseek-acp --setup`** —— 交互式粘一次，存进 `$DSH_HOME/.credentials.yaml`
  （`0600`）。见下面「登录」一节。
- **客户端的环境变量** —— 下面两份配置都有位置。

**别指望 `.zshrc` 里的 `export`**——编辑器是 GUI 应用，不继承登录 shell 的环境，
它派生的子进程同样拿不到。这也正是 `--setup` 存在的理由：凭据落在文件里，与启动
方式无关。

### 登录

`initialize` 里可能 advertise 一条 ACP 的 **Terminal Auth**：

```json
{ "id": "terminal", "type": "terminal", "args": ["--setup"] }
```

**只发给声明认得它的客户端**——`clientCapabilities.auth.terminal === true`，或
`_meta["terminal-auth"] === true`（先于能力位存在的约定）。两者都没有时 `authMethods`
是空数组，与这个功能存在之前一模一样：终端登录是 opt-in 的方法类型，塞给没准备好的
客户端只会添乱。顺带一提，顶层的 `clientCapabilities.terminal` **不算**——那一位说的
是「实现了 `terminal/*` 那组方法」（终端卡片），是另一件事。

支持这条的客户端会用**同一个二进制**加上 `--setup` 另起一个交互式终端进程，等它
退出——**退出码 0 即成功**——再重连。手动跑也是同一条：

```sh
deepseek-acp --setup      # 粘 Key，回车。终端下不回显
```

写入的引用名是 `DEEPSEEK_API_KEY`，落点 `$DSH_HOME/.credentials.yaml`。这一层**赢过**
环境变量之外的两个 `.env` 层，所以之前在 `.env` 里放过的旧 Key 不会把它压住；而进程
启动时**显式传入**的环境变量仍然优先级最高（那是「这一次运行」的操作意图）。

声明这条**不代表会拦住建会话**：本项目从不返回 `auth_required`，缺 Key 的失败照旧
发生在第一个回合（`MISSING_CREDENTIAL`）。它只是给客户端一个登录入口。

### Zed

`settings.json` 里加一个 `agent_servers` 条目：

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "deepseek-acp"],
      "env": { "DEEPSEEK_API_KEY": "sk-..." }
    }
  }
}
```

装到全局（`npm i -g deepseek-acp`）的话，`command` 填 `deepseek-acp`、`args` 留空即可。

### codeg

设置 → 智能体 → **添加自定义智能体** → **手动填写**：

| 字段 | 值 |
|---|---|
| 注册表 ID | `deepseek-acp` |
| 显示名称 | `DeepSeek Harness` |
| 版本 | `0.2.0` |
| 分发信息（JSON） | `{"npx": {"package": "deepseek-acp@0.2.0", "cmd": "deepseek-acp"}}` |
| 环境变量 | `DEEPSEEK_API_KEY=sk-...` |
| 版本查询命令 | 留空 |
| MCP 支持 | 开着即可 |

「版本」要与分发信息里的版本一致——codeg 的 preflight 会对账，对不上的表现是
连接阶段失败而不是报错。

MCP 开着时，`codeg-mcp` 会作为 server 挂进来，模型看到的工具名带**会话前缀**
（`mcp__a1_codeg-mcp__<tool>`）：`serverName` 在进程内全局唯一，而 ACP 的
`mcpServers` 是每会话参数，不加前缀时第二个会话会挂不上。

### 会话日志

默认写在 `$DSH_HOME/sessions`（即 `~/.dsh/sessions`），可用
`DEEPSEEK_ACP_SESSIONS_ROOT` 覆盖。会话恢复、列表与标题都从这里读。

---

## 致谢

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** —— 本项目的内核。
  没有它就没有这层适配器；曾经存在过的那版编辑器向 bridge 也给了本项目大量参考。
- **[LinuxDO](https://linux.do)** —— 本项目的起源社区。

---

## 许可

本项目 MIT，见 [`LICENSE`](LICENSE)。**这是一个非官方的社区适配器，与 DeepSeek
无隶属关系，亦未获其背书。**

仓库不含任何第三方源码的逐字副本。但**测试套件与设计**有相当一部分派生自
DeepSeek Harness 曾经存在的编辑器向 ACP bridge（`packages/ui/acp`，2026-07-24 被删除）。
**该快照适用 BSD-3-Clause 而不是仓库今天的 MIT**——上游是在删除之后才换的许可。
其原始版权声明与许可正文按 BSD 第 1 条的要求随附在 [`LICENSE`](LICENSE) 里。

想参与开发见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。
