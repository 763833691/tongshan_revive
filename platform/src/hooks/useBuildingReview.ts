import { useEffect, useMemo, useReducer } from "react"
import type { BuildingStatus } from "@/config"

const STORAGE_KEY = "tongshan.buildings.review.v1"
const VERSION = 1
const MAX_HISTORY = 80

export interface ReviewChange {
  id: string
  from: BuildingStatus
  to: BuildingStatus
}

export interface ReviewAction {
  label: string
  at: number
  changes: ReviewChange[]
}

interface ReviewState {
  statuses: Record<string, BuildingStatus>
  undo: ReviewAction[]
  redo: ReviewAction[]
}

type ReviewMessage =
  | { type: "apply"; ids: string[]; status: BuildingStatus; label: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "resetAll"; ids: string[] }

const EMPTY: ReviewState = { statuses: {}, undo: [], redo: [] }

function isStatus(v: unknown): v is BuildingStatus {
  return v === "pending" || v === "confirmed" || v === "rejected"
}

function load(): ReviewState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const data = JSON.parse(raw) as { version?: number; statuses?: unknown; undo?: unknown; redo?: unknown }
    if (data.version !== VERSION) return EMPTY
    const statuses: Record<string, BuildingStatus> = {}
    if (data.statuses && typeof data.statuses === "object") {
      for (const [id, s] of Object.entries(data.statuses as Record<string, unknown>)) {
        if (isStatus(s)) statuses[id] = s
      }
    }
    const readActions = (v: unknown): ReviewAction[] =>
      Array.isArray(v)
        ? v
            .filter((a): a is ReviewAction => {
              const o = a as Partial<ReviewAction>
              return (
                !!o &&
                typeof o.label === "string" &&
                Array.isArray(o.changes) &&
                o.changes.every((c) => typeof c?.id === "string" && isStatus(c?.from) && isStatus(c?.to))
              )
            })
            .slice(-MAX_HISTORY)
        : []
    return { statuses, undo: readActions(data.undo), redo: readActions(data.redo) }
  } catch {
    return EMPTY
  }
}

function buildAction(current: Record<string, BuildingStatus>, ids: string[], status: BuildingStatus, label: string): ReviewAction | null {
  const seen = new Set<string>()
  const changes: ReviewChange[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const from = current[id] ?? "pending"
    if (from === status) continue
    changes.push({ id, from, to: status })
  }
  if (!changes.length) return null
  return { label, at: Date.now(), changes }
}

function applyChanges(statuses: Record<string, BuildingStatus>, changes: ReviewChange[], key: "from" | "to") {
  const next = { ...statuses }
  for (const c of changes) {
    if (c[key] === "pending") delete next[c.id]
    else next[c.id] = c[key]
  }
  return next
}

function reducer(state: ReviewState, msg: ReviewMessage): ReviewState {
  switch (msg.type) {
    case "apply": {
      const action = buildAction(state.statuses, msg.ids, msg.status, msg.label)
      if (!action) return state
      return {
        statuses: applyChanges(state.statuses, action.changes, "to"),
        undo: [...state.undo, action].slice(-MAX_HISTORY),
        redo: [],
      }
    }
    case "undo": {
      const action = state.undo[state.undo.length - 1]
      if (!action) return state
      return {
        statuses: applyChanges(state.statuses, action.changes, "from"),
        undo: state.undo.slice(0, -1),
        redo: [...state.redo, action].slice(-MAX_HISTORY),
      }
    }
    case "redo": {
      const action = state.redo[state.redo.length - 1]
      if (!action) return state
      return {
        statuses: applyChanges(state.statuses, action.changes, "to"),
        undo: [...state.undo, action].slice(-MAX_HISTORY),
        redo: state.redo.slice(0, -1),
      }
    }
    case "resetAll": {
      const action = buildAction(state.statuses, msg.ids, "pending", "清空全部审核")
      if (!action) return state
      return {
        statuses: applyChanges(state.statuses, action.changes, "to"),
        undo: [...state.undo, action].slice(-MAX_HISTORY),
        redo: [],
      }
    }
    default:
      return state
  }
}

export function useBuildingReview() {
  const [state, dispatch] = useReducer(reducer, undefined, load)

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: VERSION, statuses: state.statuses, undo: state.undo, redo: state.redo }),
      )
    } catch (err) {
      console.warn("建筑审核结果保存失败", err)
    }
  }, [state])

  return useMemo(() => {
    const apply = (ids: string[], status: BuildingStatus, label: string) =>
      dispatch({ type: "apply", ids, status, label })
    const undoAction = state.undo[state.undo.length - 1]
    const redoAction = state.redo[state.redo.length - 1]
    return {
      statuses: state.statuses,
      confirm: (ids: string[]) => apply(ids, "confirmed", `确认 ${ids.length} 栋`),
      reject: (ids: string[]) => apply(ids, "rejected", `剔除 ${ids.length} 栋`),
      setPending: (ids: string[]) => apply(ids, "pending", `恢复 ${ids.length} 栋为待审`),
      undo: () => dispatch({ type: "undo" }),
      redo: () => dispatch({ type: "redo" }),
      resetAll: (ids: string[]) => dispatch({ type: "resetAll", ids }),
      canUndo: !!undoAction,
      canRedo: !!redoAction,
      undoLabel: undoAction?.label ?? null,
      redoLabel: redoAction?.label ?? null,
    }
  }, [state])
}
