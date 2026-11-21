import { APP_TITLE, APP_VERSION } from "@/config"
import type { BaseLayerKind } from "@/config"

interface Props {
  clipEnabled: boolean
  onClipEnabled: (b: boolean) => void
  extruded: boolean
  onExtruded: (b: boolean) => void
  baseLayer: BaseLayerKind
  onBaseLayer: (k: BaseLayerKind) => void
  onHome: () => void
  selected: number | null
  onClear: () => void
}

function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 h-7 text-xs rounded-md transition-colors duration-150 cursor-pointer whitespace-nowrap ${
        active ? "bg-cinnabar text-paper" : "text-sand/80 hover:text-paper hover:bg-ink-700"
      }`}
    >
      {children}
    </button>
  )
}

export function TopBar(p: Props) {
  return (
    <header className="h-14 shrink-0 flex items-center gap-4 px-4 bg-ink-900/95 backdrop-blur border-b border-ink-700">
      <div className="flex items-center gap-2.5 min-w-0">
        <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
          <rect x="2" y="2" width="22" height="22" rx="3" fill="none" stroke="#d4452c" strokeWidth="1.6" />
          <path d="M7 18 L7 10 L13 6 L19 10 L19 18" fill="none" stroke="#e9e4d6" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M10.5 18 v-4 h5 v4" fill="none" stroke="#d4452c" strokeWidth="1.4" />
        </svg>
        <h1 className="font-serif2 text-lg tracking-wide text-paper truncate">{APP_TITLE}</h1>
        <span className="hidden md:inline text-[10px] text-sand/50 border border-ink-600 rounded px-1.5 py-0.5">
          {APP_VERSION}
        </span>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-1 bg-ink-850 border border-ink-700 rounded-lg p-0.5" role="group" aria-label="显示模式">
        <SegBtn active={!p.clipEnabled} onClick={() => p.onClipEnabled(false)}>仅高亮</SegBtn>
        <SegBtn active={p.clipEnabled} onClick={() => p.onClipEnabled(true)}>分单元裁剪</SegBtn>
      </div>

      <div className="flex items-center gap-1 bg-ink-850 border border-ink-700 rounded-lg p-0.5" role="group" aria-label="底图">
        <SegBtn active={p.baseLayer === "satellite"} onClick={() => p.onBaseLayer("satellite")}>卫星影像</SegBtn>
        <SegBtn active={p.baseLayer === "osm"} onClick={() => p.onBaseLayer("osm")}>街道底图</SegBtn>
        <SegBtn active={p.baseLayer === "none"} onClick={() => p.onBaseLayer("none")}>无底图</SegBtn>
      </div>

      <button
        onClick={() => p.onExtruded(!p.extruded)}
        className={`h-8 px-3 text-xs rounded-lg border transition-colors duration-150 cursor-pointer whitespace-nowrap ${
          p.extruded
            ? "bg-ink-700 border-ink-600 text-paper"
            : "border-ink-700 text-sand/80 hover:text-paper"
        }`}
      >
        体量预览
      </button>

      <button
        onClick={p.onHome}
        className="h-8 px-3 text-xs rounded-lg border border-ink-700 text-sand/80 hover:text-paper transition-colors duration-150 cursor-pointer whitespace-nowrap"
      >
        回到全城
      </button>

      {p.selected !== null && (
        <button
          onClick={p.onClear}
          className="h-8 px-3 text-xs rounded-lg bg-cinnabar/15 border border-cinnabar/50 text-cinnabar hover:bg-cinnabar hover:text-paper transition-colors duration-150 cursor-pointer whitespace-nowrap"
        >
          取消选择（{String(p.selected).padStart(2, "0")}）
        </button>
      )}
    </header>
  )
}
