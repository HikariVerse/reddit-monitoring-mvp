# 长期工程与业务保护

这里只记录保护权限、数据、费用、兼容性和回归完整性的长期规则。修改规则或实现时使用针对性证据。

| 编号 | 保护 | 实现与验证 |
|---|---|---|
| INV-001 | 默认拒绝、全路由显式 `config.auth`。角色、浏览器会话、管理员 MFA、Machine Key scope、对象归属和 `allowedSourceIds` 交集由服务端校验。特权和浏览器区拒绝 Machine Key。`/v1/content/*` 支持 `read` scope 的方法限 GET/HEAD，导出使用独立授权。 | `route-policy.ts`、`check:openapi`、平台访问与私有批次回归 |
| INV-002 | 唯一内容写入经 `commitContentBatch`。重放和乱序不能重复写入、覆盖更新证据或复活已删除内容。 | 内容批写单测、表所有权检查 |
| INV-003 | 付费状态 `unknown` 或不带 Run ID 的不明启动不得自动重放。失去 Worker 租约后拒绝保存，恢复保留已知 Run ID。 | 采集连接器与 PG 并发/恢复夹具 |
| INV-004 | Viewer 配额、渠道及系统预算按实际授权原子检查、预扣，保证并发不超发。 | 采集策略、隔离 PG 预算回归 |
| INV-005 | 已合入的 SQL 迁移不可改动，新增前向追加。失败完整回滚 DDL 与台账。迁移 `050` 退役表保持退役。 | `lint:policy`、Squawk、隔离 PG 迁移 |
| INV-006 | 密钥、连接串和私有环境文件不得进入 Git、前端产物或报告证据。 | 仓库与 Web 产物检查 |
| INV-007 | 共享契约和基础层保持独立，应用与模块通过公共入口协作，保持依赖方向无环。浏览器不依赖服务器源码。 | Dependency Cruiser |
| INV-008 | 每张业务表有单一写入域，凭证、密码、会话与 MFA 相关表限定所属域读取。普通业务读按需关联，应用数据仍按实际权限范围过滤。 | `scripts/check-table-ownership.ts` |
| INV-009 | R4 归档/外置分析采用独立服务凭证与经授权的私网入口，挂载归档只读。外置推流使用限定来源的 `ingest` Machine Key。外部数据入口保留 SSRF、请求超时和负载防护。 | R4 HTTP/Parquet 夹具、应用归档授权、连接器测试 |
| INV-010 | 保持有效回归保护。新增测试聚焦导致跳过其他用例时阻断，新增跳过/抑制及规则调整交由对应评审。 | `check-governance-diff.mjs`、CODEOWNERS 路径匹配 |

度量和报告真实性见[产品说明](README.md)与[契约](contracts.md)，实际门禁和测试范围见[开发手册](development.md)。
