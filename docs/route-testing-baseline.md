# 路线模块测试基准

此文规定测试职责与运行范围，不以测试数量作为交付目标。真实运行证据记录在
[路线验证记录](route-distance-dialogue-validation.md)，实现状态见
[Route Agent 实施记录](route-agent-implementation.md)。本基准不代表以下所有真实场景已经验收通过。

## 各层负责什么

以下文件均位于 `services/training-agent/tests/`。

| 层 | 主要测试文件 | 必须保留的行为 |
| --- | --- | --- |
| 材料和需求 | `test_route_requirements.py`、`test_route_preparation.py` 材料校验部分 | 显式修改才覆盖旧要求；ID 重映射；城市切换；拒绝非法材料和不可信来源 |
| 本地搜索 | `test_route_skeleton_search.py` | 起终点、必经点、明确顺序、连续有向走廊；不同长度候选；输入不被修改 |
| 测量反馈 | `test_route_feedback.py` | 按实测比例重新搜索；超限不发布；重复骨架不重复请求；失败保留诊断 |
| 地点消歧 | `test_place_resolution.py` | 自然地点与同名商业地点区分；明确商业请求允许；城市过滤；歧义拒绝；有界补查 |
| Provider 与测量 | `test_route_measurement.py`、`test_route_provider_contracts.py` | 保留超限测量；不重复算路；请求/重试预算；响应字段及坐标协议 |
| 准备与创建接线 | `test_route_preparation.py` | 复用解析坐标；准备不算路；Strava 可选；可选点失败恢复；必经点不得静默删除；准备失败不复用旧上下文 |
| Agent 状态 | `test_route_agent.py` | 计划/版本绑定；失败后不串旧任务；当前选中路线作为修改基准；可信参数优先；没有新计划不能报成功 |
| 直接修改兼容路径 | `test_route_dialogue.py`、`test_single_day_route_plan.py` | 明确 update 的距离/版本/失败保护；不代替 refine 新候选组验收 |
| 页面与服务边界 | JS 路线单元测试、本地集成与降级集成 | 页面命令、跨入口状态、错误投影和后端不可用时的行为 |

同一规则的完整组合由业务所属层验证。上层只保留必要的参数传递、返回结果、持久化或失败恢复检查，
不重复展开算法全部排列。单元测试允许替换模型和地图，但不能据此声称真实地点或路线质量达标。

## 固定验收场景

| 场景 | 确定性基准 | 真实验证另须观察 |
| --- | --- | --- |
| 30 km 风景环线 | 准备材料路径只发布目标 ±10% 内候选；最多两轮、六次完整评估 | 实际距离、候选数量、地图模式与地点准确性 |
| 选中路线后“多经过鸭川” | 起点/距离继承；偏好修改；旧草稿不被覆盖 | 与修改前相比，是否真正增加走廊覆盖；权重变化本身不算改善 |
| 30 → 40 → 30 km | 目标切换，未声明要求继续继承 | 每轮距离误差、路线差异、成功与失败比例 |
| 同名景点/会议室 | 自然用途排除会议室，明确会议室用途仍允许 | 返回 Place ID、名称、类型和选择依据 |
| 可选点/必经点不明确 | 可选点与受影响走廊安全撤销；必经点拒绝；网络错误不冒充地点不存在 | 材料是否被过度删除；失败原因能否被用户理解 |
| Provider 失败或无合格路线 | 不发布不合格结果，不损坏旧计划，预算有界 | 按模型、Places、Routes 阶段分别记录失败和等待时间 |

距离 ±10% 只适用于准备材料与反馈路径，不把它当成旧直接 waypoints 路径的现有门槛。
控制点边覆盖不是实际沿河里程；网格轨迹相似度不是道路身份；DRIVE 结果不是户外骑行适用证明。

## 怎么运行

在仓库根目录执行。日常修改只运行表中受影响的测试文件，例如反馈算法修改：

```bash
PYTHONPATH=services/training-agent python -m pytest -q services/training-agent/tests/test_route_feedback.py services/training-agent/tests/test_route_skeleton_search.py
```

跨路线业务层修改时，扩大到路线相关回归，包括文件名不以 `test_route` 开头的路径：

```bash
PYTHONPATH=services/training-agent python -m pytest -q services/training-agent/tests/test_route*.py services/training-agent/tests/test_place_resolution.py services/training-agent/tests/test_single_day_route_plan.py services/training-agent/tests/test_itinerary_route_plan.py services/training-agent/tests/test_segment_aware_route_plan.py services/training-agent/tests/test_popular_loop_route.py
```

提交前按影响范围补检查：

- Python 共享 Agent/runtime、Provider 或跨模块契约变化：`npm run test:agent`（实际运行整个 Python 测试目录，不仅路线 Agent）。
- JS 页面/领域变化：`npm test`。
- BFF/API/存储接线变化：`npm run test:integration`；降级路径变化加 `npm run test:degraded`。
- Python 变化：`python -m compileall -q services/training-agent`；所有改动：`git diff --check`。
- 仅去重测试：先确认被删用例的独有断言有接收位置，再运行受影响测试及必要相邻层，不要求重跑真实地图。

## 真实质量基准

真实 API 验证独立于默认测试命令，使用隔离数据库，不修改配置文件或用户草稿。

1. 算法 A/B 固定材料、已解析坐标、目标、约束、地图模式和评估预算；若预算不同，必须并列报告，
   不能把增加请求得到的收益全部归因于排序算法。记录代码版本及材料来源，不能只引用会过期的 `/tmp` 文件。
2. 地点消歧 A/B 固定查询和用途，记录每次实际返回的候选及选中 Place ID；不假设多次查询结果恒定。
3. 真实 Agent 用上述固定对话场景检查完整链路；不预填模型工具参数或伪造地图返回。单次结果只作样本，
   声称稳定改善前须重复采样并报告样本数、成功/拒绝/网络失败数量，不只挑最好一次。
4. 每次记录：绝对距离误差、控制点覆盖及其证据级别、候选间差异、完整评估数、实际 Routes HTTP 数、
   全轮与各阶段耗时。未完成的模型等待单独计数；少于三条如实报告，不能用重复候选填满。

性能预算和发布阈值以业务代码为准；变更这些规则时同步更新对应断言。不要把某次网络耗时写成硬性单测门槛。

## 删除与新增规则

- 删除条件：同一行为已有明确覆盖，且独有断言已迁移；或对应生产能力确实已删除。
- 参数化用于共享搭建代码，保留有意义的场景名称。合并函数不等于减少覆盖场景。
- 不因用了 mock 就删除测试；看它是否验证业务边界。也不为每个内部函数机械增加一个测试。
- 不删除已复现的历史故障边界来追求通过数量或执行速度。
- 新增前指出现有测试缺少哪种行为；能增加一个参数场景或断言就不再复制完整 Agent 对话。

## 2026-09-20 清理记录

- 删除 `test_prepared_google_places_are_used_without_place_search`：不重复搜索由创建接线测试覆盖，
  闭环、原坐标复用与输入不变断言并入 `test_prepared_creation_reuses_coordinates_and_never_repeats_strava`。
- 删除 `test_optional_segments_are_not_claimed_as_validated_point_skeletons`：由骨架测试覆盖 Strava 不参与算路，
  增补路段输入不变与候选池上限断言。
- 两个必选走廊完整性函数合并成两个具名参数场景，仍验证默认行为及 `allow_partial=true` 时不能切断必选走廊。
- 准备流程不再重复逐条检查走廊算法，保留材料原样传递、非空待验证骨架及没有实际距离的接线断言。
- 本次涉及的七个核心文件，收集用例由 89 项降至 87 项。没有按数量目标删除历史故障或消歧边界。


## API 首版场景集（2026-09-20）

主流程固定三组，不按国家数量无限扩充：

1. 路线设置：创建 → 选择候选 → 改起点 → 改终点 → 增删/替换途经点 → 明确顺序；环线与单程互转。
2. 必经约束：新增必经 → 取消或替换必经 → 多个必经点顺序 → 与距离/地域冲突时拒绝或澄清。
   验收同时看控制点和实际几何，POI 中心不能直接等同于可通行入口。
3. 地区切换：同一会话京都 → 杭州 → 巴黎，检查 Provider、模式、坐标系与旧需求清理；
   除成功切换外，还要覆盖切换失败后的恢复。

状态边界随主流程一起测：旧版本拒绝、相同 request_id 重放、失败不改旧计划、下一轮正确继续。
HTTP 200 不等于业务成功。当前实测已覆盖的子项和两个未执行问题见
[HTTP API 验证记录](route-distance-dialogue-validation.md)；本场景集是目标，不代表全部已经通过。

### 多日骑行增量基准

`test_daily_itinerary.py` 负责草案不调用地图、逐日成功/失败隔离、距离范围提示、修改端点只更新邻日衔接提示、未确认/已确认的其他天路线保持暂存及 CAS 拒绝旧版本；`test_route_agent.py` 验证草案工具与多日修订白名单；API、确认和浏览器既有测试文件分别验证 request_id 幂等、仅 ready 日可确认、历史恢复与按天操作。真实多轮样本仍记录到路线验证文档，不作为离线测试替代品。
