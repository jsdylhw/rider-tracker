# Training Agent service

一个以本地 FIT 运动数据为中心的个人运动助手。它把 Garmin 活动整理为可查询的本地记录，用自然语言回答训练问题、生成活动分析，并可按需上传到 Strava。

Rider Tracker 是唯一浏览器入口。该目录只提供 Python Backend、Agent、CLI 和 Rider 内部 API，
不再维护第二套独立 Web 页面。

## 能做什么

- 从 Garmin 中国同步活动，或直接读取本地 `.fit` 文件。
- 分析骑行与跑步活动：强度、功率/配速、心率、分段、冲刺、爬升和恢复建议。
- 用自然语言查询单次活动，例如“100–200 秒有没有连续冲刺”。
- 汇总最近活动、比较训练表现、查看训练负荷，并给出下一次训练建议。
- 批量生成活动报告、上传 Strava；中断或失败后可继续处理。
- 规划国内外单日、多日或上下午分段骑行路线，并通过对话选择、修改、反转、撤销和确认候选。
- 在国内路线中展示并组合真实 Strava 路段；支持经典完整环线以及开放式距离、方向、地形和风景发现。
- 通过 Rider 页面查看活动报告、训练曲线、路线候选和 Strava 路段。

## 它如何工作

运动数据、活动索引、分析报告和处理记录默认保存在本地。大模型负责理解问题、选择分析方式和解释结果；FIT 解析、指标计算、路线计算和文件管理由本地程序完成。

只有在你主动使用相应功能时才会访问外部服务：Garmin 用于同步，大模型服务用于理解和分析，Strava 用于活动发布与国内热门路段参考，高德用于国内地点检索和骑行算路，Google 用于国外地点、路线和参考海拔。在 Rider Tracker 单仓中，账号和 API 凭据统一放在仓库根目录 `config.yaml`，不要在这个服务目录维护第二份配置。

## 快速开始

推荐从 Rider Tracker 根目录安装和启动：

```bash
npm run setup:agent
npm start
```

从仓库根目录示例创建统一配置：

```bash
cp config.yaml.example config.yaml
```

编辑根目录 `config.yaml` 并填入所需凭据：`agent` 用于对话和分析；Garmin 配置仅在同步时需要；Strava 配置用于活动发布和国内热门路段；高德与 Google 配置用于路线规划。`web_api_token` 用于保护 Rider Node 到 Python Backend 的内部 API。`config.yaml` 不会提交到 Git。

启动对话：

```bash
npm run agent:cli -- chat
```

可以直接这样提问：

```text
分析最近一次活动
今天上午这次骑行 100–200 秒有没有连续冲刺？
汇总最近一周训练负荷，并建议下次训练
同步最新五个活动，分析后上传到 Strava
重新分析所有活动，生成 V2 报告
从青浦新城地铁站出发骑一圈 50km 再回来，沿途风景好一点
规划一条夫子庙到中山陵再到玄武湖的路线
从夫子庙出发骑完整环陵路线
```

只启动 Python Backend 进行诊断：

```bash
npm run start:agent
```

该端口只提供 Rider 内部 API，不提供产品页面。日常使用请运行 `npm start` 并访问 Rider Node 页面。

也可直接分析一个本地文件：

```bash
npm run agent:cli -- analyze-file "data/files/fit/garmin/path/to/activity.fit"
```

## 本地活动数据库

仓库根目录 `data/rider-tracker.db` 是活动与报告的唯一运行时存储：`activities` 一条记录对应一个真实 FIT，`activity_reports` 只接受 `llm_fit_file_analysis.v2` 与 `activity_metrics.v2`。活动选择、历史上下文、报告读取和 Strava 上传均按稳定活动 ID 查询数据库，不会回读旧索引、JSONL 历史或 summary JSON。

可检查当前数据库状态：

```bash
npm run agent:cli -- debug storage-status
```

聊天中的“重新分析所有活动”会提交内存后台任务并立即返回任务 ID；也可在调试 CLI 中等待全量 V2 重建完成：

```bash
npm run agent:cli -- debug rebuild-v2-reports --scope all
```

如需给外部程序查看 JSON，使用 `ActivityStore.export_report(activity_key, path)` 显式导出；导出文件不是缓存，也不参与后续状态判断。

## Agent 路线规划

路线能力统一由 `plan-routes` Skill 组织。用户明确起终点或途经点时直接保留骨架；只有起点、区域、方向、距离、地形或风景要求时，由 Agent 先生成一至三条可检索骨架。多日和上下午行程仍使用独立的分段计划服务。

单日路线统一调用 `create_route_plan`：普通路线默认先生成地图基线，再尝试用已发现的真实 Strava 路段替换增强；任何发现、选择或拼接失败都会保留地图基线。明确要求完整经典环线时使用同一工具的 `segment_strategy=complete_loop`，由地图服务连接实际起点与完整 Strava 闭合路段后返回起点。后续选择、语义修改、反转、撤销和指定路段组合都通过 `update_route_plan` 完成。

首次生成的是待选择草稿，不会自动视为最终路线。国内使用高德骑行算路，国外使用 Google；两者都可尝试 Strava 路段增强。海拔仅作为参考信息。Strava 路段用于路线证据与组合，不代表实时路况、安全、道路开放状态或精确坡度。

`active_skill_id` 仍只授权当前一轮。会话上下文另外记录 `last_used_skills` 和 `conversation_used_skills`；当上一领域是 `plan-routes`、当前确有已保存路线且用户明确要求增加、删除、替换、反转、选择或确认时，可直接续接路线 Skill，但具体更新操作仍由 Agent 从白名单工具中选择。没有成功执行路线工具时，结果层不会声称路线已经更新。

路线 Tool 不再要求模型声明 `route_type`。首尾地点不同表示单程，首尾地点相同表示闭环；服务端只检索一次重复起点，并用第一次解析出的精确坐标闭合。内部仍写入派生的 `is_closed` 和兼容 `route_type`，用于读取旧路线及现有 UI。明确给出的 A→B→C 必须保持原顺序，只有用户明确要求环线或返回起点时才允许生成 A→B→C→A。

国内地点按路线顺序解析：首点使用高德关键字搜索，后续点优先在前一点周边检索并结合名称匹配和距离选择，周边无结果才降级到带行政区偏置的关键字搜索。语义修改途经点后，候选名称会根据新的途经顺序重新生成。

`demo/gaode_cycling_router/`、`demo/global_cycling_router/` 和 `demo/osm_cycling_router/` 保留为供应商接入与算法实验；主 Agent 使用 `services/route/` 下的持久化路线服务。

## Agent 评测

项目提供 Skill 选择和真实模型工具选择评测。真实模型工具模式使用无副作用 Sandbox，不会访问 Garmin 或写入 Strava：

```bash
TRAINING_AGENT_CONFIG_PATH=../../config.yaml python -m evaluation.cli run --cases evaluation/cases/skills.jsonl --mode skill
TRAINING_AGENT_CONFIG_PATH=../../config.yaml python -m evaluation.cli run --cases evaluation/cases/live.jsonl --mode live --repeats 3
```

评测输出工具选择成功率、任务完成率、回答一致性、响应时间、Token 用量和可选的估算成本。用例格式与报告说明见 [`evaluation/README.md`](evaluation/README.md)。
以上命令从 `services/training-agent` 目录执行；通过 npm 启动 Rider/Agent 时，启动脚本会自动注入同一个根配置路径。

如果要从代码层理解 Garmin 同步、活动身份、ActivityRun、断线恢复和多层测试，请阅读 [`docs/garmin-sync-workflow-guide.md`](docs/garmin-sync-workflow-guide.md)。

## 数据与隐私

- 下载的 FIT、分析报告和活动处理记录均为本地运行产物，默认不提交到 Git。
- `config.yaml`、令牌和第三方授权结果应只保留在本机。
- 上传到 Strava 是显式操作；分析与路线建议不等同于安全骑行或医疗建议。
