import * as Cesium from "cesium"
import "cesium/Build/Cesium/Widgets/widgets.css"
import {
  BUILDING_CLIP_DEFAULT,
  BUILDING_STATUS_META,
  BUILDINGS_URL,
  CAMERA_MIN_PITCH_DEG,
  GLOBE_HIDE_BELOW_HEIGHT,
  GRADE_COLOR,
  HOME_CENTER,
  HOME_HEIGHT,
  MEASURE_AREA_COLOR,
  MEASURE_DISTANCE_COLOR,
  SATELLITE_CREDIT,
  SATELLITE_MAX_LEVEL,
  SATELLITE_URL,
  SELECT_COLOR,
  SELECT_OUTLINE_COLOR,
  SELECT_OUTLINE_WIDTH_DEFAULT,
  SELECT_OUTLINE_WIDTH_MAX,
  SELECT_OUTLINE_WIDTH_MIN,
  TILESET_CACHE_BYTES,
  TILESET_MAX_CACHE_OVERFLOW_BYTES,
  TILESET_MAX_SSE,
  TILESET_PATH,
  TILESET_SKIP_LOD,
  UNITS_URL,
  Z_OFFSET_DEFAULT,
  type BaseLayerKind,
  type BuildingStatus,
} from "@/config"
import { loadBuildings, type BuildingFeature } from "@/lib/buildings"
import {
  clearStoredUnits,
  computeUnitMetrics,
  loadStoredUnits,
  loadUnits,
  normalizeRing,
  pointInRing,
  storeUnits,
  unitsToGeoJson,
  type UnitFeature,
} from "@/lib/units"

export type TilesetStatus = "loading" | "ready" | "missing" | "error"
export type MeasureMode = "none" | "distance" | "area"

export type TilesetLoadPhase = "connecting" | "loading" | "done" | "error"

/** 模型加载进度：connecting 阶段（等待 tileset.json）没有百分比，由前端显示为不确定进度 */
export interface TilesetLoadProgress {
  phase: TilesetLoadPhase
  percent: number
  loaded: number
  pending: number
  processing: number
  elapsedMs: number
}

export interface MeasureState {
  mode: MeasureMode
  points: number
  finished: boolean
  distanceM: number
  areaM2: number
}

export interface CameraView {
  lon: number
  lat: number
  height: number
  heading: number
  pitch: number
  roll: number
}

export interface EditState {
  editMode: boolean
  drawing: boolean
  selected: number | null
}

export interface ControllerCallbacks {
  onUnitsLoaded: (units: UnitFeature[]) => void
  onTilesetStatus: (status: TilesetStatus) => void
  onTileProgress: (pending: number, processing: number) => void
  onTilesetProgress: (progress: TilesetLoadProgress) => void
  onSelectChange: (unit: number | null) => void
  onMeasureChange: (state: MeasureState) => void
  onUnitsChanged: (units: UnitFeature[]) => void
  onEditState: (state: EditState) => void
  onBuildingsLoaded: (buildings: BuildingFeature[]) => void
  onBuildingsError: (message: string) => void
  onBuildingSelect: (id: string | null) => void
}

const EARTH_RADIUS = 6371008.8

const STATUS_COLORS: Record<BuildingStatus, Cesium.Color> = {
  pending: Cesium.Color.fromCssColorString(BUILDING_STATUS_META.pending.color),
  confirmed: Cesium.Color.fromCssColorString(BUILDING_STATUS_META.confirmed.color),
  rejected: Cesium.Color.fromCssColorString(BUILDING_STATUS_META.rejected.color),
}
const GOLD = Cesium.Color.fromCssColorString(SELECT_OUTLINE_COLOR)
/** 选中高亮时，未选中分界线用浅色，压暗后仍能从模型上分开 */
const DIM_OUTLINE_COLOR = "#f4f1e8"
const DIM_OUTLINE_WIDTH = 1.6
const DIM_LABEL_FILL = "#fffaf2"
const DIM_LABEL_INK = "#101418"
/** 只略压暗，选中范围在 updateWash 里挖空，贴图亮度不变 */
const WASH_COLOR = "#1a2228"
const WASH_ALPHA = 0.34
const OUTLINE_FRAME_BUDGET_MS = 4
const MOVING_TILESET_SSE = 24

type OutlineSamples = Generator<void, Cesium.Cartesian3[] | null>

export class PlatformController {
  private viewer: Cesium.Viewer
  private tileset: Cesium.Cesium3DTileset | null = null
  private units: UnitFeature[] = []
  private fills = new Map<number, Cesium.Entity>()
  private outlines = new Map<number, Cesium.Entity>()
  private labels = new Map<number, Cesium.Entity>()
  private clipColl: Cesium.ClippingPolygonCollection | null = null
  private selected: number | null = null
  private clipEnabled = false
  private extruded = false
  private wash: Cesium.Entity | null = null
  private editMode = false
  private drawing = false
  private drawPoints: [number, number][] = []
  private vertexEntities: Cesium.Entity[] = []
  private dragIndex: number | null = null
  private dragGroup: { unit: number; index: number }[] = []
  private suppressClickUntil = 0
  private editTool: "drag" | "add" | "delete" = "drag"
  private undoStack: { unit: number; ring: [number, number][] }[][] = []
  private drawPolyline: Cesium.Entity | null = null
  private drawPolygon: Cesium.Entity | null = null
  private drawPointEntities: Cesium.Entity[] = []
  private zOffset = Z_OFFSET_DEFAULT
  private opacity = 1
  private baseKind: BaseLayerKind = "satellite"
  private buildings: BuildingFeature[] = []
  private buildingPoints: Cesium.PointPrimitiveCollection | null = null
  private buildingPointById = new Map<string, Cesium.PointPrimitive>()
  private buildingMode = false
  private buildingClip = BUILDING_CLIP_DEFAULT
  private selectedBuilding: string | null = null
  private buildingStatuses = new Map<string, BuildingStatus>()
  private buildingOutline: Cesium.Entity | null = null
  private buildingLabel: Cesium.Entity | null = null
  private buildingHeights = new Map<string, number>()
  private heightSyncTimer = 0
  private viewRefineTimer = 0
  private viewRefineAttempts = 0
  private selectedViewHeight = 0
  private outlineWidth = SELECT_OUTLINE_WIDTH_DEFAULT
  private selectedUnitOutline: Cesium.Entity | null = null
  private selectedOutlineFrame = 0
  private selectedOutlineUnit: number | null = null
  private cameraMoving = false
  private osmLayer: Cesium.ImageryLayer | null = null
  private satelliteLayer: Cesium.ImageryLayer | null = null
  private destroyed = false
  private cb: ControllerCallbacks
  private handler: Cesium.ScreenSpaceEventHandler

  private measureMode: MeasureMode = "none"
  private measurePoints: Cesium.Cartesian3[] = []
  private measureFinished = false
  private measureEntities: Cesium.Entity[] = []
  private lastProgressEmit = 0
  private loadStartAt = 0
  private tilesLoaded = 0
  private lastPending = 0
  private lastProcessing = 0
  private loadPhase: TilesetLoadPhase = "connecting"
  private loadProgressEmit = 0
  private outlineRefreshTimer = 0
  private dimOutlineCache = new Map<number, Cesium.Cartesian3[]>()
  private dimOutlineRetry = new Map<number, number>()
  private dimPump = 0
  private flightEndsAt = 0
  private clamping = false
  private nearGlobeHidden = false

  constructor(container: HTMLElement, cb: ControllerCallbacks) {
    this.cb = cb
    Cesium.Ion.defaultAccessToken = ""
    this.viewer = new Cesium.Viewer(container, {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      contextOptions: { webgl: { stencil: true } },
    })
    this.viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#0e2a30")
    // 固定为当地时间正午，避免按当前时间把天空/受光材质渲染成夜景
    this.viewer.clock.currentTime = Cesium.JulianDate.fromIso8601("2026-11-21T04:00:00Z")
    this.viewer.clock.shouldAnimate = false
    this.viewer.scene.globe.enableLighting = false
    this.viewer.scene.screenSpaceCameraController.enableCollisionDetection = false
    // 卫星底图贴在椭球面上，必须让球面不参与深度遮挡，
    // 否则模型地表略低于椭球面时会被底图盖住（看起来像“卫星图在模型上面”）。
    this.viewer.scene.globe.depthTestAgainstTerrain = false
    this.setBaseLayer("satellite")

    if (import.meta.env.DEV) {
      const w = window as unknown as { __tsController: PlatformController; Cesium: typeof Cesium }
      w.__tsController = this
      w.Cesium = Cesium
    }

    this.handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas)
    this.handler.setInputAction(
      (e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => this.onLeftClick(e.position),
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    )
    this.handler.setInputAction(
      (e: Cesium.ScreenSpaceEventHandler.MotionEvent) => this.onMouseMove(e.endPosition),
      Cesium.ScreenSpaceEventType.MOUSE_MOVE,
    )
    this.handler.setInputAction(
      (e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => this.onLeftDown(e.position),
      Cesium.ScreenSpaceEventType.LEFT_DOWN,
    )
    this.handler.setInputAction(() => this.onLeftUp(), Cesium.ScreenSpaceEventType.LEFT_UP)
    this.handler.setInputAction(
      (e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => this.onRightClick(e.position),
      Cesium.ScreenSpaceEventType.RIGHT_CLICK,
    )
    this.handler.setInputAction(() => {
      if (this.drawing) this.finishDrawing()
    }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
    this.viewer.scene.preRender.addEventListener(this.clampCameraPitch)
    this.viewer.scene.preRender.addEventListener(this.updateGlobeVisibility)
    this.viewer.camera.moveStart.addEventListener(this.onCameraMoveStart)
    this.viewer.camera.moveEnd.addEventListener(this.onCameraMoveEnd)
    window.addEventListener("keydown", this.onKeyDown)
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return
    if (this.drawing) {
      this.cancelDrawing()
      return
    }
    if (this.buildingMode) {
      if (this.selectedBuilding) this.selectBuilding(null)
      return
    }
    if (this.editMode) {
      this.setEditMode(false)
      return
    }
    if (this.selected !== null) this.selectUnit(null)
  }

  private onLeftClick(screen: Cesium.Cartesian2) {
    if (performance.now() < this.suppressClickUntil) return
    if (this.buildingMode) {
      const pickedId = this.viewer.scene.pick(screen)?.id
      if (typeof pickedId === "string" && this.buildingPointById.has(pickedId)) {
        this.toggleBuilding(pickedId)
        return
      }
      const hit = this.pickBuildingAt(screen)
      this.selectBuilding(hit ? hit.id : null)
      return
    }
    if (this.drawing) {
      this.addDrawPoint(screen)
      return
    }
    if (this.editMode && this.editTool === "add") {
      this.addVertexAtPoint(screen)
      return
    }
    if (this.editMode && this.editTool === "delete") {
      this.deleteVertexAt(screen)
      return
    }
    if (this.measureMode !== "none" && !this.measureFinished) {
      this.addMeasurePoint(screen)
      return
    }
    this.selectUnit(this.pickUnitAt(screen))
  }

  private onMouseMove(screen: Cesium.Cartesian2) {
    const canvas = this.viewer.scene.canvas
    if (this.dragIndex !== null) {
      this.updateDrag(screen)
      canvas.style.cursor = "grabbing"
      return
    }
    if (this.drawing) {
      this.updateDrawPreview(screen)
      canvas.style.cursor = "crosshair"
      return
    }
    if (this.measureMode !== "none" && !this.measureFinished) {
      canvas.style.cursor = "crosshair"
      return
    }
    if (this.buildingMode) {
      const picked = this.viewer.scene.pick(screen)
      canvas.style.cursor = typeof picked?.id === "string" ? "pointer" : "crosshair"
      return
    }
    const picked = this.viewer.scene.pick(screen)
    canvas.style.cursor = picked?.id instanceof Cesium.Entity ? "pointer" : "default"
  }

  private onLeftDown(screen: Cesium.Cartesian2) {
    if (!this.editMode || this.drawing || this.editTool !== "drag") return
    const vertex = this.nearestVertex(screen)
    if (vertex === null) return
    this.dragIndex = vertex
    this.suppressClickUntil = performance.now() + 400
    this.beginDragGroup(vertex)
    this.viewer.scene.screenSpaceCameraController.enableRotate = false
  }

  private onLeftUp() {
    if (this.dragIndex === null) return
    this.dragIndex = null
    this.viewer.scene.screenSpaceCameraController.enableRotate = true
    this.commitDragGroup()
  }

  private onRightClick(screen: Cesium.Cartesian2) {
    if (this.drawing) {
      this.finishDrawing()
      return
    }
    void screen
  }

  async init() {
    this.flyCity(0)
    try {
      this.units = loadStoredUnits() ?? (await loadUnits(UNITS_URL))
    } catch (err) {
      console.error("单元数据加载失败", err)
      this.cb.onTilesetStatus("error")
      return
    }
    if (this.destroyed) return
    this.cb.onUnitsLoaded(this.snapshotUnits())
    this.addUnitEntities()
    void this.loadBuildingData()
    await this.tryLoadTileset()
  }

  private async loadBuildingData() {
    try {
      const buildings = await loadBuildings(BUILDINGS_URL)
      if (this.destroyed) return
      this.buildings = buildings
      this.createBuildingPoints()
      if (this.tileset) this.scheduleHeightSync(300)
      this.cb.onBuildingsLoaded(buildings)
    } catch (err) {
      console.error("建筑基底数据加载失败", err)
      if (!this.destroyed) this.cb.onBuildingsError(err instanceof Error ? err.message : "建筑基底数据加载失败")
    }
  }

  private addUnitEntities() {
    for (const u of this.units) this.createUnitEntities(u)
  }

  private createUnitEntities(u: UnitFeature) {
    const color = Cesium.Color.fromCssColorString(GRADE_COLOR[u.grade])
    const positions = u.ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat))
    const fill = this.viewer.entities.add({
      id: `unit-fill-${u.unit}`,
      properties: { unit: u.unit },
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(positions),
        material: color.withAlpha(0.26),
        outline: false,
      },
    })
    const outline = this.viewer.entities.add({
      id: `unit-outline-${u.unit}`,
      properties: { unit: u.unit },
      polyline: {
        positions,
        width: new Cesium.ConstantProperty(1.6),
        material: color.withAlpha(0.95),
        clampToGround: true,
      },
    })
    const label = this.viewer.entities.add({
      id: `unit-label-${u.unit}`,
      properties: { unit: u.unit },
      position: Cesium.Cartesian3.fromDegrees(u.centroid[0], u.centroid[1]),
      label: {
        text: String(u.unit).padStart(2, "0"),
        font: "700 13px 'Microsoft YaHei', sans-serif",
        fillColor: Cesium.Color.fromCssColorString("#f0ead8"),
        style: Cesium.LabelStyle.FILL,
        pixelOffset: new Cesium.Cartesian2(0, -2),
        scaleByDistance: new Cesium.NearFarScalar(200, 1.15, 8000, 0.85),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
    this.fills.set(u.unit, fill)
    this.outlines.set(u.unit, outline)
    this.labels.set(u.unit, label)
  }

  /* ---------------- 建筑分割审核 ---------------- */

  private createBuildingPoints() {
    if (this.buildingPoints) {
      this.viewer.scene.primitives.remove(this.buildingPoints)
      this.buildingPoints = null
    }
    this.buildingPointById.clear()
    if (!this.buildings.length) return
    const collection = new Cesium.PointPrimitiveCollection()
    for (const b of this.buildings) {
      const status = this.buildingStatuses.get(b.id) ?? "pending"
      const point = collection.add({
        id: b.id,
        position: Cesium.Cartesian3.fromDegrees(b.centroid[0], b.centroid[1], (this.buildingHeights.get(b.id) ?? 0) + 2),
        color: STATUS_COLORS[status],
        pixelSize: 8,
        outlineColor: Cesium.Color.fromCssColorString("#0c1411").withAlpha(0.7),
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(80, 1.25, 9000, 0.55),
      })
      this.buildingPointById.set(b.id, point)
    }
    collection.show = this.buildingMode
    this.buildingPoints = this.viewer.scene.primitives.add(collection)
    this.applyBuildingPointStyles()
  }

  /** 取建筑处的模型表面高度。tileset.getHeight 为毫秒级；未加载处返回 null 待重试 */
  private sampleBuildingHeight(b: BuildingFeature): number | null {
    return this.modelHeightAt(b.centroid[0], b.centroid[1])
  }

  private buildingHeight(b: BuildingFeature): number {
    const cached = this.buildingHeights.get(b.id)
    if (cached !== undefined) return cached
    const h = this.sampleBuildingHeight(b)
    if (h !== null) {
      this.buildingHeights.set(b.id, h)
      return h
    }
    return 0
  }

  private scheduleHeightSync(delay = 900) {
    window.clearTimeout(this.heightSyncTimer)
    if (this.buildingMode) this.heightSyncTimer = window.setTimeout(() => this.syncHeightBatch(), delay)
  }

  /** 分批把候选点贴到模型表面，避免一次性阻塞渲染 */
  private syncHeightBatch() {
    if (this.destroyed || !this.buildings.length) return
    let i = 0
    const step = () => {
      if (this.destroyed || !this.buildingMode) return
      if (!this.cameraMoving) {
        const deadline = performance.now() + OUTLINE_FRAME_BUDGET_MS
        for (; i < this.buildings.length && performance.now() < deadline; i++) {
          const b = this.buildings[i]
          const point = this.buildingPointById.get(b.id)
          if (!point) continue
          const h = this.buildingHeight(b)
          point.position = Cesium.Cartesian3.fromDegrees(b.centroid[0], b.centroid[1], h + 2)
        }
      }
      if (i < this.buildings.length) this.heightSyncTimer = window.setTimeout(step, 16)
    }
    step()
  }

  private applyBuildingPointStyles() {
    for (const b of this.buildings) {
      const point = this.buildingPointById.get(b.id)
      if (!point) continue
      const status = this.buildingStatuses.get(b.id) ?? "pending"
      const isSelected = b.id === this.selectedBuilding
      const dimmed = this.selectedBuilding !== null && !isSelected
      point.color = isSelected ? GOLD : dimmed ? STATUS_COLORS[status].withAlpha(0.4) : STATUS_COLORS[status]
      point.pixelSize = isSelected ? 13 : dimmed ? 5 : status === "rejected" ? 6 : 8
      point.outlineColor = isSelected
        ? Cesium.Color.WHITE
        : Cesium.Color.fromCssColorString("#0c1411").withAlpha(0.7)
      point.outlineWidth = isSelected ? 3 : 1.5
    }
  }

  /** 建筑审核模式：显示候选中点点位并接管点击拾取 */
  setBuildingMode(on: boolean) {
    if (this.buildingMode === on) return
    this.buildingMode = on
    if (!on) {
      window.clearTimeout(this.heightSyncTimer)
      this.selectedBuilding = null
      window.clearTimeout(this.viewRefineTimer)
      this.removeBuildingHighlight()
      this.cb.onBuildingSelect(null)
    }
    if (this.buildingPoints) this.buildingPoints.show = on
    if (on && this.tileset) this.scheduleHeightSync(200)
    this.applyClip()
    this.applyUnitStyles()
    this.updateWash()
  }

  setBuildingStatuses(statuses: Record<string, BuildingStatus>) {
    this.buildingStatuses = new Map(Object.entries(statuses))
    this.applyBuildingPointStyles()
  }

  setBuildingClip(on: boolean) {
    this.buildingClip = on
    this.applyClip()
  }

  getSelectedBuilding(): string | null {
    return this.selectedBuilding
  }

  getBuildings(): BuildingFeature[] {
    return this.buildings
  }

  toggleBuilding(id: string) {
    this.selectBuilding(this.selectedBuilding === id ? null : id)
  }

  selectBuilding(id: string | null) {
    const next = id !== null ? this.buildings.find((b) => b.id === id) : null
    const normalized = next ? next.id : null
    if (this.selectedBuilding === normalized) return
    this.selectedBuilding = normalized
    window.clearTimeout(this.viewRefineTimer)
    this.removeBuildingHighlight()
    if (next) {
      const height = this.buildingHeight(next)
      this.selectedViewHeight = height
      const point = this.buildingPointById.get(next.id)
      if (point) point.position = Cesium.Cartesian3.fromDegrees(next.centroid[0], next.centroid[1], height + 2)
      this.flyToBuilding(next, height)
      this.renderBuildingHighlight(next, height)
      this.scheduleViewRefine(next)
    }
    this.applyBuildingPointStyles()
    this.applyClip()
    this.cb.onBuildingSelect(normalized)
  }

  private pickBuildingAt(screen: Cesium.Cartesian2): BuildingFeature | null {
    const scene = this.viewer.scene
    let cartesian: Cesium.Cartesian3 | undefined
    try {
      cartesian = scene.pickPosition(screen)
    } catch {
      cartesian = undefined
    }
    if (!Cesium.defined(cartesian)) {
      cartesian = this.viewer.camera.pickEllipsoid(screen, Cesium.Ellipsoid.WGS84)
    }
    if (!Cesium.defined(cartesian)) return null
    const carto = Cesium.Cartographic.fromCartesian(cartesian)
    const lon = Cesium.Math.toDegrees(carto.longitude)
    const lat = Cesium.Math.toDegrees(carto.latitude)
    for (const b of this.buildings) {
      const { bbox } = b
      if (lon < bbox.west || lon > bbox.east || lat < bbox.south || lat > bbox.north) continue
      if (pointInRing(lon, lat, b.ring)) return b
    }
    return null
  }

  private flyToBuilding(b: BuildingFeature, height: number, duration = 1.3) {
    // 以模型实际表面高度取景，避免相机目标悬空导致建筑贴到画面边缘
    const positions = b.ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, height + 0.5))
    const sphere = Cesium.BoundingSphere.fromPoints(positions)
    const range = Math.max(48, Math.min(240, sphere.radius * 3.4))
    this.beginFlight(duration)
    this.viewer.camera.flyToBoundingSphere(sphere, {
      duration,
      offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-52), range),
    })
  }

  /** 首帧可能因瓦片未就绪取不到真实高度：相机到位后重采样并微调取景 */
  private scheduleViewRefine(b: BuildingFeature) {
    this.viewRefineAttempts = 0
    const tryRefine = () => {
      if (this.destroyed || this.selectedBuilding !== b.id) return
      this.viewRefineAttempts++
      const h = this.sampleBuildingHeight(b)
      if (h !== null) {
        this.buildingHeights.set(b.id, h)
        const point = this.buildingPointById.get(b.id)
        if (point) point.position = Cesium.Cartesian3.fromDegrees(b.centroid[0], b.centroid[1], h + 2)
        this.renderBuildingHighlight(b, h)
        if (Math.abs(h - this.selectedViewHeight) > 1.2) {
          this.selectedViewHeight = h
          this.flyToBuilding(b, h, 0.9)
        }
        return
      }
      if (this.viewRefineAttempts < 5) this.viewRefineTimer = window.setTimeout(tryRefine, 1200)
    }
    this.viewRefineTimer = window.setTimeout(tryRefine, 1500)
  }

  private removeBuildingHighlight() {
    for (const e of [this.buildingOutline, this.buildingLabel]) {
      if (e) this.viewer.entities.remove(e)
    }
    this.buildingOutline = null
    this.buildingLabel = null
  }

  /** 取模型表面的实际高度；瓦片尚未加载到该处时返回 null */
  private modelHeightAt(lon: number, lat: number): number | null {
    if (!this.tileset) return null
    try {
      const h = this.tileset.getHeight(Cesium.Cartographic.fromDegrees(lon, lat), this.viewer.scene)
      return h !== undefined && Number.isFinite(h) ? h : null
    } catch {
      return null
    }
  }

  /** 按米级间距把边界折线加密，避免长直线段从一个点的高度“飞”过屋顶 */
  private densifyRing(ring: [number, number][], spacingM: number, maxSamples: number): [number, number][] {
    if (ring.length < 2) return ring.map(([lon, lat]) => [lon, lat] as [number, number])
    const closed = this.samePoint(ring[0], ring[ring.length - 1])
    const count = closed ? ring.length - 1 : ring.length
    const latRad = Cesium.Math.toRadians(ring[0][1])
    const mPerLon = 111320 * Math.cos(latRad)
    const mPerLat = 110540
    const segLen = (a: [number, number], b: [number, number]) =>
      Math.hypot((b[0] - a[0]) * mPerLon, (b[1] - a[1]) * mPerLat)
    let perimeter = 0
    for (let i = 0; i < count; i++) perimeter += segLen(ring[i], ring[(i + 1) % count])
    const step = Math.max(spacingM, perimeter / maxSamples)
    const out: [number, number][] = []
    for (let i = 0; i < count; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % count]
      const parts = Math.max(1, Math.ceil(segLen(a, b) / step))
      for (let s = 0; s < parts; s++) {
        const t = s / parts
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
      }
    }
    if (out.length) out.push([out[0][0], out[0][1]])
    return out
  }

  /**
   * 把采样高度压到地面：先补洞，再取局部低分位数（抑制屋顶高点），最后中值平滑。
   * 旧实现按相邻点逐步限幅，一旦边界跨过屋顶，限幅会形成很长的“坡道”，
   * 描边就悬在空中；局部统计量不会累积误差。
   */
  private surfacePercentileHeights(raw: (number | null)[]): number[] | null {
    const validCount = raw.filter((h): h is number => h !== null).length
    if (validCount < Math.max(3, Math.ceil(raw.length * 0.25))) return null
    const values = raw.map((h) => (h === null ? Number.NaN : h))
    const firstValid = values.findIndex((h) => Number.isFinite(h))
    if (firstValid < 0) return null
    let last = firstValid
    for (let i = firstValid + 1; i < values.length; i++) {
      if (!Number.isFinite(values[i])) continue
      if (i - last > 1) {
        for (let j = last + 1; j < i; j++) {
          values[j] = values[last] + ((values[i] - values[last]) * (j - last)) / (i - last)
        }
      }
      last = i
    }
    for (let i = 0; i < firstValid; i++) values[i] = values[firstValid]
    for (let i = last + 1; i < values.length; i++) values[i] = values[last]
    const w = 3
    const low = values.map((_, i) => {
      const win = values.slice(Math.max(0, i - w), Math.min(values.length, i + w + 1)).sort((a, b) => a - b)
      return win[Math.floor((win.length - 1) * 0.2)]
    })
    return low.map((_, i) => {
      const win = low.slice(Math.max(0, i - 1), Math.min(low.length, i + 2)).sort((a, b) => a - b)
      return win[Math.floor(win.length / 2)]
    })
  }

  /** 沿边界贴模型表面生成折线坐标；瓦片未就绪时返回 null，等加载完成再补绘 */
  private *sampleBoundaryPositions(
    ring: [number, number][],
    spacingM: number,
    maxSamples: number,
    lift: number,
  ): OutlineSamples {
    if (!this.tileset) return null
    const dense = this.densifyRing(ring, spacingM, maxSamples)
    if (dense.length < 3) return null
    const raw: (number | null)[] = []
    for (const [lon, lat] of dense) {
      raw.push(this.modelHeightAt(lon, lat))
      yield
    }
    const heights = this.surfacePercentileHeights(raw)
    if (!heights) return null
    const positions = dense.map(([lon, lat], i) => Cesium.Cartesian3.fromDegrees(lon, lat, heights[i] + lift))
    // 首尾是同一个点，但两端的分位窗口不同，必须强制合并，否则接缝处会出现一条竖线
    if (positions.length > 2 && this.samePoint(dense[0], dense[dense.length - 1])) {
      positions[positions.length - 1] = positions[0]
    }
    return positions
  }

  private samplesForFrame(samples: OutlineSamples) {
    const deadline = performance.now() + OUTLINE_FRAME_BUDGET_MS
    let result = samples.next()
    while (!result.done && performance.now() < deadline) result = samples.next()
    return result
  }

  /** 瓦片调度完成后重贴描边（相机移动会换 LOD，表面高度会变） */
  private scheduleOutlineRefresh(delay = 350) {
    window.clearTimeout(this.outlineRefreshTimer)
    this.outlineRefreshTimer = window.setTimeout(() => {
      if (this.destroyed) return
      if (this.selected !== null) {
        this.renderSelectedUnitOutline(this.units.find((x) => x.unit === this.selected) ?? null)
      }
      if (this.selectedBuilding) {
        const b = this.buildings.find((x) => x.id === this.selectedBuilding)
        if (b) this.renderBuildingHighlight(b, this.buildingHeight(b))
      }
    }, delay)
  }

  /** 选中建筑：只画金色描边，不叠加填充，保留模型原始贴图 */
  private renderBuildingHighlight(b: BuildingFeature, height: number) {
    this.removeBuildingHighlight()
    const ring = b.clipRing.length >= 4 ? b.clipRing : b.ring
    const samples = this.sampleBoundaryPositions(ring, 1.2, 180, 0.4)
    let result = samples.next()
    while (!result.done) result = samples.next()
    const positions = result.value
    if (positions) {
      this.buildingOutline = this.viewer.entities.add({
        id: "building-outline",
        polyline: {
          positions,
          width: new Cesium.ConstantProperty(this.outlineWidth),
          material: GOLD,
          depthFailMaterial: new Cesium.ColorMaterialProperty(GOLD.withAlpha(0.8)),
          clampToGround: false,
        },
      })
    }
    this.buildingLabel = this.viewer.entities.add({
      id: "building-label",
      position: Cesium.Cartesian3.fromDegrees(b.centroid[0], b.centroid[1], height + 8),
      label: {
        text: `${b.code} · ${b.areaM2.toFixed(0)} m²`,
        font: "600 12px 'Microsoft YaHei', sans-serif",
        fillColor: Cesium.Color.fromCssColorString("#1a1408"),
        showBackground: true,
        backgroundColor: GOLD.withAlpha(0.94),
        backgroundPadding: new Cesium.Cartesian2(7, 4),
        pixelOffset: new Cesium.Cartesian2(0, -14),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  }

  private async tryLoadTileset() {
    const params = new URLSearchParams(window.location.search)
    const override = params.get("tileset")
    const url = override ?? TILESET_PATH
    this.loadStartAt = performance.now()
    this.tilesLoaded = 0
    this.lastPending = 0
    this.lastProcessing = 0
    this.loadPhase = "connecting"
    this.emitTilesetProgress()
    this.cb.onTilesetStatus("loading")
    try {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(url, {
        enableCollision: false,
        maximumScreenSpaceError: TILESET_MAX_SSE,
        cacheBytes: TILESET_CACHE_BYTES,
        maximumCacheOverflowBytes: TILESET_MAX_CACHE_OVERFLOW_BYTES,
        // 父层先出来，再跳过中间层，直接补近景需要的细瓦片
        skipLevelOfDetail: TILESET_SKIP_LOD,
        baseScreenSpaceError: 1024,
        skipScreenSpaceErrorFactor: 16,
        skipLevels: 1,
        immediatelyLoadDesiredLevelOfDetail: false,
        loadSiblings: false,
        cullWithChildrenBounds: true,
        dynamicScreenSpaceError: true,
        dynamicScreenSpaceErrorFactor: 4,
        foveatedScreenSpaceError: true,
        foveatedConeSize: 0.3,
        progressiveResolutionHeightFraction: 0.5,
        cullRequestsWhileMoving: true,
      })
      if (this.destroyed) {
        tileset.destroy()
        return
      }
      this.tileset = tileset
      if (this.cameraMoving) tileset.maximumScreenSpaceError = MOVING_TILESET_SSE
      // 倾斜摄影贴图本身已带光照，再乘环境光会发白
      tileset.imageBasedLighting.imageBasedLightingFactor = new Cesium.Cartesian2(0, 0)
      this.loadPhase = "loading"
      this.viewer.scene.primitives.add(tileset)
      tileset.loadProgress.addEventListener(this.handleLoadProgress)
      tileset.tileLoad.addEventListener(this.handleTileLoad)
      tileset.initialTilesLoaded.addEventListener(this.handleInitialTilesLoaded)
      tileset.allTilesLoaded.addEventListener(this.handleAllTilesLoaded)
      this.emitTilesetProgress()
      this.applyZOffset()
      this.applyOpacity()
      this.applyClip()
      this.cb.onTilesetStatus("ready")
      this.flyCity(1.8)
      this.scheduleHeightSync(1500)
      if (this.selected !== null) {
        this.renderSelectedUnitOutline(this.units.find((x) => x.unit === this.selected) ?? null)
      }
      if (this.selectedBuilding) {
        const b = this.buildings.find((x) => x.id === this.selectedBuilding)
        if (b) this.renderBuildingHighlight(b, this.buildingHeight(b))
      }
    } catch (err) {
      console.error("三维模型加载失败", err)
      this.loadPhase = "error"
        this.emitTilesetProgress()
      if (!this.destroyed) this.cb.onTilesetStatus("missing")
    }
  }

  private loadingPercent(): number {
    if (this.loadPhase === "done") return 100
    if (!this.tileset) return 0
    // 无法预知瓦片总数，用已接收瓦片数估算；initialTilesLoaded 时才到 100%
    const eased = 1 - Math.exp(-this.tilesLoaded / 24)
    return Math.min(95, Math.round(10 + 85 * eased))
  }

  private emitTilesetProgress() {
    if (this.destroyed) return
    const percent = this.loadPhase === "done" ? 100 : this.loadingPercent()
    this.cb.onTilesetProgress({
      phase: this.loadPhase,
      percent,
      loaded: this.tilesLoaded,
      pending: this.lastPending,
      processing: this.lastProcessing,
      elapsedMs: this.loadStartAt ? performance.now() - this.loadStartAt : 0,
    })
  }

  private handleLoadProgress = (pending: number, processing: number) => {
    this.lastPending = pending
    this.lastProcessing = processing
    const now = performance.now()
    if (now - this.lastProgressEmit >= 200 || (pending === 0 && processing === 0)) {
      this.lastProgressEmit = now
      this.cb.onTileProgress(pending, processing)
    }
    if (now - this.loadProgressEmit >= 250) {
      this.loadProgressEmit = now
      this.emitTilesetProgress()
    }
  }

  private handleTileLoad = () => {
    this.tilesLoaded++
    const now = performance.now()
    if (now - this.loadProgressEmit >= 200) {
      this.loadProgressEmit = now
      this.emitTilesetProgress()
    }
  }

  private handleInitialTilesLoaded = () => {
    this.finishTilesetLoading()
    this.scheduleOutlineRefresh(150)
  }

  private handleAllTilesLoaded = () => {
    if (this.loadPhase !== "done" && this.tilesLoaded > 0) this.finishTilesetLoading()
    // 相机移动会切换 LOD，表面高度变化后重贴描边
    this.scheduleOutlineRefresh(350)
  }

  private finishTilesetLoading() {
    if (this.loadPhase === "done") return
    this.loadPhase = "done"
    this.emitTilesetProgress()
  }

  /** 重试加载瓦片（转换完成后调用） */
  reloadTileset() {
    if (this.tileset) return
    void this.tryLoadTileset()
  }

  private ringPositions(u: UnitFeature, height = 0): Cesium.Cartesian3[] {
    return u.ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, height))
  }

  /** 裁剪范围：建筑审核优先按建筑基底裁剪，其次按选中单元；inverse 后只保留内部 */
  private applyClip() {
    if (!this.tileset) return
    const preview =
      this.buildingMode && this.buildingClip && this.selectedBuilding !== null
        ? this.buildings.find((b) => b.id === this.selectedBuilding)
        : null
    const unit = !preview && this.clipEnabled && this.selected !== null
      ? this.units.find((x) => x.unit === this.selected)
      : null
    const ring = preview ? preview.clipRing : unit ? unit.ring : null
    if (!ring) {
      if (this.clipColl) this.clipColl.enabled = false
      return
    }
    if (!this.clipColl) {
      this.clipColl = new Cesium.ClippingPolygonCollection({ inverse: true })
      this.tileset.clippingPolygons = this.clipColl
    }
    this.clipColl.removeAll()
    this.clipColl.add(
      new Cesium.ClippingPolygon({
        positions: ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat)),
      }),
    )
    this.clipColl.enabled = true
  }

  /** 有选中单元、且没有裁剪/建筑审核时，压暗其余单元 */
  private isHighlightMode() {
    return this.selected !== null && !this.clipEnabled && !this.buildingMode
  }

  /**
   * 未选中分界线贴模型表面。
   * 模型比椭球低约 20 米，贴地分类会把线画到屋顶上方，所以改用表面采样高度。
   */
  private *sampleDimmedOutline(u: UnitFeature): OutlineSamples {
    let hit = 0
    const n = u.ring.length
    for (let i = 0; i < Math.min(6, n); i++) {
      const [lon, lat] = u.ring[Math.floor((i * n) / 6)]
      if (this.modelHeightAt(lon, lat) !== null) hit++
      yield
    }
    if (hit < 2) return null
    return yield* this.sampleBoundaryPositions(u.ring, 6, 80, 0.2)
  }

  private unitOutlineSpec(u: UnitFeature) {
    const dimmed = this.isHighlightMode() && u.unit !== this.selected
    if (dimmed) {
      const draped = this.dimOutlineCache.get(u.unit)
      if (draped) {
        return {
          positions: draped,
          clamp: false,
          classification: Cesium.ClassificationType.BOTH,
          arc: Cesium.ArcType.NONE,
          show: true,
        }
      }
      // 表面高度分帧采样，采样完成前先不画，避免贴地线悬在模型上方
      return {
        positions: this.ringPositions(u, 0),
        clamp: false,
        classification: Cesium.ClassificationType.BOTH,
        arc: Cesium.ArcType.NONE,
        show: false,
      }
    }
    return {
      positions: this.ringPositions(u, 0),
      clamp: true,
      classification: Cesium.ClassificationType.BOTH,
      arc: Cesium.ArcType.GEODESIC,
      show: true,
    }
  }

  /** 分帧采样未选中单元，相机移动时保留已画好的线并暂停采样 */
  private ensureDimOutlinePump() {
    if (this.dimPump || !this.isHighlightMode()) return
    let job: { unit: UnitFeature; ring: UnitFeature["ring"]; samples: OutlineSamples } | null = null
    const step = () => {
      this.dimPump = 0
      if (this.destroyed || !this.isHighlightMode()) return
      if (this.cameraMoving || this.selectedOutlineFrame) {
        this.dimPump = window.requestAnimationFrame(step)
        return
      }
      if (job && (job.unit.unit === this.selected || job.unit.ring !== job.ring || !this.units.includes(job.unit))) {
        job = null
      }
      const now = performance.now()
      const next = job?.unit ?? this.units.find(
        (u) => u.unit !== this.selected && !this.dimOutlineCache.has(u.unit) && (this.dimOutlineRetry.get(u.unit) ?? 0) <= now,
      )
      if (!next) {
        const waiting = this.units.some((u) => u.unit !== this.selected && !this.dimOutlineCache.has(u.unit))
        if (waiting) this.dimPump = window.requestAnimationFrame(step)
        return
      }
      job ??= { unit: next, ring: next.ring, samples: this.sampleDimmedOutline(next) }
      const result = this.samplesForFrame(job.samples)
      if (!result.done) {
        this.dimPump = window.requestAnimationFrame(step)
        return
      }
      job = null
      const draped = result.value
      if (draped) {
        this.dimOutlineCache.set(next.unit, draped)
        this.dimOutlineRetry.delete(next.unit)
        const o = this.outlines.get(next.unit)
        if (o?.polyline) {
          o.show = true
          o.polyline.positions = new Cesium.ConstantProperty(draped)
          o.polyline.clampToGround = new Cesium.ConstantProperty(false)
          o.polyline.arcType = new Cesium.ConstantProperty(Cesium.ArcType.NONE)
        }
      } else {
        this.dimOutlineRetry.set(next.unit, now + 2000)
      }
      this.dimPump = window.requestAnimationFrame(step)
    }
    this.dimPump = window.requestAnimationFrame(step)
  }

  /** 选中态配色：选中单元用金色描边、不加填充（保留原始贴图）；其余单元压暗，但编号和分界线保持可读 */
  private applyUnitStyles() {
    const highlight = this.isHighlightMode()
    const muted = highlight || this.buildingMode
    for (const u of this.units) {
      const isSel = u.unit === this.selected
      const dimmed = highlight && !isSel
      const o = this.outlines.get(u.unit)
      const f = this.fills.get(u.unit)
      const l = this.labels.get(u.unit)
      const outlineCss = isSel ? SELECT_OUTLINE_COLOR : dimmed ? DIM_OUTLINE_COLOR : muted ? "#8f959b" : GRADE_COLOR[u.grade]
      const fillCss = isSel ? SELECT_OUTLINE_COLOR : dimmed ? "#141a1e" : muted ? "#8f959b" : GRADE_COLOR[u.grade]
      const outlineColor = Cesium.Color.fromCssColorString(outlineCss)
      const fillColor = Cesium.Color.fromCssColorString(fillCss)
      if (o?.polyline) {
        const spec = this.unitOutlineSpec(u)
        o.show = spec.show
        o.polyline.positions = new Cesium.ConstantProperty(spec.positions)
        o.polyline.clampToGround = new Cesium.ConstantProperty(spec.clamp)
        o.polyline.classificationType = new Cesium.ConstantProperty(spec.classification)
        o.polyline.arcType = new Cesium.ConstantProperty(spec.arc)
        o.polyline.material = new Cesium.ColorMaterialProperty(
          outlineColor.withAlpha(isSel ? 1 : this.buildingMode ? 0.4 : dimmed ? 1 : 0.95),
        )
        o.polyline.width = new Cesium.ConstantProperty(
          isSel ? this.outlineWidth : dimmed ? DIM_OUTLINE_WIDTH : muted ? 1.3 : 1.6,
        )
        o.polyline.depthFailMaterial = new Cesium.ColorMaterialProperty(
          outlineColor.withAlpha(isSel ? 0.85 : 0),
        )
      }
      if (f) {
        // 选中单元隐藏填充；只有「体量预览」时才显示金色体量
        f.show = !isSel || this.extruded
        const alpha = this.buildingMode
          ? 0.05
          : this.extruded
            ? isSel
              ? 0.22
              : muted
                ? 0.2
                : 0.5
            : dimmed
              ? 0.1
              : muted
                ? 0.12
                : 0.26
        f.polygon!.extrudedHeight = this.extruded ? new Cesium.ConstantProperty(26) : undefined
        f.polygon!.material = new Cesium.ColorMaterialProperty(fillColor.withAlpha(alpha))
      }
      if (l?.label) {
        l.show = !this.buildingMode
        l.label.fillColor = new Cesium.ConstantProperty(
          Cesium.Color.fromCssColorString(isSel ? "#ffffff" : dimmed ? DIM_LABEL_FILL : "#f0ead8"),
        )
        l.label.outlineColor = new Cesium.ConstantProperty(Cesium.Color.fromCssColorString(DIM_LABEL_INK))
        l.label.outlineWidth = new Cesium.ConstantProperty(dimmed ? 4 : 0)
        l.label.style = new Cesium.ConstantProperty(
          dimmed ? Cesium.LabelStyle.FILL_AND_OUTLINE : Cesium.LabelStyle.FILL,
        )
        l.label.showBackground = new Cesium.ConstantProperty(dimmed)
        l.label.backgroundColor = new Cesium.ConstantProperty(
          Cesium.Color.fromCssColorString(DIM_LABEL_INK).withAlpha(dimmed ? 0.84 : 0),
        )
        l.label.backgroundPadding = new Cesium.ConstantProperty(new Cesium.Cartesian2(7, 4))
        l.label.font = new Cesium.ConstantProperty(
          dimmed ? "700 16px 'Microsoft YaHei', sans-serif" : "700 13px 'Microsoft YaHei', sans-serif",
        )
        l.label.scaleByDistance = new Cesium.ConstantProperty(
          dimmed
            ? new Cesium.NearFarScalar(180, 1.25, 8000, 1.05)
            : new Cesium.NearFarScalar(200, 1.15, 8000, 0.85),
        )
        l.label.disableDepthTestDistance = new Cesium.ConstantProperty(Number.POSITIVE_INFINITY)
      }
    }
    if (highlight) this.ensureDimOutlinePump()
    else if (this.dimPump) {
      window.cancelAnimationFrame(this.dimPump)
      this.dimPump = 0
    }
  }

  /** 选中高亮时用深色分类面压暗选中单元以外的模型；选中范围留空，原贴图亮度不变 */
  private updateWash() {
    if (this.wash) {
      this.viewer.entities.remove(this.wash)
      this.wash = null
    }
    if (this.editMode || this.buildingMode || this.selected === null || this.clipEnabled) return
    const u = this.units.find((x) => x.unit === this.selected)
    if (!u) return
    const d = 0.15
    const outer = Cesium.Cartesian3.fromDegreesArray([
      HOME_CENTER.lon - d, HOME_CENTER.lat - d,
      HOME_CENTER.lon + d, HOME_CENTER.lat - d,
      HOME_CENTER.lon + d, HOME_CENTER.lat + d,
      HOME_CENTER.lon - d, HOME_CENTER.lat + d,
    ])
    this.wash = this.viewer.entities.add({
      id: "highlight-wash",
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(outer, [new Cesium.PolygonHierarchy(this.ringPositions(u))]),
        material: Cesium.Color.fromCssColorString(WASH_COLOR).withAlpha(WASH_ALPHA),
        outline: false,
        classificationType: Cesium.ClassificationType.BOTH,
      },
    })
  }

  /** 从屏幕坐标拾取单元：优先实体，其次按地面点做多边形包含判断 */
  private pickUnitAt(screen: Cesium.Cartesian2): number | null {
    const scene = this.viewer.scene
    const picked = scene.pick(screen)
    const id = picked?.id
    if (id instanceof Cesium.Entity) {
      const value = (id.properties as Cesium.PropertyBag | undefined)?.unit?.getValue()
      if (typeof value === "number") return value
    }
    let cartesian: Cesium.Cartesian3 | undefined
    try {
      cartesian = scene.pickPosition(screen)
    } catch {
      cartesian = undefined
    }
    if (!Cesium.defined(cartesian)) {
      cartesian = this.viewer.camera.pickEllipsoid(screen, Cesium.Ellipsoid.WGS84)
    }
    if (!Cesium.defined(cartesian)) return null
    const carto = Cesium.Cartographic.fromCartesian(cartesian)
    const lon = Cesium.Math.toDegrees(carto.longitude)
    const lat = Cesium.Math.toDegrees(carto.latitude)
    const hit = this.units.find((u) => pointInRing(lon, lat, u.ring))
    return hit ? hit.unit : null
  }

  /* ---------------- 边界编辑 ---------------- */

  private pickGroundPosition(screen: Cesium.Cartesian2): Cesium.Cartesian3 | null {
    const scene = this.viewer.scene
    let cartesian: Cesium.Cartesian3 | undefined
    try {
      cartesian = scene.pickPosition(screen)
    } catch {
      cartesian = undefined
    }
    if (!Cesium.defined(cartesian)) {
      cartesian = this.viewer.camera.pickEllipsoid(screen, Cesium.Ellipsoid.WGS84)
    }
    return cartesian ?? null
  }

  private snapshotUnits(): UnitFeature[] {
    return this.units.map((u) => ({
      ...u,
      ring: u.ring.map(([lon, lat]) => [lon, lat] as [number, number]),
      centroid: [u.centroid[0], u.centroid[1]] as [number, number],
      bbox: { ...u.bbox },
    }))
  }

  private editState(): EditState {
    return { editMode: this.editMode, drawing: this.drawing, selected: this.selected }
  }

  private refreshUnitGeometry(u: UnitFeature) {
    this.dimOutlineCache.delete(u.unit)
    this.dimOutlineRetry.delete(u.unit)
    const positions = this.ringPositions(u)
    const f = this.fills.get(u.unit)
    if (f?.polygon) {
      f.polygon.hierarchy = new Cesium.ConstantProperty(new Cesium.PolygonHierarchy(positions))
    }
    const o = this.outlines.get(u.unit)
    if (o?.polyline) {
      const spec = this.unitOutlineSpec(u)
      o.show = spec.show
      o.polyline.positions = new Cesium.ConstantProperty(spec.positions)
      o.polyline.clampToGround = new Cesium.ConstantProperty(spec.clamp)
      o.polyline.classificationType = new Cesium.ConstantProperty(spec.classification)
      o.polyline.arcType = new Cesium.ConstantProperty(spec.arc)
    }
    const l = this.labels.get(u.unit)
    if (l) l.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromDegrees(u.centroid[0], u.centroid[1]))
  }

  private clearVertices() {
    for (const e of this.vertexEntities) this.viewer.entities.remove(e)
    this.vertexEntities = []
  }

  /** 顶点贴到模型/地表实际高度，避免悬空 */
  private surfacePosition(lon: number, lat: number): Cesium.Cartesian3 {
    const carto = Cesium.Cartographic.fromDegrees(lon, lat)
    try {
      const h = this.viewer.scene.sampleHeight(carto)
      if (h !== undefined && Number.isFinite(h)) {
        return Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, h + 0.25)
      }
    } catch {
      // 模型该处尚未渲染时回退到高程偏移
    }
    return Cesium.Cartesian3.fromDegrees(lon, lat, this.zOffset + 0.5)
  }

  private rebuildVertices() {
    this.clearVertices()
    if (!this.editMode || this.drawing || this.selected === null) return
    const u = this.units.find((x) => x.unit === this.selected)
    if (!u) return
    const pts = u.ring.slice(0, -1)
    pts.forEach(([lon, lat], index) => {
      this.vertexEntities.push(
        this.viewer.entities.add({
          position: this.surfacePosition(lon, lat),
          properties: { editVertex: index, editUnit: u.unit },
          point: {
            pixelSize: 12,
            color: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.fromCssColorString(SELECT_COLOR),
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      )
    })
  }

  private samePoint(a: [number, number], b: [number, number]) {
    const tol = 2e-6
    return Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol
  }

  /** 与当前顶点重合的其他单元顶点（共享边界） */
  private sharedVertices(unit: number, index: number): { unit: number; index: number }[] {
    const u = this.units.find((x) => x.unit === unit)
    if (!u) return []
    const pos = u.ring[index]
    const out: { unit: number; index: number }[] = []
    for (const v of this.units) {
      if (v.unit === unit) continue
      const open = v.ring.length - 1
      for (let i = 0; i < open; i++) {
        if (this.samePoint(v.ring[i], pos)) out.push({ unit: v.unit, index: i })
      }
    }
    return out
  }

  /** 与给定线段两端点重合的相邻单元线段 */
  private sharedSegments(unit: number, a: [number, number], b: [number, number]): { unit: number; index: number }[] {
    const out: { unit: number; index: number }[] = []
    for (const v of this.units) {
      if (v.unit === unit) continue
      const open = v.ring.length - 1
      for (let i = 0; i < open; i++) {
        const c = v.ring[i]
        const d = v.ring[(i + 1) % open]
        if ((this.samePoint(a, c) && this.samePoint(b, d)) || (this.samePoint(a, d) && this.samePoint(b, c))) {
          out.push({ unit: v.unit, index: i })
        }
      }
    }
    return out
  }

  private pushUndo(units: number[]) {
    const metas = [...new Set(units)].map((unit) => {
      const u = this.units.find((x) => x.unit === unit)
      return u ? { unit, ring: u.ring.map(([lon, lat]) => [lon, lat] as [number, number]) } : null
    })
    this.undoStack.push(metas.filter((m): m is { unit: number; ring: [number, number][] } => m !== null))
    if (this.undoStack.length > 80) this.undoStack.shift()
  }

  undo() {
    const snap = this.undoStack.pop()
    if (!snap) return
    for (const { unit, ring } of snap) {
      const u = this.units.find((x) => x.unit === unit)
      if (u) u.ring = normalizeRing(ring)
    }
    this.finalizeUnits(snap.map((s) => s.unit))
  }

  private finalizeUnits(units: number[]) {
    for (const unit of new Set(units)) {
      const u = this.units.find((x) => x.unit === unit)
      if (!u) continue
      u.ring = normalizeRing(u.ring)
      Object.assign(u, computeUnitMetrics(u.ring))
      this.refreshUnitGeometry(u)
    }
    if (this.clipEnabled) this.applyClip()
    if (this.selected !== null && units.includes(this.selected)) {
      this.renderSelectedUnitOutline(this.units.find((u) => u.unit === this.selected) ?? null)
    }
    this.rebuildVertices()
    this.applyUnitStyles()
    this.updateWash()
    this.cb.onUnitsChanged(this.snapshotUnits())
  }

  private setRingPoint(u: UnitFeature, index: number, lon: number, lat: number) {
    const open = u.ring.length - 1
    if (index < 0 || index >= open) return
    u.ring[index] = [lon, lat]
    if (index === 0) u.ring[open] = [lon, lat]
  }

  private beginDragGroup(index: number) {
    if (this.selected === null) return
    this.dragGroup = [{ unit: this.selected, index }, ...this.sharedVertices(this.selected, index)]
    this.pushUndo(this.dragGroup.map((g) => g.unit))
  }

  private updateDrag(screen: Cesium.Cartesian2) {
    if (this.dragIndex === null || !this.dragGroup.length) return
    const cart = this.pickGroundPosition(screen)
    if (!cart) return
    const carto = Cesium.Cartographic.fromCartesian(cart)
    const lon = Cesium.Math.toDegrees(carto.longitude)
    const lat = Cesium.Math.toDegrees(carto.latitude)
    for (const g of this.dragGroup) {
      const u = this.units.find((x) => x.unit === g.unit)
      if (!u) continue
      this.setRingPoint(u, g.index, lon, lat)
      this.refreshUnitGeometry(u)
    }
    const v = this.vertexEntities[this.dragIndex]
    if (v) v.position = new Cesium.ConstantPositionProperty(this.surfacePosition(lon, lat))
  }

  private commitDragGroup() {
    if (!this.dragGroup.length) return
    const units = this.dragGroup.map((g) => g.unit)
    this.dragGroup = []
    this.finalizeUnits(units)
    if (this.selected !== null) this.applyClip()
  }

  /** 按屏幕距离找最近的顶点（顶点会被地面填充遮挡，不能依赖 scene.pick） */
  private nearestVertex(screen: Cesium.Cartesian2): number | null {
    if (!this.vertexEntities.length) return null
    const now = this.viewer.clock.currentTime
    const rect = this.viewer.scene.canvas.getBoundingClientRect()
    const sx = screen.x + rect.left
    const sy = screen.y + rect.top
    let best = { index: -1, dist: 18 }
    this.vertexEntities.forEach((e, index) => {
      const position = e.position?.getValue(now)
      if (!position) return
      const w = Cesium.SceneTransforms.worldToWindowCoordinates(this.viewer.scene, position)
      if (!w) return
      const dist = Math.hypot(sx - w.x, sy - w.y)
      if (dist < best.dist) best = { index, dist }
    })
    return best.index >= 0 ? best.index : null
  }

  private addVertexAtPoint(screen: Cesium.Cartesian2) {
    if (this.selected === null) return
    const u = this.units.find((x) => x.unit === this.selected)
    if (!u) return
    const pts = u.ring.slice(0, -1)
    if (pts.length < 3 || this.vertexEntities.length !== pts.length) return
    const now = this.viewer.clock.currentTime
    // 事件坐标相对画布；worldToWindowCoordinates 返回页面坐标，需补齐画布偏移
    const rect = this.viewer.scene.canvas.getBoundingClientRect()
    const sx = screen.x + rect.left
    const sy = screen.y + rect.top
    let best = { index: -1, t: 0, dist: Number.POSITIVE_INFINITY }
    for (let i = 0; i < pts.length; i++) {
      const a = this.vertexEntities[i]?.position?.getValue(now)
      const b = this.vertexEntities[(i + 1) % pts.length]?.position?.getValue(now)
      if (!a || !b) continue
      const w1 = Cesium.SceneTransforms.worldToWindowCoordinates(this.viewer.scene, a)
      const w2 = Cesium.SceneTransforms.worldToWindowCoordinates(this.viewer.scene, b)
      if (!w1 || !w2) continue
      const vx = w2.x - w1.x
      const vy = w2.y - w1.y
      const len2 = vx * vx + vy * vy
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((sx - w1.x) * vx + (sy - w1.y) * vy) / len2))
      const dist = Math.hypot(sx - (w1.x + vx * t), sy - (w1.y + vy * t))
      if (dist < best.dist) best = { index: i, t, dist }
    }
    // 只在贴近边界线、且不落在端点附近时插点
    if (best.index < 0 || best.dist > 14 || best.t < 0.02 || best.t > 0.98) return
    const a = pts[best.index]
    const b = pts[(best.index + 1) % pts.length]
    const point: [number, number] = [a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t]
    const shared = this.sharedSegments(u.unit, a, b)
    this.pushUndo([u.unit, ...shared.map((s) => s.unit)])
    pts.splice(best.index + 1, 0, point)
    u.ring = normalizeRing(pts)
    for (const s of shared) {
      const v = this.units.find((x) => x.unit === s.unit)
      if (!v) continue
      const vp = v.ring.slice(0, -1)
      vp.splice(s.index + 1, 0, [point[0], point[1]])
      v.ring = normalizeRing(vp)
    }
    this.finalizeUnits([u.unit, ...shared.map((s) => s.unit)])
  }

  private deleteVertexAt(screen: Cesium.Cartesian2) {
    if (this.selected === null) return
    const index = this.nearestVertex(screen)
    if (index === null) return
    const u = this.units.find((x) => x.unit === this.selected)
    if (!u) return
    if (u.ring.length - 1 <= 3) return
    const group = [{ unit: u.unit, index }, ...this.sharedVertices(u.unit, index)]
    this.pushUndo(group.map((g) => g.unit))
    for (const g of group) {
      const v = this.units.find((x) => x.unit === g.unit)
      if (!v) continue
      const vp = v.ring.slice(0, -1)
      if (vp.length <= 3) continue
      vp.splice(g.index, 1)
      v.ring = normalizeRing(vp)
    }
    this.finalizeUnits(group.map((g) => g.unit))
  }

  setEditTool(tool: "drag" | "add" | "delete") {
    this.editTool = tool
    this.rebuildVertices()
  }

  setEditMode(on: boolean) {
    if (this.editMode === on) return
    this.editMode = on
    if (!on) {
      this.cancelDrawing()
      this.dragIndex = null
      this.viewer.scene.screenSpaceCameraController.enableRotate = true
    }
    this.clearVertices()
    this.rebuildVertices()
    this.applyUnitStyles()
    this.updateWash()
    this.cb.onEditState(this.editState())
  }

  startDrawing() {
    if (!this.editMode) this.setEditMode(true)
    this.drawing = true
    this.drawPoints = []
    this.clearDrawEntities()
    this.updateWash()
    this.cb.onEditState(this.editState())
  }

  private addDrawPoint(screen: Cesium.Cartesian2) {
    const cart = this.pickGroundPosition(screen)
    if (!cart) return
    const carto = Cesium.Cartographic.fromCartesian(cart)
    this.drawPoints.push([Cesium.Math.toDegrees(carto.longitude), Cesium.Math.toDegrees(carto.latitude)])
    this.drawPointEntities.push(
      this.viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(this.drawPoints[this.drawPoints.length - 1][0], this.drawPoints[this.drawPoints.length - 1][1], this.zOffset + 0.8),
        point: {
          pixelSize: 9,
          color: Cesium.Color.fromCssColorString(SELECT_COLOR),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    )
    this.updateDrawPreview()
  }

  private updateDrawPreview(screen?: Cesium.Cartesian2) {
    const cursor = screen ? this.pickGroundPosition(screen) : null
    const cursorPt = cursor ? Cesium.Cartographic.fromCartesian(cursor) : null
    const pts = [...this.drawPoints]
    if (cursorPt) pts.push([Cesium.Math.toDegrees(cursorPt.longitude), Cesium.Math.toDegrees(cursorPt.latitude)])
    if (pts.length < 2) return
    const positions = pts.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat))
    if (!this.drawPolyline) {
      this.drawPolyline = this.viewer.entities.add({
        polyline: {
          positions,
          width: 2,
          material: Cesium.Color.fromCssColorString(SELECT_COLOR),
          clampToGround: true,
        },
      })
    } else {
      this.drawPolyline.polyline!.positions = new Cesium.ConstantProperty(positions)
    }
    if (pts.length >= 3) {
      const hierarchy = new Cesium.PolygonHierarchy(positions)
      if (!this.drawPolygon) {
        this.drawPolygon = this.viewer.entities.add({
          polygon: {
            hierarchy,
            material: Cesium.Color.fromCssColorString(SELECT_COLOR).withAlpha(0.18),
            outline: false,
          },
        })
      } else {
        this.drawPolygon.polygon!.hierarchy = new Cesium.ConstantProperty(hierarchy)
      }
    }
  }

  private clearDrawEntities() {
    if (this.drawPolyline) this.viewer.entities.remove(this.drawPolyline)
    if (this.drawPolygon) this.viewer.entities.remove(this.drawPolygon)
    for (const e of this.drawPointEntities) this.viewer.entities.remove(e)
    this.drawPolyline = null
    this.drawPolygon = null
    this.drawPointEntities = []
  }

  finishDrawing() {
    if (!this.drawing) return
    if (this.drawPoints.length < 3) {
      this.cancelDrawing()
      return
    }
    const unit = this.units.reduce((m, u) => Math.max(m, u.unit), 0) + 1
    const ring = normalizeRing(this.drawPoints)
    const u: UnitFeature = {
      unit,
      name: `${String(unit).padStart(2, "0")}单元`,
      grade: 3,
      ring,
      ...computeUnitMetrics(ring),
    }
    this.units.push(u)
    this.createUnitEntities(u)
    this.drawing = false
    this.drawPoints = []
    this.clearDrawEntities()
    this.selected = null
    this.selectUnit(unit)
    this.applyUnitStyles()
    this.updateWash()
    this.rebuildVertices()
    this.cb.onUnitsChanged(this.snapshotUnits())
    this.cb.onEditState(this.editState())
  }

  cancelDrawing() {
    this.drawing = false
    this.drawPoints = []
    this.clearDrawEntities()
    this.cb.onEditState(this.editState())
  }

  saveEdits() {
    storeUnits(this.units)
    this.cb.onUnitsChanged(this.snapshotUnits())
  }

  async revertEdits() {
    this.removeAllUnitEntities()
    this.units = loadStoredUnits() ?? (await loadUnits(UNITS_URL))
    this.selected = null
    this.renderSelectedUnitOutline(null)
    this.drawing = false
    this.clearDrawEntities()
    this.addUnitEntities()
    this.applyUnitStyles()
    this.updateWash()
    this.rebuildVertices()
    this.cb.onUnitsChanged(this.snapshotUnits())
    this.cb.onSelectChange(null)
    this.cb.onEditState(this.editState())
  }

  async resetUnits() {
    clearStoredUnits()
    await this.revertEdits()
  }

  deleteSelectedUnit() {
    if (this.selected === null) return
    const unit = this.selected
    this.units = this.units.filter((u) => u.unit !== unit)
    for (const map of [this.fills, this.outlines, this.labels]) {
      const e = map.get(unit)
      if (e) this.viewer.entities.remove(e)
      map.delete(unit)
    }
    this.selected = null
    this.renderSelectedUnitOutline(null)
    this.applyClip()
    this.applyUnitStyles()
    this.updateWash()
    this.rebuildVertices()
    this.cb.onUnitsChanged(this.snapshotUnits())
    this.cb.onSelectChange(null)
  }

  exportUnitsJson(): string {
    return JSON.stringify(unitsToGeoJson(this.units), null, 2)
  }

  private removeAllUnitEntities() {
    this.dimOutlineCache.clear()
    this.dimOutlineRetry.clear()
    window.cancelAnimationFrame(this.dimPump)
    this.dimPump = 0
    for (const e of [...this.fills.values(), ...this.outlines.values(), ...this.labels.values()]) {
      this.viewer.entities.remove(e)
    }
    this.fills.clear()
    this.outlines.clear()
    this.labels.clear()
    this.clearVertices()
  }

  private flyToUnit(u: UnitFeature) {
    const sphere = Cesium.BoundingSphere.fromPoints(this.ringPositions(u))
    const range = Math.max(190, sphere.radius * 2.2)
    this.beginFlight(1.4)
    this.viewer.camera.flyToBoundingSphere(sphere, {
      duration: 1.4,
      offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-48), range),
    })
  }

  /** 选中单元的金色表面描边（沿模型表面，避免地面线被建筑挡住） */
  private renderSelectedUnitOutline(u: UnitFeature | null) {
    window.cancelAnimationFrame(this.selectedOutlineFrame)
    this.selectedOutlineFrame = 0
    const unit = u?.unit ?? null
    if (this.selectedOutlineUnit !== unit) {
      if (this.selectedUnitOutline) this.viewer.entities.remove(this.selectedUnitOutline)
      this.selectedUnitOutline = null
      this.selectedOutlineUnit = unit
    }
    if (!u || !this.tileset) return
    const samples = this.sampleBoundaryPositions(u.ring, 4, 280, 0.35)
    const step = () => {
      if (this.destroyed) return
      if (!this.cameraMoving) {
        const result = this.samplesForFrame(samples)
        if (result.done) {
          this.selectedOutlineFrame = 0
          if (result.value) this.setSelectedOutlinePositions(result.value)
          return
        }
      }
      this.selectedOutlineFrame = window.requestAnimationFrame(step)
    }
    this.selectedOutlineFrame = window.requestAnimationFrame(step)
  }

  private setSelectedOutlinePositions(positions: Cesium.Cartesian3[]) {
    if (this.selectedUnitOutline?.polyline) {
      this.selectedUnitOutline.polyline.positions = new Cesium.ConstantProperty(positions)
      return
    }
    this.selectedUnitOutline = this.viewer.entities.add({
      id: "unit-selected-outline",
      polyline: {
        positions,
        width: new Cesium.ConstantProperty(this.outlineWidth),
        material: GOLD,
        depthFailMaterial: new Cesium.ColorMaterialProperty(GOLD.withAlpha(0.85)),
        clampToGround: false,
      },
    })
  }

  setOutlineWidth(width: number) {
    this.outlineWidth = Math.min(SELECT_OUTLINE_WIDTH_MAX, Math.max(SELECT_OUTLINE_WIDTH_MIN, width))
    this.applyUnitStyles()
    if (this.buildingOutline?.polyline) {
      this.buildingOutline.polyline.width = new Cesium.ConstantProperty(this.outlineWidth)
    }
    if (this.selectedUnitOutline?.polyline) {
      this.selectedUnitOutline.polyline.width = new Cesium.ConstantProperty(this.outlineWidth)
    }
  }

  selectUnit(unit: number | null) {
    // 再次点击同一单元视为取消
    if (unit !== null && unit === this.selected) unit = null
    if (this.selected === unit) return
    this.selected = unit
    const u = unit !== null ? this.units.find((x) => x.unit === unit) ?? null : null
    if (unit !== null && !u) {
      this.selected = null
      this.renderSelectedUnitOutline(null)
      return
    }
    if (u) {
      this.flyToUnit(u)
      // 等相机到位、瓦片渲染稳定后按真实模型表面重贴顶点
      window.setTimeout(() => {
        if (!this.destroyed && this.editMode && this.selected === u.unit) this.rebuildVertices()
      }, 1800)
    }
    this.renderSelectedUnitOutline(u)
    this.applyClip()
    this.applyUnitStyles()
    this.updateWash()
    this.rebuildVertices()
    this.cb.onSelectChange(unit)
    this.cb.onEditState(this.editState())
  }

  setClipEnabled(enabled: boolean) {
    this.clipEnabled = enabled
    this.applyClip()
    this.applyUnitStyles()
    this.updateWash()
  }

  setExtruded(extruded: boolean) {
    this.extruded = extruded
    this.applyUnitStyles()
  }

  setZOffset(z: number) {
    this.zOffset = z
    this.renderSelectedUnitOutline(null)
    this.dimOutlineCache.clear()
    this.dimOutlineRetry.clear()
    if (this.dimPump) {
      window.cancelAnimationFrame(this.dimPump)
      this.dimPump = 0
    }
    this.applyZOffset()
    this.rebuildVertices()
    this.buildingHeights.clear()
    const u = this.selected !== null ? this.units.find((x) => x.unit === this.selected) ?? null : null
    this.renderSelectedUnitOutline(u)
    if (this.selectedBuilding) {
      const b = this.buildings.find((x) => x.id === this.selectedBuilding)
      if (b) {
        this.selectedViewHeight = this.buildingHeight(b)
        this.renderBuildingHighlight(b, this.selectedViewHeight)
      }
    }
    if (this.buildings.length) this.scheduleHeightSync(500)
    this.applyUnitStyles()
  }

  private applyZOffset() {
    if (!this.tileset) return
    const up = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
      Cesium.Cartesian3.fromDegrees(HOME_CENTER.lon, HOME_CENTER.lat),
    )
    this.tileset.modelMatrix = Cesium.Matrix4.fromTranslation(
      Cesium.Cartesian3.multiplyByScalar(up, this.zOffset, new Cesium.Cartesian3()),
    )
  }

  setOpacity(alpha: number) {
    this.opacity = Math.min(1, Math.max(0.05, alpha))
    this.applyOpacity()
  }

  private applyOpacity() {
    if (!this.tileset) return
    if (this.opacity >= 0.995) {
      this.tileset.style = undefined
      return
    }
    this.tileset.style = new Cesium.Cesium3DTileStyle({
      color: `color('white', ${this.opacity.toFixed(2)})`,
    })
  }

  setBaseLayer(kind: BaseLayerKind) {
    this.baseKind = kind
    // destroy=false：保留实例，来回切换时避免重建瓦片缓存
    this.viewer.imageryLayers.removeAll(false)
    if (kind === "none") return
    if (kind === "satellite") {
      if (!this.satelliteLayer) {
        this.satelliteLayer = new Cesium.ImageryLayer(
          new Cesium.UrlTemplateImageryProvider({
            url: SATELLITE_URL,
            maximumLevel: SATELLITE_MAX_LEVEL,
            credit: SATELLITE_CREDIT,
          }),
        )
      }
      this.viewer.imageryLayers.add(this.satelliteLayer)
      return
    }
    if (!this.osmLayer) {
      this.osmLayer = new Cesium.ImageryLayer(
        new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" }),
        { saturation: 0.35, brightness: 0.9, contrast: 1.05 },
      )
    }
    this.viewer.imageryLayers.add(this.osmLayer)
  }

  getBaseLayer() {
    return this.baseKind
  }

  /** 全城视角：以 25 个单元的中心点构图，保证城镇居中 */
  flyCity(duration = 1.6) {
    const center = Cesium.Cartesian3.fromDegrees(HOME_CENTER.lon, HOME_CENTER.lat)
    const sphere = new Cesium.BoundingSphere(center, 480)
    const pitch = Cesium.Math.toRadians(-50)
    const range = HOME_HEIGHT / Math.sin(-pitch)
    this.beginFlight(duration)
    this.viewer.camera.flyToBoundingSphere(sphere, {
      duration,
      offset: new Cesium.HeadingPitchRange(0, pitch, range),
    })
  }

  /* ---------------- 测量 ---------------- */

  setMeasureMode(mode: MeasureMode) {
    this.measureMode = mode
    this.clearMeasure()
    this.viewer.scene.canvas.style.cursor = mode === "none" ? "default" : "crosshair"
  }

  private pickSurface(screen: Cesium.Cartesian2): Cesium.Cartesian3 | null {
    const scene = this.viewer.scene
    let cartesian: Cesium.Cartesian3 | undefined
    try {
      cartesian = scene.pickPosition(screen)
    } catch {
      cartesian = undefined
    }
    if (!Cesium.defined(cartesian)) {
      cartesian = this.viewer.camera.pickEllipsoid(screen, Cesium.Ellipsoid.WGS84)
    }
    return Cesium.defined(cartesian) ? cartesian : null
  }

  private addMeasurePoint(screen: Cesium.Cartesian2) {
    const p = this.pickSurface(screen)
    if (!p) return
    this.measurePoints.push(p)
    this.renderMeasure()
    this.emitMeasure()
  }

  finishMeasure() {
    if (this.measureFinished || this.measureMode === "none") return
    if (this.measureMode === "distance" && this.measurePoints.length < 2) return
    if (this.measureMode === "area" && this.measurePoints.length < 3) return
    this.measureFinished = true
    this.renderMeasure()
    this.emitMeasure()
  }

  clearMeasure() {
    this.measurePoints = []
    this.measureFinished = false
    this.renderMeasure()
    this.emitMeasure()
  }

  private measureDistance(pts: Cesium.Cartesian3[]): number {
    let total = 0
    for (let i = 1; i < pts.length; i++) total += Cesium.Cartesian3.distance(pts[i - 1], pts[i])
    return total
  }

  private measureArea(pts: Cesium.Cartesian3[]): number {
    if (pts.length < 3) return 0
    const carts = pts.map((p) => Cesium.Cartographic.fromCartesian(p))
    const lon0 = carts.reduce((s, c) => s + c.longitude, 0) / carts.length
    const lat0 = carts.reduce((s, c) => s + c.latitude, 0) / carts.length
    const cosLat = Math.cos(lat0)
    const xy = carts.map((c) => [
      (c.longitude - lon0) * cosLat * EARTH_RADIUS,
      (c.latitude - lat0) * EARTH_RADIUS,
    ])
    let sum = 0
    for (let i = 0; i < xy.length; i++) {
      const [x1, y1] = xy[i]
      const [x2, y2] = xy[(i + 1) % xy.length]
      sum += x1 * y2 - x2 * y1
    }
    return Math.abs(sum) / 2
  }

  private currentMeasure(): MeasureState {
    const distanceM = this.measureMode === "distance" ? this.measureDistance(this.measurePoints) : 0
    const areaM2 = this.measureMode === "area" ? this.measureArea(this.measurePoints) : 0
    return {
      mode: this.measureMode,
      points: this.measurePoints.length,
      finished: this.measureFinished,
      distanceM,
      areaM2,
    }
  }

  private emitMeasure() {
    this.cb.onMeasureChange(this.currentMeasure())
  }

  private removeMeasureEntities() {
    for (const e of this.measureEntities) this.viewer.entities.remove(e)
    this.measureEntities = []
  }

  private renderMeasure() {
    this.removeMeasureEntities()
    const pts = this.measurePoints
    if (pts.length === 0) return
    const isArea = this.measureMode === "area"
    const color = Cesium.Color.fromCssColorString(isArea ? MEASURE_AREA_COLOR : MEASURE_DISTANCE_COLOR)
    for (const p of pts) {
      this.measureEntities.push(
        this.viewer.entities.add({
          position: p,
          point: {
            pixelSize: 7,
            color,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      )
    }
    if (isArea && pts.length >= 3) {
      this.measureEntities.push(
        this.viewer.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(pts),
            material: color.withAlpha(0.2),
            perPositionHeight: true,
          },
        }),
      )
    }
    if (pts.length >= 2) {
      const ring = isArea && pts.length >= 3 ? [...pts, pts[0]] : pts
      this.measureEntities.push(
        this.viewer.entities.add({
          polyline: {
            positions: ring,
            width: new Cesium.ConstantProperty(2.5),
            material: color,
            clampToGround: false,
          },
        }),
      )
    }
    const state = this.currentMeasure()
    if (this.measureFinished) {
      const anchor = isArea ? Cesium.BoundingSphere.fromPoints(pts).center : pts[pts.length - 1]
      const text = isArea ? formatArea(state.areaM2) : formatDistance(state.distanceM)
      this.measureEntities.push(
        this.viewer.entities.add({
          position: anchor,
          label: {
            text,
            font: "600 13px 'Microsoft YaHei', sans-serif",
            fillColor: Cesium.Color.fromCssColorString("#0c1411"),
            showBackground: true,
            backgroundColor: color.withAlpha(0.92),
            backgroundPadding: new Cesium.Cartesian2(7, 4),
            pixelOffset: new Cesium.Cartesian2(0, -16),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      )
    }
  }

  /* ---------------- 视角书签 ---------------- */

  getCameraView(): CameraView {
    const cam = this.viewer.camera
    const carto = Cesium.Cartographic.fromCartesian(cam.positionWC)
    return {
      lon: Cesium.Math.toDegrees(carto.longitude),
      lat: Cesium.Math.toDegrees(carto.latitude),
      height: carto.height,
      heading: cam.heading,
      pitch: cam.pitch,
      roll: cam.roll,
    }
  }

  flyToView(view: CameraView, duration = 1.4) {
    const minPitch = Cesium.Math.toRadians(CAMERA_MIN_PITCH_DEG)
    this.beginFlight(duration)
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      orientation: {
        heading: view.heading,
        pitch: Math.min(view.pitch, minPitch),
        roll: view.roll,
      },
      duration,
    })
  }

  private beginFlight(duration: number) {
    this.flightEndsAt = performance.now() + duration * 1000 + 250
  }

  private onCameraMoveStart = () => {
    this.cameraMoving = true
    if (this.tileset) this.tileset.maximumScreenSpaceError = MOVING_TILESET_SSE
  }

  private onCameraMoveEnd = () => {
    this.cameraMoving = false
    if (this.tileset) this.tileset.maximumScreenSpaceError = TILESET_MAX_SSE
  }

  /** 用户操作结束后把俯角限制在最低值，避免接近水平视角造成远景纹理拉伸 */
  private clampCameraPitch = () => {
    if (this.destroyed || this.clamping || performance.now() < this.flightEndsAt) return
    const cam = this.viewer.camera
    const minPitch = Cesium.Math.toRadians(CAMERA_MIN_PITCH_DEG)
    if (cam.pitch > minPitch) {
      this.clamping = true
      cam.setView({ orientation: { heading: cam.heading, pitch: minPitch, roll: cam.roll } })
      this.clamping = false
    }
  }

  /** 拉近后隐藏卫星球面，防止底图浮到模型上方；拉远时恢复 */
  private updateGlobeVisibility = () => {
    if (this.destroyed || !this.tileset) return
    const scene = this.viewer.scene
    const h = this.viewer.camera.positionCartographic.height
    const bs = this.tileset.boundingSphere
    const inModelArea =
      Cesium.Cartesian3.distance(this.viewer.camera.positionWC, bs.center) < bs.radius * 1.2
    const hide = inModelArea && (this.nearGlobeHidden ? h < GLOBE_HIDE_BELOW_HEIGHT + 80 : h < GLOBE_HIDE_BELOW_HEIGHT)
    if (hide === this.nearGlobeHidden) return
    this.nearGlobeHidden = hide
    scene.globe.show = !hide
    if (scene.skyBox) scene.skyBox.show = !hide
    if (hide) scene.backgroundColor = Cesium.Color.fromCssColorString("#0e2a30")
  }

  destroy() {
    this.destroyed = true
    window.clearTimeout(this.heightSyncTimer)
    window.clearTimeout(this.viewRefineTimer)
    window.clearTimeout(this.outlineRefreshTimer)
    window.cancelAnimationFrame(this.dimPump)
    window.cancelAnimationFrame(this.selectedOutlineFrame)
    this.viewer.camera.moveStart.removeEventListener(this.onCameraMoveStart)
    this.viewer.camera.moveEnd.removeEventListener(this.onCameraMoveEnd)
    window.removeEventListener("keydown", this.onKeyDown)
    this.viewer.scene.preRender.removeEventListener(this.clampCameraPitch)
    this.viewer.scene.preRender.removeEventListener(this.updateGlobeVisibility)
    this.handler.destroy()
    if (this.buildingPoints) {
      this.viewer.scene.primitives.remove(this.buildingPoints)
      this.buildingPoints = null
    }
    this.viewer.destroy()
  }
}

export function formatDistance(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "0 m"
  return m < 1000 ? `${m.toFixed(1)} m` : `${(m / 1000).toFixed(2)} km`
}

export function formatArea(m2: number): string {
  if (!Number.isFinite(m2) || m2 <= 0) return "0 m²"
  return m2 < 10000 ? `${m2.toFixed(0)} m²` : `${(m2 / 10000).toFixed(2)} 公顷`
}
