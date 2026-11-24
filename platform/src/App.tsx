import { useEffect, useMemo, useRef, useState } from "react"
import {
  PlatformController,
  type MeasureMode,
  type MeasureState,
  type TilesetLoadProgress,
  type TilesetStatus,
} from "@/cesium/PlatformController"
import {
  BUILDING_CLIP_DEFAULT,
  DEFAULT_BASE_LAYER,
  SELECT_OUTLINE_WIDTH_DEFAULT,
  Z_OFFSET_DEFAULT,
  type BaseLayerKind,
  type BuildingStatus,
} from "@/config"
import type { UnitFeature } from "@/lib/units"
import { buildingsToGeoJson, countBuildings, type BuildingFeature } from "@/lib/buildings"
import { useBuildingReview } from "@/hooks/useBuildingReview"
import { TopBar } from "@/components/TopBar"
import { UnitPanel } from "@/components/UnitPanel"
import { EditorPanel } from "@/components/EditorPanel"
import { BuildingReviewPanel } from "@/components/BuildingReviewPanel"
import { BuildingLegend, BuildingReviewHud } from "@/components/BuildingReviewHud"
import { DisplaySettings, HelpOverlay, LegendCard, LoadingOverlay, MeasureBar, StatusBar } from "@/components/Overlays"
import { BookmarkPanel } from "@/components/Bookmarks"

const EMPTY_MEASURE: MeasureState = { mode: "none", points: 0, finished: false, distanceM: 0, areaM2: 0 }
const INITIAL_LOAD_PROGRESS: TilesetLoadProgress = {
  phase: "connecting",
  percent: 0,
  loaded: 0,
  pending: 0,
  processing: 0,
  elapsedMs: 0,
}

function downloadText(text: string, filename: string) {
  const blob = new Blob([text], { type: "application/geo+json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

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
  const [loadProgress, setLoadProgress] = useState<TilesetLoadProgress>(INITIAL_LOAD_PROGRESS)
  const [loadingDismissed, setLoadingDismissed] = useState(false)
  const [progress, setProgress] = useState({ pending: 0, processing: 0 })
  const [measureMode, setMeasureMode] = useState<MeasureMode>("none")
  const [measure, setMeasure] = useState<MeasureState>(EMPTY_MEASURE)
  const [editMode, setEditMode] = useState(false)
  const [drawing, setDrawing] = useState(false)
  const [buildings, setBuildings] = useState<BuildingFeature[]>([])
  const [buildingsError, setBuildingsError] = useState<string | null>(null)
  const [buildingsReady, setBuildingsReady] = useState(false)
  const [buildingMode, setBuildingMode] = useState(false)
  const [selectedBuilding, setSelectedBuilding] = useState<string | null>(null)
  const [buildingClip, setBuildingClip] = useState(BUILDING_CLIP_DEFAULT)
  const [outlineWidth, setOutlineWidth] = useState(SELECT_OUTLINE_WIDTH_DEFAULT)

  const review = useBuildingReview()
  const counts = useMemo(() => countBuildings(buildings, review.statuses), [buildings, review.statuses])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let controller: PlatformController | null = null
    let raf = 0
    let cancelled = false
    // --app 窗口刚创建时容器可能为 0 宽，Cesium 会报 "width must be > 0" 并停止渲染
    const boot = () => {
      if (cancelled) return
      if (el.clientWidth < 2 || el.clientHeight < 2) {
        raf = requestAnimationFrame(boot)
        return
      }
      controller = new PlatformController(el, {
        onUnitsLoaded: setUnits,
        onTilesetStatus: setTilesetStatus,
        onTileProgress: (pending, processing) => setProgress({ pending, processing }),
        onTilesetProgress: setLoadProgress,
        onSelectChange: setSelected,
        onMeasureChange: setMeasure,
        onUnitsChanged: setUnits,
        onEditState: (s) => {
          setEditMode(s.editMode)
          setDrawing(s.drawing)
        },
        onBuildingsLoaded: (b) => {
          setBuildings(b)
          setBuildingsError(null)
          setBuildingsReady(true)
        },
        onBuildingsError: (msg) => {
          setBuildingsError(msg)
          setBuildingsReady(true)
        },
        onBuildingSelect: setSelectedBuilding,
      })
      controllerRef.current = controller
      void controller.init()
    }
    boot()
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      controllerRef.current = null
      controller?.destroy()
    }
  }, [])

  useEffect(() => {
    controllerRef.current?.setBuildingStatuses(review.statuses)
  }, [review.statuses])

  useEffect(() => {
    controllerRef.current?.setBuildingClip(buildingClip)
  }, [buildingClip])

  useEffect(() => {
    controllerRef.current?.setOutlineWidth(outlineWidth)
  }, [outlineWidth])

  const selectedUnit = selected !== null ? units.find((u) => u.unit === selected) : null
  const selectedBuildingFeature = selectedBuilding ? buildings.find((b) => b.id === selectedBuilding) ?? null : null

  const enterBuildingReview = (on: boolean) => {
    setBuildingMode(on)
    if (!on) setSelectedBuilding(null)
    if (on) {
      controllerRef.current?.selectUnit(null)
      setEditMode(false)
      controllerRef.current?.setEditMode(false)
      setMeasureMode("none")
      controllerRef.current?.setMeasureMode("none")
    }
    controllerRef.current?.setBuildingMode(on)
  }

  const selectBuilding = (id: string | null) => {
    setSelectedBuilding(id)
    controllerRef.current?.selectBuilding(id)
  }

  const batchBuildings = (ids: string[], status: BuildingStatus) => {
    if (!ids.length) return
    const verb = status === "confirmed" ? "确认保留" : status === "rejected" ? "剔除" : "恢复为待审"
    if (!window.confirm(`将筛选出的 ${ids.length} 栋建筑标记为「${verb}」？可随时撤销。`)) return
    if (status === "confirmed") review.confirm(ids)
    else if (status === "rejected") review.reject(ids)
    else review.setPending(ids)
  }

  useEffect(() => {
    if (!buildingMode) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault()
        if (e.shiftKey) review.redo()
        else review.undo()
        return
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault()
        review.redo()
        return
      }
      if (!selectedBuilding) return
      if (e.key === "Enter") {
        e.preventDefault()
        review.confirm([selectedBuilding])
      } else if (e.key === "x" || e.key === "X" || e.key === "Delete") {
        e.preventDefault()
        review.reject([selectedBuilding])
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [buildingMode, selectedBuilding, review])

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
        buildingMode={buildingMode}
        onBuildingMode={enterBuildingReview}
      />
      <div className="flex-1 flex min-h-0">
        {buildingMode ? (
          <BuildingReviewPanel
            buildings={buildings}
            statuses={review.statuses}
            selected={selectedBuilding}
            loading={!buildingsReady}
            error={buildingsError}
            counts={counts}
            clipPreview={buildingClip}
            onClipPreview={setBuildingClip}
            onSelect={selectBuilding}
            onConfirm={(id) => review.confirm([id])}
            onReject={(id) => review.reject([id])}
            onBatch={batchBuildings}
            canUndo={review.canUndo}
            canRedo={review.canRedo}
            undoLabel={review.undoLabel}
            redoLabel={review.redoLabel}
            onUndo={review.undo}
            onRedo={review.redo}
            onReset={() => {
              if (window.confirm("清空全部审核状态（全部恢复为待审）？此操作可撤销。")) {
                review.resetAll(buildings.map((b) => b.id))
              }
            }}
            onExportConfirmed={() =>
              downloadText(
                buildingsToGeoJson(buildings, review.statuses, { onlyConfirmed: true }),
                "buildings_confirmed.geojson",
              )
            }
            onExportAll={() =>
              downloadText(buildingsToGeoJson(buildings, review.statuses, { onlyConfirmed: false }), "buildings_review.geojson")
            }
            onExit={() => enterBuildingReview(false)}
          />
        ) : (
          <UnitPanel
            units={units}
            selected={selected}
            loaded={units.length > 0}
            onSelect={(u) => controllerRef.current?.selectUnit(u)}
            onClear={() => controllerRef.current?.selectUnit(null)}
          />
        )}
        <main className="relative flex-1 min-w-[420px]">
          <div ref={containerRef} className="absolute inset-0" />
          <StatusBar
            status={tilesetStatus}
            pending={progress.pending}
            processing={progress.processing}
            baseLayer={baseLayer}
            loadPercent={loadProgress.phase === "loading" ? loadProgress.percent : 0}
          />
          {!loadingDismissed && (
            <LoadingOverlay progress={loadProgress} onSkip={() => setLoadingDismissed(true)} />
          )}
          {buildingMode ? <BuildingLegend /> : <LegendCard />}
          {!buildingMode && (
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
          )}
          {buildingMode && selectedBuildingFeature && (
            <BuildingReviewHud
              building={selectedBuildingFeature}
              status={review.statuses[selectedBuildingFeature.id] ?? "pending"}
              clipPreview={buildingClip}
              onConfirm={() => review.confirm([selectedBuildingFeature.id])}
              onReject={() => review.reject([selectedBuildingFeature.id])}
              onCancel={() => selectBuilding(null)}
            />
          )}
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
            outlineWidth={outlineWidth}
            onOutlineWidth={setOutlineWidth}
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
          <HelpOverlay
            status={tilesetStatus}
            onRetry={() => {
              setLoadingDismissed(false)
              controllerRef.current?.reloadTileset()
            }}
          />
        </main>
      </div>
    </div>
  )
}
