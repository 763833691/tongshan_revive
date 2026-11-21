import { useState } from "react"

interface Props {
  selected: number | null
  drawing: boolean
  onExit: () => void
  onSave: () => void
  onRevert: () => void
  onReset: () => void
  onDelete: () => void
  onStartDrawing: () => void
  onFinishDrawing: () => void
  onCancelDrawing: () => void
  onExport: () => void
  onTool: (tool: "drag" | "add" | "delete") => void
  onUndo: () => void
}

type Tool = "drag" | "add" | "delete"

function Btn({
  onClick,
  children,
  tone = "default",
  active = false,
}: {
  onClick: () => void
  children: React.ReactNode
  tone?: "default" | "primary" | "danger"
  active?: boolean
}) {
  const cls = active
    ? "bg-cinnabar border-cinnabar text-paper"
    : tone === "primary"
      ? "bg-cinnabar/20 border-cinnabar/60 text-cinnabar hover:bg-cinnabar hover:text-paper"
      : tone === "danger"
        ? "bg-ink-800 border-red-500/40 text-red-300 hover:bg-red-500/20"
        : "bg-ink-800 border-ink-600 text-sand/80 hover:text-paper hover:border-sand/40"
  return (
    <button
      onClick={onClick}
      className={`h-7 px-2.5 rounded-md border text-[11px] transition-colors cursor-pointer whitespace-nowrap ${cls}`}
    >
      {children}
    </button>
  )
}

export function EditorPanel(p: Props) {
  const [saved, setSaved] = useState(false)
  const [tool, setTool] = useState<Tool>("drag")
  const pickTool = (t: Tool) => {
    setTool(t)
    p.onTool(t)
  }
  return (
    <div className="absolute left-3 bottom-12 z-20 w-[330px] rounded-xl bg-ink-900/95 backdrop-blur border border-ink-700 shadow-xl p-3 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-paper tracking-wide">边界编辑</span>
          <span className="text-[10px] text-sand/45">拖点 / 加点 / 删点</span>
        </div>
        <button
          onClick={p.onExit}
          aria-label="退出编辑"
          title="退出编辑（Esc）"
          className="w-6 h-6 rounded-md border border-ink-600 text-sand/70 hover:text-paper hover:border-cinnabar/60 cursor-pointer leading-none"
        >
          ×
        </button>
      </div>

      {p.drawing ? (
        <div className="space-y-2">
          <p className="text-[11px] leading-relaxed text-sand/70">
            在地图上依次点击边界点（至少 3 点），双击或右键完成；Esc 取消。
          </p>
          <div className="flex items-center gap-1.5">
            <Btn onClick={p.onFinishDrawing} tone="primary">
              完成新增
            </Btn>
            <Btn onClick={p.onCancelDrawing}>取消绘制</Btn>
          </div>
        </div>
      ) : p.selected !== null ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Btn onClick={() => pickTool("drag")} active={tool === "drag"}>
              拖拽
            </Btn>
            <Btn onClick={() => pickTool("add")} active={tool === "add"}>
              加点
            </Btn>
            <Btn onClick={() => pickTool("delete")} active={tool === "delete"}>
              删点
            </Btn>
            <div className="flex-1" />
            <Btn onClick={p.onUndo}>撤销</Btn>
          </div>
          <p className="text-[11px] leading-relaxed text-sand/70">
            {tool === "drag"
              ? "拖拽白点移动边界；与相邻单元共用的顶点会同步移动。"
              : tool === "add"
                ? "点击边界线附近，会在最近的线段上插入顶点；相邻单元同步加点和变形。"
                : "点击白点删除顶点（至少保留 3 点）；相邻单元的同名顶点同步删除。"}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Btn
              onClick={() => {
                p.onSave()
                setSaved(true)
                window.setTimeout(() => setSaved(false), 1800)
              }}
              tone="primary"
            >
              {saved ? "已保存 ✓" : "保存修改"}
            </Btn>
            <Btn onClick={p.onRevert}>撤销未保存</Btn>
            <Btn onClick={p.onDelete} tone="danger">
              删除单元
            </Btn>
          </div>
          <p className="text-[10px] text-sand/40">共享边界双向同步：改动会同时写入相邻单元。</p>
        </div>
      ) : (
        <p className="text-[11px] leading-relaxed text-sand/70">
          先在地图或左侧列表选择一个单元进行编辑，也可以直接新增区域。
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-ink-700/70">
        <Btn onClick={p.onStartDrawing}>+ 新增区域</Btn>
        <Btn onClick={p.onExport}>导出 GeoJSON</Btn>
        <Btn onClick={p.onReset} tone="danger">
          恢复原始边界
        </Btn>
      </div>
      <p className="text-[10px] text-sand/40 leading-relaxed">
        修改保存在本机浏览器；交付时用「导出 GeoJSON」替换 <code>public/data/units.geojson</code>。
      </p>
    </div>
  )
}
