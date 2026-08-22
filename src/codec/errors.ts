/**
 * JSON-RPC 错误构造。集中在一处，保证协议层的错误码使用一致。
 * @module
 */

import { RequestError } from '@agentclientprotocol/sdk'

/** 调用方输入不合法 —— 参数校验失败、未知会话、重叠 prompt 等。 */
export function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/** 服务端内部失败 —— 保留细节，便于客户端展示可读原因。 */
export function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/**
 * 指名的东西不存在 —— 会话 id 找不到对应的日志。
 *
 * 与另外两个的区别在于**客户端该做什么**，这正是错误码唯一的用处：
 *
 *  - `invalidParams`：请求本身拼错了，改一改重发有意义。一个格式正确、只是
 *    早就被删掉的会话 id 不属于这一类——重发多少次都一样。
 *  - `internalError`：agent 坏了，客户端唯一能做的是把错误摊给用户看。一条
 *    用户自己删掉的会话根本不是故障，报成故障会让编辑器弹一个吓人的红框。
 *  - 本项：那条会话没了。编辑器该做的是把它从会话列表里摘掉（工作区状态里
 *    存着陈旧 id 是最常见的来源），或者引导用户另开一条。
 *
 * 会话 id 同时进消息与 `data.uri`（SDK 的 `resourceNotFound` 就是这个形状，
 * 与文件类资源共用）：客户端据此定位要摘掉哪一条，不必去解析消息文本。
 * @param uri - 找不到的资源标识，这里是会话 id
 * @param detail - 补充原因；只在「为什么找不到」不是自明的时候给
 */
export function resourceNotFound(uri: string, detail?: string): RequestError {
  const base = RequestError.resourceNotFound(uri)
  // 码与 data 都从 SDK 的构造子里借，只扩消息：错误码是协议常量，抄一份到这里
  // 就多了一个会与 SDK 漂移的地方。
  return detail === undefined
    ? base
    : new RequestError(base.code, `${base.message} (${detail})`, base.data)
}

/**
 * 该方法在这个部署里不可用。
 *
 * 与 `invalidParams` 的区别是给客户端的信号不同：参数错了改参数重试有意义，
 * 能力缺失重试多少次都一样。会话恢复与列表就属于后者——组合里没挂持久化时
 * 它们根本不存在。
 *
 * SDK 的这个构造子只收方法名（没有 detail 形参），所以把原因拼进去。
 */
export function methodNotFound(detail: string): RequestError {
  return RequestError.methodNotFound(detail)
}
