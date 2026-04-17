> 本文件由 codearts-agent-token-analysis.md 拆分而来。

# CodeArts Agent Token/认证链路调研记录（explore）

本文记录对 CodeArts Agent（VSCode 扩展）在认证、token 获取/刷新、以及 codebot（snap）侧请求头注入方式的调研过程与结论。当前为 explore 阶段：只读代码与文档，不做实现。

## 1. 调研目标

- 搭建一个**多用户**系统：每个用户可绑定**多个华为云账号**。
- 对外提供 **OpenAI 兼容接口**（例如 `/v1/chat/completions`，支持 stream），内部转发到华为云 CodeArts/snap-access 相关服务。
- 需要弄清：
  - 登录拿到的是什么凭据（AK/SK/ST? token?）
  - 自动刷新链路与定时策略
  - chat/snap 请求使用的 `x-auth-token` 与 `cloudDragonToken` 的来源
  - 不同业务域是否使用不同认证方式（token vs AK/SK 签名）

## 2. 调研过程（按证据链）

### 2.1 先读总体机制文档

阅读：`docs/codearts-agent-auth-and-requuest-mechanism.md`

结论（文档层面）：

- 认证扩展 `huaweicloud.authentication` 会在本地起一个回调服务 `127.0.0.1:动态端口`，接收 `/callback?identifier=...&redirect=...`。
- 登录会生成 ticket，并通过浏览器/重定向走到回调，然后用 `ticket_id + identifier` 交换会话。
- 自动刷新策略：
  - 刷新触发时间大致为 `expires_at - now - 2小时 - random(0..59)s`。
  - 刷新失败但未过期继续尝试；过期则注销。
- LLM 侧主要请求头会包含 `X-Auth-Token`、`X-Snap-Traceid` 等；chat 侧接口为 SSE。

### 2.2 读认证扩展实现：ticket 换会话、刷新

文件：`code-base/CodeArts Agent/resources/app/extensions/huaweicloud.authentication/dist/plugin.js`

关键点：

#### 2.2.1 登录 URL：redirect1 + ticket_id

- 生成 ticket：`WordArray.random(32).toString(enc.Hex)`
- 登录 URL：
  - 见 `plugin.js:95886-95901`
  - `redirect1?ticket_id=...&port=...&uri_scheme=...&is_redirect=true&...`

#### 2.2.2 ticket 换 Authentication（核心）

- `POST ${apiHost}/v2/login/ticket`，body：`{ ticket_id, identifier }`
- 见 `plugin.js:99637-99663`

#### 2.2.3 refresh：用 AK/SK + securitytoken 签名

- `POST ${apiHost}/v2/login/refresh`，body：`{duration_seconds: 86400}`
- headers：`X-Security-Token`, `Access-Key`, `Content-Type`
- 通过 `sign(req, accessKey, secretKey)` 签名
- 见 `plugin.js:99684-99705`

#### 2.2.4 token -> 临时凭据（OS-CREDENTIAL/securitytokens）

- `POST ${iamHost}/v3.0/OS-CREDENTIAL/securitytokens`，header：`X-Auth-Token: <token>`
- 见 `plugin.js:99665-99683`

> 这段很关键：认证体系里同时存在 `X-Auth-Token`（更上层的 token）与 `AK/SK + X-Security-Token`（更底层的临时安全凭证）两种机制。

### 2.3 读 codebot（snap）实现：SSE 发送与 token 注入

文件：`code-base/CodeArts Agent/resources/app/extensions/vscode-codebot/out/extension.js`

#### 2.3.1 SSE 请求统一从 platformApi client 发起

- `sendSSERequest(...)` 使用：`au.instance.platformApi?.getSseGlobalCredentialClient()`
- 见 `extension.js:9487`

说明：token/credential 的注入点很可能在 platformApi 或这个 credential client 内部。

#### 2.3.2 chat 主链路明确传 token: await yx()

- chat 发起时：`B8a(r.data, { token: await yx(), ... })`
- 见 `extension.js:9497`

这说明：chat 侧至少有一个抽象的 `yx()`，用于获取当前可用 token。

#### 2.3.3 业务侧大量直接使用 cloudDragonToken

- 例如知识库：
  - `HuaweiUser.instance.info?.cloudDragonToken` 用于 `X-Auth-Token`
  - 见 `extension.js:184`
- 例如 code review SSE：
  - `sendPostRequestWithRetry(..., s.cloudDragonToken)`
  - header：`x-auth-token: t`
  - 见 `extension.js:8766-8767`

#### 2.3.4 初步结论：x-auth-token 与 cloudDragonToken 关联

从调用形态看：

- SSE/chat 请求头使用 `x-auth-token`。
- 多处业务 API 直接把 `cloudDragonToken` 放进 `X-Auth-Token` 或 `x-auth-token`。
- chat 主链路传入 `token: await yx()`。

因此高概率：

- `yx()` 返回的 token 与 `cloudDragonToken` **同源或等价**。
- 该 token 与 AK/SK/ST **不是同一层级**（AK/SK/ST 用于 refresh 与签名类接口）。

## 3. 关键差异与补充结论（以代码为准）

### 3.1 refresh 与 ticket 接口域名（代码实锤）

文档里提到的域名与接口路径是"机制描述"，但在认证扩展代码中看到实际调用：

- `POST ${apiHost}/v2/login/ticket`
- `POST ${apiHost}/v2/login/refresh`

证据：`huaweicloud.authentication/dist/plugin.js:99637-99663`、`huaweicloud.authentication/dist/plugin.js:99684-99705`

> 这意味着后续代理实现不要只按文档接口清单推断，必须以实际请求为准。

### 3.2 IAM securitytokens 接口确实使用 X-Auth-Token

- `POST ${iamHost}/v3.0/OS-CREDENTIAL/securitytokens`
- header：`X-Auth-Token: <token>`

证据：`huaweicloud.authentication/dist/plugin.js:99665-99683`

推论：

- 系统内部存在一种"可用于 IAM 换取 AK/SK 的 token"。
- 该 token 是否与 codebot 侧 `cloudDragonToken` 同一个值，仍需继续追。

## 4. 当前阶段结果汇总

### 4.1 认证体系至少分两层

1. **业务 token 层**：`x-auth-token` / `X-Auth-Token`

- 在 codebot/snaps 的 SSE、知识库、review 等业务 API 中直接使用。
- 来源高度疑似：`HuaweiUser.instance.info.cloudDragonToken` 或 `yx()`。

2. **底层临时凭证层（AK/SK/ST）**：

- `accessKey` / `secretKey` / `securitytoken` / `expires_at`
- 用于：`/v2/login/refresh`（必需签名）
- 以及签名访问 IAM/项目列表等。

### 4.2 对服务端代理实现的含义（仅结论，不实现）

- 若要做到"自动续期"，必须保存并加密存储：
  - `secretKey`（最敏感）
  - `accessKey`
  - `securitytoken`
  - `expires_at`
- 同时必须保存并能刷新/重建业务 token：
  - `cloudDragonToken`（或 `yx()` 的返回值）
- 多用户、多账号时的核心隔离维度应是 **provider_account**：
  - 所有缓存与刷新锁以 `provider_account_id` 分片，避免串号。

### 4.3 新增确认：`yx()`、`vscode.getUserInfo` 与宿主认证层

这一轮继续追 `vscode-codebot`、prettified 副本，以及 IDE 宿主层 `app/out` 代码，已经确认以下事实：

#### 4.3.1 `yx()` 已精确定位

- 在 prettified 文件中，`yx()` 定义可直接读到：`docs/prettified/vscode-codebot.extension.copy.js:157644-157656`
- 核心逻辑：
  - `let e = await au.instance.getUserInfo()`
  - 如果 `isDefaultToken`：返回 `developersToken`
  - 如果 `isInnerVersion`：返回 `e.cloudDragonToken`
  - 如果 `isHcsVersion`：返回 `vu.getHcsLoginService().getHcsToken()`
  - 否则返回空串

结论：

- `yx()` 不是 token 生产点，只是 token 选择器。
- 在内网主路径下，`chat -> yx() -> au.instance.getUserInfo().cloudDragonToken`。

#### 4.3.2 `HuaweiUser.instance.info` 来自宿主命令 `vscode.getUserInfo`

- `docs/prettified/vscode-codebot.extension.copy.js:52683-52689`
- `HuaweiUser.getUserInfo()` 会执行：`commands.executeCommand("vscode.getUserInfo")`
- 返回值整体赋给 `this._info`

结论：

- `HuaweiUser.instance.info.cloudDragonToken` 不是 `vscode-codebot` 自己算出来的。
- 它来自 IDE 宿主命令 `vscode.getUserInfo` 的返回对象。

#### 4.3.3 `vscode.getUserInfo` 是 IDE 宿主内建命令

- 宿主层常量定义：
  - `code-base/CodeArts Agent/resources/app/out/main.js:35392-35401`
  - `code-base/CodeArts Agent/resources/app/out/vs/workbench/workbench.desktop.main.js:242272-242276`
- 扩展宿主对该命令有特殊授权判断：
  - `code-base/CodeArts Agent/resources/app/out/vs/workbench/api/node/extensionHostProcess.js:82573-82580`

结论：

- `vscode.getUserInfo` 不是普通业务扩展命令，而是 IDE 侧内建认证命令。
- 扩展调用它前会经过授权校验。

#### 4.3.4 宿主层缓存并分发用户信息与 `cloudDragonToken`

- 宿主认证服务只缓存 `_w3UserInfo`：
  - `code-base/CodeArts Agent/resources/app/out/main.js:47823-47828`
- workbench 侧 login 状态更新时会：
  - 执行 `commandService.executeCommand(VSCODE_GET_USER_INFO_COMMAND, ...)`
  - 若 `userInfo2?.name` 存在，则 `nativeAuthenticationService.setUserInfo(userInfo2)`
  - 证据：`code-base/CodeArts Agent/resources/app/out/vs/workbench/workbench.desktop.main.js:411126-411135`
- workbench 侧明确把 `cloudDragonToken` 视为受支持字段：
  - `DEFAULT_KEYS` 含 `nickname`、`hwDepartName1..6`、`cloudDragonToken`
  - 证据：`code-base/CodeArts Agent/resources/app/out/vs/workbench/workbench.desktop.main.js:411258-411277`
- 宿主 secret storage 对 `CloudDragonToken` 有专门键名和变更事件：
  - `W3_TOKEN_KEYS.CloudDragonToken`
  - `onDidChangeCloudDragonToken`
  - 证据：`code-base/CodeArts Agent/resources/app/out/vs/workbench/workbench.desktop.main.js:411114-411115`, `315554-315555`

结论：

- `vscode.getUserInfo` 返回的用户对象会被宿主层缓存为 `_w3UserInfo`。
- `cloudDragonToken` 同时还是宿主 secret storage 中的独立 token 键。
- 业务侧很多请求直接从宿主缓存用户对象或 secret storage 读取该 token。

#### 4.3.5 宿主层业务请求也直接读取 `CloudDragonToken`

- `HuaweiRequestService.getW3AuthHeaders(...)` 会直接从 secret storage 读取：
  - `authenticationService.getPassword(HW_AUTH_EXTENSION_ID, W3_TOKEN_KEYS.CloudDragonToken)`
  - 并注入 `x-auth-token`
  - 证据：`code-base/CodeArts Agent/resources/app/out/vs/workbench/workbench.desktop.main.js:417055-417073`
- 多个宿主功能在拿到 `userInfo2.cloudDragonToken` 后直接发业务请求：
  - 证据：`418965-418980`, `560918-560933`

结论：

- `cloudDragonToken` 不只是 `vscode-codebot` 使用；IDE 宿主自己的业务流也直接依赖它。
- 这进一步说明它是一个上游认证层统一分发的业务 token。

#### 4.3.6 发现一条额外的 `cloudDragonToken` 获取分支（疑似本地/W3 登录兜底）

在 prettified 的 `vscode-codebot` 副本中，还能看到一条直接获取 `cloudDragonToken` 的逻辑：

- `requestCloudDragonToken(password)` 会向 `xu.getInstance().getLocalLoginUrl()` 发起 POST
- 请求体包含：
  - `appName: "vscodehuawei"`
  - `password`
  - `requireUserInfo: true`
  - `user: this.userId`
- 如果成功，则：
  - `this.cloudDragonToken = t.cloudDragonTokens.authToken`
- 证据：`docs/prettified/vscode-codebot.extension.copy.js:1236742-1236797`

同一段代码里还存在：

- `getUserInfoFromPlugin()` 直接返回：
  - `cloudDragonToken`
  - `name`
  - `department`
  - `nickname`
- 证据：`docs/prettified/vscode-codebot.extension.copy.js:1236822-1236837`

当前判断：

- 这条链路说明 `cloudDragonToken` 至少存在一种"本地登录接口直接返回 `cloudDragonTokens.authToken`"的获取方式。
- 但它更像 `vscode-codebot` 内的一条 W3/本地登录兜底分支，不一定等于当前 `vscode.getUserInfo` 主路径。
- 因此它可以作为"`cloudDragonToken` 真实字段名与候选上游接口形态"的强证据，但不能直接等同于当前 IDE 宿主登录主链路。

#### 4.3.7 目前能坐实的存储链：`cloudDragonToken -> vscode-codebot globalState`

在 prettified 副本中还能确认：

- 插件启动后会从 `globalState` 读取：
  - `userId`
  - `department`
  - `cloudDragonToken`
  - 证据：`docs/prettified/vscode-codebot.extension.copy.js:1236598-1236605`
- 登录成功后会把这些值重新写回 `globalState`
  - `globalState.update("cloudDragonToken", this.cloudDragonToken)`
  - 证据：`docs/prettified/vscode-codebot.extension.copy.js:1236607-1236617`

同时，另一条 `au.instance` 用户态链也会把完整用户对象写入 `_userInfoKey`：

- `storeUserInfo(...)` 把用户对象写入 `this._context?.globalState.update(u._userInfoKey, x)`
- `getUserInfo(...)` 优先从该 `globalState` 读取并返回
- 证据：`docs/prettified/vscode-codebot.extension.copy.js:1215318-1215332`

结论：

- 当前仓库里，能明确坐实的 `cloudDragonToken` 存储位置是 `vscode-codebot` 自己的 `globalState`。
- 还不能坐实它在当前仓库中由谁显式写入了 IDE 宿主 `secretStorage` / `authenticationService.setPassword(..., CloudDragonToken, ...)`。

#### 4.3.8 当前对"宿主 secret storage 写入点"的最稳判断

继续全仓搜索后，仍未找到以下任一明确调用：

- `setPassword(...CloudDragonToken...)`
- `secrets.store(...CloudDragonToken...)`
- `context.secrets.store(...CloudDragonToken...)`

但可以确认宿主侧有完整消费链：

- 宿主监听 `CloudDragonToken` 的 secret 变更：
  - `app/out/vs/workbench/workbench.desktop.main.js:411092-411120`
- 宿主读取 `CloudDragonToken` 并注入业务请求：
  - `app/out/vs/workbench/workbench.desktop.main.js:417064-417067`
- 扩展宿主到 workbench 的通用 secret 写入通道是存在的：
  - `app/out/vs/workbench/api/node/extensionHostProcess.js:48673-48678`
  - `app/out/vs/workbench/workbench.desktop.main.js:317905-317912`

因此当前最稳结论是：

- 宿主 `secretStorage` 中的 `CloudDragonToken` 确实被消费，但当前仓库快照里看不到它的精确写入者。
- 现阶段更像是：
  - `vscode-codebot` 自己有一条看得见的 `globalState` 存储链
  - IDE 宿主另有一条看得见的 `secretStorage` 消费链
  - 两者之间的桥接写入点还未定位到

#### 4.3.9 当前对 `vscode.getUserInfo` 主路径的最稳判断

继续往宿主层追之后，可以进一步确认：

- 当前仓库里没有找到 `CommandsRegistry.registerCommand("vscode.getUserInfo", ...)` 这类显式注册代码。
- 当前能定位到的"最接近真实处理入口"是：
  - 扩展宿主在执行该命令前做专门授权包装
  - 然后转发给 workbench 的 command service

关键证据：

- 扩展宿主特判：
  - `app/out/vs/workbench/api/node/extensionHostProcess.js:82573-82580`
- workbench 命令执行转发：
  - `app/out/vs/workbench/workbench.desktop.main.js:264713-264724`

同时还能确认：

- `vscode.getUserInfo` 的原始返回值不是来自 `nativeAuthenticationService._w3UserInfo`
- 相反，是命令返回后再被写入 `_w3UserInfo` 作为宿主缓存

关键证据：

- 命令结果回写宿主缓存：
  - `app/out/vs/workbench/workbench.desktop.main.js:411129-411135`
- `nativeAuthenticationService.getUserInfo()/setUserInfo()` 只是简单缓存访问器：
  - `app/out/main.js:47823-47828`

结论：

- `vscode.getUserInfo` 返回的是"另一条宿主内建实现生成的用户对象"。
- `_w3UserInfo` 不是它的原始数据源，而是它的缓存落点。

#### 4.3.10 当前对"扩展 globalState 与宿主 userInfo 缓存关系"的最稳判断

继续比对后，当前更合理的判断是：

- `vscode-codebot` 的 `globalState["userInfoKey"]` / `globalState["userInfo"]`
- 宿主 `nativeAuthenticationService._w3UserInfo`

这两边更像是"并行缓存/持久化副本"，而不是已经证实的同一存储源。

目前没有找到以下桥接代码：

- 从扩展 `globalState.get("userInfoKey" / "userInfo")`
- 再调用宿主 `nativeAuthenticationService.setUserInfo(...)`

因此当前不能证明：

- `vscode.getUserInfo` 直接返回扩展 `globalState` 中的对象
- 或者扩展 `globalState` 会直接回灌到宿主 `nativeAuthenticationService`

#### 4.3.11 新增确认：认证扩展原始 session 不包含 `cloudDragonToken`

这一轮继续回到 `huaweicloud.authentication/dist/plugin.js` 验证 session 结构，结果比之前更明确：

- 认证扩展 `getSessions(...)` 的返回分两种：
  - 内置受信扩展拿 `toSessionWhichContainsAKSK(authentication)`
  - 其他路径拿 `toSession(authentication)`
  - 证据：`huaweicloud.authentication/dist/plugin.js:46323-46335`
- 其中 `toSessionWhichContainsAKSK(...)` 只包含：
  - `id`
  - `account`
  - `scopes`
  - `accessToken`
  - `domainId`
  - `expiresAt`
  - `accessKey`
  - `secretKey`
  - `securityToken`
  - 证据：`huaweicloud.authentication/dist/plugin.js:99543-99558`
- `toSession(...)` 只包含：
  - `id`
  - `account`
  - `scopes`
  - `accessToken`
  - `domainId`
  - `expiresAt`
  - 证据：`huaweicloud.authentication/dist/plugin.js:99560-99570`

结论：

- 认证扩展能直接返回的原始 session 结构里，看不到 `cloudDragonToken` 字段。
- 因此 `cloudDragonToken` 不是当前这份认证扩展登录结果直接暴露出来的字段。

#### 4.3.12 新增矛盾点：宿主业务代码却直接消费 `sessions[0].cloudDragonToken`

与此同时，宿主业务层又存在直接从 session 读取 `cloudDragonToken` 的代码：

- `workbench.desktop.main.js:418498-418507`
- `cliProcessMain.js:21927-21936`
- `sharedProcessMain.js:24481-24490`

这些位置都表现为：

- `const sessions = await this.authenticationService.getSessions(HW_AUTH_ID, [], true)`
- `const cloudDragonToken = sessions.length ? sessions[0].cloudDragonToken : void 0`
- 然后把它放进 `x-auth-token`

结论：

- 宿主侧显然预期 `HW_AUTH_ID` 的 session 上可以拿到 `cloudDragonToken`。
- 但认证扩展原始 `toSession()/toSessionWhichContainsAKSK()` 并不产出这个字段。
- 这说明在"认证扩展返回 session"与"宿主业务消费 session.cloudDragonToken"之间，仍然存在一层尚未定位的宿主补写/桥接逻辑。
- 这也进一步支持当前判断：`cloudDragonToken` 不是 `/v2/login/ticket` 直接完成的那层结果，而是后续另一层业务认证态补出来的概率更高。
