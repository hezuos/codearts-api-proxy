三模型总对比
模型	字符边界	token 边界	tokens/char
openpangu-2.0-flash	~11K	~9K	~0.78
openpangu-2.0-pro	~225K	~104K	~0.46
GLM-5.2	~560K	~195K	~0.35
关键发现
三个模型 context window 差异巨大：flash 9K ≪ pro 104K ≪ GLM-5.2 195K
flash 窗口极小（~9K tokens）—— 几乎只能装下 system prompt + 少量历史，D2 折叠注入对 flash 基本不可用，除非历史非常短
pro 窗口中等（~104K tokens）—— 能容纳中等长度折叠历史，但超长工具输出必须截断
GLM-5.2 窗口最大（~195K tokens）—— 最适合 D2 折叠注入方案
tokenizer 不同：flash 的 tokens/char 比例最高（0.78），pro 中等（0.46），GLM-5.2 最低（0.35）—— 同样字符数对 flash 的 token 消耗最大
错误形态一致：都是 HTTP 200 + SSE 2 行 + ChatAgent.00001007: The downstream service message format is incorrect（下游推理服务拒绝，本质是超 context window）