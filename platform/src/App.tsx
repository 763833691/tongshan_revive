import { useEffect, useRef, useState } from "react"
import {
  PlatformController,
  type MeasureMode,
  type MeasureState,
  type TilesetStatus,
} from "@/cesium/PlatformController"
import { DEFAULT_BASE_LAYER, Z_OFFSET_DEFAULT, type BaseLayerKind } from "@/config"
import type { UnitFeature } from "@/lib/units"
import { TopBar } from "@/components/TopBar"
import { UnitPanel } from "@/components/UnitPanel"
import { EditorPanel } from "@/components/EditorPanel"
import { DisplaySettings, HelpOverlay, LegendCard, MeasureBar, StatusBar } from "@/components/Overlays"
import { BookmarkPanel } from "@/components/Bookmarks"

const EMPTY_MEASURE: MeasureState = { mode: "none", points: 0, finished: false, distanceM: 0, areaM2: 0 }

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<PlatformController | null>(null)

  const [units, setUnits] = useState<UnitFeature[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [clipEnabled, setClipEnabled] = useState(false)
  const [extruded, setExtruded] = useState(false)
  const [baseLayer, setBaseLayer] = useState<BaseLayerKind>(DEFAULT_BASE_LAYER)
  const [zOffset, setZOffset] = useState(Z_OFFSET_DEFAULT)
  const [opacity, setOpacity] = useState(1)
  const [tilesetStatus, setTilesetStatus] = useState<TilesetStatus>("loading")
  const [progress, setProgress] = useState({ pending: 0, processing: 0 })
  const [measureMode, setMeasureMode] = useState<MeasureMode>("none")
  const [measure, setMeasure] = useState<MeasureState>(EMPTY_MEASURE)
  const [editMode, setEditMode] = useState(false)
  const [drawing, setDrawing] = useState(false)

  useEffect(() => {
    if (!containerRef.current) return
    const controller = new PlatformController(containerRef.current, {
      onUnitsLoaded: setUnits,
      onTilesetStatus: setTilesetStatus,
      onTileProgress: (pending, processing) => setProgress({ pending, processing }),
      onSelectChange: setSelected,
      onMeasureChange: setMeasure,
      onUnitsChanged: setUnits,
      onEditState: (s) => {
        setEditMode(s.editMode)
        setDrawing(s.drawing)
      },
    })
    controllerRef.current = controller
    void controller.init()
    return () => {
      controllerRef.current = null
      controller.destroy()
    }
  }, [])

  const selectedUnit = selected !== null ? units.find((u) => u.unit === selected) : null

  return (
    <div className="h-screen w-screen flex flex-col bg-ink-950 text-paper overflow-hidden">
      <TopBar
        clipEnabled={clipEnabled}
        onClipEnabled={(b) => {
          setClipEnabled(b)
          controllerRef.current?.setClipEnabled(b)
        }}
        extruded={extruded}
        onExtruded={(b) => {
          setExtruded(b)
          controllerRef.current?.setExtruded(b)
        }}
        baseLayer={baseLayer}
        onBaseLayer={(k) => {
          setBaseLayer(k)
          controllerRef.current?.setBaseLayer(k)
        }}
        onHome={() => {
          controllerRef.current?.selectUnit(null)
          controllerRef.current?.flyCity()
        }}
        editMode={editMode}
        onEditMode={(on) => {
          setEditMode(on)
          if (on) {
            setMeasureMode("none")
            controllerRef.current?.setMeasureMode("none")
          }
          controllerRef.current?.setEditMode(on)
        }}
        selected={selected}
        onClear={() => controllerRef.current?.selectUnit(null)}
      />
      <div className="flex-1 flex min-h-0">
        <UnitPanel
          units={units}
          selected={selected}
          loaded={units.length > 0}
          onSelect={(u) => controllerRef.current?.selectUnit(u)}
          onClear={() => controllerRef.current?.selectUnit(null)}
        />
        <main className="relative flex-1 min-w-0">
          <div ref={containerRef} className="absolute inset-0" />
          <StatusBar
            status={tilesetStatus}
            pending={progress.pending}
            processing={progress.processing}
            baseLayer={baseLayer}
          />
          <LegendCard />
          <MeasureBar
            mode={measureMode}
            state={measure}
            onMode={(m) => {
              setMeasureMode(m)
              controllerRef.current?.setMeasureMode(m)
            }}
            onFinish={() => controllerRef.current?.finishMeasure()}
            onClear={() => controllerRef.current?.clearMeasure()}
          />
          <DisplaySettings
            opacity={opacity}
            onOpacity={(v) => {
              setOpacity(v)
              controllerRef.current?.setOpacity(v)
            }}
            zOffset={zOffset}
            onZOffset={(z) => {
              setZOffset(z)
              controllerRef.current?.setZOffset(z)
            }}
          />
          <BookmarkPanel
            defaultName={selectedUnit ? `${selectedUnit.name}视角` : "全城视角"}
            onCapture={() => controllerRef.current!.getCameraView()}
            onRestore={(v) => controllerRef.current?.flyToView(v)}
          />
          {editMode && (
            <EditorPanel
              selected={selected}
              drawing={drawing}
              onExit={() => {
                setEditMode(false)
                controllerRef.current?.setEditMode(false)
              }}
              onSave={() => controllerRef.current?.saveEdits()}
              onRevert={() => void controllerRef.current?.revertEdits()}
              onReset={() => {
                if (window.confirm("恢复为原始 25 个单元边界？本机保存的修改将被清除。")) {
                  void controllerRef.current?.resetUnits()
                }
              }}
              onDelete={() => {
                if (window.confirm(`删除单元 ${selected !== null ? String(selected).padStart(2, "0") : ""}？`)) {
                  controllerRef.current?.deleteSelectedUnit()
                }
              }}
              onStartDrawing={() => controllerRef.current?.startDrawing()}
              onFinishDrawing={() => controllerRef.current?.finishDrawing()}
              onCancelDrawing={() => controllerRef.current?.cancelDrawing()}
              onTool={(t) => controllerRef.current?.setEditTool(t)}
              onUndo={() => controllerRef.current?.undo()}
              onExport={() => {
                const json = controllerRef.current?.exportUnitsJson()
                if (!json) return
                const blob = new Blob([json], { type: "application/geo+json" })
                const url = URL.createObjectURL(blob)
                const a = document.createElement("a")
                a.href = url
                a.download = "units.geojson"
                a.click()
                URL.revokeObjectURL(url)
              }}
            />
          )}
          <HelpOverlay status={tilesetStatus} onRetry={() => controllerRef.current?.reloadTileset()} />
        </main>
      </div>
    </div>
  )
}
