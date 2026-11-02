/**
 * Express 请求对象的全局类型增强。
 *
 * 单独成文件，便于使用方用三斜线引用把增强带进自己的编译单元
 * （ts-node 默认只编译被 require 的文件，全局增强不会自动生效）。
 */

/** UI Cookie 认证上下文。 */
export interface UiAuthContext {
  apiKeyId: string;
  userId: string;
  providerAccountId?: string;
}

declare global {
  namespace Express {
    interface Request {
      uiAuth?: UiAuthContext;
    }
  }
}
