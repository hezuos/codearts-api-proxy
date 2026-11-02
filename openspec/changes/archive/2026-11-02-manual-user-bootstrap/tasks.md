# Tasks

## 1. 用户存储与启动

- [x] 1.1 移除 `bootstrapDefaultAuth` 定义与 `index.ts` 调用，`createUser` 改 email 去重，跑 `pnpm test src/store/hierarchical-store.test.ts` 验证
- [x] 1.2 更新 `AGENTS.md` / `README.md` 单用户描述为多用户，核对文档与 spec 一致

## 2. 绑定口令

- [x] 2.1 新增内存口令存储与签发/消费逻辑，单测覆盖签发、单次消费、过期、并发单成功、删用户即废，跑对应测试验证
- [x] 2.2 新增 `POST /admin/api/users/:id/invite` 接口，Admin 鉴权下为已存在用户签发并一次返回，手工 curl 验证 200 与 404

## 3. 登录归属

- [x] 3.1 `authorize` 与 `browser/start` 共用口令校验，无归属时 400 明确报错，单测覆盖两入口无口令/坏口令/有效口令
- [x] 3.2 OAuth2 `code + state` 回调按 state 精确匹配 flow，`initiateHuaweiLogin` 沿用 `auth.userId`，单测覆盖并发不串户与未知 flow 拒绝
- [x] 3.3 回调 provision 前加跨用户抢账号检查，单测覆盖第二用户冲突拒绝与同用户重登放行

## 4. 管理界面与首页

- [x] 4.1 setup 页新增用户字段并随设密码建首用户，panel 新增建用户与签发口令入口，跑 `pnpm run lint` 验证
- [x] 4.2 首页登录入口新增口令输入框并透传 `invite_token`，手工验证无口令报错与持口令建 flow

## 5. 存量与回归

- [x] 5.1 更新 `huawei-auth.test.ts` 等依赖 bootstrap 与单用户假设的用例，跑 `pnpm test` 全绿
- [ ] 5.2 按 design 迁移计划备份并清理重复 dev 用户，上线后用真实账号走一次持口令登录验证归属
