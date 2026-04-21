# scripts/ — 开发与调试工具集

本目录包含用于逆向分析、凭据提取、请求拦截和 API 测试的脚本。
这些脚本不是代理服务的运行时依赖，仅用于开发调试。

## 目录结构

```
scripts/
├── README.md                  ← 本文件
├── cdp-intercept.mjs          CDP 请求拦截器（核心抓包工具）
├── cdp-probe.mjs              CDP 扩展宿主探测
├── cdp-explore-scope.mjs      CDP 全局作用域探索
├── test-chat.mjs              最小聊天请求测试
├── refresh-and-test.mjs       刷新凭据 + 策略查询 + 聊天测试
├── tools-definition.mjs       工具定义（chat 请求的 tools 字段）
├── read-state-db.js           读取 VS Code state.vscdb 数据库
├── extract-data.js            提取并分析 CodeArts 存储数据
├── decrypt-session.js         DPAPI + AES-256-GCM 解密会话
├── decrypt-final.js           使用预解密 AES key 解密会话
├── export-session.js          解密并导出会话到 JSON
├── dpapi-decrypt.ps1          PowerShell DPAPI 解密脚本
├── captured-requests/         拦截到的请求输出目录
├── aes-key.bin                预解密的 AES-256 密钥（二进制）
├── dpapi-key-blob.bin         DPAPI 加密的密钥 blob（二进制）
├── encrypted-session.bin      加密的会话数据（二进制）
└── session-decrypted.json     解密后的会话 JSON
```

---

## CDP 系列 — Chrome DevTools Protocol 调试

通过 CDP WebSocket 连接到 VS Code 扩展宿主进程，在运行时注入代码。

### cdp-intercept.mjs

**核心抓包工具。** Monkey-patch 扩展宿主中的 `fetch`、`__vscodePatchedFetch`、`https.request`，拦截所有发往 `snap-access` / `myhuaweicloud` 的请求，记录完整 URL、headers、body。

**用法：**
```powershell
# 1. 启动 VS Code 并开启扩展调试端口
code --inspect-extensions=63732

# 2. 从 VS Code 输出中获取 WebSocket URL，例如：
#    ws://127.0.0.1:63732/808c4f8b-076d-4c27-96c9-e70180b4c4a2

# 3. 运行脚本
node scripts/cdp-intercept.mjs ws://127.0.0.1:63732/<session-id>

# 4. 在 IDE 中触发聊天，脚本会打印捕获的请求
```

**输出：** 控制台打印请求详情；chat 请求额外保存到 `scripts/captured-request-N.json`。

### cdp-probe.mjs

**扩展宿主探测。** 连接后检查进程信息、全局变量、require cache、VS Code API、认证会话等。用于了解扩展宿主的运行时环境。

```powershell
node scripts/cdp-probe.mjs [ws-url]
```

### cdp-explore-scope.mjs

**全局作用域探索。** 快速检查扩展宿主中可用的全局变量、Node.js 内置模块、HTTP 相关对象等。用于确定 CDP 注入的可行性。

```powershell
node scripts/cdp-explore-scope.mjs
```

---

## API 测试系列

### test-chat.mjs

**最小聊天请求测试。** 使用 AK/SK/SecurityToken 进行 SDK-HMAC-SHA256 签名，向 snap-access 发送聊天请求并打印 SSE 响应。

```powershell
# 方式 1：环境变量
$env:HW_AK="your-access-key"
$env:HW_SK="your-secret-key"
$env:HW_ST="your-security-token"
node scripts/test-chat.mjs

# 方式 2：session JSON 文件
node scripts/test-chat.mjs --session scripts/session-decrypted.json

# 方式 3：带自定义 prompt
node scripts/test-chat.mjs --session scripts/session-decrypted.json "你好"
```

### refresh-and-test.mjs

**完整流程测试：刷新凭据 → 查询策略 → 发送聊天。**

1. 读取保存的 session
2. 调用 `/v2/login/refresh` 获取新凭据
3. 调用 `/v1/policy/bundle` 查询可用模型和配置
4. 用新凭据发送聊天请求

```powershell
node scripts/refresh-and-test.mjs [--session <path>]
```

### tools-definition.mjs

**工具定义模块。** 导出 `DEFAULT_TOOLS` 常量，包含 CodeArts Agent IDE 发送的 tools 列表（Task、Bash、Glob、Grep、Read、Edit、Write、TodoWrite 等）。被 `refresh-and-test.mjs` 引用。

---

## 凭据提取与解密系列

这些脚本用于从 VS Code 本地存储中提取 CodeArts 的加密凭据并解密。

### 整体流程

```
state.vscdb → extract-data.js → encrypted-session.bin
                                      ↓
Local State → dpapi-decrypt.ps1 → aes-key.bin
                                      ↓
aes-key.bin + encrypted-session.bin → decrypt-final.js / export-session.js
                                      ↓
                              session-decrypted.json
```

### read-state-db.js

**读取 VS Code state.vscdb。** 使用 sql.js 读取 CodeArts Agent 的 SQLite 数据库，扫描所有表中与华为云/认证相关的键值。

```powershell
node scripts/read-state-db.js
```

### extract-data.js

**提取存储数据。** 从 state.vscdb 中读取 `huaweicloud.codearts-snap` 的完整数据，以及 `HuaweiCloudSession` 的加密数据。将加密会话保存到 `scripts/encrypted-session.bin`。

```powershell
node scripts/extract-data.js
```

### dpapi-decrypt.ps1

**PowerShell DPAPI 解密。** 使用 Windows DPAPI（CurrentUser scope）解密从 `Local State` 中提取的 AES 密钥 blob。

```powershell
# 解密 DPAPI blob 并输出 AES key
powershell -File scripts/dpapi-decrypt.ps1 -InputFile scripts/dpapi-key-blob.bin -OutputFile scripts/aes-key.bin
```

### decrypt-session.js

**一步解密会话。** 自动完成 DPAPI 解密（调用 PowerShell）+ AES-256-GCM 解密，输出完整的 HuaweiCloudSession。

```powershell
node scripts/decrypt-session.js
```

### decrypt-final.js

**使用预解密 key 解密。** 跳过 DPAPI 步骤，直接使用 `scripts/aes-key.bin` 解密 `scripts/encrypted-session.bin`。

```powershell
node scripts/decrypt-final.js
```

### export-session.js

**解密并导出。** 与 decrypt-final.js 类似，但将结果写入 JSON 文件，并打印凭据摘要。

```powershell
node scripts/export-session.js [output-path]
# 默认输出到 scripts/session-decrypted.json
```

---

## 数据文件

| 文件 | 说明 |
|------|------|
| `aes-key.bin` | 预解密的 AES-256 密钥（32 字节二进制） |
| `dpapi-key-blob.bin` | DPAPI 加密的密钥 blob（从 Local State 提取） |
| `encrypted-session.bin` | v10 前缀 + AES-256-GCM 加密的会话数据 |
| `session-decrypted.json` | 解密后的会话 JSON（含 AK/SK/SecurityToken） |
| `captured-requests/` | cdp-intercept 捕获的请求输出目录 |

> **注意：** `aes-key.bin`、`encrypted-session.bin`、`session-decrypted.json` 包含敏感凭据，不应提交到版本控制。
