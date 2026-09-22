# Agent 对话能力摸底（2026-09-21）

代码基线：`develop / c3caa68`。本次只做能力验证与记录，不修改业务实现。

结论：正常活动查询、分析、同步、最新活动发布、报告工作流已经可用；主要缺口是选中目标传递、按问题回答指标、精确数值汇总，以及对话“重试”与持久化工作流没有接通。当前证据不支持先重写全部 Agent/Worker。

## 本轮修复进展

2026-09-21：前两项已补实现，以下实验记录保留为修复前证据。

- 本地工作流增加明确的 `scope=selected/recent`。当前选择作为活动快照传入已有 ActivityRun；显式最近 N 条才重新筛选。没有当前选择或最近范围未指定数量时，停止并要求定位目标。
- 比较工具增加 `metrics`，支持距离、时长、均速、TSS、IF，其他指标明确显示暂不支持；缺失均速显示无数据，不通过距离/时长推算。默认概览修正报告标签来源说明。
- 已通过隔离真实工作流执行验证：选旧活动上传仍为旧活动，显式最近一条切换为新活动；上传 Provider 使用替身，没有新增真实发布。
- 修复后定向回归 124 项通过，覆盖比较、工作流服务/执行器、工具运行时/循环、Skill、结果构建、展示及架构；`compileall` 与 `git diff --check` 通过。
- FIT 时间窗聚合及重试衔接未在本轮修改。真实模型修复后的稳定性尚未重测。

## 真实模型与 API 验证

通过 FastAPI TestClient 调用正式 `/api/chat`，使用真实配置、模型、数据库、FIT 和外部 Provider。覆盖八类 Skill 的业务范围，但自然语言选择了哪个 Skill/工具以实际轨迹为准。共 13 轮，每个场景仅一轮样本，不代表稳定性通过率；未覆盖浏览器和 Node BFF。

用户明确允许真实 Garmin 下载和 Strava 发布。本次实际同步入库 1 条活动、发布 1 条 Strava 活动；重复发布被已有上传记录拦下，未强制上传。创建了专用测试会话和本地报告/工作流，未删除原会话或活动。

| 轮次 | 用户请求（部分简写） | 实际工具 | 耗时 | 判断 |
| --- | --- | --- | --- | --- |
| A1 | Garmin 同步最近 1 条，只下载 | sync_garmin_activities | 6.85s | 下载并入库 1 条成功 |
| A2 | 查看最新活动的类型、时间、距离、时长 | resolve_activities | 4.02s | 正确定位刚同步活动 |
| A3 | 分析这条，简短总结，说明数据不足 | resolve_activities → analyze_selection | 6.58s | 返回实际指标和分析；未独立复核所有叙述 |
| A4 | 最新 1 条上传 Strava，已有报告复用，不强制上传 | resolve_activities → run_activity_workflow | 25.40s | 真实发布成功 |
| B1 | 列出最近 3 条骑行时间、距离、时长，不生成报告 | resolve_activities | 3.70s | 返回 3 条 |
| B2 | 比较这些活动距离、时长、平均速度，缺少不要猜 | resolve_activities → compare_activities | 3.94s | 不完整：没有回答平均速度 |
| B3 | 根据这些活动给下次轻松训练建议及依据，不规划路线 | summarize_recent_training_load | 7.77s | 返回建议、数据依据和局限；未验证长期训练效果 |
| B4 | 最新 1 条生成报告并汇总，不上传，已有复用 | resolve_activities → analyze_activity | 3.87s | 复用单活动报告；不能以此认定批量工作流已验证 |
| B5 | 法国尼斯周边约 30 km 海景环线，允许周边城镇，虚拟观景 | run_route_agent | 45.19s | route_rejected / route_search_exhausted，没有合格候选 |
| A5 | 刚才活动前 5 分钟均功率、均心率，用原始 FIT 时间窗 | resolve_activities → query_activity_detail | 7.67s | 工具执行成功，但最终数字与原始记录复算不同，见下文 |
| A6 | 再上传最新 1 条，已上传直接跳过，不更新描述 | run_activity_workflow | 2.27s | 复用同一个 Strava ID，跳过上传 |
| C1 | 最近 2 条创建可恢复工作流，确保报告再汇总，不上传 | run_activity_workflow | 2.78s | 两条报告复用，汇总生成成功 |
| C2 | 查看刚才工作流，哪些完成、哪些失败 | get_activity_workflow | 2.04s | 成功定位工作流，返回完成步骤 |

A5/A6 使用 A 会话 ID，在新的应用进程恢复上下文；B、C 使用新的会话。真实调用没有人为注入 Provider 错误。尼斯失败保留为失败样本，不通过重跑成功来替换它；本轮没有重新定位该路线搜索耗尽的内部原因。

### 额外发现：精确 FIT 数值仍经过模型汇总

用户明确要求前 5 分钟原始时间窗，回答宣称 `0–300s` 共 271 条记录，平均功率约 96 W、心率约 129 bpm。按相同 FIT、同一闭区间复算：

- 功率：270 条有效记录，含 70 条零值、排除 1 条缺失，均值 **99.037 W**。
- 心率：271 条有效记录，均值 **130.889 bpm**。
- 这是记录样本均值；没有假设它等于插值后的时间加权均值。

`fit/analysis/data.py:get_time_intervals_tool` 返回分桶统计，没有整个所选窗口的权威均值。当前 15 秒分桶含不同样本数和端点单条记录，不能直接等权平均各桶均值。具体本次模型如何得出 96/129 尚未证实，不能直接认定为某一种加权公式错误。

回答还把零功率与缺失混写。零值可能是正常停踩，缺失是另一类数据；应分别统计。建议工具直接提供全窗口各指标有效样本数、零值数、缺失数、均值及统计口径，由模型解释，不让模型重新算总均值。

独立复算使用 `parse_activity_fit`、`records_dataframe`，按 `0 <= elapsed_s <= 300` 过滤后 `mean()`；与 `fit/analysis/stats.py:_filter_numeric_window` 的闭区间一致。

## FIT 窗口进一步分析（2026-09-21，只读探针）

- 同一 FIT 的 0–300s、15 秒分桶简单平均为功率 99.51 W、心率 130.655 bpm，并非回答的 96/129；因此不能断言原问题就是分桶均值等权平均。当前已证明数值不一致，未证明模型具体算式。
- `_compact_raw_evidence` 保留桶均值但删除 `samples`。独立输入两个样本数不同的桶，输出确实不含样本数。该函数用于自动预取证据，不能在未核实本次子 Agent 实际问题/工具轨迹前认定它就是本次偏差来源。
- `_series_stats` 排除 NaN 后计算均值并四舍五入到一位小数，但未返回各指标有效数/缺失数；桶总样本数也不等于每个传感器的有效样本数。
- `_rows_to_column_arrays` 使用所有桶字段交集。独立探针中第二桶没有功率字段，第一桶有效功率也从输出整列消失。这是额外边界缺陷，不是已经证实在本次 FIT 中发生。
- 闭区间包含 300s 单条记录，其桶标签为 300–315s、实际 duration=0；标签是名义桶边界，未采集窗口外数据，但容易被模型误读。
- `parse_explicit_window('查看前5分钟平均功率和平均心率')` 返回 None；显式 `0–5分钟` 才能自动预取。自然表达仍可由模型选工具，但确定性路径覆盖不同。
- 时间轴相对于首条 FIT record 的 timestamp，属于流逝时间，不是已经排除暂停的运动时间。
- 系统提示当前把零功率描述为可能停踩或功率缺失，容易混淆记录零值和 NaN；窗口传感器完整性也不能仅由桶均值是否存在推断。

建议先确定统计口径，增加直接从原始窗口计算的权威汇总（每指标有效数、缺失数、零值数、含零均值），保留分桶作为趋势证据；随后修复缺失列与压缩损失。精确数值应通过结构化字段展示，模型负责解释。此轮未修改实现或调用真实模型；重试问题已转入 [遗留问题](known-issues-and-technical-debt.md)。

## 原始实验产物

以下为本机临时诊断文件，可能被系统清理，不能作为长期 CI 基准；含个人活动回答，不复制完整 FIT、账号配置或 Token 到仓库。

- `/tmp/agent_live_capability_probe.py`：A1–A4；`/tmp/rider-agent-live-audit-_rrk10rg/`。
- `/tmp/agent_live_capability_other.py`：B1–B5；`/tmp/rider-agent-live-audit-32fxhi_k/`。
- `/tmp/agent_live_capability_followup.py`：A5–A6；`/tmp/rider-agent-live-audit-vub7n0ou/`。
- `/tmp/agent_live_capability_workflow.py`：C1–C2；`/tmp/rider-agent-live-audit-flrne0j0/`。

真实发布仅以“最新 1 条”为目标；下文选中旧活动后误发布的探针使用上传替身，未对真实账号执行该错误路径。

## 后续建议与验收顺序

1. **先固定业务目标**：选中旧活动后发布、分析+汇总均必须使用该活动快照；显式“最新 N 条”才重新解析范围。
2. **固定数值和问题契约**：比较按所需指标输出事实/缺失；FIT 全窗口聚合由代码完成，模型解释。
3. **接通现有恢复能力**：工作流 partial 保留失败任务和 ID，“重试”调用该工作流重试；插入闲聊或恢复会话不丢目标。
4. **成功必须有相应证据**：外部操作不能仅凭模型声称完成；普通解释问答不强制工具调用。

先用固定材料与故障注入验收这些边界，再复测真实对话；没有必要为这些问题先把同步业务都改成 Worker。尚未验证长时间进程中断、Worker 租约恢复、浏览器端交互、全部运动类型、多用户隔离、所有地图区域和模型多次稳定性。

---

# 附录：子 Agent 隔离运行与静态审计

日期：2026-09-21；仓库 develop / c3caa68。此报告由子 Agent 完成，未修改业务代码，未真实下载或上传。主 Agent 另行运行的真实 API/模型实验由主报告合并，不能把以下故障注入看作真实模型出现率。

## 验证方法与产物

- 真实 `run_tool_loop`、Skill 授权、工具适配、SQLite、ActivityRun factory/executor/retry。
- 模型输出是脚本控制，验证“如果模型这样调用，代码实际会怎样”，不验证自然语言模型选工具的准确率。
- Garmin/Strava provider 替身；FIT 为临时占位文件，通过 mock 已有报告避免解析它。未读取生产 config、data、token、日志。
- `/tmp/agent_dialogue_probe.py` 可复跑；`/tmp/agent-dialogue-probe-results.json` 保存逐轮 prompt/status/answer/steps。
- 现有隔离回归：138 passed in 25.70s，`/tmp/agent-audit-regression.txt`。覆盖 tool_loop、tool_runtime、skill_runtime、activity_workflow_service、workflow_executor、chat_sessions、route_agent、activity_query_agent、training_history_analysis、route_advice。
- 业务补充回归：111 passed in 38.23s，`/tmp/agent-audit-business-regression.txt`。两组共 249 项；新增探针 17 条记录（其中含 8 类 Skill 的故障注入）。

## 能力覆盖矩阵

| 业务/对话 | 本次覆盖方法 | 结果与边界 |
|---|---|---|
| 活动库：查最近三条 → 看第二个 → 返回 | 新增空库完整循环；已有真实临时仓库导航回归 | 空库 completed 且明确没有找到活动；导航/焦点回归通过。主 Agent 另行真实列表验证 |
| 单活动分析、FIT 精确追问 | tool_loop、activity_query_agent 回归 | 终结工具能返回业务答案；原始窗口请求会收窄工具；未在子 Agent 跑真实 FIT/模型 |
| 多活动/历史比较 | training_history_analysis、comparison 回归；静态追踪真实实测漏均速 | 服务支持固定指标模板，未实现任意指定比较指标；详见问题 2 |
| Garmin：同步三条 → 失败 → 重试 | 真实运行时/工具，provider 注入失败；回归含正常纯同步与第二轮焦点替换 | 直接失败被记住；插入闲聊或恢复会话后重试被拒；未真实 Garmin |
| Strava：选旧活动 → 上传这条 | 临时两活动库，真实 factory/executor，upload 替身记录路径 | 选 old 却上传 new.fit，已复现；详见问题 1 |
| ActivityRun：上传失败 → 重试 | 同上，失败写真实临时工作流；短回复与服务 retry 对照 | 短“重试”提示无可重试操作；显式 workflow_id 重试能只推进失败上传，详见问题 3 |
| 训练建议 | Skill/工具回归与 8 Skill 无工具故障注入 | 此子 Agent 未跑真实建议质量；主 Agent 实测负责 |
| 路线创建/追问/失败 | route_agent + tool_loop 定向回归 | 路线独立入口有产物约束；普通主对话仅激活 plan-routes 而不调用子 Agent 时仍可完成纯文本；此子 Agent 未调用地图 |
| 跨业务/会话恢复 | 新增同步失败→你好→重试，以及序列化恢复后重试 | 两者 retry_rejected，并清除旧失败动作 |

## 已复现问题（按优先级）

### 1. P1：选中的活动未传入发布/本地工作流，可能处理另一个活动

对话探针：已有 old(9月1日)、new(9月20日)，context 明确选 old；用户“上传这条活动到 Strava”；脚本模型合法调用 run_activity_workflow(limit=1,goals=[upload_strava])。

实测 provider 替身收到 `.../new.fit`，工作流活动和会话焦点均变 new。不是账号测试；是实际选择逻辑的隔离复现。

原因：
- `agent/tools/agent_tools.py:709` schema 仅 limit/order/sport_type，无 activity_key/当前选择。
- `agent/tools/handlers/activity_operations.py:72` 完全不读取 context.selected_activities；调用 start_local_activity_workflow 后还将处理对象安装为焦点。
- `operations/activity/workflow_factory.py:35` 再次 resolve_recent，而非冻结当前选择。
- publish Skill 却宣称对“用户要求的本地活动范围”执行，并提供 resolve_activities；定位结果实际上不能传给这个工作流。

建议先补“明确选择快照”参数并确定当前选择与显式最新N条的优先级。无需重写 Worker。未定位清楚时禁止以 latest 默默替代“这条”。同样影响指定日期/中间某条活动的分析+上传组合。

### 2. P2：比较模板不能按用户指定指标回答，且描述证据来源不准确

主 Agent 真实实测用户要求“距离、时长、平均速度，缺少不要猜”，结果漏均速。静态根因与该症状一致：
- `agent/tools/handlers/activity_insights.py:73` 丢弃 args，只传当前活动。
- `services/activity/comparison.py:12` 服务没有 question/metrics 参数。
- 同文件 `:55` `_activity_from_facts` 只投影时长、距离、标签、TSS、IF，没有速度。
- `:34` 读取报告、`:80` 使用报告标签，`:153` 模板却宣称“不依赖报告文本”。
- `agent/main_agent/turn_policy.py:51` 将 compare 视为终结工具，`result_builder.py:93` 直接返回模板答案，模型没有补答机会。

建议比较工具承接明确指标字段，返回每项事实/缺失/来源；保留确定性计算，只让最终回答围绕请求选择内容。不需要换 Agent 架构。

### 3. P2：ActivityRun 有恢复能力，但短“重试”到不了该能力

探针选定一次工作流，报告已存在，上传 provider 返回 network_error。

实测：业务输出 partial，答案正确写上传失败；但主结果 status=completed、last_failed_action=null；下一轮“重试”直接 no_retryable_action，无模型调用。对照：直接调用 retry_activity_workflow(workflow_id) 返回 completed、retried_task_ids=[new:upload_strava]。

原因：
- `operations/activity/workflow_service.py:201` partial 和任务内错误保留在 tasks，无顶层 error。
- `agent/main_agent/tool_result.py:24` 失败判定只认 error/status failed 或有限 result 嵌套，不认 partial 下任务失败。
- `agent/main_agent/turn_policy.py:68` partial 被视为终结结果。
- `turn_control.py:80` 没有 last_failed_action 就直接回“没有可重试”，不让模型看 workflow_id。

建议记录当前工作流 id 与可重试失败任务，短“重试”调用该工作流 retry，而不是重放 create 工作流。completed 可表示对话已结束，但必须另外向 UI 暴露业务 partial，避免混为任务成功。

### 4. P2：失败后插入闲聊/重启会话，使短重试失效并丢弃失败记录

“同步三条”注入断网→tool_failed并记下动作；“你好”→completed；“重试”→retry_rejected。恢复序列化会话后相同。

原因：`main_agent/loop.py:90` 每个普通轮清 active_skill；`app/chat_sessions.py:285` 序列化不保留 active_skill；`turn_control.py:57` 只认当前 skill 白名单，失配便清 last_failed_action。

建议保持当前权限约束，不盲恢复旧 skill；重试意图重新验证失败动作所属业务/目标，或引导模型恢复该 Skill。不要只因插入闲聊就永久抹掉可恢复任务。

### 5. P2 边界：主对话外部操作成功宣称缺少执行证据约束

对 8 个 Skill 均注入“activate_skill → 纯文本已经完成你的任务”。所有普通主对话结果 completed、steps=[]。对一般问答是正常行为；对“同步3条”“上传至Strava”等宣称外部动作完成，则会误导。

原因：`execution_policy.py:77` 普通 chat 不要求工具证据；`result_builder.py:85` 无失败便标 completed。独立路线页面的强约束不能覆盖主对话未实际委派的情况。

这是可复现运行时边界，不代表真实模型目前频繁这样回复。优先保证上传/下载/新建路线的成功展示来自结构化结果，不应为了修此问题让所有问答强制工具调用。

### 6. 低优先级：短重试对标点敏感

is_retry("重试")=true；"重试。"、"请重试"、"再试一次吧"、"Retry!" 均 false（`turn_control.py:92` 仅 strip/lower）。后者仍能由模型处理，不能说一定失败，但恢复路径与有无标点有关。已有导航命令会去掉标点，重试没有。

## 建议针对个人项目的下一步

不先做全量 Worker 统一。先修选中活动准确传给工作流；再修比较指标/来源；然后接短重试到现有 ActivityRun。其余故障处理可以继续局部修补。活动查询、普通单活动分析、模型建议与同步等正常路径是否好用，以主 Agent 此轮真实对话补充为准。


## FIT 查询统一路径修复

在提交 `2b8fc18` 后实施，重试仍维持延期。

- 删除正则窗口自动预取及单独压缩分支；所有自然语言窗口交由模型转换为工具参数，调用同一 FIT handler。
- 时间与距离工具新增 `window_summary`，直接按原始窗口计算每指标均值、有效数、缺失数、零值数；零值计入，缺失排除。统计不依赖分桶间隔。
- 保留闭区间语义和首条 FIT record 起算的流逝时间；桶 start/end 显示实际首末样本位置，端点单记录不再标成窗口外区间。
- 列式输出改用字段并集并用 null 对齐，保留各指标有效/缺失计数；不再因单个桶缺失删除整列。
- 删除旧正则预取专用测试，替换为两种问法的统一工具路径、不同分桶间隔的汇总一致性、部分/整桶缺失和边界验证。
- 隔离定向测试 147 项通过。模型仍负责语义理解及回答表述；这不等于形式化验证任意模型回答中的每个数字。


### 修复后真实 FIT 子 Agent 复测

使用真实模型、同一最新 FIT，通过 `run_activity_query_agent` 直接执行；不是浏览器/BFF 多轮验收，没有上传或下载操作。临时探针 `/tmp/fit_window_unified_check.py`，结果 `/tmp/fit_window_unified_check.jsonl`。

| 问法 | 实际工具参数 | 耗时 | 整窗回答 |
| --- | --- | --- | --- |
| 前五分钟，每10秒查看功率和心率 | get_time_intervals(0,300,10) | 11.12s | 99.0 W / 130.9 bpm |
| 0–5分钟，每5秒查看功率和心率 | get_time_intervals(0,300,5) | 11.87s | 99.0 W / 130.9 bpm |

两轮确定性汇总均为 99.037 W、130.889 bpm；功率有效270、缺失1、零值70。工具调用和整窗均值符合预期。

仍有回答质量限制：第二轮模型在开头正确引用零值70，但后续文字又写72，并编造缺失样本所在桶；两轮对记录空档的描述也需要核对，不能仅凭模型文字判定。该实测不作为整段自然语言答案完全通过的证据。当前改动解决路径分叉、汇总缺位与列丢失；模型逐桶抄写/解释的完整正确性尚未保证，后续应考虑结构化统计直接渲染、将模型解释单独展示。重试继续延期。


后续材料表达与输出预算的17次真实模型对照见 [FIT 查询格式验证](fit-query-format-validation.md)。本次仅测试并记录，没有改变生产格式；不再用“模型转述不可靠”概括已观察到的预算截断。

FIT查询后续已接入按需summary/二维表投影，输出预算8192且拒绝截断响应；162项定向测试通过及两轮真实只读复测，详见 [格式验证实施记录](fit-query-format-validation.md)。


## 主对话执行证据与进度展示（2026-09-21）

范围：不扩展恢复状态机或Worker，不修改路线算法。

- 下载、发布、活动工作流、路线Skill已经激活，但当轮缺少相应终结业务结果时，返回既有 `action_not_executed` 错误，不采纳模型纯文本“成功”；成功定位活动不能替代发布结果，旧轮trace不作为证据。
- 对缺少目标的请求开放 `ask_user_clarification`，返回 clarification_required；普通聊天/只读分析不强制外部操作。原可信入口的强制工具策略继续优先生效。
- 此边界针对已选择的业务Skill和真实结构化执行记录，不是对任意未激活Skill的自然语言成功宣称进行语义审查，也未验证业务执行一定完整符合所有自然语言目标。不能据此声称消灭所有模型幻觉。
- 主对话支持 `agent_stream.v1` NDJSON，原路线入口继续使用 `route_stream.v1`；Browser→Node BFF→Python贯通。Progress只含阶段、固定标签、状态、步骤序号，不含原始工具参数/账号/Provider结果。
- 主窗口新增独立处理面板：当前阶段、已耗时、可展开步骤；不以聊天气泡追加进度。部分完成/排队/待结果不显示为全部成功，断线不捏造完成；结束或切换会话停止计时并忽略迟到事件。
- 目前工作流和FIT子Agent显示主工具级阶段，不展示它们每个内部子步骤；不显示虚构进度百分比。

### 真实主对话验收

使用真实模型、FastAPI正式 `/api/chat` 流入口，同一独立会话连续9轮；保留正常数据库/报告和账号行为。测试产物 `/tmp/acceptance-b185053109/`、`/tmp/agent_postfix_acceptance.txt`。

| 场景 | 状态 | 耗时 | 进度事件数 |
| --- | --- | ---: | ---: |
| 普通聊天 | completed | 2.42s | 1 |
| 活动列表 | completed | 4.47s | 5 |
| 指定指标比较 | completed | 5.02s | 7 |
| FIT窗口汇总 | completed | 8.79s | 7 |
| 训练建议 | completed | 11.88s | 8 |
| 报告与汇总工作流 | completed | 2.96s | 4 |
| 工作流状态查询 | completed | 3.31s | 4 |
| Garmin同步 | completed | 7.78s | 5 |
| Strava幂等发布 | completed | 2.54s | 4 |

结果：指定指标比较返回3条均速；FIT回答99.0W/130.9bpm、功率缺失1/零值70；两条报告复用并生成汇总，后续成功查询同一工作流。Garmin本地已有，下载0/跳过1/失败0；Strava已有上传记录，跳过发布，没有新增上传。训练建议正常返回，但未逐条专业评估全部叙述。路线生成质量未在此轮重新验收。

验证层次：真实模型/API验证正常路径；故障注入验证无执行、仅定位、跨轮旧证据及正常澄清；JS测试验证进度面板、排队/部分完成、迟到事件、BFF和两端客户端流传递。没有运行真实浏览器截图验收。

本轮检查：JavaScript 447/447；Python受影响集合138项通过，补充“仅定位不能证明发布”用例后结果构建13项通过；compileall、git diff --check通过。未提交本轮改动。
