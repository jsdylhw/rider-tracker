# OSM Cycling Router Demo

独立验证“江浙沪 OSM 数据 + 自建 GraphHopper + 本地风景点检索 + Strava 路段偏好”的骑行算路原型。
它不接入 Main Agent，不修改 `ActivityRun`，也不会上传、删除或变更 Strava 活动。

## 目标与边界

- 路由计算：仅 GraphHopper + OpenStreetMap，内部坐标统一 WGS-84。
- 地图范围：江苏、浙江、上海。GraphHopper 与地点检索使用同一份合并 PBF，避免搜索结果落在算路范围外。
- 地点检索：本地 SQLite + RTree。仅索引湖泊/水库/瀑布、山峰、观景点、公园/自然区域、景点/古迹，以及用于路线锚定的城镇；默认忽略餐馆、商店等无关 POI。
- 验证对象：青浦与杭州等江浙沪范围内的真实 FIT 起终点，比较 `bike`、`racingbike` 和 `car`（避开高速）。
- Strava：仅调用有界的 `segments/explore` 获取一个矩形内的热门骑行路段样本；它不是全量公开骑行轨迹数据源。
- 不做：导航、生产 API、后台批量抓取、把 Strava 路段当作安全或合法通行保证。

## 启动 GraphHopper

```bash
cd demo/osm_cycling_router
chmod +x download_java_runtime.sh run_local.sh download_jzsh_osm.sh build_places_index.sh
./download_java_runtime.sh
./run_local.sh
```

如果本机已经有 Java 25+，可跳过 `download_java_runtime.sh`。首次执行 `run_local.sh` 会下载并合并江苏、浙江、上海的官方 Geofabrik PBF，再导入 GraphHopper。合并和地点索引使用 `pyosmium`：

```bash
python -m pip install osmium
```

首次导入的磁盘、内存和时间都会显著高于原来的上海范围 demo；下载的省级 PBF、合并结果和 GraphHopper 缓存均被 `.gitignore` 排除。

## Docker 一键部署

Docker 版本包含 Java、GraphHopper、Python、`pyosmium`、江浙沪数据下载/合并，以及风景点索引构建。首次启动会下载较大的省级 PBF 并导入路网，完成前健康检查不会通过；后续启动会复用 `./data` 卷中的 PBF、SQLite 索引与 GraphHopper 缓存：

```bash
cd demo/osm_cycling_router
docker compose up --build
```

启动完成后打开 <http://127.0.0.1:8080>，即可在地图上点击起点和终点、搜索本地风景点，或切换到“自由环线”并点击一个起点。两种模式都可选择 `bike`、`racingbike` 或 `car`；其中 `car` 在导入路网时排除了 `motorway` 与 `motorway_link`，适合用于比较主爬之间的普通道路连接，默认仍是 `racingbike`。网页底图由浏览器请求在线 OpenStreetMap 瓦片，因此可以浏览全球；路线和风景点查询仍严格使用本地江浙沪数据。该网页仅为 demo：页面后端监听本机回环地址，读取本地 SQLite，并代理到同机 GraphHopper；没有接入主 Agent 或任何外部写操作。

服务以 host 网络模式运行，但 GraphHopper 在配置中只监听 `127.0.0.1:8989`。这样 rootless Docker / WSL 可以复用本机代理下载地图，同时 API 不会暴露到局域网。默认容器 JVM 上限为 6GB；如果首次导入内存不足，可在 `compose.yml` 调高 `JAVA_OPTS`，同时保证 Docker Desktop / WSL 有足够内存。停止服务不会删除本地地图数据；如需重新下载并完整导入，手动删除 `data/` 后重新启动。

如果网络需要代理，在执行 `docker compose` 的 shell 中导出 `HTTP_PROXY` / `HTTPS_PROXY`；Compose 会将它们传给容器。下载采用 `.part` 文件和 HTTP Range 续传，短暂断网或重启不会把半截 PBF 当成已完成数据。

容器完成后可直接执行地点查询，无需在宿主机安装 Python 依赖：

```bash
docker compose exec graphhopper python3 /app/places.py search "径山寺" \
  --database /app/data/scenic_places.sqlite --near "30.24,120.10"

docker compose exec graphhopper python3 /app/places.py nearby \
  --database /app/data/scenic_places.sqlite \
  --point "31.10,121.02" --radius-m 5000
```

首次启动会导入 PBF、建立 `data/graph-cache-jzsh`，耗时和内存取决于机器；后续复用缓存。
服务只绑定 `127.0.0.1:8989`，避免意外暴露为公网路由服务。
配置启用了 GraphHopper 11 内置 `bike` / `racingbike` 的必需 OSM 编码字段；先用默认模型验证，再讨论自定义权重。

## 本地自由环线

“自由环线”只解决“从一个起点出发、骑约 N km、再回到起点”。它使用同一台本地 GraphHopper 的 `round_trip` 算法：对固定起点尝试 8 个 seed，筛掉距离偏离目标超过 ±20% 或无法闭合的结果，按距离误差排序，并去除几何高度相似的候选。每个请求都只访问 `127.0.0.1:8989`；没有调用外部 GraphHopper API。

在网页中切换到“自由环线”，点击地图选择起点，填写目标距离后点击“生成自由环线”。候选会同时画在地图上；点击列表或路线可高亮并查看距离、预计时长和误差。

也可以直接调用 demo API：

```bash
curl --noproxy '*' -G 'http://127.0.0.1:8080/api/free-loop' \
  --data-urlencode 'point=30.3085,120.0939' \
  --data-urlencode 'distance_km=20' \
  --data-urlencode 'profile=racingbike' \
  --data-urlencode 'count=3'
```

`round_trip.distance` 只是近似目标长度，且不理解“环某个湖泊”“必须经过某景点”等约束。它适用于通用的本地骑行闭环；指定地标环线需要下一阶段的湖泊/景区面几何和多点约束路由。

## 本地地点与风景点检索

在合并 PBF 后构建一个小型本地索引。构建阶段需要 `pyosmium`，查询阶段只依赖 Python 标准库和 SQLite：

```bash
python -m pip install osmium
bash demo/osm_cycling_router/build_places_index.sh
```

按名字搜索地点，并以起点偏置结果：

```bash
python demo/osm_cycling_router/places.py search "淀山湖" \
  --database demo/osm_cycling_router/data/scenic_places.sqlite \
  --near "31.10,121.02"
```

查询一个坐标周围 2km 内、值得纳入骑行路线解释的地点：

```bash
python demo/osm_cycling_router/places.py nearby \
  --database demo/osm_cycling_router/data/scenic_places.sqlite \
  --point "31.10,121.02" --radius-m 2000
```

结果包含 OSM ID、类别、坐标、原始标签和距离。它们是给后续地点消歧、GraphHopper 算路与 LLM 路线解释使用的事实输入；没有结果只代表当前 OSM 数据未标注，不代表现实中不存在该地点。

## 语义道路走廊索引

GraphHopper 保存完整的可路由路网，但不能直接回答“春风十里路 / YBA4 在哪里、可作为哪一段连接走廊”。`road_corridors.py` 从同一份 PBF 额外索引有道路名称、编号、道路关系或自行车属性的道路；保存简化几何和 SQLite RTree，而不重复 GraphHopper 的图结构。

容器首次启动会自动建立 `data/road_corridors.sqlite`。也可手动重建：

```bash
python demo/osm_cycling_router/road_corridors.py build \
  --pbf demo/osm_cycling_router/data/osm/jzsh-latest.osm.pbf \
  --database demo/osm_cycling_router/data/road_corridors.sqlite

python demo/osm_cycling_router/road_corridors.py search "YBA4" \
  --database demo/osm_cycling_router/data/road_corridors.sqlite

python demo/osm_cycling_router/road_corridors.py nearby \
  --point "31.706,119.334" --radius-m 5000 \
  --database demo/osm_cycling_router/data/road_corridors.sqlite
```

查询结果给出道路名、编号、所属道路关系和少量可用作途经点的 anchors。它们是后续生成“直连 / 经春风十里路 / 经绿道”等连接候选的事实输入；道路本身仍由本地 GraphHopper 计算并校验可通性。

## 多候选主爬闭环

`route_candidates.py` 把每一段主爬之间的连接扩展为“直连 + 经指定语义走廊的局部途经”候选，并同时搜索主爬顺序、正反方向和连接候选。它返回最多三条路线；“经 YBA4”只选择合适锚点，不强制骑完整条春风十里路。

```bash
python demo/osm_cycling_router/route_candidates.py \
  --input demo/osm_cycling_router/data/route-probes/jurong-maoshan-wawushan-climbs.geojson \
  --road-database demo/osm_cycling_router/data/road_corridors.sqlite \
  --corridor YBA4 \
  --segment-id 1530562 --segment-id 11607745 \
  --start "31.946528,119.163720" --target-km 100 \
  --profile car --max-routes 3 \
  --output demo/osm_cycling_router/data/route-probes/jurong-yba4-candidates.geojson
```

评分暂时只考虑目标距离、连接段长度、几何重叠与覆盖不同走廊；全程高程不在这一版承诺范围内。输出是可解释的规划 JSON，下一阶段再将它渲染为动态地图路线并接入 Agent。

传入 `--output` 后会同时生成可直接在 Demo 查看的 GeoJSON。运行服务后打开
`http://127.0.0.1:8080/?probe=jurong-yba4-candidates`；点击左侧每条候选可单独高亮并缩放到该路线。

## 干线 + 已验证区域闭环

`lollipop_loop.py` 是低层的“城市出发、进入一个**已验证**骑行区域、在区域内绕圈后按相同或近似干线返回”的拼接器。它把 `A → B` 和 `B → A` 只计算一次，保留在总距离中，但只对 B 区内部的多点闭环计算回头比例；不会把合理的进出山区共用道路误判为差路线。

它**不会**根据“环江心洲 / 环陵一圈”这类地点名自行推断可骑边界。区域骨架必须先来自已验证的 Strava Segment、完整 OSM 道路关系或人工审核的连续道路；随后才可以按一个方向提供边界点：

```bash
python demo/osm_cycling_router/lollipop_loop.py \
  --start "32.0226,118.7836" \
  --gateway "32.0100,118.6958" \
  --via "32.0350,118.6980" --via "32.0320,118.6670" \
  --via "31.9850,118.6650" --via "31.9820,118.6900" \
  --profile racingbike \
  --name "城市—已验证区域闭环（实验）" \
  --output demo/osm_cycling_router/data/route-probes/verified-area-lollipop.geojson
```

输出包含顺、逆两个区域环线候选；每条候选都显示干线去程、干线回程、区域内部距离和**仅区域内部**的重复比例。

## 用真实 FIT 探针算路

另开终端：

```bash
python demo/osm_cycling_router/probe.py \
  --fit "garmin_cn_fit_files/2026-07-30 08_38_25_青浦区 公路骑行_622437900.fit" \
  --profile bike

python demo/osm_cycling_router/probe.py \
  --fit "garmin_cn_fit_files/2026-07-30 08_38_25_青浦区 公路骑行_622437900.fit" \
  --profile racingbike
```

先只比较：是否能连通、距离是否接近真实活动、是否出现明显不合理的主路 / 绕行。不要把首个返回路线直接视为安全骑行建议。

## 主爬段的正反向选择

Strava 的爬坡方向是训练事实，但不一定是路书中唯一合理的行进方向。`segment_loop.py` 默认保留原方向；对风景闭环或路书探索，可传入 `--allow-reverse`，让每条候选道路既可作为主爬，也可反向作为下坡/连接段：

```bash
python demo/osm_cycling_router/segment_loop.py \
  --input demo/osm_cycling_router/data/route-probes/hangzhou-nw-climb-loop.geojson \
  --output demo/osm_cycling_router/data/route-probes/hangzhou-nw-reversible-loop.geojson \
  --target-km 80 --profile car --allow-reverse
```

要让路线真正从指定地点出发，传入 `--start`。规划器会把“起点→第一段”和“最后一段→起点”都计入路线评分和总距离，而不是仅把主爬段本身闭合：

```bash
python demo/osm_cycling_router/segment_loop.py \
  --input demo/osm_cycling_router/data/route-probes/hangzhou-nw-climb-loop.geojson \
  --output demo/osm_cycling_router/data/route-probes/jingshan-town-reversible-loop.geojson \
  --target-km 80 --profile car --allow-reverse \
  --start "30.377490,119.860585" --start-name "径山镇"
```

反向段会在 GeoJSON 中标记 `route_direction: reverse`，且不计入“已知主爬爬升”。该搜索最多支持 5 条路段，避免方向组合指数增长。它仍会对连接段重叠、距离和最长转场评分；找不到质量足够的组合时，应拒绝结果而不是强行闭环。

运行不需要路由服务的单元测试：

```bash
python -m unittest demo/osm_cycling_router/test_router.py
```

## Strava 路段样本

Strava Segment Explorer 对一个 bounds 只返回有限的热门路段。它可以作为候选路线的“骑行活跃度”信号，不能替代 OSM 路网，也不能批量下载他人活动。
请求失败时只会对临时网络 / 5xx / 429 做有限重试；不会关闭 HTTPS 证书校验。当前 WSL 如仍出现 `SSLEOFError`，应先修复该环境的代理或 TLS 路径，而不是修改 demo 代码跳过验证。


```bash
export STRAVA_ACCESS_TOKEN='...'
python demo/osm_cycling_router/strava_segments.py \
  --bounds '31.05,121.05,31.25,121.30' \
  --output demo/osm_cycling_router/data/strava-segment-sample.json
```

当 Explorer 找到疑似完整环线后，先只读取该 Segment 的详情与 polyline，再交给本地规划器连接城市起点；不要用几个手工边界点替代真实骑行骨架：

```bash
python demo/osm_cycling_router/strava_segments.py \
  --segment-id 17544798 \
  --output demo/osm_cycling_router/data/jiangxinzhou-loop.geojson

python demo/osm_cycling_router/segment_loop.py \
  --input demo/osm_cycling_router/data/jiangxinzhou-loop.geojson \
  --output demo/osm_cycling_router/data/route-probes/city-jiangxinzhou.geojson \
  --start "32.0226,118.7836" --start-name "城市起点" \
  --profile racingbike --target-km 50
```

若一个真实 Segment 是进出区域的明确约束（例如“经夹江大桥东往西过江，再开始江心洲闭环”），将桥段与闭环段按意图写入同一个 GeoJSON，并传入 `--preserve-input-order`。这样桥段不是可被重排的普通主爬：

```bash
python demo/osm_cycling_router/segment_loop.py \
  --input demo/osm_cycling_router/data/jiangxinzhou-bridge-then-loop.geojson \
  --output demo/osm_cycling_router/data/route-probes/city-jiangxinzhou-via-bridge.geojson \
  --start "32.0226,118.7836" --start-name "城市起点" \
  --profile racingbike --target-km 55 --preserve-input-order --near-handoff-m 100
```

`--near-handoff-m` 只允许衔接两条 Strava 轨迹首尾非常接近的情况；输出会把该短缝渲染为黄色虚线“待核验接缝”，不能当作已经由本地路网验证的道路。

后续排序实验应是：GraphHopper 生成候选路线 → 计算它与本地历史 FIT 及这个 Strava 路段样本的重叠 → 用这些只读信号排序。不得让模型自行编造道路或路段热度。

## 进入主项目的门槛

1. 至少用 5 条青浦 / 上海 FIT 验证 `bike` 与 `racingbike`。
2. 记录不可连通、主路、绕行、与真实轨迹距离差等失败样本。
3. 决定是否需要通过 GraphHopper custom model 调整道路类型、铺装和自行车优先级。
4. 只有探针稳定后，才增加 `agent/route/` 的 `RouteProvider` 与用户可见工具。
5. 地点搜索需要实测同名地点消歧、杭州西站等边界区域和 PBF 更新后的重建时间；不要把 demo 索引直接当生产地理编码服务。
