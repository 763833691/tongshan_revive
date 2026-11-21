import * as Cesium from "cesium"
import "cesium/Build/Cesium/Widgets/widgets.css"
import {
  CAMERA_MIN_PITCH_DEG,
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
import { loadUnits, pointInRing, type UnitFeature } from "@/lib/units"

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

export interface ControllerCallbacks {
  onUnitsLoaded: (units: UnitFeature[]) => void
  onTilesetStatus: (status: TilesetStatus) => void
  onTileProgress: (pending: number, processing: number) => void
  onSelectChange: (unit: number | null) => void
  onMeasureChange: (state: MeasureState) => void
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
  private clipEnabled = true
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
    this.handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      if (this.measureMode !== "none" && !this.measureFinished) {
        this.addMeasurePoint(e.position)
        return
      }
      this.selectUnit(this.pickUnitAt(e.position))
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    this.handler.setInputAction((e: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      const canvas = this.viewer.scene.canvas
      if (this.measureMode !== "none" && !this.measureFinished) {
        canvas.style.cursor = "crosshair"
        return
      }
      const picked = this.viewer.scene.pick(e.endPosition)
      canvas.style.cursor = picked?.id instanceof Cesium.Entity ? "pointer" : "default"
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE)
    this.viewer.scene.preRender.addEventListener(this.clampCameraPitch)
  }

  async init() {
    this.flyCity(0)
    try {
      this.units = await loadUnits(UNITS_URL)
    } catch (err) {
      console.error("单元数据加载失败", err)
      this.cb.onTilesetStatus("error")
      return
    }
    if (this.destroyed) return
    this.cb.onUnitsLoaded(this.units)
    this.addUnitEntities()
    await this.tryLoadTileset()
  }

  private addUnitEntities() {
    for (const u of this.units) {
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

  private styleUnit(unit: number, selected: boolean) {
    const u = this.units.find((x) => x.unit === unit)
    const o = this.outlines.get(unit)
    const f = this.fills.get(unit)
    if (!u) return
    const base = selected ? SELECT_COLOR : GRADE_COLOR[u.grade]
    if (o) {
      o.polyline!.material = new Cesium.ColorMaterialProperty(
        Cesium.Color.fromCssColorString(base).withAlpha(selected ? 1 : 0.95),
      )
      o.polyline!.width = new Cesium.ConstantProperty(selected ? 3.2 : 1.6)
    }
    if (f) {
      f.polygon!.material = new Cesium.ColorMaterialProperty(
        Cesium.Color.fromCssColorString(base).withAlpha(selected ? 0.34 : 0.26),
      )
    }
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
    if (this.selected === unit) return
    if (this.selected !== null) this.styleUnit(this.selected, false)
    this.selected = unit
    if (unit !== null) {
      const u = this.units.find((x) => x.unit === unit)
      if (!u) {
        this.selected = null
        return
      }
      this.styleUnit(unit, true)
      this.flyToUnit(u)
      this.applyClip()
    } else if (this.clipColl) {
      this.clipColl.enabled = false
      this.clipColl.removeAll()
    }
    this.cb.onSelectChange(unit)
  }

  setClipEnabled(enabled: boolean) {
    this.clipEnabled = enabled
    this.applyClip()
  }

  setExtruded(extruded: boolean) {
    for (const u of this.units) {
      const f = this.fills.get(u.unit)
      if (!f) continue
      const selected = u.unit === this.selected
      const base = selected ? SELECT_COLOR : GRADE_COLOR[u.grade]
      if (extruded) {
        f.polygon!.extrudedHeight = new Cesium.ConstantProperty(26)
        f.polygon!.material = new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString(base).withAlpha(0.5),
        )
      } else {
        f.polygon!.extrudedHeight = undefined
        f.polygon!.material = new Cesium.ColorMaterialProperty(
          Cesium.Color.fromCssColorString(base).withAlpha(selected ? 0.34 : 0.26),
        )
      }
    }
  }

  setZOffset(z: number) {
    this.zOffset = z
    this.applyZOffset()
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

  destroy() {
    this.destroyed = true
    this.viewer.scene.preRender.removeEventListener(this.clampCameraPitch)
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
