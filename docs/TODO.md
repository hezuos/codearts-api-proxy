

- [ ] 貌似不能接其他大模型的巨量信息后，转本系统proxy
- [ ] testsuit 完善，体系化
- [x] 上游返回 Error: ChatAgent.00001216 - The inference service is abnormal, error info is : [Prompt length exceeds: the prompt length 344632 must less than the maximum input length 196608]. — 已在 v2.2.5 修复：主动重置 + 自动恢复 + 客户端可见 notice。见 `openspec/changes/fix-upstream-prompt-length-exceeds`。