// 平台全局配置 —— 业务方可直接改这里的常量
export const APP_TITLE = "铜山古城数字孪生平台"
export const APP_VERSION = "原型 v0.2"

// 三维瓦片服务地址：默认读平台 public 目录。
// 生产部署可设置 VITE_TILESET_PATH=/3dtiles/tongshan/tileset.json 指向 Nginx 独立目录；
// 运行时也可用 ?tileset=http://... 临时覆盖。
export const TILESET_PATH =
  (import.meta.env.VITE_TILESET_PATH as string | undefined) ?? "./3dtiles/tongshan/tileset.json"

// 单元边界数据
export const UNITS_URL = "./data/units.geojson"

// 模型覆盖城镇中心（EPSG:4548 -> WGS84），用于初始相机与垂直偏移计算
export const HOME_CENTER = { lon: 117.529519, lat: 23.737031 }

// 初始相机高度（米）
export const HOME_HEIGHT = 620

// 模型整体高程偏移（米）：实测模型地表位于椭球面以下约 30 m，
// 抬升 +30 m 后建筑坐落于 OSM 底图平面，单元色块回到地面（不再罩住屋顶）。
export const Z_OFFSET_DEFAULT = 30

// 相机最低俯角（度）：侧视过平时，倾斜摄影模型在掠射角下会把远处纹理拉成横向条纹。
// 限制 pitch 不高于 -15°（至少向下看 15°），可避免对岸出现拉伸条带。
export const CAMERA_MIN_PITCH_DEG = -15

// 近距离自动隐藏卫星底图的高度阈值（米）：
// 模型地表局部低于椭球面，拉近后卫星球面会浮到模型上方；低于该高度只显示模型，
// 远景仍保留卫星影像。恢复显示带回差，避免阈值附近闪烁。
export const GLOBE_HIDE_BELOW_HEIGHT = 450

// 瓦片调度参数：12GB 倾斜模型需要更大的缓存，否则 Cesium 会频繁降级清晰度
export const TILESET_MAX_SSE = 16
export const TILESET_CACHE_BYTES = 1024 * 1024 * 1024
export const TILESET_MAX_CACHE_OVERFLOW_BYTES = 2 * 1024 * 1024 * 1024

// 底图：satellite（Esri 卫星影像，WGS84/WebMercator，无 GCJ-02 偏移）；
// osm（街道底图）；none（无底图，仅看模型）
export type BaseLayerKind = "satellite" | "osm" | "none"

export const DEFAULT_BASE_LAYER: BaseLayerKind = "satellite"

// Esri World Imagery：免 key，国内一般可访问；正式商用请按 Esri 条款申请授权
export const SATELLITE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
// Esri 在部分海域的 19 级瓦片返回灰色 "Map data not yet available" 占位图，
// 限制到 18 级后 Cesium 会用 18 级瓦片放大，灰色块消失。
export const SATELLITE_MAX_LEVEL = 18
export const SATELLITE_CREDIT = "影像 © Esri, Maxar, Earthstar Geographics"
export const OSM_CREDIT = "地图 © OpenStreetMap contributors"

// 管控分级配色（与规划图对应；分级归属待业务方最终确认，在 units.geojson 的 grade 字段）
export const GRADE_META: Record<number, { label: string; color: string }> = {
  1: { label: "一级 · 重点保护", color: "#d4452c" },
  2: { label: "二级 · 保护协调", color: "#c8913f" },
  3: { label: "三级 · 一般协调", color: "#7ba05b" },
}

export const GRADE_COLOR: Record<number, string> = {
  1: GRADE_META[1].color,
  2: GRADE_META[2].color,
  3: GRADE_META[3].color,
}

// 选中态 / 测量工具配色
export const SELECT_COLOR = "#ff5a3c"
export const MEASURE_DISTANCE_COLOR = "#ffb04a"
export const MEASURE_AREA_COLOR = "#63c5da"
