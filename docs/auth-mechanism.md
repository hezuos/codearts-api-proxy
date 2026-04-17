> 本文件由 codearts-agent-auth-and-requuest-mechanism.md 拆分而来。

# 华为云 CodeArts Agent 认证与请求机制技术文档

## 一、系统架构概述

```mermaid
flowchart TB
    subgraph IDE层["IDE 宿主层"]
        CA[CodeArts Agent]
        AUTH_EXT[huaweicloud.authentication]
        AI_EXT[vscode-codebot]
        TOOLKIT[toolkit 认证层]
    end

    subgraph 本地服务层["本地服务层"]
        LOCAL_SERVER[localhost HTTP Server]
        SESSION_MGR[会话管理器]
        CHAT_SESSIONS[chat_sessions 持久化]
    end

    subgraph 云端服务层["云端服务层"]
        AUTH_CLOUD[华为云认证服务<br/>iam.myhuaweicloud.com]
        AI_CLOUD[AI 服务集群<br/>snap-access.cn-north-4.myhuaweicloud.com]
        POLICY_CLOUD[策略中心<br/>policy-center]
    end

    AUTH_EXT --> LOCAL_SERVER
    LOCAL_SERVER --> AUTH_CLOUD
    AUTH_CLOUD --> SESSION_MGR
    SESSION_MGR --> TOOLKIT

    AI_EXT --> TOOLKIT
    AI_EXT --> CHAT_SESSIONS
    AI_EXT --> AI_CLOUD
    AI_EXT --> POLICY_CLOUD

    AUTH_CLOUD -.认证信息.-> TOOLKIT
    TOOLKIT -.注入token.-> AI_EXT
```

### 核心组件职责

| 组件                         | 职责                           | 技术栈                           |
| ---------------------------- | ------------------------------ | -------------------------------- |
| `huaweicloud.authentication` | 认证扩展，管理用户会话         | Express + portfinder + crypto-js |
| `vscode-codebot`             | 主 AI 扩展，处理聊天和代码生成 | TypeScript + SSE                 |
| toolkit 会话层               | 跨扩展共享认证信息             | VS Code Authentication API       |
| localhost 回调服务           | 接收浏览器认证回调             | Express 动态端口                 |

---

## 二、认证机制详解

### 2.1 认证流程

```mermaid
sequenceDiagram
    participant User as 用户
    participant IDE as CodeArts Agent
    participant AuthExt as authentication 扩展
    participant LocalServer as localhost:port
    participant Browser as 浏览器
    participant IAM as iam.myhuaweicloud.com
    participant Toolkit as toolkit 会话层
    participant AIExt as vscode-codebot

    IDE->>AuthExt: 扩展激活
    AuthExt->>LocalServer: 创建 HTTP 服务<br/>127.0.0.1:动态端口
    AuthExt->>LocalServer: 注册 /callback 路由

    Note over User,AIExt: 首次登录流程

    User->>IDE: 点击登录
    IDE->>AuthExt: 触发登录
    AuthExt->>Browser: 打开登录页面<br/>含 callback URL

    Browser->>IAM: 用户认证
    IAM->>IAM: 验证凭据
    IAM->>LocalServer: 重定向到 /callback<br/>?identifier=xxx&redirect=yyy

    LocalServer->>AuthExt: 提取 identifier
    AuthExt->>AuthExt: 建立 session 对象

    Note over AuthExt: session 包含<br/>credential.access<br/>credential.secret<br/>credential.securitytoken<br/>credential.expires_at

    AuthExt->>Toolkit: 注册会话<br/>CODEARTS_SESSION_ID

    loop 定时刷新
        AuthExt->>IAM: refreshToken(session)
        IAM-->>AuthExt: 新凭据三元组
        AuthExt->>AuthExt: 更新会话
    end

    AIExt->>Toolkit: getSession(CODEARTS_SESSION_ID)
    Toolkit-->>AIExt: 会话对象
    AIExt->>AIExt: 构建请求头并注入 token
```

### 2.2 本地回调服务实现

**关键代码位置**：`huaweicloud.authentication/dist/plugin.js`

**初始化流程**：

1. **创建服务**：使用 Express 创建 HTTP 服务
2. **绑定端口**：`listen(0, "127.0.0.1")` 动态分配端口
3. **端口检查**：若端口 < 10000，关闭并重试一次
4. **路由注册**：`GET /callback` 接收认证回调

**回调处理逻辑**：

```mermaid
flowchart TD
    A[/callback 收到请求] --> B{检查参数}
    B -->|缺少参数| C[返回错误 JSON<br/>lack argument identifier or redirect]
    B -->|参数完整| D[记录日志<br/>Receive the callback request]
    D --> E[保存 identifier<br/>this.identifier = i]
    E --> F[307 重定向<br/>t.redirect 307, a]

    G[会话建立] --> H[计算首次刷新时间<br/>expires_at - 当前时间 - 随机秒数]
    H --> I{是否需要立即刷新}
    I -->|是| J[立即执行 refreshToken]
    I -->|否| K[设置定时器<br/>setTimeout renewAndReuseSession]
```

**会话对象结构**：

```json
{
  "account": {
    "id": "用户ID",
    "label": "用户名"
  },
  "domainId": "域ID",
  "credential": {
    "access": "AK",
    "secret": "SK",
    "securitytoken": "临时令牌",
    "expires_at": "过期时间 ISO 8601"
  }
}
```

### 2.3 会话刷新机制

**刷新时间计算**：

- 首次刷新时间 = `expires_at - 当前时间 - 2小时 - 随机秒数`
- 随机秒数范围：`0-59`
- 若剩余时间 < 0，立即刷新

**刷新流程**：

1. 调用 `apiService.refreshToken(authentication)`
2. 获取新凭据：`access`、`secret`、`securitytoken`、`expires_at`
3. 更新本地会话对象
4. 记录日志：`renew session success` 或 `renew session error`
5. 若失败且未过期，继续定期刷新；若已过期，触发登出

### 2.4 错误处理模型

**错误类型枚举**：

| 错误常量               | 描述                    | 处理建议                 |
| ---------------------- | ----------------------- | ------------------------ |
| `UNAUTHORIZED`         | 认证错误                | 重新登录                 |
| `PROXY`                | 代理认证错误            | 检查代理设置             |
| `FORBIDDEN_TOKEN`      | IAM.1201                | Token 被禁用，联系管理员 |
| `FORBIDDEN_API_ACCESS` | not programmatic access | 用户仅支持控制台访问     |
| `TIMEOUT`              | 登录超时                | 检查网络并重试           |
| `FAILED`               | 登录失败                | 检查用户名密码           |
| `USER_OR_PWD`          | 用户名或密码错误        | 重新输入                 |
| `ACCOUNT_LOCKED`       | 账户锁定                | 15分钟后重试             |
| `ACCOUNT_DISABLED`     | 账户禁用                | 联系管理员               |

---