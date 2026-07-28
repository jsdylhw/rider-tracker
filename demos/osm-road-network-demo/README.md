# OSM Road Network Demo

这个目录是独立 Demo，用来验证“瓦片地图选起点和终点 -> 加载 OSM graph 并生成起点到终点的路线 -> 关闭瓦片 -> 本地 graph 自由骑行”的最小闭环。

它不接入主项目运行流程，也不修改 `route-service`、`map-controller`、`ride-engine` 等现有模块。

## 功能范围

- 规划阶段使用 OSM 瓦片地图选择一段路：第一次点击起点，第二次点击终点
- 地图上蓝色圆点表示起点，绿色圆点表示终点；浅蓝矩形表示即将加载的路网范围
- 点击“旧金山”或“宇治”只移动地图视野，不会自动设置起点
- 点击“生成路线”后，Demo 会优先复用对应地点的本地路网缓存；缓存未命中时依次尝试 4km、3km、2km 的初始区域路网。每一级都会先保证 bbox 覆盖两个选点，成功后不再自动扩至 10km
- 生成路线时会自动把起点和终点吸附到本地 graph，并沿 OSM 道路规划起点到终点的路线，不再画两点直连线
- 如果公共 Overpass endpoint 暂不可用，会回退到内置网格路网，方便继续测试转向逻辑
- 在浏览器本地把 OSM ways / nodes 建成双向 graph
- 开始模拟前路线已经吸附到本地 graph；模拟开始后只沿已生成的 graph 路线前进
- 按设定速度沿路线匀速模拟骑行
- 初始路线会从起点骑到用户选择的终点
- 初始路线走完后自动继续前进；没有输入时默认直行，有左/右/直行命令时按命令进入下一段
- 可选加载 Google Street View 原型，使用 demo-local 单 pano 控制器，跟随当前模拟位置更新
- 输出 demo route JSON

## 启动方式

建议用本地 HTTP 服务打开，避免浏览器对 `file://` 模块脚本和 CDN 资源的限制：

```bash
cd /home/liuhaowen/codes/rider-tracker
python -m http.server 8080
```

浏览器访问：

```text
http://localhost:8080/demos/osm-road-network-demo/index.html
```

## Demo 测试

这个 demo 的测试放在 demo 目录内部，不接入主项目 `npm run test`：

```bash
cd /home/liuhaowen/codes/rider-tracker
node demos/osm-road-network-demo/test.js
```

## 预加载路网缓存

为了减少街景原型测试时的变量，demo 内置了旧金山与宇治中心点附近约 10km x 10km 的 OSM 路网缓存：

```text
demos/osm-road-network-demo/fixtures/san-francisco-road-network.json
demos/osm-road-network-demo/fixtures/uji-road-network.json
```

刷新缓存：

```bash
cd /home/liuhaowen/codes/rider-tracker
node demos/osm-road-network-demo/fetch-san-francisco-road-network.js
node demos/osm-road-network-demo/fetch-uji-road-network.js
```

页面逻辑是：如果起点和终点都落在任一缓存 bbox 内，直接使用对应地点的本地缓存；否则再请求 Overpass。状态栏会显示当前使用的是“旧金山缓存路网”“宇治缓存路网”“实时 OSM 路网”还是“内置网格 fallback”。

## 外部服务

- OpenStreetMap tile：只用于起步阶段选择起点和终点
- Leaflet CDN：用于地图控件
- Overpass API：用于刷新缓存，或在页面缓存未命中时按 bbox 请求 OSM 路网数据
- Google Maps JavaScript API：仅在手动输入 API Key 并点击“加载街景”后使用，用于 Street View 原型验证

如果只验证 OSM 路网和自由骑逻辑，这个 demo 不需要 Google Maps API Key。只有街景原型需要 Key。

## 街景原型

街景部分先在 demo 内独立验证：

```text
demos/osm-road-network-demo/street-view-controller.js
```

验证目标是确认“OSM graph 当前位置 -> route/currentRecord -> Street View controller”的数据链路可行。未加载 Google API 时 route 会按平坡 fallback；加载街景后会用 demo-local elevation controller 补 `gradePercent`，街景 pitch 随坡度更新。

当前 demo-local controller 在试单个 `StreetViewPanorama` 的位置驱动方案：优先从当前 pano 的原生相邻 links 中选择与路线 heading 最接近的 pano。当前 pano 的 links 可用后，会在后台解析同一路线方向的后续 2-3 跳元数据（pano id、坐标、heading），但不会创建第二个可渲染 pano，也不会直接跳过中间 pano。下一张 pano 的坐标会投影到骑行路线，只有模拟位置追上该路线里程附近时才切换，因此 pano 间距不会放大为视觉速度；30km/h 与 29km/h 都按单跳渲染。没有可沿路线继续的街景时，保留当前 pano 和视角，等待下一次可用定位或原生 link。坐标查找仍按约 1 秒 / 18 米节流，并缓存坐标桶结果。当前 pano 与模拟路线相差过大时，controller 最多每 900ms 按 0.7 秒速度预测发起一次 GPS catch-up。Street View 加载成功即切入全屏街景，路网地图缩为右下角小窗；原生 links 和点击前往保持关闭，用户手动平移视角后会暂停自动更新 3 秒。这个实验用来验证是否能减少按坐标跳 pano 带来的黑屏和模糊。

为定位黑屏，街景原型面板会记录最近 200 条 `GPS 查找 / setPano / pano 就绪 / 超时` 事件；页面仅展示最新 12 条。点击“下载 JSON”可导出完整时间线，用于检查是查找请求慢、pano 就绪慢，还是连续切换在前一个 pano 完成前覆盖了它。首个 pano 未就绪时会保留加载提示，避免 GPS 首次查找期间显示纯黑画面。

坡度也先在 demo 内独立补全：

```text
demos/osm-road-network-demo/elevation-controller.js
```

加载 Google Maps 后可选择“请求 Google Elevation 补海拔和坡度”。该开关默认关闭；开启后初始路线会按 Google Elevation API 的 512 locations 上限批量请求海拔，后续每过一个路口生成新街区路线时，只对 route 中未命中 localStorage 缓存的新坐标增量请求。Demo 还内置日/月请求 cap，避免刷新或反复测试时误刷配额。拿到海拔后会写回 `route.points[].elevationMeters` / `gradePercent`，Street View pitch 随当前采样点坡度更新。

街景面板会显示两类信息：

- 同步 GPS：传给 demo 单 pano Street View controller 的当前位置和 heading
- 街景探测：用同一个 GPS 调 `StreetViewService.getPanorama({ radius: 50 })` 的结果

如果探测显示 `ZERO_RESULTS`，说明当前 GPS 附近 50m 内没有 Google 街景可用；如果探测显示 `OK` 但画面不变化，再优先排查 Street View controller 或容器渲染。

瓦片只用于用户正在交互查看的区域，不做批量预取或离线下载。起步路线确认后会移除瓦片图层，后续自由骑行只画本地 OSM road graph。

公共 Overpass endpoint 偶尔会限流或返回错误页。页面会先尝试旧金山缓存；缓存未命中时才请求多个 endpoint；如果全部失败，会加载一个简化网格路网作为离线回退。回退数据只用于验证 graph 转向逻辑，不代表真实 OSM 路网。

## 动态转向算法

这个 demo 不再通过远程路线 API 诱导转向，而是在本地 OSM graph 上直接做路口选择：

1. Overpass 返回 OSM `way` 和 `node`
2. Demo 过滤 `highway` 类型，拆成双向 directed edges
3. “生成路线”时把起点和终点吸附到最近道路边，第二个点击点也用于决定起步 heading
4. 初始路线用本地 graph shortest path 从起点规划到终点
5. 初始路线走完后自动接入本地 graph，并按路口决策继续自由骑行
6. 如果用户已经输入左拐 / 右拐 / 直行，立即按命令选择 outgoing edge
7. 如果没有输入，立即默认选择最接近直行的 outgoing edge
8. 每次继续后再规划到下 1 个可决策路口

## 当前限制

- 未命中缓存时，初始路网 bbox 以用户选择的起终点中点为中心，按 4km、3km、2km 依次尝试；每一级都会自动扩大到足以覆盖两个选点，并增加 0.4km 余量。后续扩网固定为 2km x 2km；预读距离会按骑行速度和最近成功请求耗时动态计算，并限制在距边界 250-500m。抵达路口时直接复用已合并的 graph，预读尚未完成时才等待剩余请求时间。真实死路不会触发扩网，扩展失败会停在当前边界。预加载 fixture 仍为 10km x 10km，用于复用缓存测试。
- 为降低 Overpass 压力，默认不加载 `service`、`footway`、`path` 等细碎道路类型。
- 初始路线使用本地 graph shortest path；初始终点之后只做局部沿路延伸和路口选择。
- 不处理 OSM 单行线、turn restriction、bike-only routing cost。
- 未加载 Google API 时路线按平坡 fallback；加载街景后会按 Google Elevation API 补海拔和坡度。
- OSM 数据中部分道路交叉可能不是共享 node，会导致 demo 识别不到路口。
- 路线 JSON 是 demo 内部结构，后续接主项目前还需要转换成 Rider Tracker 正式 route schema。

## 后续接入主项目的建议边界

Demo 跑通后，建议把能力拆成独立模块：

```text
src/adapters/maps/osm-overpass-client.js
src/domain/route/osm-road-graph.js
src/domain/route/local-road-router.js
src/app/services/dynamic-route-planner-service.js
```

主项目骑行引擎只消费稳定的 route / grade 数据，不直接依赖页面 demo 代码。
