# SIFTLINE 导航与交互

导航以 [App](../apps/web/src/App.tsx) 和 [WorkbenchShell](../apps/web/src/pages/WorkbenchShell.tsx) 为准。产品工作以“找到资料、开展研究、交付报告”为主线。

| 入口 | 当前体验 |
|---|---|
| `/`、`/product` | 产品介绍与场景入口。信号聚焦在 `/focus`，AI 发布情报在 `/ai`，文档与指南在 `/docs`、`/guide`。 |
| `/reports`、`/reports/new` | 报告工作台、创建向导、报告列表、运行和周期计划。在线报告可查图表与证据，导出为独立 HTML。 |
| `/projects?view=list`、`/projects?view=resources` | 全部研究、研究资料和所选项目。当前项目页承接概览、数据接入、内容研究、洞察等操作，实际 tab 从 ProjectsPage 读取。 |
| `/explore`、`/content`、`/workspace` | 探索覆盖数据源和研究范围、进度、图表、证据和快照。内容页支持权限内检索和导出；工作区提供已保存资料。 |
| `/app/feed` | 完整资讯与社媒入口，按频道、平台和已有范围切换，支持在抽屉中原位阅读。 |
| `/sources`、`/admin/queue`、`/settings` | 来源、配额、监测、AI 运维与个人设置。菜单随用户角色显示，操作由服务器校验授权。 |

访客可浏览公共入口和开放数据。成员登录后进入研究、报告和探索，既有批次、报告与归档以所有权、共享设置和来源权限为准。管理员和 Owner 管理相应资源，敏感操作需要 MFA。

继续保证窄屏图表可读、加载/空态/无权限明确、键盘阅读和抽屉焦点恢复、深链接保留研究范围。新图表需能追溯样本、分母和证据。按实际延迟选择首屏请求、缓存、分页和懒加载。组件实现及共享基础样式优先复用。

交互优化任务见[当前状态](status.md)。过去的首页和 PR 规格见 `docs/research/` 与本地 `output/README.md`。
