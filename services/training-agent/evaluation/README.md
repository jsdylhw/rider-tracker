# Agent Evaluation

这套评测记录 Main Agent 的 Skill 选择、工具选择、任务结果、回答约束、耗时和 Token 用量，供重复比较。

本目录维护数据集、判定标准和运行方式。单次结果直接在对话中汇报；运行器生成的 JSONL/报告属于本地测试产物，不再复制到项目文档或改动日志。

## 两种模式

- `skill`：运行真实主循环的第一轮，只暴露 `activate_skill`；激活后立即停止，不暴露或执行领域工具。
- `live`：通过 `activate_skill` 渐进加载 Skill 工具并完整运行；所有业务 handler 替换为评测 Sandbox，不会同步 Garmin、写 Strava 或修改活动数据。

## 运行

```bash
TRAINING_AGENT_CONFIG_PATH=../../config.yaml python -m evaluation.cli list-cases
TRAINING_AGENT_CONFIG_PATH=../../config.yaml python -m evaluation.cli run --cases evaluation/cases/skills.jsonl --mode skill
TRAINING_AGENT_CONFIG_PATH=../../config.yaml python -m evaluation.cli run --cases evaluation/cases/live.jsonl --mode live --repeats 3
```

这些命令从 `services/training-agent` 目录执行，并读取 Rider Tracker 根目录的统一 `config.yaml`。

报告默认写入 `evaluation/artifacts/<UTC timestamp>/`：

- `results.jsonl`：每次 Case 的 Result、Trace 和评分。
- `summary.json`：汇总指标，适合版本对比或 CI。
- `report.md`：人工可读报告和失败原因。

如果已知模型单价，可以计算估算成本：

```bash
python -m evaluation.cli run \
  --cases evaluation/cases/live.jsonl \
  --mode live \
  --input-price 1.0 \
  --output-price 2.0 \
  --cache-write-price 1.0 \
  --cache-read-price 0.1
```

价格单位为每百万 Token 的美元价格。如果模型返回了缓存 Token，而对应缓存价格没有提供，成本也会显示为 `not configured`，避免产生不完整估算。

## Case 约束

每行是一个 `agent_eval_case.v1` JSON 对象。工具评分使用约束而不是要求完整轨迹逐字相同：

- `required_tools`：必须出现，且参数匹配。
- `forbidden_tools`：不能出现。
- `ordered_tools`：只约束关键调用的相对顺序。
- `completion`：检查 Agent 结果和指定工具结果。
- `answer_assertions`：检查关键事实必须出现或禁止出现。

Skill 和真实模型评测具有波动性；建议重要回归使用 `--repeats 3`。

Skill 与 live 套件需要本地 `config.yaml`。所有领域工具都在 Sandbox 或未暴露状态下运行，不产生 Garmin、SQLite 或 Strava 副作用。

## 多业务对话基准

可复用的多轮输入、固定材料、业务判定与失败边界见 [对话回归语料](dialogue-scenarios.md)。新增 `cases/dialogue-baseline-skills.jsonl` 可直接用现有 CLI 运行，只验证 Skill 选择。旧 runner 不支持有状态多轮，且 live 模式是模型加替身工具，不能用来证明真实 FIT、数据库或外部发布结果正确。旧 live 路线用例仍含历史主工具契约，不作为当前路线委派的验收基准。


## 有状态单轮 / 多轮数据集

`cases/dialogues-validation.jsonl` 与 `cases/dialogues-test.jsonl` 各 8 个案例：4 个单轮、4 个双轮，总计 16 个案例 / 24 轮，覆盖 8 类 Skill 与普通聊天。验证集用于调试；测试集用于保留场景验收，不根据测试集失败不断改写期望。相近业务必然共享工具，但失败切换地区与必经点修改、骑行分桶与徒步末段、发布成功与发布结果未知分别放在不同集合。

每行 `agent_dialogue_case.v1` 包含 `case_id`、`scenario_family`、`split`、`tags`、`turns`。每轮包含 `input`、`expected`、显式 `tool_outputs`，可选 `selected_activity_keys`。期望与固定答案不作为提示注入模型，工具被实际调用后才提供对应材料。跨集合重复 ID、场景族和完全相同的输入会被拒绝；近义场景仍需人工审查。

从仓库根目录运行：

```bash
# 无网络：同时检查两个集合的完整性和隔离
PYTHONPATH=services/training-agent python -m evaluation.dialogues \
  services/training-agent/evaluation/cases/dialogues-validation.jsonl \
  services/training-agent/evaluation/cases/dialogues-test.jsonl --check

# 真实模型 + 固定业务结果：先验证集，再测试集
PYTHONPATH=services/training-agent python -m evaluation.dialogues \
  services/training-agent/evaluation/cases/dialogues-validation.jsonl \
  services/training-agent/evaluation/cases/dialogues-test.jsonl \
  --split validation --output /tmp/rider-dialogues-validation.jsonl
# 将上面的 split 改为 test、output 改为 /tmp/rider-dialogues-test.jsonl
```

`--case-id` 可重复指定以单独复现。输出文件必须尚不存在，防止覆盖前次失败；有失败案例时 CLI 返回非零退出码。每组调用正式 `run_tool_loop`，轮间保留 `AgentContext` 与对话；新案例使用新上下文和临时数据根目录。只替换业务工具，保留真实 Skill 激活、权限、完成判断和短控制入口；未配置的工具明确失败。运行器临时替换进程内注册表，须在独立 CLI 进程串行执行，不能嵌入在线服务。

输出逐轮保存状态、工具参数/输出、选择目标、回答、评分、耗时和 token。固定结果不按参数重新计算，因此参数断言和人工轨迹复核同样必要。连接失败保留为失败样本，不能归因于能力不足；重要样本重复运行时另存输出，不能覆盖前次失败。

### 证据边界

- 这套自动评测证明主 Agent 在固定证据下如何选工具、沿用活动及表达结果，不证明真实 FIT 数值、路线子 Agent、地图网络、账号发布或浏览器表现。
- 路线案例只检查委派参数与返回状态；地区材料清理、距离质量和多日暂存仍用路线业务测试与真实 API 验收。
- `selected_activity_keys` 检查内存活动选择，不等于数据库导航栈或进程重启恢复通过。完整导航、恢复与任务幂等见人工语料和对应业务测试。
- 当前自动答案断言只覆盖指定事实，不能替代人工评价建议质量。训练指导仍复用汇总证据；恢复/效率/表现不可用时必须明确限制。
- 当前为基准 v1，无训练集。验证集用于开发与提示调整，测试集保留评估；模型从未使用这些案例训练。

离线测试：`PYTHONPATH=services/training-agent python -m pytest services/training-agent/tests/test_dialogue_evaluation.py -q`。
