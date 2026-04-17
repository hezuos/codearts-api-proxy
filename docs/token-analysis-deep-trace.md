> 本文件由 codearts-agent-token-analysis.md 拆分而来。

#### 4.3.13 新增确认：CodeArts IDE 场景下 `vscode-codebot` 真实接的是 `CodeArtsContextService.getLoginService()`

继续回到 prettified `vscode-codebot` 后，可以更精确地区分 CodeArts IDE 场景与普通 VS Code 场景：

- `au.instance` 初始化时会 `setToolkitApi(...)`
- 在 CodeArts IDE 场景下，会把 `_loginAPI` 指向 `@codearts/plugin` 暴露的 login manager
- 证据：`docs/prettified/vscode-codebot.extension.copy.js:1215270-1215275`

更关键的是：

- `getLoginManager().getLoginInfo()` 实际返回：
  - `CodeArtsContextService.getLoginService().getUserInfo()`
- `getLoginManager().getAKSKInfo()` 实际返回：
  - `CodeArtsContextService.getLoginService().getAKSKInfo()`
- 证据：`docs/prettified/vscode-codebot.extension.copy.js:134587-134599`

结论：

- 在 CodeArts IDE 内，`vscode-codebot` 的登录态并不只是靠 `vscode.getUserInfo`。
- 更底层还存在一套 `@codearts/plugin -> CodeArtsContextService -> LoginService` 的宿主桥接层。

#### 4.3.14 新增确认：`CodeArtsContextService.LoginService` 当前可见实现只稳产出基础用户信息和 AKSK

当前在 prettified 中能直接读到 `LoginService` 的实现：

- `getUserInfo()` 返回 `ReplaySubject userInfo$`
- `getAKSKInfo()` 返回 `ReplaySubject akskInfo$`
- 初始化时会监听：`authentication.onDidChangeSessions`
- 然后通过：
  - `authentication.getSession(CODEARTS_SESSION_ID, [""])`
  - `transferSessionToUserInfo(session)`
  - `CodeArtsContextService.getApiService().getUserProjects()`
  - `CodeArtsContextService.getApiService().getUserAkSk()`
  - 来更新 `userInfo$` 与 `akskInfo$`
- 证据：`docs/prettified/vscode-codebot.extension.copy.js:118793-118873`

其中 `transferSessionToUserInfo(session)` 当前可见字段只有：

- `id`
- `name`
- `projects`
- `links`
- `loginType: "codearts"`
- 证据：`docs/prettified/vscode-codebot.extension.copy.js:118852-118861`

结论：

- 当前能直接读到的 `CodeArtsContextService.LoginService` 实现，本身也没有显式产出 `cloudDragonToken`。
- 它更像是"基础用户态 + AKSK/IAM 能力"的封装。

#### 4.3.15 新增确认：`CodeArtsContextService.ApiService.getUserAkSk()` 走的是宿主 `huaweiCloudRequest` / IAM 线，不是 `cloudDragonToken` 线

继续往下读 `CodeArtsContextService.ApiService` 后可以确认：

- `getUserProjects()` 通过 `@codearts/plugin.authentication.huaweiCloudRequest(...)` 请求：
  - `GET https://iam.myhuaweicloud.com/v3/projects`
- `getUserAkSk()` 通过同一个宿主请求器请求：
  - `POST https://iam.myhuaweicloud.com/v3.0/OS-CREDENTIAL/securitytokens`
- `getDomainId()` 通过同一个宿主请求器请求：
  - `GET https://iam.myhuaweicloud.com/v3/auth/domains`
- 证据：`docs/prettified/vscode-codebot.extension.copy.js:108485-108537`

再对照宿主层：

- `@codearts/plugin.authentication.huaweiCloudRequest()` 最终落到：
  - `extHostAuthentication.$request(...)`
  - `MainThreadAuthentication.$request(...)`
  - `huaweiRequestService.request(...)`
- 而 `MainThreadAuthentication.$request(...)` 这里校验和读取的是：
  - `HC_AUTH_ID`
  - 不是 `HW_AUTH_ID`
- 证据：
  - `app/out/vs/workbench/api/node/extensionHostProcess.js:82514-82528`
  - `app/out/vs/workbench/workbench.desktop.main.js:315791-315806`

结论：

- `CodeArtsContextService` 这套 API 走的是 HC/IAM/AKSK 宿主请求器。
- 它与 `cloudDragonToken` 所在的 HW/W3 业务 token 线不是同一条链。
- 当前仓库里至少已经能明确看到两条并行认证态：
  - HC/IAM/AKSK 线
  - HW/W3/cloudDragonToken 线

#### 4.3.16 当前最新判断：真正缺失的是两条宿主认证态的"合流点"

把当前所有证据拼起来后，现阶段最稳的判断变成：

- `huaweicloud.authentication` 原始 session 不直接返回 `cloudDragonToken`
- `CodeArtsContextService.LoginService` 当前可见实现也不直接返回 `cloudDragonToken`
- 但 `vscode-codebot` 和宿主业务层最终都广泛依赖 `userInfo.cloudDragonToken` / `session.cloudDragonToken`

因此当前最关键、也是仍未定位到的缺口是：

- 谁在宿主更底层把 HC/IAM/AKSK 登录态与 HW/W3/business token 登录态合流
- 谁给最终的 `userInfo` 或 `session` 补上了 `cloudDragonToken`
- 谁把这个 token 同步写入了宿主 `secretStorage(CloudDragonToken)`

#### 4.3.17 新增确认：宿主 `HuaweiRequestService` 里 HC 与 HW 认证头是分阶段叠加的

继续往宿主请求器里读后，可以把认证头拼装策略明确下来：

- `HuaweiRequestService.getHeaders(entity)` 的顺序是：
  - 先尝试 `getSignedHeaders(...)`
  - 拿不到再尝试 `getXAuthToken(...)`
  - 最后无论前面结果如何，都再执行 `getW3AuthHeaders(headers)`
- 证据：`app/out/vs/workbench/workbench.desktop.main.js:416969-416991`

更具体地：

- `getSignedHeaders(...)` 会读取 HC/HCS 凭证并生成 AK/SK 签名头
  - HCS 模式：`getSessions(HCS_AUTH_ID, ...)`
  - 其他模式：`getPassword(HC_AUTH_EXTENSION_ID, SESSION_KEY)`
  - 证据：`app/out/vs/workbench/workbench.desktop.main.js:416997-417048`
- `getW3AuthHeaders(...)` 只在 `Scenario.HW` 下工作
  - 它会从 `getPassword(HW_AUTH_EXTENSION_ID, W3_TOKEN_KEYS.CloudDragonToken)` 读取 token
  - 然后无条件叠加 `x-auth-token`
  - 证据：`app/out/vs/workbench/workbench.desktop.main.js:417055-417073`

结论：

- 宿主通用请求器内部本身就把 HC/IAM/AKSK 线与 HW/W3/business token 线分成了两个阶段。
- `cloudDragonToken` 在这里不是签名凭证，而是最后阶段额外补上的业务 token。

#### 4.3.18 新增确认：宿主中 `cloudDragonToken` 至少被同步到三个缓存面

当前宿主代码里，`cloudDragonToken` 至少存在三种被消费的"缓存面"：

1. `secretStorage`

- `getPassword(HW_AUTH_EXTENSION_ID, W3_TOKEN_KEYS.CloudDragonToken)`
- 证据：`app/out/vs/workbench/workbench.desktop.main.js:417064-417066`

2. `userInfo`

- 多处直接 `executeCommand(VSCODE_GET_USER_INFO_COMMAND, ...)` 后读取 `userInfo2.cloudDragonToken`
- 证据：
  - `418965-418979`
  - `419440-419449`
  - `420307-420313`

3. `sessions(HW_AUTH_ID)`

- 多处直接 `getSessions(HW_AUTH_ID, [], true)` 后读取 `sessions[0].cloudDragonToken`
- 证据：`418498-418507`

结论：

- 宿主业务并不是只依赖一种来源。
- 更像是同一个 `cloudDragonToken` 被同步到了：
  - `secretStorage`
  - `userInfo`
  - `HW_AUTH_ID session`
- 因此当前最值得追的已不是消费点，而是"谁在宿主更底层把它同步到这三个缓存面"。

#### 4.3.19 新增确认：`huaweicloud.authentication` 当前只写自己的 `HuaweiCloudSession`，仍看不到 `CloudDragonToken`

再次回看认证扩展后，可以进一步确认：

- 扩展只把登录态写进自己的 secretStorage 键：`HuaweiCloudSession`
- 相关操作只有：
  - `secretStorage.get(this.sessionSymbol)`
  - `secretStorage.store(this.sessionSymbol, JSON.stringify(...))`
  - `secretStorage.delete(this.sessionSymbol)`
- 证据：`huaweicloud.authentication/dist/plugin.js:46114`, `46257`, `46280-46283`, `46301`

并且到当前为止仍然没有找到：

- `CloudDragonToken`
- `setPassword(...HW_AUTH_EXTENSION_ID, CloudDragonToken, ...)`
- `secrets.store(...CloudDragonToken...)`

结论：

- `huaweicloud.authentication` 当前能看到的持久化只覆盖它自己的 `HuaweiCloudSession`。
- `CloudDragonToken` 大概率不是这个扩展直接写入宿主 `secretStorage` 的。
- 更可能来自宿主 runtime、内建命令实现，或当前仓库快照里未展开的更底层桥接层。

#### 4.3.20 新增关键矛盾：认证扩展注册的 provider id 与宿主 HW 业务消费的 provider id 不是同一个值

这是当前最关键的新发现之一。

在 `huaweicloud.authentication` 扩展里，当前可直接读到：

- `HuaweiCloudAuthenticationProvider._id = "huawei-cloud-authentication"`
- 扩展启动时注册：
  - `authentication.registerAuthenticationProvider(HuaweiCloudAuthenticationProvider._id, ...)`
- 证据：
  - `huaweicloud.authentication/dist/plugin.js:46891-46892`
  - `huaweicloud.authentication/dist/plugin.js:99845-99852`

而宿主层常量里又明确写着：

- `HC_AUTH_ID = "huawei-cloud-authentication"`
- `HW_AUTH_ID = "huawei-authentication"`
- 证据：`app/out/vs/workbench/workbench.desktop.main.js:241595`, `241605`

同时宿主 HW 业务代码消费的是：

- `getSessions(HW_AUTH_ID, [], true)`
- 也就是 `getSessions("huawei-authentication", [], true)`
- 证据：`app/out/vs/workbench/workbench.desktop.main.js:418498-418499`

结论：

- `huaweicloud.authentication` 扩展直接注册出来的 provider，是 HC 那条：`huawei-cloud-authentication`
- 但宿主 HW 业务层消费的 provider，是另一条：`huawei-authentication`
- 这两者不是同一个 provider id
- 因此宿主读取 `HW_AUTH_ID` session 时，拿到的并不是 `huaweicloud.authentication` 扩展原始 provider 直接返回的结果

这基本坐实了一个新判断：

- 在 `huaweicloud.authentication` 扩展与宿主 `HW_AUTH_ID` 消费层之间，仍然存在另一层 provider、映射层，或宿主内建桥接实现
- `session.cloudDragonToken` 更可能正是在这一层被补出来

### 4.4 尚未确认的问题（下一步调研）

- `vscode.getUserInfo` 在宿主层的具体命令注册实现位置仍未精确落点。
- `cloudDragonToken` 是谁写入宿主 secret storage 的：
  - 是否由 `huaweicloud.authentication` 扩展写入。
  - 是否由更底层 toolkit/native auth provider 写入。
- prettified 中 `getLocalLoginUrl()` 这条本地登录链与宿主 `vscode.getUserInfo` 主路径之间的关系仍未完全确认。
- `vscode-codebot globalState` 与 IDE 宿主 `secretStorage` 之间的桥接写入点仍未确认。
- `vscode.getUserInfo` 的更底层宿主 handler/命令注册位置仍未确认。
- 扩展 `globalState("userInfoKey"/"userInfo")` 与宿主 `_w3UserInfo` 的直接桥接仍未确认。
- `cloudDragonToken` 的最初来源仍未完全证明：
  - 是否直接来自 `/v2/login/ticket` 返回值。
  - 或者是否由登录后另一个 exchange/profile 接口补出。
- 宿主究竟是在 `getSessions(HW_AUTH_ID, ...)` 过程中补写了 `session.cloudDragonToken`，还是调用方对 session 做了二次包装，仍未确认。
- `CodeArtsContextService.LoginService` 之外，是否还存在另一层隐藏的 `@codearts/plugin` / runtime 登录服务在回填 `cloudDragonToken`，仍未确认。
- 谁把同一个 `cloudDragonToken` 同步到了 `secretStorage`、`userInfo`、`HW_AUTH_ID session` 这三个宿主缓存面，仍未确认。
- `HW_AUTH_ID = "huawei-authentication"` 这条 provider 到底由谁注册、谁产出 session，仍未确认。
- `platformApi.getSseGlobalCredentialClient()` 的实现/注入点在哪个扩展里（可能在 `huaweicloud.codearts-agent-support` 等）。

## 5. 关键证据索引（可跳转）

- 登录 URL 构造：`huaweicloud.authentication/dist/plugin.js:95886-95901`
- ticket 换会话：`huaweicloud.authentication/dist/plugin.js:99637-99663`
- refresh（AK/SK 签名）：`huaweicloud.authentication/dist/plugin.js:99684-99705`
- token -> securitytokens：`huaweicloud.authentication/dist/plugin.js:99665-99683`
- `yx()` 定义：`docs/prettified/vscode-codebot.extension.copy.js:157644-157656`
- `HuaweiUser.getUserInfoByVscode()`：`docs/prettified/vscode-codebot.extension.copy.js:52683-52689`
- 宿主命令授权分支：`app/out/vs/workbench/api/node/extensionHostProcess.js:82573-82580`
- 宿主缓存 `_w3UserInfo`：`app/out/main.js:47823-47828`
- login 状态更新时写入宿主用户信息：`app/out/vs/workbench/workbench.desktop.main.js:411126-411135`
- 宿主支持字段白名单：`app/out/vs/workbench/workbench.desktop.main.js:411258-411277`
- 宿主读取 `CloudDragonToken` 注入 `x-auth-token`：`app/out/vs/workbench/workbench.desktop.main.js:417064-417067`
- 本地登录分支返回 `cloudDragonTokens.authToken`：`docs/prettified/vscode-codebot.extension.copy.js:1236742-1236797`
- `vscode-codebot` 从 `globalState` 读取 `cloudDragonToken`：`docs/prettified/vscode-codebot.extension.copy.js:1236598-1236605`
- `vscode-codebot` 写回 `globalState.cloudDragonToken`：`docs/prettified/vscode-codebot.extension.copy.js:1236607-1236617`
- `au.instance` 用户对象写入/读取 `_userInfoKey`：`docs/prettified/vscode-codebot.extension.copy.js:1215318-1215332`
- `vscode.getUserInfo` 授权包装入口：`app/out/vs/workbench/api/node/extensionHostProcess.js:82573-82580`
- workbench 命令执行转发：`app/out/vs/workbench/workbench.desktop.main.js:264713-264724`
- `vscode.getUserInfo` 返回后回写 `_w3UserInfo`：`app/out/vs/workbench/workbench.desktop.main.js:411129-411135`
- `nativeAuthenticationService` userInfo 缓存访问器：`app/out/main.js:47823-47828`
- 认证扩展 `getSessions()` 返回 session：`huaweicloud.authentication/dist/plugin.js:46323-46335`
- 认证扩展 `toSessionWhichContainsAKSK()`：`huaweicloud.authentication/dist/plugin.js:99543-99558`
- 认证扩展 `toSession()`：`huaweicloud.authentication/dist/plugin.js:99560-99570`
- 宿主从 `sessions[0].cloudDragonToken` 读取 token：`app/out/vs/workbench/workbench.desktop.main.js:418498-418507`
- `cliProcessMain` 从 `sessions[0].cloudDragonToken` 读取 token：`app/out/vs/code/node/cliProcessMain.js:21927-21936`
- `sharedProcessMain` 从 `sessions[0].cloudDragonToken` 读取 token：`app/out/vs/code/electron-utility/sharedProcess/sharedProcessMain.js:24481-24490`
- `au.instance` 在 CodeArts IDE 场景设置 toolkit/login API：`docs/prettified/vscode-codebot.extension.copy.js:1215270-1215275`
- `getLoginManager().getLoginInfo()` -> `CodeArtsContextService.getLoginService().getUserInfo()`：`docs/prettified/vscode-codebot.extension.copy.js:134587-134599`
- `CodeArtsContextService.LoginService` 实现：`docs/prettified/vscode-codebot.extension.copy.js:118793-118873`
- `transferSessionToUserInfo(session)`：`docs/prettified/vscode-codebot.extension.copy.js:118852-118861`
- `CodeArtsContextService.ApiService.getUserProjects/getUserAkSk/getDomainId`：`docs/prettified/vscode-codebot.extension.copy.js:108485-108537`
- 宿主 `huaweiCloudRequest` 桥接入口：`app/out/vs/workbench/api/node/extensionHostProcess.js:82514-82528`
- 宿主 `MainThreadAuthentication.$request(...)` 使用 `HC_AUTH_ID`：`app/out/vs/workbench/workbench.desktop.main.js:315791-315806`
- 宿主 `HuaweiRequestService.getHeaders()` 认证头拼装顺序：`app/out/vs/workbench/workbench.desktop.main.js:416969-416991`
- 宿主 `getSignedHeaders()/getCredential()`：`app/out/vs/workbench/workbench.desktop.main.js:416997-417048`
- 宿主 `getW3AuthHeaders()`：`app/out/vs/workbench/workbench.desktop.main.js:417055-417073`
- 认证扩展只持久化 `HuaweiCloudSession`：`huaweicloud.authentication/dist/plugin.js:46114`, `46257`, `46280-46283`, `46301`
- 认证扩展 provider id：`huaweicloud.authentication/dist/plugin.js:46891-46892`
- 认证扩展注册 provider：`huaweicloud.authentication/dist/plugin.js:99845-99852`
- 宿主 `HC_AUTH_ID` 与 `HW_AUTH_ID` 常量：`app/out/vs/workbench/workbench.desktop.main.js:241595`, `241605`
- SSE client：`vscode-codebot/out/extension.js:9487`
- chat 请求带 token：`vscode-codebot/out/extension.js:9497`
- code review 使用 cloudDragonToken：`vscode-codebot/out/extension.js:8766-8767`
- 知识库使用 cloudDragonToken：`vscode-codebot/out/extension.js:184`
