---
name: plan-routes
description: 根据明确途经点或开放式骑行需求，创建并持续修改经过验证的骑行路线。
---

# 规划路线

用户需要真实路线，而不只是训练类型建议时，使用本 Skill。

## 创建第一版草稿

- 用户给出明确起终点或途经点时，保持原顺序并调用一次 `create_route_plan`。除非用户明确要求返回、骑环线或回到起点，否则不得擅自闭合路线。
- 对开放式需求，根据起点或区域、方向、距离、地形和风景推导一至三个合理且可检索的途经点骨架，并在一次 `create_route_plan` 调用中提交所有候选。
- 起点、“骑一圈再回来”和目标距离已经足够，不要要求用户自行设计中间点。
- 路线形状只由途经点顺序表达。点到点路线的首尾不同；环线必须把完全相同的起点检索词重复为最后一点。不得另外传递猜测的路线类型。
- 只有用户提供数字目标或范围时才设置 `target_distance_km`。不得根据著名路线的常见长度自行编造目标；没有距离要求的明确途经点路线必须按地图服务的实际距离接受。
- “不走重复路”“不要原路返回”“去回程分开”是确定性路线约束：必须传入 `route_constraints.avoid_repeated_roads=true`，通常保留 `maximum_self_overlap_ratio=0.1`。不得只把要求写进路线名称、理由或 `segment_preferences`。
- 国内路线中，“不要掉头”“不坐轮渡”“不走阶梯”分别映射到 `route_constraints.avoid_u_turns`、`avoid_ferry`、`avoid_stairs`。用户明确给出允许绕行比例时才设置 `maximum_detour_ratio`；“不要绕路”但没有数字时使用 `route_preferences.routing_priority=shortest`，不得编造比例。
- 国内路线中，“少左转”“少右转”“少拐弯”分别映射到 `route_preferences.turn_bias=fewer_left`、`fewer_right`、`fewer_turns`；“路线简单、好记、少换路”使用 `navigation_complexity=simple`；“尽量快”和“尽量短”分别使用 `routing_priority=fastest` 与 `shortest`。
- `route_preferences` 只用于高德返回的真实备选路线排序，不是通行或安全保证。没有导航步骤证据时，不得声称已经减少某类转向。不要把中国大陆的少左转经验自动套用为其他国家的安全规则。
- 用户明确要求某条有名称或特定区域的完整热门环线时，调用 `create_route_plan`，并传入 `segment_strategy=complete_loop`、`origin`、`area`，以及确有依据的 `segment_name_hint`。
- 只有多日行程或同一天拆成多个阶段时，才使用 `create_itinerary_plan`。

普通路线默认使用 `segment_strategy=auto`：地图服务先验证每个骨架，随后服务可以用可用的 Strava 路段组合替换基准路线。发现、选择或组合失败时保留已验证的地图基准路线。只有用户明确要求必须有 Strava 证据时才使用 `require`；用户明确不要时使用 `ignore`。

中国大陆使用高德算路，其他国家使用 Google Places 和 Google Routes。服务只解析一次环线中重复的起点，并使用完全相同的起点坐标闭合路线。必须报告地图服务返回的实际距离，不得假装路线达到目标；被拒绝或未解析的候选不能作为有效路线报告。

国内候选包含 `route_quality` 时，应简要报告与用户要求直接相关的证据，例如左/右转次数、掉头次数、导航步骤数、绕行比例、重复率以及是否含轮渡/阶梯/桥/隧道。只报告字段中真实存在的证据，不得根据候选名称自行声称“更安全”或“绝不绕路”。

## 继续对话修改

初始结果是草稿。最多展示三个候选，然后等待用户选择或用自然语言修改。

- 使用 `select_candidate` 切换预览；只有用户明确确认后才使用 `confirm_candidate`。
- 后续修改使用 `replace_waypoint`、`replace_waypoints`、`replace_stage`、确定性反转或 `undo`。
- 后续提出避免重复道路时，使用 `update_route_plan` 的同一个 `route_constraints` 结构，并通过 `replace_waypoint` 或 `replace_waypoints` 给出新的骨架。服务端会校验地图最终轨迹；超过阈值的候选会被拒绝，不能把工具成功等同于要求已满足。
- 后续只改变“少左转、少右转、少拐弯、尽量短、尽量快、路线简单”等偏好时，沿用当前途经点调用 `update_route_plan.replace_waypoints`，并传入更新后的 `route_preferences`，让高德重新返回并排序备选；不得仅修改候选名称。
- 用户希望查看附近 Strava 素材时使用 `explore_route_segments`。
- 只有当前计划的已发现候选池中存在真实 Segment ID 时，才能使用 `compose_segments`。保持用户要求的路段顺序，绝不能编造 ID。
- 只有请求的地理区域或路线概念发生实质变化时，才重新创建路线计划。

海拔和 Strava 热度只是参考证据。不得声称掌握实时交通、道路安全、通行许可、街景连续性或精确路面坡度。
