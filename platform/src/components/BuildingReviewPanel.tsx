import { useMemo, useState } from "react"
import { BUILDING_STATUS_META, type BuildingStatus } from "@/config"
import {
  BUILDING_FLAG_LABEL,
  buildingStatusOf,
  type BuildingCounts,
  type BuildingFeature,
} from "@/lib/buildings"
import { cn } from "@/lib/utils"

type StatusFilter = "all" | BuildingStatus

interface Props {
  buildings: BuildingFeature[]
  statuses: Record<string, BuildingStatus>
  selected: string | null
  loading: boolean
  error: string | null
  counts: BuildingCounts
  clipPreview: boolean
  onClipPreview: (on: boolean) => void
  onSelect: (id: string | null) => void
  onConfirm: (id: string) => void
  onReject: (id: string) => void
  onBatch: (ids: string[], status: BuildingStatus) => void
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
  onUndo: () => void
  onRedo: () => void
  onReset: () => void
  onExportConfirmed: () => void
  onExportAll: () => void
  onExit: () => void
}

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "pending", label: "待审" },
  { key: "confirmed", label: "已确认" },
  { key: "rejected", label: "已剔除" },
]

function isSuspicious(b: BuildingFeature) {
  return b.flags.some((f) => f !== "outside")
}

function statusText(s: BuildingStatus) {
  return BUILDING_STATUS_META[s].label
}

export function BuildingReviewPanel(p: Props) {
  const [kw, setKw] = useState("")
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all")
  const [unitFilter, setUnitFilter] = useState<string>("all")
  const [onlySuspicious, setOnlySuspicious] = useState(false)
  const [autoNext, setAutoNext] = useState(true)

  const unitOptions = useMemo(() => {
    const set = new Set<number>()
    for (const b of p.buildings) if (b.unit !== null) set.add(b.unit)
    return [...set].sort((a, b) => a - b)
  }, [p.buildings])

  const filtered = useMemo(() => {
    const q = kw.trim().toLowerCase()
    return p.buildings.filter((b) => {
      if (unitFilter === "outside" ? b.unit !== null : unitFilter !== "all" && b.unit !== Number(unitFilter)) return false
      if (onlySuspicious && !isSuspicious(b)) return false
      const s = buildingStatusOf(b.id, p.statuses)
      if (statusFilter !== "all" && s !== statusFilter) return false
      if (!q) return true
      return b.code.includes(q) || b.id.toLowerCase().includes(q) || (b.unit !== null && String(b.unit).includes(q))
    })
  }, [p.buildings, p.statuses, kw, statusFilter, unitFilter, onlySuspicious])

  const selected = p.selected ? p.buildings.find((b) => b.id === p.selected) : null
  const selectedStatus = selected ? buildingStatusOf(selected.id, p.statuses) : "pending"

  const nextPending = (currentId: string) => {
    const idx = filtered.findIndex((b) => b.id === currentId)
    const after = filtered.slice(idx + 1).find((b) => buildingStatusOf(b.id, p.statuses) === "pending")
    if (after) return after.id
    const before = filtered.find((b) => b.id !== currentId && buildingStatusOf(b.id, p.statuses) === "pending")
    return before ? before.id : null
  }

  const act = (id: string, kind: "confirm" | "reject") => {
    if (kind === "confirm") p.onConfirm(id)
    else p.onReject(id)
    if (autoNext) p.onSelect(nextPending(id))
  }

  const step = (dir: -1 | 1) => {
    if (!selected) {
      if (filtered[0]) p.onSelect(filtered[0].id)
      return
    }
    const idx = filtered.findIndex((b) => b.id === selected.id)
    const next = filtered[idx + dir]
    if (next) p.onSelect(next.id)
  }

  const total = p.buildings.length
  const pct = (n: number) => (total ? (n / total) * 100 : 0)

  return (
    <aside className="w-[330px] shrink-0 flex flex-col bg-ink-900/95 backdrop-blur border-r border-ink-700 min-h-0">
      <div className="shrink-0 p-3 border-b border-ink-700 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <h2 className="font-serif2 text-sm text-paper tracking-widest">建筑分割审核</h2>
            <span className="text-[10px] text-sand/45">CAD 基底 · 自动保存</span>
          </div>
          <button
            onClick={p.onExit}
            title="退出建筑审核"
            aria-label="退出建筑审核"
            className="w-6 h-6 rounded-md border border-ink-600 text-sand/70 hover:text-paper hover:border-cinnabar/60 cursor-pointer leading-none"
          >
            ×
          </button>
        </div>

        <div className="flex items-baseline justify-between text-[11px]">
          <span className="text-sand/55">{p.loading ? "建筑数据加载中…" : `${total} 个候选块`}</span>
          <span className="tabular-nums">
            <span className="text-[#5fbf8a]">{p.counts.confirmed}</span>
            <span className="text-sand/30"> / </span>
            <span className="text-[#e0b25a]">{p.counts.pending}</span>
            <span className="text-sand/30"> / </span>
            <span className="text-[#8f959b]">{p.counts.rejected}</span>
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-ink-800 overflow-hidden flex" aria-hidden>
          <div style={{ width: `${pct(p.counts.confirmed)}%`, background: BUILDING_STATUS_META.confirmed.color }} />
          <div style={{ width: `${pct(p.counts.rejected)}%`, background: BUILDING_STATUS_META.rejected.color }} />
          <div style={{ width: `${pct(p.counts.pending)}%`, background: BUILDING_STATUS_META.pending.color }} />
        </div>
        <div className="flex items-center justify-between text-[10px] text-sand/40">
          <span>确认 / 待审 / 剔除</span>
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={p.clipPreview}
              onChange={(e) => p.onClipPreview(e.target.checked)}
              className="accent-[#d4452c]"
            />
            裁剪预览
          </label>
        </div>

        {p.error && (
          <p className="text-[10px] text-cinnabar/90 leading-relaxed">
            {p.error}。请确认 <code>public/data/buildings.geojson</code> 已生成。
          </p>
        )}

        <input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          placeholder="搜索编号 / 单元 / CAD 句柄"
          className="w-full h-8 px-2.5 text-xs bg-ink-850 border border-ink-700 rounded-lg text-paper placeholder:text-sand/40 outline-none focus:border-cinnabar/70 transition-colors"
        />

        <div className="flex gap-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={cn(
                "flex-1 h-7 text-[11px] rounded-md border transition-colors cursor-pointer",
                statusFilter === f.key
                  ? "border-cinnabar/70 bg-cinnabar/15 text-paper"
                  : "border-ink-700 text-sand/65 hover:text-paper",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex gap-1.5">
          <select
            value={unitFilter}
            onChange={(e) => setUnitFilter(e.target.value)}
            className="flex-1 h-7 px-1.5 text-[11px] bg-ink-850 border border-ink-700 rounded-md text-sand/80 outline-none focus:border-cinnabar/70 cursor-pointer"
            aria-label="按单元筛选"
          >
            <option value="all">全部单元</option>
            {unitOptions.map((u) => (
              <option key={u} value={u}>
                {String(u).padStart(2, "0")} 单元
              </option>
            ))}
            <option value="outside">范围外</option>
          </select>
          <button
            onClick={() => setOnlySuspicious(!onlySuspicious)}
            className={cn(
              "h-7 px-2 text-[11px] rounded-md border transition-colors cursor-pointer whitespace-nowrap",
              onlySuspicious
                ? "border-[#e0b25a]/70 bg-[#e0b25a]/15 text-[#e0b25a]"
                : "border-ink-700 text-sand/65 hover:text-paper",
            )}
            title="面积偏小/偏大、轮廓复杂等可疑项"
          >
            可疑项
          </button>
        </div>
        <div className="flex items-center justify-between text-[10px] text-sand/40">
          <span>
            筛选出 <span className="text-sand/75 tabular-nums">{filtered.length}</span> 栋
          </span>
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" checked={autoNext} onChange={(e) => setAutoNext(e.target.checked)} className="accent-[#d4452c]" />
            处理后自动下一栋
          </label>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-1.5 min-h-0">
        {p.loading && <p className="text-xs text-sand/40 text-center py-8">加载建筑基底…</p>}
        {!p.loading && filtered.length === 0 && (
          <p className="text-xs text-sand/40 text-center py-8">没有匹配的建筑</p>
        )}
        {filtered.map((b) => {
          const s = buildingStatusOf(b.id, p.statuses)
          const active = b.id === p.selected
          const meta = BUILDING_STATUS_META[s]
          return (
            <button
              key={b.id}
              onClick={() => p.onSelect(active ? null : b.id)}
              className={cn(
                "w-full flex items-center gap-2 px-2 h-9 rounded-md text-left transition-colors cursor-pointer border",
                active ? "bg-ink-700 border-cinnabar/60" : "border-transparent hover:bg-ink-800",
              )}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: s === "rejected" ? "#5b6268" : meta.color }}
                aria-hidden
              />
              <span className={cn("font-serif2 text-[12px] w-10 tabular-nums", active ? "text-cinnabar" : "text-paper")}>
                {b.code}
              </span>
              <span className="flex-1 text-[10px] text-sand/55 truncate">
                {b.unit !== null ? `${String(b.unit).padStart(2, "0")} 单元` : "范围外"}
                {isSuspicious(b) && <span className="text-[#e0b25a]"> · 可疑</span>}
              </span>
              <span className="text-[10px] text-sand/55 tabular-nums">{b.areaM2.toFixed(0)} m²</span>
              <span
                className="text-[9px] w-9 text-right shrink-0"
                style={{ color: s === "pending" ? "rgba(207,199,176,.5)" : meta.color }}
              >
                {statusText(s)}
              </span>
            </button>
          )
        })}
      </div>

      {selected && (
        <div className="shrink-0 border-t border-ink-700 p-3 space-y-2.5 max-h-[46%] overflow-y-auto">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-serif2 text-base text-paper">{selected.code}</span>
              <span
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{ color: BUILDING_STATUS_META[selectedStatus].color, border: `1px solid ${BUILDING_STATUS_META[selectedStatus].color}55` }}
              >
                {statusText(selectedStatus)}
              </span>
            </div>
            <button
              onClick={() => p.onSelect(null)}
              title="取消预览（Esc）"
              aria-label="取消预览"
              className="w-6 h-6 rounded-md border border-ink-600 text-sand/70 hover:text-paper hover:border-cinnabar/60 cursor-pointer leading-none"
            >
              ×
            </button>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            <Stat label="面积" value={`${selected.areaM2.toFixed(1)} m²`} />
            <Stat label="周长" value={`${selected.perimeterM.toFixed(1)} m`} />
            <Stat label="顶点" value={String(selected.verts)} />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <Stat label="所属单元" value={selected.unit !== null ? `${String(selected.unit).padStart(2, "0")} 单元` : "范围外"} />
            <Stat label="CAD 句柄" value={selected.cadHandle} />
          </div>

          {selected.flags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {selected.flags.map((f) => (
                <span
                  key={f}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-[#e0b25a]/35 text-[#e0b25a]/90"
                >
                  {BUILDING_FLAG_LABEL[f] ?? f}
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => act(selected.id, "confirm")}
              disabled={selectedStatus === "confirmed"}
              className={cn(
                "flex-1 h-8 text-xs rounded-md border transition-colors",
                selectedStatus === "confirmed"
                  ? "border-ink-700 text-sand/30 cursor-not-allowed"
                  : "bg-[#5fbf8a]/15 border-[#5fbf8a]/50 text-[#5fbf8a] hover:bg-[#5fbf8a] hover:text-ink-950 cursor-pointer",
              )}
            >
              ✓ 确认保留
            </button>
            <button
              onClick={() => act(selected.id, "reject")}
              disabled={selectedStatus === "rejected"}
              className={cn(
                "flex-1 h-8 text-xs rounded-md border transition-colors",
                selectedStatus === "rejected"
                  ? "border-ink-700 text-sand/30 cursor-not-allowed"
                  : "bg-ink-800 border-red-500/40 text-red-300 hover:bg-red-500/20 cursor-pointer",
              )}
            >
              ✕ 剔除
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <StepBtn onClick={() => step(-1)}>← 上一栋</StepBtn>
            <StepBtn onClick={() => step(1)}>下一栋 →</StepBtn>
            <div className="flex-1" />
            <button
              onClick={() => p.onSelect(null)}
              className="h-7 px-2 rounded-md border border-ink-600 text-[10px] text-sand/70 hover:text-paper cursor-pointer"
            >
              取消预览
            </button>
          </div>
          <p className="text-[10px] text-sand/35 leading-relaxed">
            确认或剔除都可撤销；选中后模型按该建筑基底裁剪（外扩 0.8 m 以免切掉出檐），只加金色描边、不覆盖原贴图。描边粗细在右上「显示设置」调整。快捷键：Enter 确认 · X 剔除 · Esc 取消 · Ctrl+Z 撤销。
          </p>
        </div>
      )}

      <div className="shrink-0 border-t border-ink-700 p-2.5 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <button
            onClick={p.onUndo}
            disabled={!p.canUndo}
            title={p.undoLabel ? `撤销：${p.undoLabel}` : "没有可撤销的操作"}
            className={cn(
              "flex-1 h-7 text-[11px] rounded-md border transition-colors",
              p.canUndo
                ? "border-ink-600 text-sand/85 hover:text-paper hover:border-sand/40 cursor-pointer"
                : "border-ink-800 text-sand/25 cursor-not-allowed",
            )}
          >
            ↶ 撤销{p.undoLabel ? `（${p.undoLabel}）` : ""}
          </button>
          <button
            onClick={p.onRedo}
            disabled={!p.canRedo}
            title={p.redoLabel ? `重做：${p.redoLabel}` : "没有可重做的操作"}
            className={cn(
              "h-7 px-2 text-[11px] rounded-md border transition-colors",
              p.canRedo ? "border-ink-600 text-sand/85 hover:text-paper cursor-pointer" : "border-ink-800 text-sand/25 cursor-not-allowed",
            )}
          >
            ↷ 重做
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => p.onBatch(filtered.map((b) => b.id), "confirmed")}
            disabled={filtered.length === 0}
            className="flex-1 h-7 text-[10px] rounded-md border border-[#5fbf8a]/40 text-[#5fbf8a]/90 hover:bg-[#5fbf8a]/15 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          >
            批量确认筛选（{filtered.length}）
          </button>
          <button
            onClick={() => p.onBatch(filtered.map((b) => b.id), "rejected")}
            disabled={filtered.length === 0}
            className="h-7 px-2 text-[10px] rounded-md border border-red-500/30 text-red-300/85 hover:bg-red-500/15 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          >
            批量剔除
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={p.onExportConfirmed}
            className="flex-1 h-7 text-[10px] rounded-md border border-ink-600 text-sand/85 hover:text-paper hover:border-sand/40 transition-colors cursor-pointer"
          >
            导出已确认
          </button>
          <button
            onClick={p.onExportAll}
            className="flex-1 h-7 text-[10px] rounded-md border border-ink-600 text-sand/85 hover:text-paper hover:border-sand/40 transition-colors cursor-pointer"
          >
            导出审核结果
          </button>
          <button
            onClick={p.onReset}
            className="h-7 px-2 text-[10px] rounded-md border border-ink-600 text-sand/55 hover:text-red-300 hover:border-red-500/40 transition-colors cursor-pointer"
            title="清空全部审核状态（可撤销）"
          >
            重置
          </button>
        </div>
      </div>
    </aside>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-ink-850 border border-ink-700 px-2 py-1.5 min-w-0">
      <p className="text-[9px] text-sand/40">{label}</p>
      <p className="text-[11px] text-paper tabular-nums truncate">{value}</p>
    </div>
  )
}

function StepBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="h-7 px-2 rounded-md border border-ink-600 text-[10px] text-sand/75 hover:text-paper hover:border-sand/40 transition-colors cursor-pointer"
    >
      {children}
    </button>
  )
}
