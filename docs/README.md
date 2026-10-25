# 开发文档索引

| 文档 | 内容 | 维护方式 |
|------|------|----------|
| [spec-v2.0-original.md](spec-v2.0-original.md) | 需求方提供的原始方案（v2.0，2026-10-25），**逐字复制，不修改** | 只读。原文 SHA-256：`EC321E7B…C2A` |
| [architecture.md](architecture.md) | 实际实现的架构、模块职责、关键决策，以及**与方案的每一处偏离及实测证据** | 随代码演进 |
| [acceptance.md](acceptance.md) | 可复现的验收步骤、期望输出、逐项检查清单、问题回报模板 | 每次发版更新证据 |
| [requirement-changes.md](requirement-changes.md) | 对基线方案的正式变更（RC 编号）、影响与实现约束；RC-001 发送即翻译、RC-002 回车触发 | 需求变更时追加 |
| [releases/v0.2.2.md](releases/v0.2.2.md) | v0.2.2（当前最新）的版本定义、改动方案、证据与回滚 | 每次发版新增一份 |
| [../release/README.md](../release/README.md) | 可分发软件包（v0.1.0）的清单、功能说明、安装与校验方法 | 每次打包更新 |
| [../README.md](../README.md) | 面向使用者的快速开始、配置、已知限制、排障 | 随版本更新 |
| [../CHANGELOG.md](../CHANGELOG.md) | 版本变更记录 | 每次发版 |

约定：`spec-v2.0-original.md` 是需求基线，**不做任何编辑**；实现与基线不一致的地方，一律记录在 `architecture.md` 的「与方案的差异」一节，并附上实测证据。这样"当初要求什么"和"最后为什么这样做"都能追溯。
