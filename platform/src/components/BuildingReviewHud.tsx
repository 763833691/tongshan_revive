import { BUILDING_STATUS_META, type BuildingStatus } from "@/config"
import type { BuildingFeature } from "@/lib/buildings"

interface Props {
  building: BuildingFeature
  status: BuildingStatus
  clipPreview: boolean
  onConfirm: () => void
  onReject: () => void
  onCancel: () => void
}

export function BuildingLegend() {
  return (
    <div className="absolute bottom-3 right-3 px-3 py-2.5 rounded-lg bg-ink-900/90 backdrop-blur border border-ink-700 space-y-1.5 pointer-events-none">
      <p className="text-[10px] text-sand/50 tracking-widest">建筑审核状态</p>
      {(["pending", "confirmed", "rejected"] as const).map((s) => (
        <div key={s} className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: BUILDING_STATUS_META[s].color }} aria-hidden />
          <span className="text-[11px] text-sand/80">{BUILDING_STATUS_META[s].label}</span>
        </div>
      ))}
      <p className="text-[10px] text-sand/35 pt-0.5">点位为建筑中心，点击可单独裁剪</p>
    </div>
  )
}

export function BuildingReviewHud({ building, status, clipPreview, onConfirm, onReject, onCancel }: Props) {
  const meta = BUILDING_STATUS_META[status]
  return (
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 h-12 px-3 rounded-xl bg-ink-900/95 backdrop-blur border border-ink-600 shadow-xl">
      <div className="flex items-baseline gap-2">
        <span className="font-serif2 text-sm text-paper">{building.code}</span>
        <span className="text-[10px]" style={{ color: meta.color }}>
          {meta.label}
        </span>
      </div>
      <div className="h-5 w-px bg-ink-700" aria-hidden />
      <span className="text-[11px] text-sand/75 tabular-nums">{building.areaM2.toFixed(1)} m²</span>
      <span className="text-[11px] text-sand/50">
        {building.unit !== null ? `${String(building.unit).padStart(2, "0")} 单元` : "范围外"}
      </span>
      <span className="text-[10px] text-sand/35 hidden lg:inline">{clipPreview ? "已按基底裁剪" : "未裁剪"}</span>
      <div className="h-5 w-px bg-ink-700" aria-hidden />
      <button
        onClick={onConfirm}
        disabled={status === "confirmed"}
        className="h-8 px-3 rounded-lg bg-[#5fbf8a] text-ink-950 text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
        title="确认保留（Enter）"
      >
        ✓ 确认
      </button>
      <button
        onClick={onReject}
        disabled={status === "rejected"}
        className="h-8 px-3 rounded-lg border border-red-500/50 text-red-300 text-xs hover:bg-red-500/15 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
        title="剔除（X）"
      >
        ✕ 剔除
      </button>
      <button
        onClick={onCancel}
        className="w-8 h-8 rounded-lg border border-ink-600 text-sand/70 hover:text-paper hover:border-sand/40 transition-colors cursor-pointer"
        title="取消预览（Esc）"
        aria-label="取消预览"
      >
        ×
      </button>
    </div>
  )
}
