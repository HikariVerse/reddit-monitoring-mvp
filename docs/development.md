# 开发、验证与运行

## 分支与交付

团队合并基线是 Euroish `main`，当前产品开发与验收使用 HikariVerse 的 `feat/r4-duckdb-explore`。见[当前基线](status.md)。开始前检查工作区和目标分支，集成时处理实际冲突并重验受影响行为。发布使用不可变 `vX.Y.Z` 标签及同一提交构建的镜像。生产运行版本要从部署记录和镜像 revision 复核。

## 本机完整开发与验收

当前工作站为 i5-13500H（12 核、16 线程）、约 64 GB 内存与 RTX 4060 8 GB。Docker/WSL 的资源配额独立，按实际可见资源与输入规模调整。重分析默认以可见逻辑线程减一分配共享预算，`BI_CPU_CORES` 可覆盖。采集 Worker 的 `WORKER_CONCURRENCY`、报告模型并发、DuckDB 查询和分析任务有各自预算，调优时一并观察主业务延迟、RAM 和显存。

准备仓外私有环境文件。设置 `POSTGRES_PASSWORD`（URL 安全字符）、`SESSION_SECRET`（至少 32 字符，独立于归档凭证）、`APP_ORIGIN=https://localhost:8443`、`SITE_ADDRESS=https://localhost`、`HTTPS_PORT=8443`、`TLS_CONFIG=tls internal`。完整配置还需设置 `ARCHIVE_ROOT_HOST`（已有合规归档目录）和 `ARCHIVE_SERVICE_TOKEN`（至少 32 个可打印 ASCII 字符）。默认挂载本机 `output/` 的已有模型，也可用 `POTION_MODEL_HOST` 和 `ANALYTICS_MODEL_HOST` 指向别处。配置仅挂载目录，数据库使用对应 Compose 项目的卷。

```powershell
$localEnv = Read-Host '输入仓外本机环境配置文件路径'
docker compose --env-file $localEnv -p siftline-local -f docker-compose.yml -f deploy/local.compose.yml up --build -d --wait
curl.exe -kfsS https://localhost:8443/readyz
```

上面使用 CPU 配置。NVIDIA 容器可用时，将 `-f deploy/local-gpu.compose.yml` 附在 CPU overlay 后，安装 GPU 推理后端并启用探测。使用相同项目名会更新该开发栈，调整环境前核对目标及其数据库卷。代理端口默认根据环境文件设置，完整配置另将 PG 绑定为 `127.0.0.1:55440`，可用 `LOCAL_POSTGRES_PORT` 调整。网页 API 使用 `/api/v1/*`，代理到 Fastify 的 `/v1/*`。

归档来源注册、权限、模型、CPU/GPU 配置和回退见 [R4 操作](r4-archive.md)。现有 `output/docker-v2/` 是该工作站旧联调记录及当前可复用运行入口，保持原卷、端口与私有配置。新的仓库配置使用独立项目，按需显式迁移数据。需要真实 LLM 时从私有环境提供 `REPORT_LLM_BASE_URL`、`REPORT_LLM_API_KEY` 和模型名。外部采集需要显式启用、受限配额与来源授权。

### 源码开发

Node 24+、PostgreSQL 16；R4 插件需要 Python 3.11+，构建镜像使用 3.12。连接明确的开发数据库，以[环境变量示例](../deploy/env/app.env.example)准备配置。

```powershell
npm ci --ignore-scripts
npm --prefix apps/web ci --ignore-scripts
npm run db:migrate
npm run app:api
# 在另一终端启动 Web
npm --prefix apps/web run dev
```

宿主 Vite 联调使用其实际 origin 作为 `APP_ORIGIN`，确需 HTTP 时仅在本地设置 `ALLOW_HTTP_DEV=true`。编译运行可使用 `npm run build:api` 后 `npm run start:api`。

## 按风险验证

| 变更 | 本地入口 |
|---|---|
| 文档、锚点、迁移兼容 | `npm run lint:policy` |
| 单域业务、类型和依赖 | 对应 `lint:api` / `lint:web`、`npm run typecheck`、`npm run lint:arch`、`npm run test:unit` |
| HTTP 接线、访问策略 | `npm run check:openapi`；按风险加 Fastify inject、隔离 PG 或浏览器角色测试 |
| SQL、持久化、事务 | 用一次性本机 PG16，`TEST_SOURCE_DATABASE_URL` 指向回环地址的 `source_validation_*` 测试库，运行 `npm run test:postgres`；编译件用 `npm run smoke:compiled` |
| 交互、前端产物 | 测受影响的真实入口；`npm run build:web`、`npm run check:web-bundle`，按风险加 `npm run test:browser` |
| 归档、容器 | R4 用 `python -m pytest -p no:cacheprovider plugins/zst-archive/tests`；Compose 用相应组合 `config --quiet` 和隔离实例冒烟 |

[验证工作流](../.github/workflows/verify.yml)根据[变更范围](../scripts/ci-scope.mjs)选择任务，`CI Gate` 汇总结果。治理脚本阻断新增 `.only(`，高亮抑制和敏感路径变更供评审。CODEOWNERS 按路径匹配，批准要求由托管设置决定。PR 正文模板可自由使用。相关保护见[长期不变量](invariants.md)。

## 轻量部署与运维

基础 [Compose](../docker-compose.yml)描述在线 PostgreSQL、API 和 Caddy。资源受限时另叠加 [lightweight overlay](../deploy/lightweight.compose.yml)，通过 `DB_MEMORY_LIMIT`、`APP_MEMORY_LIMIT` 和 `PROXY_MEMORY_LIMIT` 调整。选用历史限额的环境使用该 overlay 继续部署。轻量栈保留原有 PostgreSQL 调参、代理内网和日志轮转。独立 R4 的部署和资源由[归档手册](r4-archive.md)管理。

```powershell
$deployEnv = Read-Host '输入该部署的仓外环境配置文件路径'
docker compose --env-file $deployEnv -p siftline-light -f docker-compose.yml -f deploy/lightweight.compose.yml up --build -d --wait
```

- 生产密钥通过权限受限的仓外文件或秘密管理配置。保持 HTTPS、代理信任边界、外部 URL/SSRF 防护、管理员 MFA 和最小权限。MFA 及加密主密钥的变更需要先确认已有账户、凭证和恢复路径。
- 镜像按 `--target runtime` 与 `--target proxy` 构建，保留同一提交标签与 `org.opencontainers.image.revision`。部署后检查健康、权限及该次发布涉及的真实业务。
- 涉及数据库状态的发布先备份并在隔离库验证回滚/恢复，核对实际 `schema_migration` 的文件名和哈希。可用 `npm run db:backup -- --file <受限路径>`、`npm run db:restore -- --file <备份文件> --target <隔离库>`。旧 PR #32 试验迁移曾复用 059–062，对保留数据的实例单独确认台账，不改写或清空历史迁移。
- 离线数据和 CLI 见 [AI 历史数据](../data/ai/history/README.md)。采集批处理命令为 `npm run collect:batch -- <文件>`，实际提交需审核预算、适用范围和限定来源的权限。
