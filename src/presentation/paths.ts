/**
 * 工具卡片里的路径呈现。
 *
 * 只把**标题**里的工作区内路径相对化，`locations` 与 diff 的 `path` 保持原样：
 * 前者是给人看的，后者是给编辑器定位文件用的——把定位路径改成相对的会让
 * 跳转失败，而且失败方式是安静的（编辑器找不到文件就什么都不做）。
 * @module
 */

import { isAbsolute, relative as relativePath, sep as pathSep } from 'node:path'

/**
 * 判断绝对路径是否落在工作区内。
 * @param path - 待判断的绝对路径
 * @param cwd - 工作区
 * @returns 在工作区内则 true
 */
export function insideWorkspace(path: string, cwd: string): boolean {
  const rel = relativePath(cwd, path)
  // `..` 开头表示跳出工作区；绝对结果表示分属不同盘符/根。
  return rel.length > 0 && !rel.startsWith(`..${pathSep}`) && rel !== '..' && !isAbsolute(rel)
}

/**
 * 把标题里出现的工作区内绝对路径换成相对路径。
 *
 * 只做整段替换，不做子串扫描：标题由工具自己写，格式各异，在里面正则找路径
 * 容易误伤（比如命令行参数里的路径就不该动）。
 * @param title - 工具给出的标题
 * @param rawPath - 该卡片主要操作的路径；无则原样返回
 * @param cwd - 会话工作区；无则原样返回
 * @returns 展示用标题
 */
export function displayTitle(title: string, rawPath: string | undefined, cwd: string | undefined): string {
  if (rawPath === undefined || cwd === undefined) return title
  if (!isAbsolute(rawPath) || !insideWorkspace(rawPath, cwd)) return title
  const rel = relativePath(cwd, rawPath)
  return title.includes(rawPath) ? title.replaceAll(rawPath, rel) : title
}

/**
 * `locations` 原样透传。
 *
 * 存在这个函数只是为了让「不相对化」这件事在调用处显式可见——否则下一个人
 * 会顺手给 locations 也加上相对化，然后 follow-along 静默失效。
 * @param locations - 工具给出的位置
 * @param _cwd - 会话工作区（有意不使用）
 * @returns 原样的位置
 */
export function relativizeLocations<T>(locations: readonly T[] | undefined, _cwd: string | undefined): readonly T[] | undefined {
  return locations
}
