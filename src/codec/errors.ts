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
