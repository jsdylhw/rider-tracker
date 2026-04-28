# 0427 路线规划独立项目讨论记录

## 项目定位

路线规划功能适合从 Rider Tracker 中独立出来，作为一个面向骑行者的路线生成与选择工具。Rider Tracker 可以继续负责骑行模拟、FIT/GPX 数据导入导出、上传 Strava、骑行分析等能力；路线规划项目负责根据城市、起点、距离、爬升、骑行风格和热门赛段生成候选路线。

这个项目的核心不是让大模型直接生成坐标点，而是让大模型作为路线规划 agent，调用地图、Strava、海拔和 GPX 工具，生成候选路线、验证路线、评分并解释推荐理由。

## GraphHopper

GraphHopper 是开源 OSM 路由引擎，适合作为传统地图算法核心。

可以重点研究的能力：

- 基于 OpenStreetMap 的路网建图。
- 支持自行车、步行、汽车等 profile。
- 支持 Dijkstra、A*、双向搜索、Contraction Hierarchies 等路径算法。
- 支持 snap to road，把 GPS 点或候选点吸附到路网。
- 支持 isochrone，计算一定时间或距离内可到达区域。
- 支持 elevation 和 path details，例如路况、坡度、道路类型等。
- 可以作为 Java library 使用，也可以作为独立 server 使用。

相关项目：

- `graphhopper/graphhopper`：核心路由引擎。
- `graphhopper/graphhopper-maps`：开源路线规划 UI，可以参考多点路线、替代路线、GPX 导出和前端交互设计。

适合本项目的角色：

- 负责真实路网连接。
- 负责起点到 Strava 赛段起点、赛段终点到下一个赛段、最后回到起点的路径求解。
- 负责生成可骑行的路线，而不是只拼接直线。
- 后续可作为高德/其他地图 API 的可替换后端。

## BRouter

BRouter 更偏骑行场景，是一个离线 OSM 路由引擎，特别适合研究“怎样算出更像骑行者会选择的路”。

可以重点研究的能力：

- 离线路由。
- 面向骑行的 profile。
- 支持海拔与坡度因素。
- 支持 no-go 点，避免经过某些区域。
- 支持 via points，通过指定中间点塑造路线。
- 支持 alternative routes。
- 支持高度可配置的 `.brf` routing profile。

相关项目：

- `abrensch/brouter`：核心路由引擎、Android app、server、profile 等。
- `nrenner/brouter-web`：BRouter 的 Web 前端，可以参考骑行路线编辑 UI、profile 选择、GPX 输出等。

适合本项目的角色：

- 作为骑行路线质量的重点参考。
- 研究 profile 如何影响路线，例如公路车、爬坡、休闲、避主路、偏绿道。
- 研究离线骑行路线规划是否可作为后期高级版本。

## AI Agent 与传统算法分工

大模型适合负责：

- 理解自然语言需求。
- 判断城市中的骑行主题区域，例如山、水、绿道、公园、经典爬坡、城市观光。
- 生成结构化路线需求。
- 选择搜索区域和候选赛段类型。
- 调用地图、Strava、海拔、GPX 工具。
- 对候选路线做解释和总结。

传统算法/地图 API 适合负责：

- 地理编码。
- 路网路径计算。
- 多点路径连接。
- 赛段排序。
- 距离、爬升、坡度、绕路率、重复率计算。
- GPX 生成。
- 路线合法性校验。

推荐架构：

1. 用户输入自然语言需求。
2. AI agent 转为结构化任务。
3. 地图工具解析起点和候选区域。
4. Strava 工具查询热门赛段和个人骑行历史。
5. 本地算法筛选赛段。
6. 路由引擎连接赛段。
7. 本地评分器筛选候选路线。
8. AI agent 解释推荐理由。
9. 导出 GPX/FIT，或交给 Rider Tracker 进行模拟骑行。

## Strava 赛段数据的使用

Strava 适合提供热门赛段和个人历史骑行参考，但不适合作为完整路线规划引擎。

可利用的数据：

- segment polyline。
- segment 起点/终点坐标。
- distance。
- average grade。
- elevation gain。
- effort count。
- athlete count。
- star count。
- 自己在某个赛段上的 efforts。

典型用法：

- 通过地理 bbox 查询附近热门赛段。
- 根据坡度和爬升筛选爬坡赛段。
- 根据距离和坡度筛选平路/巡航赛段。
- 根据 effort count、athlete count、star count 估计热度。
- 根据自己骑过次数判断熟悉路线或新鲜路线。
- 将 Strava 赛段作为“必须经过的高价值片段”，再用地图引擎连接成完整路线。

需要注意：

- Strava Segment 不是完整路线，只是一段路。
- 多个赛段之间通常需要地图 API 生成 connector。
- Strava 官方公开 API 不能直接读取 Global Heatmap 原始热图数据。
- 热门程度可以先用 segment 统计字段和个人历史作为替代指标。

## 路线拼接思路

给定起点 `S` 和一个约 10km 外的赛段 `A1 -> A2`：

1. 计算 `S -> A1`。
2. 固定经过赛段 `A1 -> A2`。
3. 计算 `A2 -> S`，形成 loop。
4. 如果距离过短，加入额外 waypoint。
5. 如果距离过长，换更近的赛段或调整回程。
6. 对候选路线评分。

评分因素：

- 总距离是否接近目标。
- 总爬升是否接近目标。
- 是否包含目标类型赛段。
- 是否绕路。
- 是否重复道路过多。
- 是否经过热门赛段。
- 是否适合当前骑行类型，例如爬坡、沿江、休闲、公路车训练。

## OSM 生态可以提供的能力

OpenStreetMap 本身是开放地图数据，不是一个单独的路线规划产品。真正可用的能力来自 OSM 数据和围绕它构建的工具生态。

### 地图基础数据

OSM 可以提供：

- 道路、路径、桥梁、隧道。
- 自行车道、绿道、步道、山路。
- 道路等级，例如主路、支路、住宅路、服务路。
- 单行线、转向限制、通行权限。
- 路面类型，例如 asphalt、gravel、unpaved。
- 坡道、台阶、障碍、栅栏等。
- POI，例如公园、景点、咖啡店、补给点、车站。
- 水系、山体、公园、行政区边界等地理要素。

### 路由能力

OSM 数据本身不直接给路线，但可以被路由引擎使用：

- GraphHopper。
- BRouter。
- OSRM。
- Valhalla。
- openrouteservice。

这些工具可以基于 OSM 计算：

- A 点到 B 点路线。
- 多点路线。
- 自行车/步行/汽车不同 profile。
- 避开某类道路。
- 等时圈。
- snap to road。
- map matching。
- GPX/GeoJSON/polyline 输出。

### 搜索与地理编码

常见工具：

- Nominatim：地址搜索和反向地理编码。
- Photon：基于 OSM 的地理搜索。
- Pelias：地理编码服务，可使用 OSM 等数据源。

可以用于：

- 将“杭州黄龙体育中心”转成坐标。
- 将坐标反查为地点。
- 搜索附近 POI。

### POI 与区域查询

Overpass API 可以查询 OSM 中的结构化对象。

可用于：

- 查询起点附近的山、公园、水系、绿道。
- 查询自行车道和特定 road tag。
- 查询补给点、咖啡店、景点。
- 辅助 AI agent 判断“沿江”“爬山”“城市观光”等路线主题。

### 海拔与地形

OSM 对海拔支持有限，通常需要结合外部 DEM 数据。

可选来源：

- SRTM。
- Copernicus DEM。
- Open-Meteo Elevation API。
- openrouteservice elevation。
- GraphHopper/BRouter 内置或外挂 elevation 数据。

可用于：

- 路线总爬升。
- 坡度分析。
- 爬坡赛段识别。
- 骑行强度估算。

### 文件格式与前端生态

常见格式：

- GPX。
- GeoJSON。
- KML/KMZ。
- encoded polyline。

常见前端：

- Leaflet。
- MapLibre GL。
- OpenLayers。

这些可以支撑：

- 地图展示。
- 路线编辑。
- 赛段高亮。
- 海拔图。
- GPX 导入导出。
- 候选路线对比。

## 明天可以继续看的实现方向

1. 先看 GraphHopper 的 route API、profile、elevation、path details 和 GPX 输出。
2. 再看 BRouter 的 profile 机制，重点理解为什么它更适合骑行。
3. 对比 `graphhopper-maps` 和 `brouter-web` 的前端交互。
4. 定义一个最小原型：
   - 输入起点、目标距离、路线类型。
   - 查询附近 Strava segments。
   - 选择一个爬坡或平路赛段。
   - 用地图 API 连接成 loop。
   - 导出 GPX。
5. 后续再加入 AI agent，根据自然语言自动选择区域、赛段和解释路线。

