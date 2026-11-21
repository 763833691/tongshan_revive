# 铜山古城数字孪生平台（Web 原型 v0.2）

基于 CesiumJS 的古城三维数字孪生原型：加载一份完整的 DJI Terra 倾斜摄影模型，用 CAD 导出的 25 个保护更新单元边界做**动态裁剪**，支持单元检索、分级着色、点击选取、距离/面积测量、模型透明度、视角书签与高程校准。

- 前端：Vite 7 + React 19 + TypeScript + Tailwind CSS 3.4 + **Cesium 1.147**
- 数据：EPSG:4548 倾斜摄影 OSGB → 3D Tiles（11.16 GB），单元边界 GeoJSON（WGS84）
- 底图：Esri World Imagery 卫星影像（默认，WGS84/WebMercator，无 GCJ-02 偏移）
- 坐标：模型与 CAD 已天然对齐，**不做任何配准/坐标转换开发**

---

## 1. 快速开始

```powershell
cd platform
npm install
npm run dev -- --port 5173
```

打开 `http://localhost:5173/`。

> 本机 7100 端口被 Windows 保留（`listen EACCES`），所以开发命令显式改用 5173；换机器可直接 `npm run dev`。

其他命令：

```powershell
npm run build   # tsc -b + vite build，输出 dist/
npm run lint    # ESLint（shadcn/ui 生成组件已单独放宽规则）
```

> 构建会原样复制 `public/`。若 `public/3dtiles` 在位，`dist` 会多出 **11.16 GB**；最近一次构建是先把该目录临时移出再构建的（`dist` 约 26 MB）。日常预览请用 `npm run dev`，生产环境按 §7 把瓦片独立发布。

### 数据地址覆盖

- 构建期：`$env:VITE_TILESET_PATH="/3dtiles/tongshan/tileset.json"; npm run build`
- 运行期：`http://localhost:5173/?tileset=http://server/3dtiles/tongshan/tileset.json`

---

## 2. 已实现功能

| 功能 | 说明 |
|---|---|
| 整城模型加载 | `Cesium3DTileset.fromUrl`，1 GB 主缓存 + 2 GB 溢出缓存，自动重试 |
| 25 单元面板 | 编号、面积、周长、分级、搜索、分级筛选 |
| 分单元裁剪 | `ClippingPolygonCollection({ inverse: true })`，只保留选中单元；可切「仅高亮」 |
| 点击选取单元 | 点列表或直接点模型/地面，按平面位置做点在多边形内判断 |
| 分级配色 | 一级 {14, 20}，其余按 `units.geojson` 的 `grade` 字段渲染 |
| 选中高亮 | 默认「灰度高亮」：选中单元保持彩色，其余场景加灰并保留灰色边界与填充；再次点击选中单元、按 Esc、点卡片 × 或「取消选择」均可退出 |
| 分单元裁剪 | 可选模式：只保留选中单元的模型，其余单元仍可在灰度高亮模式下查看 |
| 边界编辑 | 顶部「编辑边界」进入，提供 **拖拽 / 加点 / 删点** 三种工具和撤销；顶点按模型实际表面高度贴合，不再悬空 |
| 共享边界 | 相邻单元共用的顶点/线段会**双向同步**：拖动、插点、删点会同时改写两侧单元 |
| 新增区域 | 「+ 新增区域」后连续点击 ≥3 点，双击或右键完成；自动分配编号、名称与三级分类 |
| 编辑保存 | 「保存修改」写入本机 `localStorage`（键 `tongshan.units.v1`）；「导出 GeoJSON」下载后替换 `public/data/units.geojson` |
| 单元档案卡 | 面积、周长、中心点、外接范围、数据来源、待录字段提示 |
| 体量预览 | 单元边界挤出 26 m，用于快速判断建设强度 |
| 模型透明度 | 5%–100%，`Cesium3DTileStyle` 实时调整 |
| 高程校准 | 默认 +30 m（见 §5），滑杆 ±100 m 可复查 |
| 距离测量 | 连续取点，3D 距离，完成后标注总长 |
| 面积测量 | 连续取点，水平投影面积（m² / 公顷） |
| 视角书签 | localStorage 持久化，最多 20 条，一键回到保存视角 |
| 俯角下限 | 相机至少向下 15°（`CAMERA_MIN_PITCH_DEG`），避免贴近水平时远景影像/模型拉伸 |
| 近景底图 | 相机低于 450 m 且位于模型范围内时自动隐藏卫星球面，防止底图浮到模型上方；拉远恢复 |
| 底图切换 | **卫星影像（默认）** / 街道底图 OSM / 无底图；**不使用 GCJ-02 加密底图** |
| 海面 | 卫星影像直接铺满周边海域，并透过模型水面破洞显示真实海面 |
| 加载状态 | 瓦片调度中/排队数、模型缺失时的接入指引 |

---

## 3. 数据与关键配置

工作区根目录：`E:\BaiduSyncdisk\研究生参与项目资料\26-1120铜山古城数字平台`

| 数据 | 路径 |
|---|---|
| 倾斜摄影 OSGB | `terra_osgbs/`（metadata.xml：EPSG:4548，原点 553911.594, 2626595.549, 90.427） |
| 3D Tiles 产物 | `platform/public/3dtiles/tongshan/`（tileset.json + Data/，11.16 GB，8958 个文件） |
| 单元边界（投影） | `单元边界/units_编号_epsg4548.geojson` |
| 单元边界（WGS84） | `单元边界/units_wgs84.geojson` |
| 前端使用 | `platform/public/data/units.geojson`（25 个面，含 `unit/name/area_ha/grade`） |
| 校验图 | `_work/单元划分校验图.png` |

业务方可直接修改 `src/config.ts`：

```ts
TILESET_PATH        // 三维瓦片地址（支持 VITE_TILESET_PATH）
HOME_CENTER         // 全城视角中心 117.529519, 23.737031
HOME_HEIGHT         // 全城视角相机高度 620 m
Z_OFFSET_DEFAULT    // 模型高程偏移，实测 +30 m
CAMERA_MIN_PITCH_DEG // 相机最低俯角 -15°（限制过度侧视）
GLOBE_HIDE_BELOW_HEIGHT // 近景隐藏卫星底图的高度阈值 450 m（带回差）
DEFAULT_BASE_LAYER  // 默认卫星影像 satellite
SATELLITE_URL       // Esri World Imagery 瓦片模板（WGS84/WebMercator）
SATELLITE_MAX_LEVEL // Esri 最高 18 级，避开 19 级灰色占位瓦片
GRADE_META          // 分级名称与配色
SELECT_COLOR        // 选中态朱砂红
```

---

## 4. Cesium 1.147 适配要点（升级时注意）

| 旧写法 | 1.147 写法 |
|---|---|
| `tileLoadProgressEvent` | `tileset.loadProgress` |
| `disableCollision: true` | `enableCollision: false` |
| `ClippingPolygonCollection({ edgeWidth, edgeColor })` | 已移除边缘高亮；剪裁边界由贴地描边表达 |
| — | `ClippingPolygonCollection` 默认裁剪**内部**，只显示选中单元必须设 `inverse: true` |
| `polyline.width = 3` | `new ConstantProperty(3)`（类型收紧） |
| `erasableSyntaxOnly` | 构造函数不能用参数属性（`constructor(private x)`） |

`vite.config.ts` 中 Cesium 资源基址分环境：

- 开发：`/node_modules/cesium/Build/Cesium/`（`vite-plugin-static-copy` 的 dev 中间件在本机不可靠）
- 构建：`./cesium/`（配合 `base: './'`，可部署到任意子目录）

构建时 Cesium 静态资源必须**递归复制并剥离 4 段前缀**：

```ts
{ src: 'node_modules/cesium/Build/Cesium/**/*', dest: 'cesium', rename: { stripBase: 4 } }
```

若写成 `Build/Cesium/*`，插件只会复制 3 个 JS 文件且嵌到 `dist/cesium/node_modules/...`，开发态因走 `/node_modules` 看不出来，**生产构建会报 “The source image could not be decoded / Rendering has stopped”**。本次已修复并用 `npm run preview` 复验。

底图切换使用 `imageryLayers.removeAll(false)` 保留图层实例，避免 `removeAll()` 默认销毁图层后切回底图失败。

---

## 5. 高程校准记录（阶段一验收第 3 条）

**结论：模型抬升 +30 m。**

测定过程（2026-11-21，Cesium `scene.pickPosition` + 单元 14/20 视角）：

1. `Z_OFFSET = 0` 时，模型地表采样高度约 `-30 ~ -35 m`，屋顶约 `0 ~ -5 m`；单元色块（高度 0）位于屋顶之上，会把建筑染红。
2. 在 +30 m / +60 m / +90 m 三档对比截图中：
   - +30 m：色块回到地面，建筑不再被罩住，边界贴建筑基底；
   - +60 m：模型整体悬空，边界滑到建筑南侧；
   - +90 m：悬空更明显。
3. 故取 `Z_OFFSET_DEFAULT = 30` 写入 `src/config.ts`，平台保留滑杆供后续数据复查。

> 模型抬升只影响高度，不改变平面位置；平面套合无需配准。

### 卫星影像与海域叠加

- 默认底图为 **Esri World Imagery 卫星影像**（`server.arcgisonline.com/.../World_Imagery`），WebMercator/WGS84，**没有 GCJ-02 偏移**，海岸线与模型套合良好。
- 状态栏已加入 `影像 © Esri, Maxar, Earthstar Geographics` 署名。
- **灰块问题已定位并修复**：Esri 在部分海域的 19 级瓦片返回灰色 “Map data not yet available” 占位图，低角度旋转/放大时会出现一块灰色平面。平台将 `SATELLITE_MAX_LEVEL` 限制为 **18 级**，Cesium 改用 18 级瓦片放大显示，灰块消失；代价是该区域卫星影像略糊，但模型本身清晰度不受影响。若需要更高清底图，应接入项目自有正射影像或天地图 key。
- 周边海域由卫星影像直接铺满；模型自身的水面破洞会透出下面的真实海面，颜色自然衔接，因此**没有再加一块蓝色海面平面**——那样会把岸上陆地也染蓝。
- 若后续要求“统一纯色海面/填平水面破洞”，建议在阶段三用 CesiumLab/GISBox 场景编辑补水面，或单独做一个只覆盖海湾的 mask 多边形。
- 底图可随时切换「卫星影像 / 街道底图 / 无底图」，图层实例保留，不会重复建缓存。
- 商用请遵守 Esri 授权；也可换天地图影像（需申请 key）或项目自有无人机正射影像，接入方式与卫星层相同。

---

## 6. 验收记录（2026-11-21）

使用 Chrome 157 headless（SwiftShader）实测，`platform` 开发服务 + 本地 11.16 GB 瓦片：

- [x] **模型与单元边界套合无平面偏移**：单元 14/20 边界与建筑基底吻合；单元 14 的 594 m 周长、1.42 公顷与 CAD 一致。
- [x] **逐单元裁剪正常**：选中后 `clippingPolygons.length = 1`、`enabled = true`、`inverse = true`；切「仅高亮」后模型完整显示；再切回裁剪恢复。
- [x] **高程偏移已测定**：+30 m，测定过程见 §5。
- [x] 浏览器 console 无异常、无 404（已补 favicon）；瓦片请求正常，无失败请求。
- [x] **25 个单元逐一切换**：脚本依次点击 01–25，全部满足 `selected = 单元号`、`clippingPolygons.length = 1`、`enabled = true`、`inverse = true`；「回到全城」后 `selected = null`、裁剪关闭。
- [x] 点击模型可选中单元（实测依次选中 04、05、24 号）；再次点击、Esc、卡片 ×、顶部「取消选择」均可退出；灰度高亮模式保留其他单元的灰色边界与填充。
- [x] 距离测量（101.1 m 样例）、面积测量、透明度、视角书签保存/恢复均正常。
- [x] **卫星影像已接入**：默认加载 Esri 影像（实测 80 个瓦片请求、无失败），海岸线与模型套合；卫星影像 / 街道 / 无底图来回切换正常。
- [x] **低角度灰块修复**：对比 z16–z19 瓦片，确认 z19 返回灰色占位图；限制 `maximumLevel: 18` 后，同机位低角度旋转测试灰块消失，无 404、无 console 异常。
- [x] **生产构建可运行**：`npm run build` + `npm run preview` 加载 `?tileset=` 远程瓦片，模型/界面正常，console 零异常；Cesium 静态资源 345 个文件完整。

> headless 环境无法代表真实 GPU 帧率。**交付前必须在目标机器上实测近景 ≥30 FPS**（11.16 GB 原始纹理是主要瓶颈，见 §8）。

---

## 7. 生产部署（Nginx）

### 7.1 体积与服务器要求

| 内容 | 大小 | 是否必须部署 |
|---|---|---|
| `dist/`（前端） | **26.4 MB / 350 个文件** | 是 |
| `public/3dtiles/tongshan/` | **11.16 GB / 8958 个文件** | 是 |
| `node_modules/` | 约 350 MB | 否（仅构建机需要） |
| 源码 `src/` | 约 0.2 MB | 否（服务器只放 dist） |

服务器只做静态文件分发，最低建议：**2 vCPU / 2 GB 内存 / 20 GB 可用磁盘**；网络建议千兆内网，公网至少 20 Mbps。首次打开不会一次下载 11 GB，只按视锥和清晰度拉取可见瓦片，但走近城区仍可能瞬间拉取数百 MB。

### 7.2 构建与目录

当前 `dist/` 已按外链瓦片方式构建（瓦片地址为 `/3dtiles/tongshan/tileset.json`）：

```powershell
cd platform
$env:VITE_TILESET_PATH="/3dtiles/tongshan/tileset.json"
# 若 public/3dtiles 还在，先临时移出，避免复制 11 GB 进 dist
npm run build
```

服务器目录：

```
/srv/tongshan/
  dist/                 # 前端产物（含 cesium/、data/）
  3dtiles/tongshan/     # 11.16 GB 瓦片，独立存放，前端发版不影响模型
```

从 Windows 拷贝到服务器（示例，按实际共享路径修改）：

```powershell
robocopy .\platform\dist \\server\share\tongshan\dist /MIR /R:2 /W:2
robocopy .\platform\public\3dtiles \\server\share\tongshan\3dtiles /MIR /R:2 /W:2
```

如果服务器就是本机，直接把 `dist` 和 `public\3dtiles` 放到对应目录即可。

### 7.3 Nginx

模板见 [`deploy/nginx.conf.example`](deploy/nginx.conf.example)，要点：

- `try_files ... /index.html` 支持前端路由；
- `/3dtiles/` 用独立 `root` 指向瓦片目录，并加 CORS（同源部署时可去掉）；
- `tileset.json` 开 gzip（b3dm 本身已压缩，不必再 gzip）；
- 静态资源长缓存；`Content-Type` 增加 `b3dm`。

局域网用户访问 `http://服务器IP/` 即可。当前**没有登录鉴权**，内网可用；如需限制，给 Nginx 加 `allow/deny` 或 `auth_basic`。

交付前在真实浏览器逐一点击 25 个单元，确认裁剪切换、console 零报错、近景 ≥30 FPS。

> **公网部署注意**：11.16 GB 未压缩模型不建议直接公网开放，先做 Draco/KTX2/网格压缩（通常可降到约 1/7），并确认 Esri 影像/天地图的使用授权。

---

## 8. 已知限制与下一步

**限制**

- 3D Tiles 11.16 GB，纹理未压缩；内网可接受，公网必须先做 Draco/KTX2/网格压缩（阶段三）。
- 默认 Esri 卫星影像免 key，国内一般可访问，但正式商用需遵守 Esri 授权；也可换天地图影像（需 key）或项目自有正射影像。**禁用高德/腾讯/谷歌等 GCJ-02 底图**。
- 单元编号按面积+方位从规划图推定，08/11 号仅靠面积区分，**必须与规划方核对**。
- 分级目前 14/20 为一级，其余为二/三级推定，待业务方确认。
- 单元档案（四至描述、责任主体、照片、修缮记录）尚未录入，界面已预留。
- 面积测量为水平投影面积，跨立面取点会偏小；坡度大的区域需业务确认口径。
- 城墙等 CAD 图层尚未叠加（DWG 需先转 GeoJSON）。
- 当前为单机静态数据，无后端与权限（阶段二 PostGIS + FastAPI/Express）。
- 模型水面有破洞，目前靠卫星海面透出兜底；要统一水面需阶段三场景修补。
- 共享边界按坐标容差（约 0.2 m）匹配；若相邻面顶点原本不重合或经过外部软件大幅改形，可能无法自动同步，需要先对齐再编辑。
- 边界编辑结果保存在**本机浏览器**（localStorage），不跨设备、无权限控制与多人协作；正式使用需接后端（阶段二）并把「导出 GeoJSON」结果替换数据文件。
- 新增区域目前自动命名为「NN单元」、默认三级，编号/名称/等级/档案的表单编辑尚未实现。
- 模型地表局部低于 WGS84 椭球面，拉近后卫星球面会浮在模型上方，因此近距离会自动隐藏底图；该现象需在阶段三用实测地形/正射影像彻底校正。
- 低角度侧视的横向条纹/黑色碎片**仅在软件 WebGL（SwiftShader，如无 GPU 的 headless 截图）下出现**；同一机位用真实显卡（实测 RTX 2080 Ti / ANGLE D3D11）渲染画面正常，故不作为平台缺陷处理。已额外加 -15° 俯角下限兜底；若现场终端仍复现，请记录显卡型号与浏览器 GPU 状态。

**下一步优先级**

1. 目标机器实测帧率；必要时把 `TILESET_MAX_SSE` 调到 20–24 或先做压缩。
2. 与规划方核对 25 个单元编号与管控分级，改 `units.geojson` 一处即可生效。
3. 录入单元档案静态 JSON（`public/data/unit-records.json`），再迁 PostGIS。
4. CAD 城墙图层转 GeoJSON 叠加。
5. 接入自有正射影像或天地图影像底图。

---

## 9. 目录

```
platform/
  public/
    3dtiles/tongshan/       # 11.16 GB 3D Tiles（.gitignore）
    data/units.geojson      # 25 单元边界（WGS84）
  src/
    cesium/PlatformController.ts  # 场景、瓦片、裁剪、拾取、测量、书签
    components/
      TopBar.tsx            # 模式/底图/体量/回城
      UnitPanel.tsx         # 单元列表 + 档案卡
      Overlays.tsx          # 状态栏/图例/显示设置/测量条/缺失指引
      Bookmarks.tsx         # 视角书签
    lib/units.ts            # GeoJSON 加载、周长、点在多边形内
    config.ts               # 业务常量
  deploy/nginx.conf.example
  vite.config.ts
```

## 10. 实施纪律（沿用交接方案）

1. 不做坐标配准/转换开发——平面零偏差已验证；
2. 不物理切割模型文件；
3. 转换产物不进代码仓库；
4. 改动单元边界只改 `public/data/units.geojson`（动态裁剪的优势）；
5. 交付前在真实浏览器逐一点击 25 个单元验证。
