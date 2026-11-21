import { useMemo, useState } from "react"
import type { UnitFeature } from "@/lib/units"
import { GRADE_META } from "@/config"

interface Props {
  units: UnitFeature[]
  selected: number | null
  onSelect: (unit: number) => void
  loaded: boolean
}

type GradeFilter = 0 | 1 | 2 | 3

export function UnitPanel({ units, selected, onSelect, loaded }: Props) {
  const [kw, setKw] = useState("")
  const [grade, setGrade] = useState<GradeFilter>(0)

  const filtered = useMemo(() => {
    const q = kw.trim()
    return units.filter((u) => {
      if (grade !== 0 && u.grade !== grade) return false
      if (!q) return true
      return u.name.includes(q) || String(u.unit) === q
    })
  }, [units, kw, grade])

  const total = units.length
  const selectedUnit = selected !== null ? units.find((u) => u.unit === selected) : null

  return (
    <aside className="w-[300px] shrink-0 flex flex-col bg-ink-900/95 backdrop-blur border-r border-ink-700">
      <div className="p-3 border-b border-ink-700 space-y-2.5">
        <div className="flex items-baseline justify-between">
          <h2 className="font-serif2 text-sm text-paper tracking-widest">保护更新单元</h2>
          <span className="text-[11px] text-sand/50">{loaded ? `${total} 个单元` : "加载中…"}</span>
        </div>
        <input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          placeholder="搜索单元编号，如 08"
          className="w-full h-8 px-2.5 text-xs bg-ink-850 border border-ink-700 rounded-lg text-paper placeholder:text-sand/40 outline-none focus:border-cinnabar/70 transition-colors"
        />
        <div className="flex gap-1.5">
          {([0, 1, 2, 3] as const).map((g) => (
            <button
              key={g}
              onClick={() => setGrade(g)}
              className={`flex-1 h-7 text-[11px] rounded-md border transition-colors duration-150 cursor-pointer ${
                grade === g
                  ? "border-cinnabar/70 bg-cinnabar/15 text-paper"
                  : "border-ink-700 text-sand/70 hover:text-paper"
              }`}
            >
              {g === 0 ? "全部" : `${["", "一", "二", "三"][g]}级`}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filtered.map((u) => {
          const active = u.unit === selected
          return (
            <button
              key={u.unit}
              onClick={() => onSelect(u.unit)}
              className={`w-full flex items-center gap-2.5 px-2.5 h-10 rounded-lg text-left transition-colors duration-150 cursor-pointer ${
                active ? "bg-ink-700 border border-cinnabar/60" : "hover:bg-ink-800 border border-transparent"
              }`}
            >
              <span
                className="w-2.5 h-2.5 rounded-sm shrink-0"
                style={{ background: GRADE_META[u.grade].color }}
                aria-hidden
              />
              <span className={`font-serif2 text-sm w-8 ${active ? "text-cinnabar" : "text-paper"}`}>
                {String(u.unit).padStart(2, "0")}
              </span>
              <span className="flex-1 text-xs text-sand/80 truncate">{GRADE_META[u.grade].label}</span>
              <span className="text-[11px] text-sand/50 tabular-nums">{u.areaHa.toFixed(2)} ha</span>
            </button>
          )
        })}
        {filtered.length === 0 && (
          <p className="text-xs text-sand/40 text-center py-8">没有匹配的单元</p>
        )}
      </div>

      {selectedUnit && (
        <div className="p-3 border-t border-ink-700 max-h-[46%] overflow-y-auto">
          <div className="rounded-lg bg-ink-850 border border-ink-700 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-serif2 text-base text-paper">{selectedUnit.name}</span>
              <span
                className="text-[10px] px-1.5 py-0.5 rounded shrink-0"
                style={{
                  color: GRADE_META[selectedUnit.grade].color,
                  border: `1px solid ${GRADE_META[selectedUnit.grade].color}55`,
                }}
              >
                {GRADE_META[selectedUnit.grade].label}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <Stat label="占地面积" value={`${selectedUnit.areaHa.toFixed(2)} 公顷`} />
              <Stat label="边界周长" value={`${selectedUnit.perimeterM.toFixed(0)} m`} />
            </div>

            <div className="space-y-1 pt-1">
              <Row label="单元中心">
                {selectedUnit.centroid[0].toFixed(6)}, {selectedUnit.centroid[1].toFixed(6)}
              </Row>
              <Row label="外接范围">
                {selectedUnit.bbox.west.toFixed(5)}–{selectedUnit.bbox.east.toFixed(5)}
                <br />
                {selectedUnit.bbox.south.toFixed(5)}–{selectedUnit.bbox.north.toFixed(5)}
              </Row>
              <Row label="数据来源">CAD 单元边界 · EPSG:4548 → WGS84</Row>
            </div>

            <div className="rounded-md border border-dashed border-ink-600 px-2.5 py-2">
              <p className="text-[10px] text-sand/45 leading-relaxed">
                档案字段（四至描述、责任主体、现状照片、修缮记录）待业务方录入；当前版本展示空间位置、面积与管控分级。
              </p>
            </div>

            <p className="text-[10px] text-sand/35 leading-relaxed">
              单元编号按面积与方位从规划图推定，投入使用前需与规划方核对（08/11 号仅靠面积区分）。
            </p>
          </div>
        </div>
      )}
    </aside>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-ink-800/70 px-2 py-1.5">
      <p className="text-[9px] text-sand/40">{label}</p>
      <p className="text-[12px] text-paper tabular-nums">{value}</p>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[10px] leading-relaxed">
      <span className="text-sand/40 w-14 shrink-0">{label}</span>
      <span className="text-sand/75 tabular-nums">{children}</span>
    </div>
  )
}
