# R4 归档、分析与运行

R4 通过外置 DuckDB 只读访问分月 Parquet 与 SQLite FTS，并运行可选 Python 分析。PostgreSQL 保存业务、归档引用和研究快照。主线检查项目和来源权限后调用归档服务。

## 连接与研究

1. 运维使用已验证的 Reddit R4 推送来源，配置 `external_ingest` 和 `reddit-archive` 标签，关闭来源调度。用该活跃来源 UUID 配置 `ARCHIVE_ANALYSIS_SOURCE_ID`。普通用户需要显式来源授权，项目读取和编辑各自按服务端权限验证。
2. 在项目的「数据接入」检测归档连接，确认归档版本、可用月份、关键词或 Subreddit 与 UTC 时间窗。可用 AND/OR/NOT、引号短语和括号。预览后确认引用，同版本同范围可幂等复用。
3. 从项目或探索页进入过滤检索、样本分析和证据。原帖报告评论数与实际已归档数分别显示；已归档内容可能是精选或截断。撤销来源授权、暂停或变更版本后需要按实际状态重新验证，解除关联不改变归档。

归档根目录须为已准备好的分月包，每个包包含 `manifest.json`、`corpus/posts.parquet`、`corpus/comments.parquet` 与 `index/fts_*.sqlite`。保持同一版本文件静态。容器把目录只读挂载，独立凭证仅供主线与插件使用。跨节点使用私网、VPN 或 TLS。

## 运行与设备

优先用[本机完整 Compose](development.md#本机完整开发与验收)，它会把 API 指向 `http://archive:8765`。源代码运行时可在本机用 Python 3.11+ 安装插件 `python -m pip install "./plugins/zst-archive[analytics,balanced]"`，balanced 另需匹配的 spaCy 英文模型，镜像构建已提供该安装步骤。通过 `python -m zst_archive.cli inspect --archive-root <目录>` 检查归档。配置 `ARCHIVE_ROOT`、`ARCHIVE_SERVICE_TOKEN` 后在私有终端执行 `python -m zst_archive.service` 默认监听本机 `8765`。主线配置 `ARCHIVE_ANALYSIS_ENABLED=true`、`ARCHIVE_ANALYSIS_BASE_URL`、`ARCHIVE_ANALYSIS_SOURCE_ID`、`ARCHIVE_ANALYSIS_SERVICE_TOKEN`，最后一项与侧车 token 对应。

| 场景 | 设置与检查 |
|---|---|
| CPU | `ANALYTICS_ACCEL_MODE=off`。装分析依赖并提供 INT8 权重时走 CPU ONNX，基础统计可独立完成。资源不足或模型缺失时查看实际档位和降级状态。 |
| GPU | Compose GPU overlay 安装 GPU ONNX 和 CUDA 依赖，需要容器设备支持。 `auto` 或 `prefer_gpu` 探测 CUDA 和 FP16 权重。运行失败或显存不足时可回退 CPU，按实际元数据报告设备、权重和回退原因。 |
| 调优 | 默认共享 CPU 预算来自 `BI_CPU_CORES=auto`，由实际可见逻辑线程减一；`BI_MAX_CONCURRENT_JOBS` 控制重分析并发。另按输入和 SQL 分别设置 `ARCHIVE_DUCKDB_THREADS`、`ARCHIVE_DUCKDB_MEMORY_LIMIT`、`ARCHIVE_DUCKDB_TEMP_LIMIT` 和查询并发/超时。主线请求超时应覆盖预期归档超时。 |

对归档服务的已鉴权 `GET /health` 返回 `status` 和 `analytics`，含 `available`、`balancedReady`、面板与 `v2Runtime` 信息。探测结果、单次实际推理和历史样本性能分别记录。归档版本变化、来源无权限、召回超限或资源不足按返回状态处理，详情见[契约](contracts.md)。

旧推流使用独立授权。通过运维入口选择 `inspect`、`query`、`push`，先 dry-run，再使用限定该来源的 `ingest` Machine Key。推流批次和离线归档引用可依各自生命周期管理。
