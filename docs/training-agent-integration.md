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

当前阶段保留两个数据库：

- Rider 数据位于根目录 `data/`，保存活动、FIT 和骑行执行状态。
- Agent 数据位于 `services/training-agent/data/`，保存会话、分析报告、工作流和路线计划。

在活动入口统一前，不允许 Node 和 Python 同时直接写同一组 SQLite 表。后续由 Rider 提供活动导入接口，Agent 使用稳定 `activity_id` 关联分析结果。

## 验收层次

1. `npm test`：Rider 的确定性逻辑和 UI 单元测试。
2. `npm run test:agent`：Python Agent 全量测试。
3. `npm run test:integration`：使用临时端口和临时 Rider 数据库启动两个真实进程，验证健康检查和代理链路。
4. 在线验收：显式使用本地账号验证模型、Garmin、Strava、高德和 Google，不纳入默认 CI，也不默认产生上传副作用。

## 后续集成顺序

1. 把 Rider 当前活动上下文传给 Agent。
2. 统一 Garmin/FIT 活动进入 Rider 活动库的入口。
3. 增加结构化 `workout.preview`、`workout.apply` 和 `activity.report` 动作。
4. 用户确认后由 Rider 执行路线或 ERG 课表；Agent 不直接控制 FTMS。
5. 骑行结束后把 FIT 和结果回传给 Agent，形成建议、执行、反馈和报告闭环。
