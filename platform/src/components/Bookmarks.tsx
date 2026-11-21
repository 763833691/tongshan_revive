import { useState } from "react"
import type { CameraView } from "@/cesium/PlatformController"

interface Bookmark {
  id: string
  name: string
  view: CameraView
  createdAt: number
}

const STORAGE_KEY = "tongshan.camera-bookmarks.v1"

function loadBookmarks(): Bookmark[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Bookmark[]
    return Array.isArray(parsed) ? parsed.slice(0, 20) : []
  } catch {
    return []
  }
}

function persist(list: Bookmark[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    /* storage 不可用时静默失败 */
  }
}

export function BookmarkPanel({
  defaultName,
  onCapture,
  onRestore,
}: {
  defaultName: string
  onCapture: () => CameraView
  onRestore: (view: CameraView) => void
}) {
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<Bookmark[]>(loadBookmarks)
  const [name, setName] = useState("")

  const save = () => {
    const label = name.trim() || defaultName
    const next = [
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: label, view: onCapture(), createdAt: Date.now() },
      ...list,
    ].slice(0, 20)
    setList(next)
    persist(next)
    setName("")
  }

  const remove = (id: string) => {
    const next = list.filter((b) => b.id !== id)
    setList(next)
    persist(next)
  }

  return (
    <div className="absolute bottom-28 right-3 flex flex-col items-end gap-2">
      {open && (
        <div className="w-64 rounded-lg bg-ink-900/95 backdrop-blur border border-ink-700 overflow-hidden">
          <div className="px-3 py-2.5 border-b border-ink-700 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-sand/50 tracking-widest">视角书签</p>
              <span className="text-[10px] text-sand/35">{list.length}/20</span>
            </div>
            <div className="flex gap-1.5">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save()
                }}
                maxLength={16}
                placeholder={defaultName}
                className="flex-1 min-w-0 h-7 px-2 text-[11px] bg-ink-850 border border-ink-700 rounded-md text-paper placeholder:text-sand/35 outline-none focus:border-cinnabar/70"
              />
              <button
                onClick={save}
                className="h-7 px-2.5 text-[11px] rounded-md bg-cinnabar text-paper hover:opacity-90 transition-opacity cursor-pointer shrink-0"
              >
                收藏
              </button>
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto p-1.5 space-y-1">
            {list.length === 0 && (
              <p className="text-[11px] text-sand/35 text-center py-5">收藏当前视角，便于汇报时快速切换</p>
            )}
            {list.map((b) => (
              <div key={b.id} className="flex items-center gap-1 group">
                <button
                  onClick={() => onRestore(b.view)}
                  className="flex-1 min-w-0 text-left px-2 h-8 rounded-md hover:bg-ink-800 transition-colors cursor-pointer"
                >
                  <span className="block text-[11px] text-sand/85 truncate">{b.name}</span>
                  <span className="block text-[9px] text-sand/35 tabular-nums">
                    {new Date(b.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </button>
                <button
                  onClick={() => remove(b.id)}
                  className="w-6 h-6 rounded text-sand/30 hover:text-cinnabar hover:bg-ink-800 text-xs cursor-pointer transition-colors"
                  aria-label={`删除 ${b.name}`}
                >
                  ×
                </button>
              </div>
            ))}
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
        视角书签
      </button>
    </div>
  )
}
