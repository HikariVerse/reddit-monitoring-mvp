# 数据、接口与指标契约

共享请求和数据结构见 [TypeBox 契约](../packages/contracts/src/)，运行时路由和鉴权见已认证的 `GET /v1/openapi.json`（网页代理为 `/api/v1/openapi.json`）。以 `npm run check:openapi` 校验实际注册和鉴权声明。本文维护跨域语义和业务口径。

## 权限和在线数据

- `owner`、`admin` 和 `viewer` 使用浏览器会话。敏感运维受管理员 MFA 保护。Machine Key 受实际 scope 和来源限制，特权与浏览器会话专属入口禁止调用。对象、来源与批次范围在服务端求交集。
- 采集来源的身份由平台、渠道、内容类型和目标决定。`deliveryMode` 创建后不可改。 `usageDomain` 决定运维工作区，`feedLane` 控制推荐分发，旧客户端省略字段保留原值。
- 内容按来源、类型、外部 ID 标识。内容版本通过观测时间、抓取时间及稳定证据键决胜，已删除内容禁止旧版复活。观测用内容、来源、渠道、证据键去重。同键同内容幂等，同键异内容返回 `409`。 `publishedAt`、`sourceObservedAt`、`fetchedAt` 各自独立。
- `collection_batch` 和成员由采集域维护，项目关联由项目域维护。受限用户只读可见的共享或本人批次。内容页、研究和流式导出使用相同的权限范围；导出要求实际导出授权，CSV 防公式注入。检索游标绑定范围，变更范围后重取。
- 采集预检返回字段权限、存量覆盖及预算估计，提交和派发分别重验。 `collect` 使用 `Idempotency-Key`；状态未知的付费执行留待对账，保留原任务身份。

## 主要业务接口

| 能力 | 入口与行为 |
|---|---|
| 信息流、资讯和监测 | `/v1/content/stories`、`/v1/feed/*` 与 `/v1/intelligence/*`。 `channelScope=info\|social\|all` 在支持端点与平台取交集。监测按对象和来源授权，使用预估、预算与取证窗口，趋势取真实观测或有效分桶。 |
| 研究发现 | `POST /v1/research/resources/discover` 读取符合权限的在线资料、批次、项目与归档候选。归档快速估计和精确复核分别解释；读取发现不启动付费请求。 |
| 项目归档 | `/v1/projects/:id/archives` 及预览、状态、查询、证据端点。引用绑定归档 ID、版本和规范化范围，同范围幂等。查询只在引用与附加条件的交集取样。版本变化可返回 `409 archive_version_changed`； HMAC 游标绑定版本和过滤范围。未知全量时 `totalMatches=null`；证据以月份、帖子及评论标识定位。 |
| Explore | `/v1/explore/capabilities`、`/analyze`、`/progress/:runId`、`/evidence` 和 `/studies/:studyId`（同一前缀）。返回本次实际使用的来源、档位、窗口或快照；证据与研究快照按拥有者及来源访问。 |
| 报告流程 | `/v1/reports/drafts`、`/runs` 和运行 `/action` 组织异步任务，根据场景选择目标、范围、章节和确认采集。阶段结果区分就绪、纯数据、失败或待处理，显示实际报告模式 `llm_verified`、`partial_llm` 或 `pure_data`。 |
| 报告、导出与计划 | `/v1/reports/:id` 读可见报告，`/export` 在同一读取判定外额外检查浏览器导出权限。 `/v1/reports/schedules` 管理计划，手动触发和定时窗口分别生成运行；周期按计划和时间窗维护幂等。 |

报告、发现和 Explore 使用浏览器会话。报告数据章和证据由分析结果提供，LLM 使用已有范围、指标和证据 ID。保存的 Explore 研究可作为报告资料，底层仍按服务端授权访问。离线 HTML 可展示已经授权导出的快照内容。

## 指标、证据与降级

Python 工作者的[指标注册表](../plugins/zst-archive/analytics_core/analysis_core/catalog.py)定义指标 ID、单位、分组和面板，方法见[商业计算](../plugins/zst-archive/analytics_core/analysis_core/commercial.py)。在线 TS 的[回退分析](../src/modules/archive-analysis/explore-fallback.ts)覆盖基础面板。场景、过滤和支持状态以实际来源与响应为准。

- 样本规模、统计分母、日期、来源、去重层级和分析模型一并解释结果。可用性状态包括 `ready`、`exploratory`、`insufficient_data`、`unsupported_source` 等。无可用日期、分母或观测时显示缺测和实际覆盖。
- MI06 样本品牌份额以符合条件的品牌提及计数为分母。MI07 衡量品牌提及文档占样本的覆盖。MI03 需要归档总体台账以计算每百万关注度，PG 普通样本缺少该总体时返回不支持。
- MI14 标识有比较语境的竞品关系，MI13 统计共提及。MI19 按分句和相应目标归属品牌、属性及情感，品牌或分母不足时保留可追溯样本与适用性。
- 报告快照保存分析口径与证据引用。展示或导出保留原数据窗口、范围与覆盖，不将样本提及份额当作市场占有率。原始样本和已实测范围见[状态页](status.md)。
