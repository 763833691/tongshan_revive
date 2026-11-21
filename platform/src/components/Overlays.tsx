import { useState } from "react"
import { GRADE_META, OSM_CREDIT, SATELLITE_CREDIT, type BaseLayerKind } from "@/config"
import type { MeasureMode, MeasureState, TilesetStatus } from "@/cesium/PlatformController"
import { formatArea, formatDistance } from "@/cesium/PlatformController"

/* ---------- 底部状态栏 ---------- */
export function StatusBar({
  status,
  pending,
  processing,
  baseLayer,
}: {
  status: TilesetStatus
  pending: number
  processing: number
  baseLayer: BaseLayerKind
}) {
  const text =
    status === "loading"
      ? "模型加载中…"
      : status === "ready"
        ? processing > 0 || pending > 0
          ? `模型已加载 · 调度中 ${processing} · 排队 ${pending}`
          : "模型已加载"
        : status === "missing"
          ? "未找到三维模型"
          : "模型加载失败"
  return (
    <div className="absolute bottom-3 left-3 flex items-center gap-3 px-3 h-8 rounded-lg bg-ink-900/90 backdrop-blur border border-ink-700 text-[11px] text-sand/80 pointer-events-none">
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          status === "ready" ? "bg-grade3" : status === "loading" ? "bg-grade2 animate-pulse" : "bg-cinnabar"
        }`}
        aria-hidden
      />
      <span>{text}</span>
      <span className="text-sand/35">
        {baseLayer === "satellite" ? SATELLITE_CREDIT : baseLayer === "osm" ? OSM_CREDIT : "无底图"}
      </span>
    </div>
  )
}

/* ---------- 图例 ---------- */
export function LegendCard() {
  return (
    <div className="absolute bottom-3 right-3 px-3 py-2.5 rounded-lg bg-ink-900/90 backdrop-blur border border-ink-700 space-y-1.5 pointer-events-none">
      <p className="text-[10px] text-sand/50 tracking-widest">单元管控分级</p>
      {[1, 2, 3].map((g) => (
        <div key={g} className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: GRADE_META[g].color }} aria-hidden />
          <span className="text-[11px] text-sand/80">{GRADE_META[g].label}</span>
        </div>
      ))}
    </div>
  )
}

/* ---------- 显示设置：透明度 + 高程校准 ---------- */
export function DisplaySettings({
  opacity,
  onOpacity,
  zOffset,
  onZOffset,
}: {
  opacity: number
  onOpacity: (v: number) => void
  zOffset: number
  onZOffset: (v: number) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="absolute top-3 right-3 flex flex-col items-end gap-2">
      {open && (
        <div className="w-64 px-3 py-3 rounded-lg bg-ink-900/95 backdrop-blur border border-ink-700 space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-sand/50">模型不透明度</p>
              <span className="text-[11px] text-sand/80 tabular-nums">{Math.round(opacity * 100)}%</span>
            </div>
            <input
              type="range"
              min={5}
              max={100}
              step={5}
              value={Math.round(opacity * 100)}
              onChange={(e) => onOpacity(Number(e.target.value) / 100)}
              className="w-full accent-[#d4452c]"
              aria-label="模型不透明度"
            />
            <p className="text-[10px] text-sand/35 leading-relaxed">降低不透明度可透看单元边界与建筑基底。</p>
          </div>
          <div className="h-px bg-ink-700" />
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-sand/50">模型高程偏移</p>
              <span className="text-[11px] text-sand/80 tabular-nums">{zOffset.toFixed(1)} m</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={-100}
                max={100}
                step={1}
                value={zOffset}
                onChange={(e) => onZOffset(Number(e.target.value))}
                className="flex-1 accent-[#d4452c]"
                aria-label="模型高程偏移"
              />
              <button
                onClick={() => onZOffset(0)}
                className="text-[11px] px-2 h-6 rounded border border-ink-600 text-sand/70 hover:text-paper cursor-pointer transition-colors"
              >
                归零
              </button>
            </div>
            <p className="text-[10px] text-sand/35 leading-relaxed">实测模型地表低于椭球面约 30 m，默认抬升 +30 m 落地；此滑杆用于后续数据复查。</p>
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen(!open)}
        className={`h-8 px-3 text-xs rounded-lg backdrop-blur border transition-colors cursor-pointer ${
          open
            ? "bg-ink-700 border-ink-600 text-paper"
            : "bg-ink-900/90 border-ink-700 text-sand/80 hover:text-paper"
        }`}
      >
        显示设置
      </button>
    </div>
  )
}

/* ---------- 测量工具 ---------- */
export function MeasureBar({
  mode,
  state,
  onMode,
  onFinish,
  onClear,
}: {
  mode: MeasureMode
  state: MeasureState
  onMode: (m: MeasureMode) => void
  onFinish: () => void
  onClear: () => void
}) {
  const readout =
    mode === "distance"
      ? formatDistance(state.distanceM)
      : mode === "area"
        ? formatArea(state.areaM2)
        : ""
  const canFinish = mode === "distance" ? state.points >= 2 : mode === "area" ? state.points >= 3 : false
  return (
    <div className="absolute top-3 left-3 flex items-center gap-1.5 pl-1.5 pr-2 h-10 rounded-lg bg-ink-900/95 backdrop-blur border border-ink-700">
      <span className="text-[10px] text-sand/45 tracking-widest pr-1">测量</span>
      <ToolBtn active={mode === "distance"} onClick={() => onMode(mode === "distance" ? "none" : "distance")}>
        距离
      </ToolBtn>
      <ToolBtn active={mode === "area"} onClick={() => onMode(mode === "area" ? "none" : "area")}>
        面积
      </ToolBtn>
      {mode !== "none" && (
        <>
          <span className="w-px h-5 bg-ink-700 mx-0.5" aria-hidden />
          <span className="text-[11px] text-sand/75 tabular-nums min-w-[76px] text-right">
            {readout || "点击取点"}
          </span>
          <span className="text-[10px] text-sand/35 tabular-nums">{state.points} 点</span>
          <button
            onClick={onFinish}
            disabled={!canFinish || state.finished}
            className={`h-7 px-2.5 text-[11px] rounded-md transition-colors ${
              canFinish && !state.finished
                ? "bg-cinnabar text-paper hover:opacity-90 cursor-pointer"
                : "text-sand/30 border border-ink-700 cursor-not-allowed"
            }`}
          >
            完成
          </button>
          <button
            onClick={onClear}
            className="h-7 px-2 text-[11px] rounded-md border border-ink-700 text-sand/70 hover:text-paper transition-colors cursor-pointer"
          >
            清除
          </button>
        </>
      )}
    </div>
  )
}

function ToolBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`h-7 px-2.5 text-[11px] rounded-md transition-colors cursor-pointer ${
        active ? "bg-cinnabar text-paper" : "text-sand/75 hover:text-paper hover:bg-ink-800"
      }`}
    >
      {children}
    </button>
  )
}

/* ---------- 模型缺失指引 ---------- */
export function HelpOverlay({ status, onRetry }: { status: TilesetStatus; onRetry: () => void }) {
  const [collapsed, setCollapsed] = useState(false)
  if (status !== "missing" && status !== "error") return null
  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="absolute top-16 left-1/2 -translate-x-1/2 h-8 px-3 text-xs rounded-lg bg-ink-900/90 border border-ink-700 text-sand/80 hover:text-paper cursor-pointer"
      >
        如何接入三维模型？
      </button>
    )
  }
  return (
    <div className="absolute top-16 left-1/2 -translate-x-1/2 w-[480px] max-w-[92vw] rounded-xl bg-ink-900/95 backdrop-blur border border-ink-600 p-4 shadow-2xl">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-serif2 text-sm text-paper">
          {status === "missing" ? "尚未检测到三维模型" : "三维模型加载失败"}
        </h3>
        <button onClick={() => setCollapsed(true)} className="text-sand/50 hover:text-paper text-xs cursor-pointer">
          收起
        </button>
      </div>
      <ol className="text-xs text-sand/80 space-y-1.5 leading-relaxed list-decimal list-inside">
        <li>
          确认 <code className="text-paper bg-ink-800 px-1 rounded">public\3dtiles\tongshan\tileset.json</code>{" "}
          存在（本机已放置 12 GB 转换产物）；
        </li>
        <li>
          若重新转换：先用 <code className="text-paper bg-ink-800 px-1 rounded">3dtile.exe -f osgb -i scene -o platform\public\3dtiles\tongshan</code>{" "}
          处理 DJI Terra OSGB；
        </li>
        <li>
          也可用 <code className="text-paper bg-ink-800 px-1 rounded">?tileset=http://…/tileset.json</code>{" "}
          指定远程地址（需服务端 CORS）。
        </li>
      </ol>
      <button
        onClick={onRetry}
        className="mt-3 h-8 px-4 text-xs rounded-lg bg-cinnabar text-paper hover:opacity-90 transition-opacity cursor-pointer"
      >
        重试加载
      </button>
    </div>
  )
}
