#!/usr/bin/env node
/**
 * 发布前置检查，由 `prepublishOnly` 调用。
 *
 * **为什么值得为几个字段写一个脚本**：npm 的首发是几乎不可撤销的（24 小时后
 * `unpublish` 就受限，而包名会一直占着）。`repository` 填着占位符发出去，
 * 表现不是报错，是 npm 页面上一个点不开的源码链接和一个没人能提 issue 的包。
 * 这类字段只有作者本人知道，所以这里不猜、不填默认值，只负责**拦住**。
 *
 * 版本一致性（`AGENT_INFO` vs `package.json`）与依赖锁定（约束 C1）各自有用例守着，
 * 而 `prepublishOnly` 本来就会跑 `npm test`，这里不重复。
 */

import { readFileSync, existsSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

/**
 * URL 字段的占位符特征。**尖括号只对 URL 有效**：npm 的 `author` 规范格式就是
 * `Name <email> (url)`，一个合规的署名必然带尖括号。第一版把 `[<>]` 用在所有
 * 字段上，于是 `Test Author <test@example.invalid>` 被判成占位符——一个只会
 * 在填对了之后才发作的假阳性。
 */
const URL_PLACEHOLDER = /[<>]|example\.com|YOUR[-_ ]|TODO/i
/** 人名字段只查这几个明确的模板残留，不查尖括号。 */
const NAME_PLACEHOLDER = /你的账号|YOUR[-_ ]NAME|TODO/i

const problems = []

/**
 * @param {string} label
 * @param {unknown} value
 * @param {RegExp} [placeholder] 省略则只查非空
 */
function requireFilled(label, value, placeholder) {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${label} 为空`)
    return
  }
  if (placeholder?.test(value)) problems.push(`${label} 仍是占位符：${value}`)
}

requireFilled('author', pkg.author, NAME_PLACEHOLDER)
requireFilled('repository.url', pkg.repository?.url, URL_PLACEHOLDER)
requireFilled('homepage', pkg.homepage, URL_PLACEHOLDER)
requireFilled('bugs.url', pkg.bugs?.url, URL_PLACEHOLDER)
requireFilled('description', pkg.description)
requireFilled('license', pkg.license)

// LICENSE 正文。npm 会自动把它打进 tarball，但只有在文件存在时——
// 声明了 MIT 却没有正文，等于没有授权。
if (!existsSync(new URL('LICENSE', root))) problems.push('仓库根缺 LICENSE 文件')

// `files` 里的每一项都得真的存在。写错的条目 npm 会静默忽略：曾经有一条
// `composition`（真实路径是 `lib/composition`）挂在那里，谁也没发现。
for (const entry of pkg.files ?? []) {
  if (!existsSync(new URL(entry, root))) problems.push(`files 里的 "${entry}" 不存在`)
}

// `bin` / `main` / `types` 指向的文件必须已经构建出来。
//
// **`prepack` 帮不上忙**：`npm publish` 的生命周期是 `prepublishOnly` → `prepack`
// → `prepare` → `publish`，前置检查跑在构建**之前**。所以 `prepublishOnly` 自己
// 先跑一遍 `npm run build`（见 package.json），这几条才有意义。
//
// 它真正拦的是「构建产物与 package.json 的指向对不上」：改了入口文件名而忘了改
// `main` / `bin`，npm 照发不误，装上去才报 MODULE_NOT_FOUND。
// （`--ignore-scripts` 连这个脚本一起跳过，拦不了，也不该假装拦得住。）
for (const [label, rel] of [
  ['main', pkg.main],
  ['types', pkg.types],
  ...Object.entries(pkg.bin ?? {}).map(([name, path]) => [`bin.${name}`, path]),
]) {
  if (rel && !existsSync(new URL(rel, root))) problems.push(`${label} 指向的 ${rel} 不存在（先 npm run build）`)
}

if (problems.length > 0) {
  console.error('发布前置检查未通过：\n')
  for (const p of problems) console.error(`  ✗ ${p}`)
  console.error('\n这几个字段只有作者本人知道，脚本不替你猜。npm 的首发几乎不可撤销')
  console.error('（24 小时后 unpublish 就受限，包名会一直占着），所以宁可发不出去。')
  process.exit(1)
}

console.error(`✓ 发布前置检查通过：${pkg.name}@${pkg.version}`)
