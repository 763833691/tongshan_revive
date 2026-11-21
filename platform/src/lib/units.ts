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
  const gj = (await res.json()) as { features: GeoJsonFeature[] }
  return gj.features.map((f) => {
    const ring = f.geometry.coordinates[0] as [number, number][]
    let sx = 0
    let sy = 0
    let west = Number.POSITIVE_INFINITY
    let south = Number.POSITIVE_INFINITY
    let east = Number.NEGATIVE_INFINITY
    let north = Number.NEGATIVE_INFINITY
    // 去掉闭合重复点参与质心/包络计算
    const pts = ring.slice(0, ring.length - 1)
    for (const [x, y] of pts) {
      sx += x
      sy += y
      if (x < west) west = x
      if (x > east) east = x
      if (y < south) south = y
      if (y > north) north = y
    }
    return {
      unit: f.properties.unit,
      name: f.properties.name,
      areaHa: f.properties.area_ha,
      grade: f.properties.grade,
      ring,
      centroid: [sx / pts.length, sy / pts.length],
      perimeterM: ringPerimeterMeters(ring),
      bbox: { west, south, east, north },
    }
  })
}
