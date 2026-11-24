import type { BuildingStatus } from "@/config"
import { normalizeRing } from "@/lib/units"

export interface BuildingFeature {
  /** CAD 句柄，跨重新提取保持稳定，用于持久化审核结果 */
  id: string
  /** 人类可读序号（0001…） */
  code: string
  ring: [number, number][]
  /** 用于裁剪的外扩基底（约 +0.8 m），避免切掉出檐；无则为 ring */
  clipRing: [number, number][]
  centroid: [number, number]
  bbox: { west: number; south: number; east: number; north: number }
  areaM2: number
  perimeterM: number
  verts: number
  /** 所属保护更新单元；范围外为 null */
  unit: number | null
  flags: string[]
  layer: string
  cadHandle: string
}

export const BUILDING_FLAG_LABEL: Record<string, string> = {
  small: "面积偏小",
  large: "面积偏大",
  complex: "轮廓复杂",
  outside: "不在单元内",
}

interface RawBuildingFeature {
  properties: {
    id?: string
    code?: string
    area_m2?: number
    perimeter_m?: number
    verts?: number
    unit?: number | null
    flags?: string[]
    layer?: string
    cad_handle?: string
    centroid?: [number, number]
    bbox?: number[]
    clip_ring?: number[][]
  }
  geometry: { type: string; coordinates: number[][][] | number[][][][] }
}

export interface BuildingGeoJson {
  type: string
  features: RawBuildingFeature[]
}

export function buildingsFromGeoJson(gj: BuildingGeoJson): BuildingFeature[] {
  const out: BuildingFeature[] = []
  for (const f of gj.features ?? []) {
    const p = f.properties ?? {}
    const id = p.id ?? p.cad_handle
    if (!id) continue
    const coords = f.geometry?.type === "Polygon" ? (f.geometry.coordinates as number[][][])[0] : null
    if (!coords || coords.length < 3) continue
    const ring = normalizeRing(coords.map(([lon, lat]) => [lon, lat] as [number, number]))
    if (ring.length < 4) continue
    const clipRing =
      p.clip_ring && p.clip_ring.length >= 3
        ? normalizeRing(p.clip_ring.map(([lon, lat]) => [lon, lat] as [number, number]))
        : ring
    const bbox = p.bbox && p.bbox.length >= 4 ? p.bbox : null
    const lons = ring.map((c) => c[0])
    const lats = ring.map((c) => c[1])
    out.push({
      id,
      code: p.code ?? id,
      ring,
      clipRing,
      centroid: p.centroid ?? [
        (Math.min(...lons) + Math.max(...lons)) / 2,
        (Math.min(...lats) + Math.max(...lats)) / 2,
      ],
      bbox: bbox
        ? { west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] }
        : { west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) },
      areaM2: p.area_m2 ?? 0,
      perimeterM: p.perimeter_m ?? 0,
      verts: p.verts ?? ring.length,
      unit: p.unit ?? null,
      flags: Array.isArray(p.flags) ? p.flags : [],
      layer: p.layer ?? "",
      cadHandle: p.cad_handle ?? id,
    })
  }
  return out
}

export async function loadBuildings(url: string): Promise<BuildingFeature[]> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`建筑基底数据加载失败: ${res.status}`)
  return buildingsFromGeoJson((await res.json()) as BuildingGeoJson)
}

export interface BuildingCounts {
  pending: number
  confirmed: number
  rejected: number
}

export function countBuildings(buildings: BuildingFeature[], statuses: Record<string, BuildingStatus>): BuildingCounts {
  let confirmed = 0
  let rejected = 0
  for (const b of buildings) {
    const s = statuses[b.id]
    if (s === "confirmed") confirmed++
    else if (s === "rejected") rejected++
  }
  return { confirmed, rejected, pending: buildings.length - confirmed - rejected }
}

export function buildingStatusOf(
  id: string,
  statuses: Record<string, BuildingStatus>,
): BuildingStatus {
  return statuses[id] ?? "pending"
}

/** 导出审核结果：默认只导出已确认建筑，可附加审核状态供复核 */
export function buildingsToGeoJson(
  buildings: BuildingFeature[],
  statuses: Record<string, BuildingStatus>,
  opts: { onlyConfirmed: boolean },
): string {
  const features = buildings
    .filter((b) => !opts.onlyConfirmed || statuses[b.id] === "confirmed")
    .map((b) => ({
      type: "Feature" as const,
      properties: {
        id: b.id,
        code: b.code,
        area_m2: b.areaM2,
        perimeter_m: b.perimeterM,
        verts: b.verts,
        unit: b.unit,
        layer: b.layer,
        cad_handle: b.cadHandle,
        flags: b.flags,
        status: buildingStatusOf(b.id, statuses),
      },
      geometry: { type: "Polygon" as const, coordinates: [b.ring] },
    }))
  return JSON.stringify(
    {
      type: "FeatureCollection",
      crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::4326" } },
      features,
    },
    null,
    2,
  )
}
