# Dynamic Model List 验证报告

> 日期: 2026-04-27
> 变更: dynamic-model-list (20/20 tasks complete)
> 结论: 实现存在 4 个关键问题，导致上游模型获取始终失败，fallback 到静态 MODEL_MAP

## 验证环境

- 区域: cn-north-4
- chatHost: `https://snap-access.cn-north-4.myhuaweicloud.com`
- API Key: `sk-449aba3a-...` (有效，已验证)
- Session: 有 AK/SK + securityToken，**无 businessToken**

## 问题 1: agent_id 硬编码错误

### 现状

`src/config.ts` 中 `getAgentId()` 返回硬编码值：

```
外部版本: "Pangu_Doer_in_CodeArts"
内部版本: "CodeMate"
```

### 实际情况

上游 `/v1/agent-center/agents/detail` 使用的 `agent_id` 是 **UUID 格式**，不是字符串名称：

| agent_id (UUID) | agent_name | is_primary_agent |
|---|---|---|
| `a8bcb36232554267a5142361cc25a393` | CodeAgent | true |
| `9a6f53a0e1b349fd90727dee689a7144` | CodeAgent-chat | false |

用 `"Pangu_Doer_in_CodeArts"` 或 `"CodeAgent"` 调用 `/detail` 均返回：

```json
{"error_code":"PROMPTCENTER.00000001","error_msg":"This agent does not exist"}
```

### VS Code 扩展中的逻辑

扩展代码 (`vscode-codebot.extension.copy.js:7480-7498`)：

```js
get defaultAgentId() {
  let e = this.getProductConfigs(), x = "";
  return (
    e.isInnerVersion
      ? (x = this.brandName.replaceAll(" ", "_"))  // 内部: "CodeMate"
      : (x = "Pangu_Doer_in_CodeArts"),             // 外部: "Pangu_Doer_in_CodeArts"
    x
  );
}

get selectDefaultAgentId() {
  let e = this.getProductConfigs(), x = "";
  return (
    e.isInnerVersion
      ? (x = this.brandName.replaceAll(" ", "_"))  // 内部: "CodeMate"
      : (x = "CodeAgent"),                          // 外部: "CodeAgent"
    x
  );
}
```

**注意**: 扩展中也有 `defaultAgentId = "Pangu_Doer_in_CodeArts"`，但实际请求时扩展先调 `/useragents` 获取 agent 列表，用返回的 UUID `agent_id` 调 `/detail`，而非直接用 `defaultAgentId`。

### 修复方向

新增 `/useragents` 端点调用，获取可用 agent 列表，取第一个 `is_primary_agent=true` 的 agent 的 `agent_id` (UUID)，再用此 UUID 调 `/detail`。

---

## 问题 2: 模型字段名错误

### 现状

`src/upstream/huawei/models.ts:155-157`：

```ts
return filtered
  .map((m) => m.model_id)
  .filter((id): id is string => typeof id === "string" && id.length > 0);
```

代码读取 `m.model_id` 字段。

### 实际情况

上游返回的模型对象**没有 `model_id` 字段**，实际字段为：

| 字段 | 示例值 | 说明 |
|---|---|---|
| `model_alias` | `"Glm-5-internal"` | 模型标识符（用于 API 请求） |
| `model_name` | `"GLM-5"` | 显示名称 |
| `model_type` | - | 模型类型 |
| `model_parameters` | `{...}` | 参数配置 |

5 个可用模型：

| model_alias | model_name |
|---|---|
| Glm-5-internal | GLM-5 |
| GLM-5.1 | GLM-5.1 |
| GLM-4.7-SFT-Harmony | GLM-4.7-ArkTS-SPARK |
| deepseek-v3.2 | DeepSeek-V3.2 |
| Glm-4.7-internal | GLM-4.7 |

### 修复方向

将 `m.model_id` 改为 `m.model_alias`。

---

## 问题 3: 缺少 /useragents 端点

### 现状

当前代码直接调 `/detail?agent_id=xxx`，没有先获取 agent 列表。

### VS Code 扩展中的逻辑

扩展代码 (`vscode-codebot.extension.copy.js:214333-214357`)：

```js
async getGptListInfoRequest(e = 0, x = 100) {
  let r = xu.getInstance().getGptsUrl();
  let n = {
    "x-snap-traceid": p1(),
    "x-auth-token": await yx(),
    "Agent-Type": "AgentCenter",
    "X-Language": Xi.get(BP.env.language) ?? j3,
  };
  let a = {
    offset: e * x,
    limit: x,
    is_primary_agent: !0,
    supported_client: this.getIDETypeParam(),
    min_compatible_plugin_version: f2(!1),
  };
  let s = {
    url: `${r}/useragents`,   // <-- /useragents 端点
    method: "GET",
    headers: n,
    params: a,
  };
}
```

### /useragents 响应格式

```json
{
  "total": 16,
  "agents": [
    {
      "agent_id": "a8bcb36232554267a5142361cc25a393",
      "agent_name": "CodeAgent",
      "agent_type": "openapi",
      "is_primary_agent": true,
      "supported_clients": ["IJ", "IP", "DS", ...],
      "description": { "llm": {...}, "human": {...} },
      "alias": { "alias_en_us": "Agent", "alias_zh_cn": "智能体" },
      ...
    }
  ]
}
```

### 修复方向

在 `models.ts` 中新增 `fetchUserAgents()` 函数，先获取 agent 列表，再调 `/detail`。

---

## 问题 4: supported_client 过滤导致空结果

### 现状

当前代码在外部版本中不过滤 `supported_client`（只在内部版本过滤 `supported_clients` 数组）。

### 实际情况

`/useragents?supported_client=vscode` 返回 `total: 0`，因为 agent 的 `supported_clients` 数组中**没有 `"vscode"`**：

```
supported_clients: ["IJ","IP","DS","QA","CL","GO","IC","IU","PS","PY","PC","RD","RM","RR","WS"]
```

但 `metadata.client_support` 中包含 `VSCODE` 和 `VSCODE_H`。

不带 `supported_client` 参数时返回 16 个 agent。

### 修复方向

调用 `/useragents` 时不传 `supported_client` 参数，或传空值。在获取到 agent 列表后，在客户端侧按 `metadata.client_support` 过滤。

---

## 上游 API 完整流程（VS Code 扩展实际使用）

```
1. GET /v1/agent-center/agents/useragents
   params: { offset: 0, limit: 100, is_primary_agent: true }
   headers: { x-auth-token, Agent-Type: "AgentCenter", X-Language, ... }
   → 获取 agent 列表

2. 从列表中选择 agent (取 agent_id UUID)

3. GET /v1/agent-center/agents/detail?agent_id={UUID}
   headers: { x-auth-token, Agent-Type: "AgentCenter", X-Language, ... }
   → 获取 agent 详情 + 模型列表

4. 从 gpts.models[] 提取 model_alias 作为模型 ID
```

## x-auth-token 来源

扩展代码 (`vscode-codebot.extension.copy.js:157644-157657`)：

```js
async function yx() {
  let u = ee.getInstance().getProductConfigs().isDefaultToken,
    e = await au.instance.getUserInfo();
  return u
    ? ee.getInstance().getProductConfigs().developersToken
    : ee.getInstance().getProductConfigs().isInnerVersion
      ? e.cloudDragonToken
      : ee.getInstance().getProductConfigs().isHcsVersion
        ? vu.getHcsLoginService().getHcsToken()
        : ("");  // 外部商业版本返回空字符串!
}
```

**在外部商业版本中，`x-auth-token` 为空字符串**。但测试表明，即使不传 `x-auth-token`，AK/SK 签名 + securityToken 也足以通过认证（返回 200 而非 401）。

## policyCenterDomain 说明

`policyCenterDomain` 与 `chatDomain` 是**不同的域名**：

- `chatDomain` = `snap-access.cn-north-4.myhuaweicloud.com` (用于 chat/codegen)
- `policyCenterDomain` = 通过 IDE 配置注入 (用于 agent-center/prompt-center)

在当前代理中，`getGptsUrl()` 从 `chatHost` 推导，这在大多数情况下是正确的（测试已验证 `/v1/agent-center/agents/` 路径在 snap-access host 上存在且可用）。

## 修复优先级

| # | 问题 | 影响 | 优先级 |
|---|---|---|---|
| 1 | agent_id 硬编码错误 | 上游返回 400，始终 fallback | P0 |
| 2 | 模型字段名错误 (model_id → model_alias) | 即使请求成功也提取不到模型 | P0 |
| 3 | 缺少 /useragents 端点 | 无法动态获取 agent_id | P0 |
| 4 | supported_client 过滤 | 可能导致空结果 | P1 |
