# SIFTLINE 开发入口

SIFTLINE 是**面向跨境电商的多源数据研究与智能报告平台**。当前开发和本机验收在 HikariVerse 的 `feat/r4-duckdb-explore`，Euroish 团队仓库的 `main` 是合并基线。开工先运行 `git status --short --branch` 和 `git rev-parse HEAD`，按任务核对分支和未提交工作。

React 工作台负责研究流程。Fastify/TypeBox 管接口与访问授权，PostgreSQL 保存在线业务和研究快照。独立 R4 服务用 DuckDB 读历史归档并运行 Python/ONNX 分析。先查[当前状态与近期任务](docs/status.md)，按需读[开发与验证](docs/development.md)、[架构](docs/architecture.md)、[契约与指标](docs/contracts.md)或 [R4 操作](docs/r4-archive.md)。

- 本机完整配置以实际可见 CPU、内存、GPU 为依据。CPU 核心分析可独立运行，GPU 按健康探测可选增强，失败保留 CPU 回退与运行版本。按[开发手册](docs/development.md#本机完整开发与验收)启动，按变更影响选择验证。
- 优先复用项目已有能力与成熟组件。技术取舍看业务效果、数据正确性、运行成本与维护性。工程约束和实际需求冲突时，直接说明冲突和证据。
- 保持[长期工程保护](docs/invariants.md)。服务端校验权限、对象归属、来源和费用；唯一内容写入口为 `commitContentBatch`；已合入迁移前向追加，付费状态不明禁止自动重放，密钥不进 Git、前端或交付日志。
- 交付前检查完整 diff，记录实际运行命令、结果、版本和覆盖范围，分别说明代码、接线、运行、端到端和部署状态。

`docs/plans/`、`docs/research/`、`output/` 及其他归档是按需查阅的规划、任务和验收证据。局部约束、资源假设和验收标准随原任务有效。以当前明确用户任务、现行文档和实际工程状态开展开发，发生冲突时记录必要决策。本地交付从 `output/README.md` 查找。
