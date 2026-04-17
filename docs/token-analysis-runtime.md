> 本文件由 codearts-agent-token-analysis.md 拆分而来。

---

## 6. 运行时分析记录（2026-04-16）

本节记录通过运行时分析（进程探测、SQLite 提取、DPAPI 解密、日志分析、CDP 连接）获取的关键发现。

### 6.1 CodeArts Agent 进程结构

CodeArts Agent 是 Electron 应用，共 13 个进程：

| 进程     | PID   | 调试端口 | 说明                        |
| -------- | ----- | -------- | --------------------------- |
| 主进程   | 7396  | 无       | Electron 主进程             |
| 扩展宿主 | 10432 | 63730    | 不响应标准 /json 端点       |
| 共享进程 | 15404 | 63732    | 可通过 CDP 连接，无 require |
| 渲染器 1 | 9056  | 无       | -                           |
| 渲染器 2 | 11516 | 无       | -                           |

关键发现：

- 扩展宿主端口 63730 不响应标准 Node inspector `/json` 端点，可能是内部 HTTP 服务而非 inspector
- 共享进程端口 63732 可通过 CDP 连接，但没有 `require` 权限，无法直接调用 VS Code API

### 6.2 成功解密 HuaweiCloudSession

通过以下步骤成功解密了存储在 `state.vscdb` 中的加密 session：

**解密流程**：

1. 从 `C:\Users\xLight\AppData\Roaming\codearts-agent\Local State` 文件读取 `os_crypt.encrypted_key`（Base64 编码的 DPAPI 加密 AES 密钥）
2. 用 PowerShell DPAPI (`System.Security.Cryptography.ProtectedData.Unprotect`) 解密得到 32 字节 AES-256 密钥
3. 用 AES-256-GCM 解密 `secret://HuaweiCloudSession`（v10 前缀格式：3字节版本 `v10` + 12字节 nonce + 密文 + 16字节 auth tag）

**解密后的 HuaweiCloudSession 结构**：

```json
{
  "account": { "id": "56b6ea8565c74f60a20f589277c09e4b", "label": "steertech" },
  "scopes": [],
  "accessToken": "",
  "accessKey": "HST3WW66WAM5OL3IP4ZJ",
  "secretKey": "wM1SAChRoLqqoRt75sj1UL9SJYm6un1JcV7xqDbk",
  "securitytoken": "<772 chars base64>",
  "expires_at": "2026-04-17T03:45:15.015000Z",
  "domainId": "8038a99920b344549d2b0691e72e1446",
  "id": "huawei-cloud-authentication"
}
```

**关键结论**：

- `accessToken` 为空字符串 — session 里没有业务 token
- 只有 AK/SK/SecurityToken — 这是底层临时凭证
- **不含 `cloudDragonToken`** — 进一步证实了代码分析的结论

### 6.3 codearts-snap globalState 中的 userInfoKey

`state.vscdb` 键 `huaweicloud.codearts-snap` 的 `userInfoKey` 字段只有：

- `description`, `enabled`, `id`, `name`, `projects`, `links`, `loginType`
- **不含** `cloudDragonToken`

### 6.4 ★★★ 日志揭示 HC 模式认证路径 — 不需要 cloudDragonToken

从扩展日志 `CodeArts智能代码助手.log` 中发现关键日志：

```
[INFO] Hc or Hcs version, token is transferred by the toolkit.
[INFO] Send sse request. description: build sse link for chat/code, url: https://snap-access.cn-north-4.myhuaweicloud.com/v1/chat/chat, traceId: a2489bac077244688c80b6c41aeaa59c
[INFO] Send request success! description: build sse link for chat/code
```

**核心发现**：

- 当前 CodeArts Agent 运行在 **HC 模式**（华为云商用版，非内网/W3 模式）
- 在 HC 模式下，**token 由 toolkit（`@codearts/plugin` 平台基础设施）自动注入**
- **不走 `cloudDragonToken` 路径**！
- `yx()` 函数返回空串，请求头中不设置 `x-auth-token`
- 认证改由 `platformApi.getSseGlobalCredentialClient()` 通过 AK/SK 签名实现

这对应了 `yx()` 的分支逻辑（`docs/prettified/vscode-codebot.extension.copy.js:157644-157656`）：

- `isInnerVersion` → 返回 `cloudDragonToken`（内网路径）
- HC/HCS 模式 → token 由 toolkit 处理（当前实际路径），`yx()` 返回空串

### 6.5 确认的完整 API 端点清单

从日志确认的实际请求 URL：

| 接口           | URL                                                                                  | 方法 |
| -------------- | ------------------------------------------------------------------------------------ | ---- |
| **聊天 SSE**   | `https://snap-access.cn-north-4.myhuaweicloud.com/v1/chat/chat`                      | POST |
| **排队状态**   | `https://snap-access.cn-north-4.myhuaweicloud.com/api/v1/queue/status`               | POST |
| **策略配置**   | `https://snap-access.cn-north-4.myhuaweicloud.com/v1/policy/bundle`                  | POST |
| **Agent 详情** | `https://snap-access.cn-north-4.myhuaweicloud.com/v1/agent-center/agents/detail`     | POST |
| **用户 Agent** | `https://snap-access.cn-north-4.myhuaweicloud.com/v1/agent-center/agents/useragents` | POST |
| **技能规则**   | `https://snap-access.cn-north-4.myhuaweicloud.com/v1/skills-rules/list`              | POST |
| **项目信息**   | `https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/user/project`      | POST |

### 6.6 聊天响应格式（从日志获取）

```json
{
  "id": "812bd21009c247099226337163ae23d5",
  "model": "glm-5.1",
  "type": "answer",
  "chat_id": "dbd288a0324741db978311cca685846b",
  "response_message_id": "812bd21009c247099226337163ae23d5",
  "request_message_id": "95bcc5505dd0489ebb0c3d1797af3f0a",
  "agent_name": "CodeAgent",
  "is_delta_response": true,
  "is_model_auto_switched": false,
  "prompt_id": "local",
  "prompt_tokens": 0,
  "text": "增量文本片段",
  "output": [{ "type": "output_text", "text": "完整输出" }],
  "error_code": "0"
}
```

### 6.7 模型和 Agent 配置（从 globalState 获取）

- `hc-gpt-info-key`：包含可用的 agent 列表（CodeAgent, DevMate, CodeMate 等）
- `hc-selected-model-key`：包含当前选中的模型配置（GLM-5.1 等）

---

## 7. ★★★ `platformApi.getSseGlobalCredentialClient()` 完整实现分析（2026-04-16）

本节记录对 `vscode-codebot/out/extension.js` 中 SSE 签名机制的完整分析。

### 7.1 `platformApi` 对象定义

**类型**: `oRe` 实例

```js
oRe = class {
  constructor(e, x) {
    this.context = e;
    this.vscodeInstance = x;
  }
  getNoCredentialClient() {}
  getGlobalCredentialClient(e) {
    return eRe.getInstance(this.context, this.vscodeInstance);
  }
  getBasicCredentialClient(e) {}
  getObsClient(e) {}
  getSseNoCredentialClient() {}
  getSseGlobalCredentialClient() {
    return iRe.getInstance(this.context, this.vscodeInstance);
  }
  getSseBasicCredentialClient(e) {}
};
```

**赋值位置**: `au` 类（认证服务单例）的 `setToolkitApi()` 方法：

```js
this._platformApi = new oRe(this._context, nf0);
```

### 7.2 SSE Global Credential Client（`iRe` 类）— 签名核心

```js
iRe = class extends tRe {
  static instance = new iRe();
  domainId = null;
  userInfo = null;
  credentials = null;
  apiService = new Rm();

  async sendRequest(e) {
    let x;
    // HC 模式: 通过 getHcUserInfo() 获取用户信息
    // 内部版(vB): 通过 Xke() 获取
    vB
      ? (x = await Xke())
      : (x = await lastValueFrom(
          vu.getHcLoginService().getHcUserInfo().pipe(take(1)),
        ));

    if (!x?.accessKeyId || !x?.secretAccessKey) {
      M.getInstance().debug("sign user info failed");
      return null;
    }

    this.checkUserInfo(x);
    // 核心: 使用 AK/SK 创建 GlobalCredentials
    this.credentials = Ake(this.credentials, x, this.iamEndPoint);
    // 使用 credentials 签名并发送请求
    return nRe
      .getInstance(context)
      .withCredentials(this.credentials)
      .withHttpsAgent(this.proxyAgent)
      .sendRequest(e);
  }
};
```

**关键流程**:

1. `getHcUserInfo()` 返回 `{accessKeyId, secretAccessKey, accessToken}`
2. `Ake()` 创建 `GlobalCredentials` 对象：`new GlobalCredentials().withAk().withSk().withSecurityToken()`
3. `GlobalCredentials.processAuthRequest()` 使用 `SDK-HMAC-SHA256` 算法签名
4. 签名后 headers 包含 `Authorization` 和 `X-Sdk-Date`

### 7.3 AK/SK 签名算法 — SDK-HMAC-SHA256

系统中存在**两套签名实现**：

#### 系统 A — 华为云 SDK 官方签名（`AKSKSigner`，约 Line 2600）

- **算法标识**: `SDK-HMAC-SHA256`
- **关键 headers**: `X-Sdk-Date`, `X-Sdk-Content-Sha256`, `host`
- **导出**: `lD.AKSKSigner = vqr`
- **流程**: buildCanonicalRequest → buildPayloadHash → hmacSHA256 签名
- **用途**: GlobalCredentials 的 `processAuthRequest`（这是 HC 模式 SSE 请求的路径）

#### 系统 B — Agent Mode 专用签名（`CCu` 类，约 Line 3496-3500）

- **算法标识**: 同 `SDK-HMAC-SHA256`
- **关键函数**: `lZx(request, accessKeyId, secretAccessKey)` — 完整实现：
  ```js
  function lZx(u, e, x) {
    let { method: t, url: r, headers: n = {}, data: a = "" } = u;
    let { host: s, searchParams: o, pathname: E } = new URL(r);
    let A = {};
    o.forEach((d, D) => (A[D] = d));
    let B = {
      type: t,
      method: t,
      host: s,
      query: A,
      body: a,
      headers: BZx(n),
      uri: decodeURI(E),
    };
    return new CCu(B, e, x).getSignedHeaders();
  }
  ```
- **CCu 类方法**: `getSignedHeaders()` → 生成 `X-Sdk-Date` → `getCanonicalRequest()` → `getSignature()` → 设置 `Authorization` header
- **签名格式**: `SDK-HMAC-SHA256 Access={AK}, SignedHeaders={headers}, Signature={sig}`

### 7.4 SSE 请求头构建

**`sendSSERequest` 方法** (Line 9487):

```js
async sendSSERequest(e, x) {
  let n = au.instance.platformApi?.getSseGlobalCredentialClient();
  if (!n) return null;
  let s = n.sendRequest(e);       // 通过 credentials 签名后发送
  let o = await Promise.race([s, timeout]);  // 带超时
  return o;
}
```

**请求参数构建** (Line 9513, `constructRequestParams`):

```js
headers = {
  "Content-Type": "application/json",
  "Agent-Type": isCodeGen ? "CodeAgent" : "ChatAgent",
  "Accept": "text/event-stream",
  "X-Language": ...,
  "x-snap-traceid": traceId,
  "x-auth-token": e.token,     // 非 HC 模式时设置（HC 模式为空串）
  "heartbeat-enable": true,
  ...
}
```

### 7.5 三种认证模式对比

| 模式                        | Token 来源                     | 认证 Header                                               |
| --------------------------- | ------------------------------ | --------------------------------------------------------- |
| **内部版** (isInnerVersion) | `e.cloudDragonToken`           | `x-auth-token: <cloudDragonToken>`                        |
| **HC 华为云版** (当前模式)  | AK/SK 签名 (GlobalCredentials) | `Authorization: SDK-HMAC-SHA256 ...` + `X-Sdk-Date`       |
| **Agent Mode** (DZx函数)    | `accessToken` + AK/SK签名      | `X-Security-Token` + `Authorization: SDK-HMAC-SHA256 ...` |

### 7.6 Agent Mode 签名流程

`DZx` 函数 (约 Line 3500):

```js
async function DZx(u, e) {
  let t = await getHcUserInfo(); // {accessKeyId, secretAccessKey, accessToken}
  let r = {
    method: "POST",
    url: `${agentModeUrl}/chat/completions`,
    headers: {
      "content-type": "application/json",
      "X-Security-Token": t?.accessToken, // 临时安全令牌
      ...e.headers,
    },
    data: JSON.stringify(u),
  };
  let n = lZx(r, t?.accessKeyId, t?.secretAccessKey); // AK/SK签名
  e.headers = n; // 替换原始 headers
}
```

### 7.7 凭证映射关系

从解密的 HuaweiCloudSession 到签名参数的映射：

| HuaweiCloudSession 字段 | 签名参数                      | 说明         |
| ----------------------- | ----------------------------- | ------------ |
| `accessKey`             | `accessKeyId` / AK            | 公钥         |
| `secretKey`             | `secretAccessKey` / SK        | 私钥         |
| `securitytoken`         | `accessToken` / SecurityToken | 临时安全令牌 |

### 7.8 结论：我们已有所有必要凭证

在 HC 模式下：

1. **不需要** `cloudDragonToken`
2. **需要** AK/SK/SecurityToken — 我们已经从解密的 session 获取
3. 认证通过 `SDK-HMAC-SHA256` 签名注入到 `Authorization` header
4. 签名算法是标准的华为云 API 签名（与官方 SDK 一致）

---

## 8. 下一步

1. 实现 `SDK-HMAC-SHA256` 签名算法
2. 用已获取的 AK/SK/SecurityToken 构造签名后的聊天请求
3. 发送到 `https://snap-access.cn-north-4.myhuaweicloud.com/v1/chat/chat`
4. 验证响应
5. 将签名逻辑集成到代理服务中

---

## 9. 运行时分析脚本索引

| 脚本                            | 用途                                        |
| ------------------------------- | ------------------------------------------- |
| `scripts/cdp-probe.mjs`         | CDP 协议探针，连接扩展宿主 WebSocket        |
| `scripts/extract-data.js`       | 从 state.vscdb 提取 userInfo 和加密 session |
| `scripts/decrypt-session.js`    | 完整解密流程（DPAPI + AES-GCM）             |
| `scripts/decrypt-final.js`      | 最终 AES-256-GCM 解密脚本                   |
| `scripts/dpapi-decrypt.ps1`     | PowerShell DPAPI 解密脚本                   |
| `scripts/read-state-db.js`      | 用 sql.js 读取所有 state.vscdb 数据库       |
| `scripts/encrypted-session.bin` | 提取的加密 session 二进制数据               |
| `scripts/dpapi-key-blob.bin`    | DPAPI 加密的 AES 密钥 blob                  |
| `scripts/aes-key.bin`           | 解密后的 32 字节 AES-256 密钥               |
