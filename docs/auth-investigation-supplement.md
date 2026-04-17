> 本文件由 codearts-agent-auth-and-requuest-mechanism.md 拆分而来。


## 十二、补充调研记录（2026-04-14，explore）

### 12.1 调研方法

- 继续只读分析 `huaweicloud.authentication/dist/plugin.js` 与 `vscode-codebot/out/extension.js`。
- 重点追踪：
  - `ticket_id + identifier` 登录交换
  - `/v2/login/refresh` 的真实签名方式
  - `x-auth-token`、`cloudDragonToken`、`yx()` 的关系
  - `platformApi.getSseGlobalCredentialClient()` 的作用边界

### 12.2 代码实锤：登录与刷新真实接口

在认证扩展中确认：

- 登录交换：`POST ${apiHost}/v2/login/ticket`
  - body：`{ ticket_id, identifier }`
  - 证据：`code-base/CodeArts Agent/resources/app/extensions/huaweicloud.authentication/dist/plugin.js:99637`
- 刷新接口：`POST ${apiHost}/v2/login/refresh`
  - body：`{ duration_seconds: 86400 }`
  - 证据：`code-base/CodeArts Agent/resources/app/extensions/huaweicloud.authentication/dist/plugin.js:99684`

这说明文档中的机制描述是对的，但实际代码使用的接口路径应以这里为准。

### 12.3 代码实锤：refresh 依赖 AK/SK/ST 签名

`refreshToken(e)` 会构造请求头：

- `X-Security-Token: e.securitytoken`
- `Access-Key: e.accessKey`
- `Content-Type: application/json`

随后通过 `sign(req, e.accessKey, e.secretKey)` 签名。

证据：`code-base/CodeArts Agent/resources/app/extensions/huaweicloud.authentication/dist/plugin.js:99691-99703`

结论：

- 若代理想托管自动续期，服务端必须安全保存并加密存储：
  - `accessKey`
  - `secretKey`
  - `securitytoken`
  - `expires_at`

### 12.4 代码实锤：存在另一层 X-Auth-Token 体系

认证扩展里还存在：

- `POST ${iamHost}/v3.0/OS-CREDENTIAL/securitytokens`
- 使用 header：`X-Auth-Token: <token>`

证据：`code-base/CodeArts Agent/resources/app/extensions/huaweicloud.authentication/dist/plugin.js:99665-99680`

结论：

- 系统内部至少存在“两层认证”：
  1. 上层 `X-Auth-Token`
  2. 下层 `AK/SK + X-Security-Token`

### 12.5 codebot 侧：chat/SSE 走业务 token，不直接走 AK/SK

在 `vscode-codebot/out/extension.js` 中发现：

- SSE 请求统一经由 `au.instance.platformApi?.getSseGlobalCredentialClient()` 发起
  - 证据：`code-base/CodeArts Agent/resources/app/extensions/vscode-codebot/out/extension.js:9487`
- chat 主链路调用时显式传入：`token: await yx()`
  - 证据：`code-base/CodeArts Agent/resources/app/extensions/vscode-codebot/out/extension.js:9497`
- code review 调用时，直接从 `au.instance.getUserInfo()` 拿 `cloudDragonToken`，放入 `x-auth-token`
  - 证据：`code-base/CodeArts Agent/resources/app/extensions/vscode-codebot/out/extension.js:8766-8767`
- 知识库调用时，也直接使用 `HuaweiUser.instance.info?.cloudDragonToken` 作为 `X-Auth-Token`
  - 证据：`code-base/CodeArts Agent/resources/app/extensions/vscode-codebot/out/extension.js:184`

当前高概率结论：

- `yx()` 返回值与 `cloudDragonToken` 同源或等价。
- `x-auth-token` 是业务 token，用于 snap/chat/review/rag 等业务域。
- 它与 `AK/SK/securitytoken` 不是一个层级。

### 12.6 当前阶段建模结论

若后续实现“多用户 + 每用户多华为云账号 + OpenAI 兼容代理”，至少需要管理两类凭据：

1. **业务 token 类**
   - `cloudDragonToken` 或与 `yx()` 等价的 token
   - 用于 chat/sse/review/rag 等业务请求

2. **底层会话类**
   - `accessKey`
   - `secretKey`
   - `securitytoken`
   - `expires_at`
   - 用于 refresh 与签名类接口

且所有缓存、刷新锁、会话状态都应以 `provider_account_id` 为隔离单位，避免多账号串用。

### 12.7 新增确认：`vscode.getUserInfo` 位于 IDE 宿主认证层

继续跨到 IDE 宿主层 `app/out` 后，可以确认：

- `VSCODE_GET_USER_INFO_COMMAND = "vscode.getUserInfo"`
  - 证据：`code-base/CodeArts Agent/resources/app/out/main.js:35392-35401`
  - 证据：`code-base/CodeArts Agent/resources/app/out/vs/workbench/workbench.desktop.main.js:242272-242276`
- 扩展侧执行该命令时有单独授权判断：
  - `extensionHostProcess.js:82573-82580`
- `vscode-codebot` 中的 `HuaweiUser.getUserInfoByVscode()` 实际就是：
  - `commands.executeCommand("vscode.getUserInfo")`
  - 证据：`docs/prettified/vscode-codebot.extension.copy.js:52683-52689`

这说明：

- `vscode.getUserInfo` 是宿主内建认证命令，不是 `vscode-codebot` 自己注册的普通命令。
- `HuaweiUser.instance.info` 的数据源来自 IDE 宿主认证层。

### 12.8 新增确认：`yx()` 只是 token 选择器，不是 token 生产点

在 prettified 副本中已经能直接读到 `yx()`：

- `docs/prettified/vscode-codebot.extension.copy.js:157644-157656`

逻辑为：

- 先 `await au.instance.getUserInfo()`
- 默认 token 模式返回 `developersToken`
- inner version 返回 `e.cloudDragonToken`
- HCS 版本返回 `getHcsToken()`

因此：

- `chat -> yx() -> getUserInfo().cloudDragonToken`
- `yx()` 并不负责换取业务 token
- 真正的业务 token 生产点仍在更上游的宿主认证层

### 12.9 新增确认：宿主层缓存用户信息，并单独维护 `CloudDragonToken`

在宿主认证服务里：

- `NativeAuthenticationService.getUserInfo()` 只是返回 `_w3UserInfo`
- `setUserInfo(value)` 只是写入 `_w3UserInfo`
- 证据：`code-base/CodeArts Agent/resources/app/out/main.js:47823-47828`

在 workbench 登录状态更新时：

- 会执行 `VSCODE_GET_USER_INFO_COMMAND`
- 若返回对象含 `name`，就 `nativeAuthenticationService.setUserInfo(userInfo2)`
- 证据：`code-base/CodeArts Agent/resources/app/out/vs/workbench/workbench.desktop.main.js:411126-411135`

同时宿主层还明确维护：

- `W3_TOKEN_KEYS.CloudDragonToken`
- `onDidChangeCloudDragonToken`
- 证据：`411114-411115`, `315554-315555`

并且业务请求会直接从 secret storage 读取这个 token：

- `authenticationService.getPassword(HW_AUTH_EXTENSION_ID, W3_TOKEN_KEYS.CloudDragonToken)`
- 然后注入 `x-auth-token`
- 证据：`417064-417067`

这说明：

- `cloudDragonToken` 是宿主认证层统一缓存/分发的业务 token
- 不只 `vscode-codebot` 用它，IDE 宿主自己的业务流也直接依赖它

### 12.10 新增发现：`vscode-codebot` 中存在一条本地登录获取 `cloudDragonToken` 的分支

在 prettified 的 `vscode-codebot` 副本中还能看到：

- `requestCloudDragonToken(password)` 会调用 `getLocalLoginUrl()`
- POST 请求体包含：
  - `appName: "vscodehuawei"`
  - `user`
  - `password`
  - `requireUserInfo: true`
- 成功后把：
  - `t.cloudDragonTokens.authToken`
  - 赋给 `this.cloudDragonToken`
- 证据：`docs/prettified/vscode-codebot.extension.copy.js:1236742-1236797`

这说明：

- `cloudDragonToken` 至少有一种明确的返回字段形态：`cloudDragonTokens.authToken`
- 但这更像 `vscode-codebot` 内的一条本地/W3 登录兜底分支
- 目前还不能直接证明它就是当前宿主 `vscode.getUserInfo` 主链路背后的真实来源

### 12.11 新增确认：当前能坐实的 `cloudDragonToken` 存储链在 `vscode-codebot globalState`

继续追 prettified 副本后确认：

- 插件会从 `globalState` 读取：
  - `userId`
  - `department`
  - `cloudDragonToken`
  - 证据：`docs/prettified/vscode-codebot.extension.copy.js:1236598-1236605`
- 登录成功后会回写：
  - `globalState.update("cloudDragonToken", this.cloudDragonToken)`
  - 证据：`docs/prettified/vscode-codebot.extension.copy.js:1236607-1236617`

同时还存在一条完整用户对象存储链：

- `storeUserInfo(...)` 写入 `_userInfoKey`
- `getUserInfo(...)` 优先从 `_userInfoKey` 读取
- 证据：`docs/prettified/vscode-codebot.extension.copy.js:1215318-1215332`

这说明：

- 当前仓库中能明确看见的 `cloudDragonToken` 写入动作，发生在 `vscode-codebot` 自己的 `globalState`
- 还没找到它显式写入 IDE 宿主 `secretStorage` 的代码

### 12.12 新增确认：`vscode.getUserInfo` 不是读宿主缓存，而是先产出结果再回写缓存

继续追宿主层后可以确认：

- 当前仓库里没有找到 `CommandsRegistry.registerCommand("vscode.getUserInfo", ...)` 这种显式注册代码。
- 但能定位到最接近的处理入口：
  - 扩展宿主特判并授权包装：
    - `app/out/vs/workbench/api/node/extensionHostProcess.js:82573-82580`
  - 然后转发到 workbench command service：
    - `app/out/vs/workbench/workbench.desktop.main.js:264713-264724`

同时还能确认：

- `loginStateUpdate(HW_AUTH_ID, ...)` 时，会先执行 `vscode.getUserInfo`
- 再把返回的 `userInfo2` 写入 `nativeAuthenticationService.setUserInfo(userInfo2)`
- 证据：`app/out/vs/workbench/workbench.desktop.main.js:411129-411135`

- `nativeAuthenticationService.getUserInfo()/setUserInfo()` 只是对 `_w3UserInfo` 的简单缓存访问
- 证据：`app/out/main.js:47823-47828`

这说明：

- `_w3UserInfo` 不是 `vscode.getUserInfo` 的原始来源，而是它的缓存落点。
- `vscode.getUserInfo` 的更底层返回对象来自另一条宿主内建实现，但当前还没精确落到注册代码。

### 12.13 新增判断：扩展 `globalState` 与宿主 `_w3UserInfo` 更像并行缓存

当前证据更支持下面这个判断：

- `vscode-codebot` 自己维护：
  - `globalState["userInfoKey"]`
  - `globalState["userInfo"]`
- IDE 宿主维护：
  - `nativeAuthenticationService._w3UserInfo`

但当前仓库里没有找到：

- 从扩展 `globalState` 直接桥接到 `nativeAuthenticationService.setUserInfo(...)` 的代码

因此目前更合理的结论是：

- 两边像是并行的缓存/持久化副本
- 还不能证明 `vscode.getUserInfo` 直接返回扩展 `globalState` 中的对象

### 12.14 新增确认：认证扩展原始 session 结构不含 `cloudDragonToken`

继续回到 `huaweicloud.authentication/dist/plugin.js` 验证 session 返回结构后，可以确认：

- 认证扩展 `getSessions(...)` 实际返回的是：
  - 对受信内置扩展：`toSessionWhichContainsAKSK(authentication)`
  - 对其他调用方：`toSession(authentication)`
  - 证据：`huaweicloud.authentication/dist/plugin.js:46323-46335`
- `toSessionWhichContainsAKSK(...)` 中包含：
  - `accessToken`
  - `domainId`
  - `expiresAt`
  - `accessKey`
  - `secretKey`
  - `securityToken`
  - 证据：`huaweicloud.authentication/dist/plugin.js:99543-99558`
- `toSession(...)` 中只包含：
  - `accessToken`
  - `domainId`
  - `expiresAt`
  - 证据：`huaweicloud.authentication/dist/plugin.js:99560-99570`

这说明：

- 认证扩展当前能直接返回的原始 session 对象里，没有 `cloudDragonToken` 字段。
- 所以 `cloudDragonToken` 不是这层认证扩展 session 序列化时直接产出的字段。

### 12.15 新增矛盾点：宿主业务代码却直接使用 `sessions[0].cloudDragonToken`

与此同时，宿主层多个位置又直接这样取 token：

- `const sessions = await this.authenticationService.getSessions(HW_AUTH_ID, [], true)`
- `const cloudDragonToken = sessions.length ? sessions[0].cloudDragonToken : void 0`
- 然后注入 `x-auth-token`

证据：

- `app/out/vs/workbench/workbench.desktop.main.js:418498-418507`
- `app/out/vs/code/node/cliProcessMain.js:21927-21936`
- `app/out/vs/code/electron-utility/sharedProcess/sharedProcessMain.js:24481-24490`

这说明：

- 宿主业务层明确预期 `HW_AUTH_ID` 的 session 上最终可以访问 `cloudDragonToken`。
- 但认证扩展原始 `toSession()/toSessionWhichContainsAKSK()` 并不返回这个字段。
- 因此，在“认证扩展返回 session”到“宿主业务消费 session.cloudDragonToken”之间，仍然存在一层尚未定位的宿主补写/桥接逻辑。

### 12.16 当前最稳新判断：`cloudDragonToken` 更像登录后补出的业务认证态

把这一轮证据拼起来后，当前更稳的判断是：

- 登录主链先产出的是 AK/SK/ST/expiresAt 这类底层会话凭据。
- `cloudDragonToken` 并不是 `huaweicloud.authentication` 当前原始 session 返回结构里的字段。
- 宿主或其他更底层认证桥接层，后续又生成、补写、缓存了 `cloudDragonToken`。

因此当前更应优先追：

- 谁在宿主层给 `userInfo` 或 `session` 补上了 `cloudDragonToken`
- 谁把 `CloudDragonToken` 写进了宿主 secret storage
- 这两条链是否实际来自同一个上游接口/服务

### 12.17 新增确认：CodeArts IDE 场景下 `vscode-codebot` 实际还依赖 `CodeArtsContextService`

继续读 prettified `vscode-codebot` 后，可以确认在 CodeArts IDE 场景下还有一层更底层桥接：

- `au.instance` 初始化时会设置 `_platformApi`
- 在非纯 VS Code 场景下，还会把 `_loginAPI` 指向 `@codearts/plugin` 暴露的 login manager
- 证据：`docs/prettified/vscode-codebot.extension.copy.js:1215270-1215275`

更关键的是：

- `getLoginManager().getLoginInfo()` 实际返回：
  - `CodeArtsContextService.getLoginService().getUserInfo()`
- `getLoginManager().getAKSKInfo()` 实际返回：
  - `CodeArtsContextService.getLoginService().getAKSKInfo()`
- 证据：`docs/prettified/vscode-codebot.extension.copy.js:134587-134599`

这说明：

- 在 CodeArts IDE 内，`vscode-codebot` 不只是调用 `vscode.getUserInfo`
- 还依赖一层 `@codearts/plugin -> CodeArtsContextService -> LoginService` 的宿主桥接 API

### 12.18 新增确认：`CodeArtsContextService.LoginService` 当前可见实现只稳产出基础用户信息和 AKSK

当前可直接读到的 `LoginService` 实现里：

- 通过 `authentication.getSession(CODEARTS_SESSION_ID, [""])` 获取登录 session
- 用 `transferSessionToUserInfo(session)` 生成基础用户对象
- 再通过 `CodeArtsContextService.getApiService().getUserProjects()` 补项目列表
- 通过 `CodeArtsContextService.getApiService().getUserAkSk()` 补 AKSK 信息
- 证据：`docs/prettified/vscode-codebot.extension.copy.js:118793-118873`

其中 `transferSessionToUserInfo(session)` 当前可见字段只有：

- `id`
- `name`
- `projects`
- `links`
- `loginType: "codearts"`
- 证据：`docs/prettified/vscode-codebot.extension.copy.js:118852-118861`

这说明：

- 当前这份 `LoginService` 可见实现本身也没有显式产出 `cloudDragonToken`
- 它更像“基础用户态 + AKSK/IAM 能力”封装

### 12.19 新增确认：`CodeArtsContextService.ApiService` 走的是 HC/IAM/AKSK 宿主请求器，不是 `cloudDragonToken` 业务线

`CodeArtsContextService.ApiService` 里当前能直接看到：

- `getUserProjects()` -> `GET https://iam.myhuaweicloud.com/v3/projects`
- `getUserAkSk()` -> `POST https://iam.myhuaweicloud.com/v3.0/OS-CREDENTIAL/securitytokens`
- `getDomainId()` -> `GET https://iam.myhuaweicloud.com/v3/auth/domains`
- 三者都通过 `@codearts/plugin.authentication.huaweiCloudRequest(...)` 发起
- 证据：`docs/prettified/vscode-codebot.extension.copy.js:108485-108537`

再对照宿主层：

- `huaweiCloudRequest(...)` 最终走到：
  - `extHostAuthentication.$request(...)`
  - `MainThreadAuthentication.$request(...)`
  - `huaweiRequestService.request(...)`
- 而 `MainThreadAuthentication.$request(...)` 里使用的是：
  - `HC_AUTH_ID`
  - 不是 `HW_AUTH_ID`
- 证据：
  - `app/out/vs/workbench/api/node/extensionHostProcess.js:82514-82528`
  - `app/out/vs/workbench/workbench.desktop.main.js:315791-315806`

这说明：

- `CodeArtsContextService` 这套 API 明确属于 HC/IAM/AKSK 线
- 它与宿主/业务侧直接使用的 `cloudDragonToken` 不是同一条认证链

### 12.20 当前最新判断：缺失的是两条宿主认证态的合流点

把这一轮证据拼起来后，当前最稳判断变成：

- `huaweicloud.authentication` 原始 session 不直接返回 `cloudDragonToken`
- `CodeArtsContextService.LoginService` 当前可见实现也不直接返回 `cloudDragonToken`
- 但 `vscode-codebot` 与宿主业务层最终又都广泛依赖 `userInfo.cloudDragonToken` / `session.cloudDragonToken`

因此当前最关键的缺口是：

- 谁在宿主更底层把 HC/IAM/AKSK 登录态与 HW/W3/business token 登录态合流
- 谁给最终的 `userInfo` 或 `session` 补上了 `cloudDragonToken`
- 谁把这个 token 同步写进了宿主 `secretStorage(CloudDragonToken)`

### 12.21 新增确认：宿主 `HuaweiRequestService` 内部已经明确区分 HC 签名头与 HW 业务 token 头

继续追宿主请求器后，可以把认证头策略明确下来：

- `HuaweiRequestService.getHeaders(entity)` 的顺序是：
  - 先尝试 `getSignedHeaders(...)`
  - 拿不到再尝试 `getXAuthToken(...)`
  - 最后无论前面如何，再执行 `getW3AuthHeaders(headers)`
- 证据：`app/out/vs/workbench/workbench.desktop.main.js:416969-416991`

其中：

- `getSignedHeaders(...)` 负责 HC/HCS 侧 AK/SK 签名头
  - HCS 模式读 `getSessions(HCS_AUTH_ID, ...)`
  - 其他模式读 `getPassword(HC_AUTH_EXTENSION_ID, SESSION_KEY)`
  - 证据：`app/out/vs/workbench/workbench.desktop.main.js:416997-417048`
- `getW3AuthHeaders(...)` 只在 `Scenario.HW` 下工作
  - 它会从 `getPassword(HW_AUTH_EXTENSION_ID, W3_TOKEN_KEYS.CloudDragonToken)` 读取 token
  - 然后补 `x-auth-token`
  - 证据：`app/out/vs/workbench/workbench.desktop.main.js:417055-417073`

这说明：

- 宿主请求器内部本身就把 HC/IAM/AKSK 线与 HW/W3/business token 线拆成了两个阶段
- `cloudDragonToken` 在宿主请求器中是“最后阶段附加的业务 token”，不是签名凭证

### 12.22 新增确认：宿主中 `cloudDragonToken` 至少被同步到三个缓存面

当前宿主代码里，`cloudDragonToken` 至少存在三种并行消费面：

1. `secretStorage`

- `getPassword(HW_AUTH_EXTENSION_ID, W3_TOKEN_KEYS.CloudDragonToken)`
- 证据：`app/out/vs/workbench/workbench.desktop.main.js:417064-417066`

2. `userInfo`

- 多处 `executeCommand(VSCODE_GET_USER_INFO_COMMAND, ...)` 后直接读取 `userInfo2.cloudDragonToken`
- 证据：
  - `418965-418979`
  - `419440-419449`
  - `420307-420313`

3. `sessions(HW_AUTH_ID)`

- 多处 `getSessions(HW_AUTH_ID, [], true)` 后直接读取 `sessions[0].cloudDragonToken`
- 证据：`418498-418507`

这说明：

- 宿主业务层并不是只认一个来源
- 更像是同一个 `cloudDragonToken` 被同步到了：
  - `secretStorage`
  - `userInfo`
  - `HW_AUTH_ID session`

### 12.23 新增确认：`huaweicloud.authentication` 仍只持久化自己的 `HuaweiCloudSession`

再次回看认证扩展后，当前仍只能确认它持久化的是：

- `HuaweiCloudSession`
- 相关操作是：
  - `secretStorage.get(this.sessionSymbol)`
  - `secretStorage.store(this.sessionSymbol, JSON.stringify(...))`
  - `secretStorage.delete(this.sessionSymbol)`
- 证据：`huaweicloud.authentication/dist/plugin.js:46114`, `46257`, `46280-46283`, `46301`

到目前为止依然没有找到：

- `CloudDragonToken`
- `setPassword(...HW_AUTH_EXTENSION_ID, CloudDragonToken, ...)`
- `secrets.store(...CloudDragonToken...)`

这说明：

- 当前能看到的认证扩展持久化只覆盖它自己的登录 session
- `CloudDragonToken` 更可能来自宿主 runtime、内建命令实现，或当前仓库快照里未展开的更底层桥接层

### 12.24 新增关键矛盾：认证扩展注册的 provider id 与宿主 HW 业务消费的 provider id 不一致

这是当前阶段最关键的新证据之一。

在 `huaweicloud.authentication` 扩展内部，当前能直接读到：

- `HuaweiCloudAuthenticationProvider._id = "huawei-cloud-authentication"`
- 启动时注册：
  - `authentication.registerAuthenticationProvider(HuaweiCloudAuthenticationProvider._id, ...)`
- 证据：
  - `huaweicloud.authentication/dist/plugin.js:46891-46892`
  - `huaweicloud.authentication/dist/plugin.js:99845-99852`

而宿主层常量又明确区分：

- `HC_AUTH_ID = "huawei-cloud-authentication"`
- `HW_AUTH_ID = "huawei-authentication"`
- 证据：`app/out/vs/workbench/workbench.desktop.main.js:241595`, `241605`

同时宿主 HW 业务代码直接消费的是：

- `getSessions(HW_AUTH_ID, [], true)`
- 即 `getSessions("huawei-authentication", [], true)`
- 证据：`app/out/vs/workbench/workbench.desktop.main.js:418498-418499`

这说明：

- `huaweicloud.authentication` 扩展直接注册出来的是 HC 那条 provider：`huawei-cloud-authentication`
- 宿主 HW 业务层消费的却是另一条 provider：`huawei-authentication`
- 两者不是同一个 provider id

因此当前最稳的新判断是：

- 宿主读取 `HW_AUTH_ID` session 时，拿到的并不是 `huaweicloud.authentication` 扩展原始 provider 直接返回的结果
- 在认证扩展与宿主 HW 业务消费层之间，仍然存在另一层 provider、映射层，或宿主内建桥接实现
- `session.cloudDragonToken` 很可能正是在这一层被补出来

### 12.25 仍未完全确认的问题

- `vscode.getUserInfo` 的具体命令注册实现位置仍未精确落点。
- `cloudDragonToken` 是否直接来自 `/v2/login/ticket` 返回值，仍需继续追踪。
- `CloudDragonToken` 是谁写入宿主 secret storage 的，仍需继续追。
- prettified 中 `getLocalLoginUrl()` 登录分支与宿主 `vscode.getUserInfo` 主链路的关系，仍需继续追。
- `vscode-codebot globalState` 与 IDE 宿主 `secretStorage` 之间的桥接写入点，仍需继续追。
- `vscode-codebot globalState` 与宿主 `_w3UserInfo` 的直接桥接，仍需继续追。
- 宿主是在 `getSessions(HW_AUTH_ID, ...)` 过程中补写了 `session.cloudDragonToken`，还是上层调用方拿到 session 后又做了二次包装，仍未确认。
- `CodeArtsContextService.LoginService` 之外，是否还存在另一层隐藏的 `@codearts/plugin` / runtime 登录服务在回填 `cloudDragonToken`，仍未确认。
- 谁把同一个 `cloudDragonToken` 同步到了 `secretStorage`、`userInfo`、`HW_AUTH_ID session` 这三个宿主缓存面，仍未确认。
- `HW_AUTH_ID = "huawei-authentication"` 这条 provider 究竟由谁注册、谁产出 session，仍未确认。
- `platformApi.getSseGlobalCredentialClient()` 的实现可能位于其他 support/toolkit 扩展中，后续应继续跨扩展追查。