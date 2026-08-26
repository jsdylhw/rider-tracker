# 数据库与活动数据访问

项目使用 SQLite 保存活动目录、导入时提取的确定性事实、LLM 报告，以及聊天分析导航状态。
FIT 文件仍是磁盘上的不可变原始数据；SQLite 是可重建的派生状态。

默认数据库路径：

```text
data/rider-tracker.db
```

从项目根目录查看表结构：

```bash
sqlite3 data/rider-tracker.db ".tables"
sqlite3 data/rider-tracker.db ".schema activity_facts"
```

## 数据关系

```text
FIT 文件
  └─ activities              一条 FIT 对应一条活动
       ├─ activity_facts     导入时计算的指标和特征（一对一）
       ├─ activity_reports   当前完整 LLM 报告（一对一）
       ├─ analysis_results   针对性问答的结果（多条）
       └─ analysis_navigation 工作区导航焦点（按 workspace 保存）
```

活动主键 `activities.id` 同时也叫 `activity_key`。它由 FIT 内容计算得到；不要依赖列表序号作为稳定标识。

## 表的职责

### `activities`

活动目录与基础索引。每条 FIT 一行，包含：

- 原始来源：`source`、`source_activity_id`、`fit_file_path`
- 时间与类型：`started_at`、`sport_type`、`sub_sport`、`name`
- 常用基础字段：距离、时长、爬升、平均功率、NP、平均心率、TSS、Strava ID
- `raw_json`：未展开的补充索引字段

它适合“有几个活动”“最近五条是什么”“某天有哪些活动”这类目录问题。

```sql
SELECT id, started_at, sport_type, name,
       ROUND(distance_km, 2) AS km,
       ROUND(elapsed_seconds / 60.0, 1) AS minutes
FROM activities
ORDER BY started_at DESC
LIMIT 5;
```

### `activity_facts`

导入 FIT 时由本地确定性代码生成，不调用 LLM。它是后续问答、比较、周/月统计的事实来源。

| 字段 | 内容 |
| --- | --- |
| `metrics_json` | `activity_metrics.v2`：功率、NP、IF、TSS、心率、踏频、配速、爬升、训练效果、数据质量等。 |
| `features_json` | `activity_features.v1`：冲刺候选、持续高强度/快速跑候选、爬坡候选、扫描基线与质量说明。 |
| `extractor_version` | 特征算法版本；算法升级后可据此重建。 |
| `input_hash` / `revision` | 用于判断事实内容是否变化及追踪版本。 |

其中 `sprint_candidates`、`effort_candidates`、`climb_candidates` 都是**候选/定位结果**，不是“训练结论”。例如城市骑行的起步高功率可能是短冲刺候选，但是否是一次有效冲刺训练仍由后续分析解释。

```sql
SELECT a.started_at,
       json_extract(f.metrics_json, '$.load.power_stress.tss') AS tss,
       json_extract(f.metrics_json, '$.power.normalized_power_w') AS np_w,
       json_extract(f.features_json, '$.sprint_candidates.count') AS sprint_candidates,
       json_extract(f.features_json, '$.climb_candidates.count') AS climb_candidates
FROM activities AS a
JOIN activity_facts AS f ON f.activity_id = a.id
ORDER BY a.started_at DESC;
```

### `activity_reports`

一条活动当前版本的完整报告。它由 `ActivityAnalysisAgent` 生成，内容包括 Markdown、Strava 描述和定性结论。

- `metrics_json` 与 `report_json` 中仍保留报告当时使用的指标快照，方便报告自包含。
- 历史计算、比较和训练负荷统计应优先读取 `activity_facts.metrics_json`，不要从 Markdown 或 `training_load` 文本做正则提取。
- 重新生成报告会更新这一表，不会覆盖 `activity_facts` 的原始确定性事实。

```sql
SELECT a.started_at, r.schema_version, r.status, r.revision, r.updated_at
FROM activities AS a
LEFT JOIN activity_reports AS r ON r.activity_id = a.id
ORDER BY a.started_at DESC;
```

### `analysis_navigation` 与 `analysis_results`

它们是 Agent 对话运行态，不是运动事实。

- `analysis_navigation`：按 `workspace_id` 保存活动集合顺序和当前焦点，支持“看第二个”“返回”。
- `analysis_results`：保存一次定向问题的结果，例如“100–200 秒有没有连续冲刺”；不会覆盖完整报告。

排障时可以查看默认工作区：

```sql
SELECT workspace_id, root_scope_json, focus_stack_json, updated_at
FROM analysis_navigation
WHERE workspace_id = 'default';
```

## Python 访问入口

不要让业务代码直接散落 SQL；优先使用 Repository 与服务层。

```python
from storage.repositories.activity import ActivityStore

store = ActivityStore()

# 目录与单条活动
count = store.count_activities()
activity = store.get_activity("<activity_key>")
entries = store.list_activity_entries()

# 导入时事实
facts = store.get_facts("<activity_key>")
metrics = facts["metrics"]
features = facts["features"]

# 完整 LLM 报告
report = store.get_report("<activity_key>")
```

活动定位使用纯 Resolver；只有 Agent 工具适配器决定是否写入导航焦点：

```python
from domain.activity.selection import ActivitySelectionRequest
from services.activity.resolver import ActivityResolver

request = ActivitySelectionRequest.from_arguments({
    "kind": "recent", "limit": 5, "order": "latest",
})
result = ActivityResolver().resolve(request)
```

## 导入与回填

下列路径会自动生成 `activity_facts`：

- Garmin 同步后对每个下载/已存在 FIT 的索引。
- 手动调用 `upsert_activity_from_fit()`。
- 直接生成完整报告时，若 FIT 此前未走导入流程，也会补齐 facts。

旧数据库可执行一次只读 FIT 的本地回填：

```bash
npm run agent:cli -- rebuild-facts
```

该命令只会解析 FIT 并写入 `activity_facts`；不调用远程模型、不生成报告、不上传 Strava。算法更新后使用：

```bash
npm run agent:cli -- rebuild-facts --force
```

## 读取策略

```text
活动列表 / 单项定位       → activities
普通活动概览 / 冲刺、爬坡 → activity_facts
多活动比较 / 周月训练趋势 → 多条 activity_facts.metrics_json
完整可读报告 / Strava 文案 → activity_reports
精确秒数、公里、异常解释   → 重新读取对应 FIT 的局部原始数据
```

数据库中的所有表都有外键关系。不要手工删除 `activities` 的单行来“清理报告”；删除活动会级联删除其 facts 和 report。正常写入请使用 `ActivityStore` 或对应服务，保证路径、内容哈希和版本字段一致。
