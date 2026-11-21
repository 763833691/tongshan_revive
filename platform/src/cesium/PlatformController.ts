import * as Cesium from "cesium"
import "cesium/Build/Cesium/Widgets/widgets.css"
import {
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
  TILESET_CACHE_BYTES,
  TILESET_MAX_CACHE_OVERFLOW_BYTES,
  TILESET_MAX_SSE,
  TILESET_PATH,
  UNITS_URL,
  Z_OFFSET_DEFAULT,
  type BaseLayerKind,
} from "@/config"
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
  onSelectChange: (unit: number | null) => void
  onMeasureChange: (state: MeasureState) => void
  onUnitsChanged: (units: UnitFeature[]) => void
  onEditState: (state: EditState) => void
}

const EARTH_RADIUS = 6371008.8

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
    window.addEventListener("keydown", this.onKeyDown)
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return
    if (this.drawing) {
      this.cancelDrawing()
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
    await this.tryLoadTileset()
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

  private async tryLoadTileset() {
    const override = new URLSearchParams(window.location.search).get("tileset")
    const url = override ?? TILESET_PATH
    this.cb.onTilesetStatus("loading")
    try {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(url, {
        enableCollision: false,
        maximumScreenSpaceError: TILESET_MAX_SSE,
        cacheBytes: TILESET_CACHE_BYTES,
        maximumCacheOverflowBytes: TILESET_MAX_CACHE_OVERFLOW_BYTES,
      })
      if (this.destroyed) {
        tileset.destroy()
        return
      }
      this.tileset = tileset
      this.viewer.scene.primitives.add(tileset)
      tileset.loadProgress.addEventListener(this.handleLoadProgress, this)
      this.applyZOffset()
      this.applyOpacity()
      this.applyClip()
      this.cb.onTilesetStatus("ready")
      this.flyCity(1.8)
    } catch (err) {
      console.error("三维模型加载失败", err)
      if (!this.destroyed) this.cb.onTilesetStatus("missing")
    }
  }

  private handleLoadProgress(pending: number, processing: number) {
    const now = performance.now()
    if (now - this.lastProgressEmit < 200 && pending + processing > 0) return
    this.lastProgressEmit = now
    this.cb.onTileProgress(pending, processing)
  }

  /** 重试加载瓦片（转换完成后调用） */
  reloadTileset() {
    if (this.tileset) return
    void this.tryLoadTileset()
  }

  private ringPositions(u: UnitFeature, height = 0): Cesium.Cartesian3[] {
    return u.ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat, height))
  }

  /** 选中单元的裁剪范围：ClippingPolygon 默认裁剪内部，inverse 后只保留内部 */
  private applyClip() {
    if (!this.tileset) return
    if (!this.clipEnabled || this.selected === null) {
      if (this.clipColl) this.clipColl.enabled = false
      return
    }
    const u = this.units.find((x) => x.unit === this.selected)
    if (!u) return
    if (!this.clipColl) {
      this.clipColl = new Cesium.ClippingPolygonCollection({ inverse: true })
      this.tileset.clippingPolygons = this.clipColl
    }
    this.clipColl.removeAll()
    this.clipColl.add(new Cesium.ClippingPolygon({ positions: this.ringPositions(u) }))
    this.clipColl.enabled = true
  }

  /** 选中态配色：选中单元高亮，其余单元在“仅高亮”模式下转为灰色，保留边界与填充 */
  private applyUnitStyles() {
    const muted = this.selected !== null && !this.clipEnabled
    for (const u of this.units) {
      const isSel = u.unit === this.selected
      const o = this.outlines.get(u.unit)
      const f = this.fills.get(u.unit)
      const l = this.labels.get(u.unit)
      const color = isSel ? SELECT_COLOR : muted ? "#8f959b" : GRADE_COLOR[u.grade]
      const css = Cesium.Color.fromCssColorString(color)
      if (o) {
        o.polyline!.material = new Cesium.ColorMaterialProperty(css.withAlpha(isSel ? 1 : muted ? 0.75 : 0.95))
        o.polyline!.width = new Cesium.ConstantProperty(isSel ? 3.2 : muted ? 1.3 : 1.6)
      }
      if (f) {
        const alpha = this.extruded ? (isSel ? 0.5 : muted ? 0.2 : 0.5) : isSel ? 0.34 : muted ? 0.12 : 0.26
        f.polygon!.extrudedHeight = this.extruded ? new Cesium.ConstantProperty(26) : undefined
        f.polygon!.material = new Cesium.ColorMaterialProperty(css.withAlpha(alpha))
      }
      if (l) {
        l.label!.fillColor = new Cesium.ConstantProperty(
          Cesium.Color.fromCssColorString(isSel ? "#ffffff" : muted ? "#c9ced3" : "#f0ead8"),
        )
      }
    }
  }

  /** “仅高亮”模式下用灰色遮罩压暗选中单元以外的场景（含模型与底图） */
  private updateWash() {
    if (this.wash) {
      this.viewer.entities.remove(this.wash)
      this.wash = null
    }
    if (this.editMode || this.selected === null || this.clipEnabled) return
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
        material: Cesium.Color.fromCssColorString("#6f757b").withAlpha(0.68),
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
    const positions = this.ringPositions(u)
    const f = this.fills.get(u.unit)
    if (f?.polygon) {
      f.polygon.hierarchy = new Cesium.ConstantProperty(new Cesium.PolygonHierarchy(positions))
    }
    const o = this.outlines.get(u.unit)
    if (o?.polyline) {
      o.polyline.positions = new Cesium.ConstantProperty(positions)
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

  selectUnit(unit: number | null) {
    // 再次点击同一单元视为取消
    if (unit !== null && unit === this.selected) unit = null
    if (this.selected === unit) return
    this.selected = unit
    if (unit !== null) {
      const u = this.units.find((x) => x.unit === unit)
      if (!u) {
        this.selected = null
        return
      }
      this.flyToUnit(u)
      // 等相机到位、瓦片渲染稳定后按真实模型表面重贴顶点
      window.setTimeout(() => {
        if (!this.destroyed && this.editMode && this.selected === u.unit) this.rebuildVertices()
      }, 1800)
    }
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
    this.applyZOffset()
    this.rebuildVertices()
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
    window.removeEventListener("keydown", this.onKeyDown)
    this.viewer.scene.preRender.removeEventListener(this.clampCameraPitch)
    this.viewer.scene.preRender.removeEventListener(this.updateGlobeVisibility)
    this.handler.destroy()
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
