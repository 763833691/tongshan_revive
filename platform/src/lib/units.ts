// 单元数据类型与加载
export interface UnitFeature {
  unit: number
  name: string
  areaHa: number
  grade: 1 | 2 | 3
  /** [lon, lat] 闭合环（末点=首点） */
  ring: [number, number][]
  centroid: [number, number]
  /** 周长（米），由经纬度环按球面距离累计 */
  perimeterM: number
  bbox: { west: number; south: number; east: number; north: number }
}

interface GeoJsonFeature {
  properties: { unit: number; name: string; area_ha: number; grade: 1 | 2 | 3 }
  geometry: { coordinates: number[][][] }
}

export interface UnitGeoJson {
  type: string
  features: GeoJsonFeature[]
}

export const UNITS_STORAGE_KEY = "tongshan.units.v1"

export function unitsFromGeoJson(gj: UnitGeoJson): UnitFeature[] {
  return gj.features.map((f) => {
    const ring = normalizeRing(f.geometry.coordinates[0] as [number, number][])
    return {
      unit: f.properties.unit,
      name: f.properties.name,
      grade: f.properties.grade,
      ring,
      ...computeUnitMetrics(ring),
    }
  })
}

export function loadStoredUnits(): UnitFeature[] | null {
  try {
    const raw = localStorage.getItem(UNITS_STORAGE_KEY)
    if (!raw) return null
    const gj = JSON.parse(raw) as UnitGeoJson
    if (!gj?.features?.length) return null
    return unitsFromGeoJson(gj)
  } catch {
    return null
  }
}

export function storeUnits(units: UnitFeature[]) {
  localStorage.setItem(UNITS_STORAGE_KEY, JSON.stringify(unitsToGeoJson(units)))
}

export function clearStoredUnits() {
  localStorage.removeItem(UNITS_STORAGE_KEY)
}

const EARTH_RADIUS = 6371008.8

export function haversineMeters(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180
  const dLat = (b[1] - a[1]) * toRad
  const dLon = (b[0] - a[0]) * toRad
  const lat1 = a[1] * toRad
  const lat2 = b[1] * toRad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function ringPerimeterMeters(ring: [number, number][]): number {
  let total = 0
  for (let i = 1; i < ring.length; i++) total += haversineMeters(ring[i - 1], ring[i])
  if (ring.length > 2) total += haversineMeters(ring[ring.length - 1], ring[0])
  return total
}

/** 射线法判断点是否在多边形内（经纬度环） */
export function pointInRing(lon: number, lat: number, ring: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

export async function loadUnits(url: string): Promise<UnitFeature[]> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`单元数据加载失败: ${res.status}`)
  return unitsFromGeoJson((await res.json()) as UnitGeoJson)
}

/** 保证环闭合（末点=首点） */
export function normalizeRing(points: [number, number][]): [number, number][] {
  const pts = points.filter((p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1])
  if (!pts.length) return []
  const first = pts[0]
  const last = pts[pts.length - 1]
  return first[0] === last[0] && first[1] === last[1] ? pts : [...pts, [first[0], first[1]]]
}

/** 球面/局部平面近似的面积（公顷），仅用于编辑后重算 */
export function ringAreaHa(ring: [number, number][]): number {
  const pts = ring.slice(0, Math.max(0, ring.length - 1))
  if (pts.length < 3) return 0
  const lat0 = pts.reduce((s, p) => s + p[1], 0) / pts.length
  const mPerDegLat = 111132.92
  const mPerDegLon = 111320 * Math.cos((lat0 * Math.PI) / 180)
  let area2 = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    area2 += x1 * mPerDegLon * (y2 * mPerDegLat) - x2 * mPerDegLon * (y1 * mPerDegLat)
  }
  return Math.abs(area2 / 2) / 10000
}

/** 编辑后重算质心、周长、面积、包络 */
export function computeUnitMetrics(ring: [number, number][]) {
  const closed = normalizeRing(ring)
  const pts = closed.slice(0, Math.max(0, closed.length - 1))
  let sx = 0
  let sy = 0
  let west = Number.POSITIVE_INFINITY
  let south = Number.POSITIVE_INFINITY
  let east = Number.NEGATIVE_INFINITY
  let north = Number.NEGATIVE_INFINITY
  for (const [x, y] of pts) {
    sx += x
    sy += y
    if (x < west) west = x
    if (x > east) east = x
    if (y < south) south = y
    if (y > north) north = y
  }
  return {
    areaHa: ringAreaHa(closed),
    centroid: [(sx / pts.length) as number, (sy / pts.length) as number] as [number, number],
    perimeterM: ringPerimeterMeters(closed),
    bbox: { west, south, east, north },
  }
}

/** 导出为可回写的 GeoJSON（properties 字段与导入一致） */
export function unitsToGeoJson(units: UnitFeature[]) {
  return {
    type: "FeatureCollection",
    features: units.map((u) => ({
      type: "Feature",
      properties: {
        unit: u.unit,
        name: u.name,
        area_ha: Number(u.areaHa.toFixed(3)),
        grade: u.grade,
      },
      geometry: { type: "Polygon", coordinates: [u.ring] },
    })),
  }
}
