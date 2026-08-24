# Training Agent 集成说明

## 当前边界

Rider Tracker 是唯一面向浏览器的产品入口。Node 服务负责页面、Web Bluetooth、FTMS、实时骑行、活动文件和确定性安全控制；内置 Python Training Agent 负责对话、历史活动分析、Garmin/Strava 工作流以及路线规划。

两个运行时位于同一 Git 仓，但保持两个进程：

```text
Browser -> Rider Node -> Training Agent Python
```

这一边界可以避免慢速模型或地图请求阻塞实时骑行控制，也允许 Python 分析代码继续使用现有库。

## 代码来源

`services/training-agent/` 从 Personal FIT Agent 的固定提交导入。运行时数据、FIT、日志、SQLite、地图数据和 Token 不属于迁移内容。后续同步原仓改动时应使用明确提交，不要直接复制脏工作区。

根目录 `config.yaml` 是 Rider 与 Training Agent 的唯一人工配置入口，模板为 `config.yaml.example`。启动器将同一份 YAML 映射为 Node 环境变量，同时通过 `TRAINING_AGENT_CONFIG_PATH` 交给 Python。环境变量只用于临时覆盖，不再维护第二份 Agent 配置。

## 本地数据

Rider 与 Training Agent 现在共用根目录下的 SQLite 数据库，默认路径为
`data/rider-tracker.db`。数据库迁移必须显式运行 `npm run db:migrate`；Node 和
Python 在正常启动时只检查 schema，不各自执行隐式迁移。

- `activities` 保存活动身份、摘要和原始 FIT 路径。
- `activity_facts`、`activity_reports` 保存 Agent 生成的确定性特征和报告。
- `activity_artifacts` 保存可重建的详情曲线/地图序列，避免每次打开活动都重新解码 FIT。
- `athlete_profiles` 是 FTP、体重、最大/静息心率和骑行模拟参数的唯一事实源；Rider 设置页通过 Node 代理访问 Python，不再直接保存这些字段到 `user-profile.json`。
- `route_plans`、`route_plan_revisions` 保存 Agent 路线草稿及修改历史。
- `saved_routes` 保存 Rider 已确认的路线资产；`route_progress` 单独保存未完成进度。
- `activities.saved_route_id` 及路线起止里程把完成活动关联到实际骑行路线。
- `chat_sessions` 保存可恢复的对话状态。
- 原始 FIT 文件统一保存在根目录 `data/files/fit/`，数据库只保存相对路径或必要的绝对路径。

Strava 也由 Python 单独持有外部副作用：凭据来自 `config.yaml`，OAuth Token 默认保存在
`data/strava-tokens.json`，Token 刷新、活动上传和状态查询都通过 Node 代理进入 Training Agent。
旧 Node Token 文件的 `default` 包装格式会在首次读取时兼容，后续写入统一的单用户格式。

共享数据库不等于允许任意跨层写入。Rider 负责实时骑行和文件接收，Agent 负责
分析派生数据和路线计划；两边通过稳定的 `activity_id`、`plan_id` 关联。

## 验收层次

1. `npm test`：Rider 的确定性逻辑和 UI 单元测试。
2. `npm run test:agent`：Python Agent 全量测试。
3. `npm run test:integration`：使用临时端口和临时 Rider 数据库启动两个真实进程，验证健康检查和代理链路。
4. 在线验收：显式使用本地账号验证模型、Garmin、Strava、高德和 Google，不纳入默认 CI，也不默认产生上传副作用。

## 后续整理

FIT 处理、路线持久化和前端外壳的下一阶段整理顺序及验收边界见
[`consolidation-roadmap.md`](./consolidation-roadmap.md)。工作流恢复状态机暂不在该轮整理范围内。
