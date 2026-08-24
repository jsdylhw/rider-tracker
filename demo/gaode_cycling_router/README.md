# 高德骑行路线 Demo

这是与 `demo/osm_cycling_router/` 并行的国内地图验证实验：

- 底图与两点连接段使用高德；连接段调用 **高德 Web Service 骑行路径规划**。
- 路线组合算法不重写：继续复用已有的主路段顺序、正反方向、回头路惩罚、候选排序和 Strava 骨架拼接逻辑。
- 原始 FIT、OSM、Strava 几何一律保持 WGS‑84；仅在高德调用/显示边界转换为 GCJ‑02，避免污染已有数据。

高德骑行 Web API 只接受一对起终点，因此旧算法中“经走廊锚点”的候选会被拆成多条相邻的高德骑行连接段再拼接；每一段仍是真实的高德骑行导航，不退化成汽车导航。

## 启动

1. 在高德开放平台申请 **Web 服务 API Key** 与 **JS API Key**，并为 JS Key 配置本地 Referer 限制。
2. 推荐直接在仓库根目录 `config.yaml` 填写 `amap.web_service_key`、`amap.js_key`、`amap.security_js_code`（该文件已忽略）。也可复制并填写 Demo 内的本地配置：

   ```bash
   cd demo/gaode_cycling_router
   cp .env.example .env
   ```

3. 启动：

   ```bash
   ./run_local.sh
   # 浏览器打开 http://127.0.0.1:8090
   ```

Demo 默认读取自身 `data/` 下已生成的高德探针。可用 `ROUTE_PROBE_DIR=../osm_cycling_router/data/route-probes` 改为读取旧 OSM Demo 的路线探针；读取时会自动把 WGS‑84 几何转换为 GCJ‑02，因此能正确叠加到高德底图。

## 以高德骑行重组已确认骨架

对已从 Strava 确认顺序的路段，可以直接使用高德替代原有 GraphHopper 连接段。输入保持 WGS‑84，输出是可直接显示在高德底图上的 GCJ‑02 GeoJSON：

```bash
python -m demo.gaode_cycling_router.compose_segments \
  --input demo/osm_cycling_router/data/jiangxinzhou-via-jiajiang-bridge.geojson \
  --segment-id 14356032 --segment-id 11875601 --segment-id 17544798 \
  --start '32.022624,118.783559' --target-km 55 --near-handoff-m 100 \
  --start-name '夫子庙' \
  --output demo/gaode_cycling_router/data/fuzimiao-jiangxinzhou-amap.geojson
```

该命令调用现有 `plan_ordered_segment_route`：路段顺序、短接缝核验标记、距离/回头路评分保持不变，只有每个连接段改为高德骑行导航。输出文件默认可在网页中直接载入。

## 命名环线的正确流程

“环淀山湖”“环某公园”不是让模型编几个景点，再把它们用导航相连。这个 Demo 将流程固定为：

1. 地图服务先把用户起点与地标解析为 WGS‑84 坐标和目标范围；LLM 只产出距离、训练/风景偏好、`landmark_loop` 等约束，不能杜撰道路或环线几何。
2. 对目标范围分块请求有限次 Segment Explorer，按边界覆盖而非单纯热度选择最多 12 条候选，并请求其详情几何。
3. 详情必须覆盖目标的东南西北边界；不满足时状态为 `needs_more_evidence`，网页只展示已找到的路段，**不会**输出“环湖路线”。
4. 边界都被覆盖但路段尚不连通时状态为 `needs_connector_validation`：再用高德骑行导航验证每一个连接段。
5. 只有骨架和连接段均可走时，才生成多个候选，并用距离范围、闭环误差和回头路比例过滤；结果 GeoJSON 可以立即在网页探针中预览。

可以单独运行第 2–3 步。结果是可持久化、可审计的 JSON，不含 Token：

```bash
export STRAVA_ACCESS_TOKEN='...'
python -m demo.gaode_cycling_router.discover_landmark_route \
  --name '淀山湖' \
  --bounds '31.120,120.930,31.200,121.030' \
  --alias 'Dianshan' \
  --min-km 60 --max-km 80 \
  --start-name '东方绿舟地铁站' \
  --output demo/gaode_cycling_router/data/dianshan-evidence-run.json
```

`status` 的含义：`needs_more_evidence` 表示缺少可信边界路段；`needs_connector_validation` 表示发现的真实路段还需用高德骑行连接验证；只有 `ready_for_connector_routing` 才可以进入候选路线生成。详情请求有 45 秒默认预算，超时项会被显式写入 `detail_failures`，下一轮可只补这些 id；已保存的详情几何也应按 id 复用，避免重复请求。

第 4 步会先用端点直线距离对所有路段顺序和正反方向做纯本地预筛，只将前 3 个不同的顺序交给高德。这样不会因为 5 条路段的 384 种组合而放大外部请求。它的产物是 **高德骑行已验证的预览候选**，并仍保留原证据状态：

```bash
python -m demo.gaode_cycling_router.validate_skeleton_candidates \
  --input demo/gaode_cycling_router/data/dianshan-evidence-run.json \
  --segment-id 17111162 --segment-id 11710466 \
  --segment-id 13314477 --segment-id 13314465 \
  --start '31.100591,121.015106' \
  --min-km 60 --max-km 80 --start-name '东方绿舟地铁站' \
  --name '东方绿舟 · 淀山湖路段候选' \
  --output demo/gaode_cycling_router/data/dianshan-candidates-amap.geojson
```

这里的 `--input` 可直接使用整个 evidence-run JSON（脚本会读取其中的 `detail_feature_collection`），也可使用单独导出的详情 GeoJSON；输出后打开 `http://127.0.0.1:8090/?probe=dianshan-candidates-amap` 即可在高德底图上实时比较各候选。候选若超出距离范围会明确标记，不能因为“能导航”就当作满足需求。

## 安全与范围

- `AMAP_WEB_SERVICE_KEY` 仅在本地 Python 服务中使用，浏览器不会收到它。
- JS API Key 必须发送给浏览器；Demo 为方便本地测试，`securityJsCode` 也走浏览器直配。生产环境应按高德文档改为 `serviceHost` 反向代理，并限制 Key 的 Referer/IP。
- WSL 设置了 HTTP(S) 代理时，Demo 会先经代理请求；若 TLS 被代理瞬时断开，会自动改为直连重试一次。
- 目前是验证 Demo，不接入 Main Agent，也不替换原 OSM/GraphHopper 版本。
