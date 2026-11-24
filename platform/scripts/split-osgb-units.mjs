/**
 * Clip the DJI Terra OSGB model to the 25 protection units and write one GLB per unit.
 * DasViewer opens *.glb. Vertices in the OSGB are metres relative to metadata.xml SRSOrigin.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { parseOsgb, osgbUnits } from './osgb-reader.js'

const ROOT = 'E:/BaiduSyncdisk/研究生参与项目资料/26-1120铜山古城数字平台/terra_osgbs'
const OUT = 'H:/铜山古城_分区模型'
const UNITS_JSON = new URL('./units-local.json', import.meta.url)
const CELL = 1

const only = process.argv.includes('--only')
  ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',').map(Number))
  : null

function signedArea(ring) {
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

function pip(x, y, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function buildGrid(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of ring) {
    if (p[0] < minX) minX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] > maxY) maxY = p[1]
  }
  minX -= CELL
  minY -= CELL
  maxX += CELL
  maxY += CELL
  const cols = Math.ceil((maxX - minX) / CELL)
  const rows = Math.ceil((maxY - minY) / CELL)
  const state = new Uint8Array(cols * rows) // 0 out, 1 in, 2 edge
  const mark = (c, r) => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return
    state[r * cols + c] = 2
  }
  const walk = (x0, y0, x1, y1) => {
    let x = Math.floor((x0 - minX) / CELL)
    let y = Math.floor((y0 - minY) / CELL)
    const xEnd = Math.floor((x1 - minX) / CELL)
    const yEnd = Math.floor((y1 - minY) / CELL)
    const dx = x1 - x0
    const dy = y1 - y0
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0
    const tDeltaX = stepX === 0 ? Infinity : Math.abs(CELL / dx)
    const tDeltaY = stepY === 0 ? Infinity : Math.abs(CELL / dy)
    const xBound = minX + (stepX > 0 ? (x + 1) * CELL : x * CELL)
    const yBound = minY + (stepY > 0 ? (y + 1) * CELL : y * CELL)
    let tMaxX = stepX === 0 ? Infinity : Math.abs((xBound - x0) / dx)
    let tMaxY = stepY === 0 ? Infinity : Math.abs((yBound - y0) / dy)
    mark(x, y)
    for (let n = 0; n < cols + rows + 8; n++) {
      if (x === xEnd && y === yEnd) break
      if (tMaxX < tMaxY) {
        tMaxX += tDeltaX
        x += stepX
      } else {
        tMaxY += tDeltaY
        y += stepY
      }
      mark(x, y)
    }
  }
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    walk(a[0], a[1], b[0], b[1])
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (state[i] === 2) continue
      const x = minX + (c + 0.5) * CELL
      const y = minY + (r + 0.5) * CELL
      if (pip(x, y, ring)) state[i] = 1
    }
  }
  return { minX, minY, cols, rows, state }
}

function cellOf(grid, x, y) {
  const c = Math.floor((x - grid.minX) / CELL)
  const r = Math.floor((y - grid.minY) / CELL)
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return 0
  return grid.state[r * grid.cols + c]
}

function regionClass(grid, ax, ay, bx, by, cx, cy) {
  let c0 = Math.floor((Math.min(ax, bx, cx) - grid.minX) / CELL)
  let c1 = Math.floor((Math.max(ax, bx, cx) - grid.minX) / CELL)
  let r0 = Math.floor((Math.min(ay, by, cy) - grid.minY) / CELL)
  let r1 = Math.floor((Math.max(ay, by, cy) - grid.minY) / CELL)
  if (c1 < 0 || r1 < 0 || c0 >= grid.cols || r0 >= grid.rows) return 'out'
  if (c0 < 0) c0 = 0
  if (r0 < 0) r0 = 0
  if (c1 >= grid.cols) c1 = grid.cols - 1
  if (r1 >= grid.rows) r1 = grid.rows - 1
  let hasIn = false, hasOut = false, hasEdge = false
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const s = grid.state[r * grid.cols + c]
      if (s === 1) hasIn = true
      else if (s === 2) hasEdge = true
      else hasOut = true
    }
  }
  if (!hasIn && !hasEdge) return 'out'
  if (hasIn && !hasOut && !hasEdge) return 'in'
  return 'clip'
}

function leftOf(px, py, ax, ay, bx, by) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax) >= -1e-7
}

function lerp(p, q, t) {
  return {
    x: p.x + (q.x - p.x) * t,
    y: p.y + (q.y - p.y) * t,
    z: p.z + (q.z - p.z) * t,
    u: p.u + (q.u - p.u) * t,
    v: p.v + (q.v - p.v) * t,
  }
}

function clipEdge(poly, ax, ay, bx, by) {
  if (!poly.length) return poly
  const out = []
  let prev = poly[poly.length - 1]
  let prevIn = leftOf(prev.x, prev.y, ax, ay, bx, by)
  for (const cur of poly) {
    const curIn = leftOf(cur.x, cur.y, ax, ay, bx, by)
    if (curIn !== prevIn) {
      const dx = cur.x - prev.x, dy = cur.y - prev.y
      const ex = bx - ax, ey = by - ay
      const den = dx * ey - dy * ex
      let t = 0
      if (Math.abs(den) > 1e-12) t = ((ax - prev.x) * ey - (ay - prev.y) * ex) / den
      if (t < 0) t = 0
      else if (t > 1) t = 1
      out.push(lerp(prev, cur, t))
    }
    if (curIn) out.push(cur)
    prev = cur
    prevIn = curIn
  }
  return out
}

function clipTriangle(tri, ring) {
  let poly = tri
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    poly = clipEdge(poly, a[0], a[1], b[0], b[1])
    if (poly.length < 3) return []
  }
  return poly
}

function triArea(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function pointInTri(a, b, c, p) {
  const c1 = triArea(a, b, p)
  const c2 = triArea(b, c, p)
  const c3 = triArea(c, a, p)
  const hasNeg = c1 < -1e-8 || c2 < -1e-8 || c3 < -1e-8
  const hasPos = c1 > 1e-8 || c2 > 1e-8 || c3 > 1e-8
  return !(hasNeg && hasPos)
}

function earcut(poly) {
  if (poly.length < 3) return []
  if (poly.length === 3) return poly
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length]
    area += p.x * q.y - q.x * p.y
  }
  const verts = area < 0 ? poly.slice().reverse() : poly.slice()
  const idx = verts.map((_, i) => i)
  const out = []
  let guard = 0
  while (idx.length > 3 && guard++ < 64) {
    let cut = false
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i + idx.length - 1) % idx.length]
      const i1 = idx[i]
      const i2 = idx[(i + 1) % idx.length]
      const a = verts[i0], b = verts[i1], c = verts[i2]
      if (triArea(a, b, c) <= 1e-8) continue
      let hit = false
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue
        if (pointInTri(a, b, c, verts[j])) { hit = true; break }
      }
      if (hit) continue
      out.push(a, b, c)
      idx.splice(i, 1)
      cut = true
      break
    }
    if (!cut) break
  }
  if (idx.length === 3) out.push(verts[idx[0]], verts[idx[1]], verts[idx[2]])
  return out
}

class Sink {
  constructor() {
    this.tex = []
    this.data = new Float32Array(15 * 8192)
    this.n = 0
    this.tris = 0
  }
  push(tex, a, b, c) {
    if (Math.abs(triArea(a, b, c)) < 1e-4) return
    let i = this.n
    if (i + 15 > this.data.length) {
      const bigger = new Float32Array(this.data.length * 2)
      bigger.set(this.data)
      this.data = bigger
    }
    const d = this.data
    d[i] = a.x; d[i + 1] = a.y; d[i + 2] = a.z; d[i + 3] = a.u; d[i + 4] = a.v
    d[i + 5] = b.x; d[i + 6] = b.y; d[i + 7] = b.z; d[i + 8] = b.u; d[i + 9] = b.v
    d[i + 10] = c.x; d[i + 11] = c.y; d[i + 12] = c.z; d[i + 13] = c.u; d[i + 14] = c.v
    this.n = i + 15
    this.tex.push(tex)
    this.tris++
  }
}

function loadUnits() {
  const raw = JSON.parse(fs.readFileSync(UNITS_JSON, 'utf8'))
  return raw.filter((u) => !only || only.has(u.unit)).map((u) => {
    let ring = u.exterior.map((p) => [p[0], p[1]])
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring = ring.slice(0, -1)
    if (signedArea(ring) < 0) ring.reverse()
    const grid = buildGrid(ring)
    return { ...u, ring, grid, sink: new Sink() }
  })
}

const texDir = path.join(OUT, '_tex')
fs.mkdirSync(texDir, { recursive: true })
const texOf = new Map()
let nextTex = 0
function texIdOf(file) {
  if (!file || file.length < 4) return -1
  const hash = crypto.createHash('sha1').update(file).digest('hex')
  let id = texOf.get(hash)
  if (id == null) {
    id = nextTex++
    texOf.set(hash, id)
    fs.writeFileSync(path.join(texDir, `${id}.jpg`), file)
  }
  return id
}

function leavesOf(startFile) {
  const out = []
  const seen = new Set()
  const stack = [startFile]
  while (stack.length) {
    const file = stack.pop()
    const key = path.resolve(file)
    if (seen.has(key)) continue
    seen.add(key)
    if (!fs.existsSync(file)) {
      console.log('  missing', file)
      continue
    }
    let scene
    try {
      scene = parseOsgb(fs.readFileSync(file))
    } catch (err) {
      console.log('  parse fail', path.basename(file), err.message)
      continue
    }
    if (scene.misread.length) console.log('  misread', path.basename(file), scene.misread.join(','))
    const units = osgbUnits(scene)
    for (const u of units) {
      if (u.files && u.files.length) {
        for (const rel of u.files) stack.push(path.resolve(path.dirname(file), rel))
      } else {
        for (const mesh of u.meshes) out.push(mesh)
      }
    }
  }
  return out
}

function consumeMesh(mesh, units) {
  const tex = texIdOf(mesh.image && mesh.image.file)
  if (tex < 0 || !mesh.uvs) return 0
  const p = mesh.positions
  const uv = mesh.uvs
  const idx = mesh.indices
  let kept = 0
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t] * 3, i1 = idx[t + 1] * 3, i2 = idx[t + 2] * 3
    const ax = p[i0], ay = p[i0 + 1], az = p[i0 + 2]
    const bx = p[i1], by = p[i1 + 1], bz = p[i1 + 2]
    const cx = p[i2], cy = p[i2 + 1], cz = p[i2 + 2]
    const j0 = idx[t] * 2, j1 = idx[t + 1] * 2, j2 = idx[t + 2] * 2
    for (const unit of units) {
      const g = unit.grid
      if (ax < g.minX && bx < g.minX && cx < g.minX) continue
      if (ay < g.minY && by < g.minY && cy < g.minY) continue
      const maxX = g.minX + g.cols * CELL
      const maxY = g.minY + g.rows * CELL
      if (ax > maxX && bx > maxX && cx > maxX) continue
      if (ay > maxY && by > maxY && cy > maxY) continue
      const kind = regionClass(g, ax, ay, bx, by, cx, cy)
      if (kind === 'out') continue
      if (kind === 'in') {
        unit.sink.push(tex,
          { x: ax, y: ay, z: az, u: uv[j0], v: uv[j0 + 1] },
          { x: bx, y: by, z: bz, u: uv[j1], v: uv[j1 + 1] },
          { x: cx, y: cy, z: cz, u: uv[j2], v: uv[j2 + 1] })
        kept++
        continue
      }
      const poly = clipTriangle([
        { x: ax, y: ay, z: az, u: uv[j0], v: uv[j0 + 1] },
        { x: bx, y: by, z: bz, u: uv[j1], v: uv[j1 + 1] },
        { x: cx, y: cy, z: cz, u: uv[j2], v: uv[j2 + 1] },
      ], unit.ring)
      const tris = earcut(poly)
      for (let k = 0; k < tris.length; k += 3) unit.sink.push(tex, tris[k], tris[k + 1], tris[k + 2])
      if (tris.length) kept++
    }
  }
  return kept
}

function writeGlb(unit) {
  const sink = unit.sink
  const counts = new Map()
  for (const tex of sink.tex) counts.set(tex, (counts.get(tex) || 0) + 1)
  const groups = []
  for (const [tex, n] of counts) {
    groups.push({
      tex, n, i: 0,
      pos: new Float32Array(n * 9),
      uv: new Float32Array(n * 6),
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
    })
  }
  const byTex = new Map(groups.map((g) => [g.tex, g]))
  const d = sink.data
  for (let t = 0; t < sink.tris; t++) {
    const g = byTex.get(sink.tex[t])
    const o = t * 15
    const base = g.i
    for (let v = 0; v < 3; v++) {
      const x = d[o + v * 5], y = d[o + v * 5 + 1], z = d[o + v * 5 + 2]
      const uu = d[o + v * 5 + 3], vv = d[o + v * 5 + 4]
      const at = (base + v) * 3
      // glTF is Y-up. OSGB is Z-up: (x, y, z) -> (x, z, -y)
      g.pos[at] = x
      g.pos[at + 1] = z
      g.pos[at + 2] = -y
      g.uv[(base + v) * 2] = uu
      g.uv[(base + v) * 2 + 1] = 1 - vv
      if (g.pos[at] < g.min[0]) g.min[0] = g.pos[at]
      if (g.pos[at + 1] < g.min[1]) g.min[1] = g.pos[at + 1]
      if (g.pos[at + 2] < g.min[2]) g.min[2] = g.pos[at + 2]
      if (g.pos[at] > g.max[0]) g.max[0] = g.pos[at]
      if (g.pos[at + 1] > g.max[1]) g.max[1] = g.pos[at + 1]
      if (g.pos[at + 2] > g.max[2]) g.max[2] = g.pos[at + 2]
    }
    g.i += 3
  }

  const binParts = []
  let offset = 0
  const align = () => {
    const pad = (4 - (offset % 4)) % 4
    if (pad) {
      binParts.push(Buffer.alloc(pad))
      offset += pad
    }
  }
  const views = []
  const accessors = []
  const images = []
  const textures = []
  const materials = []
  const primitives = []
  const pushView = (buf, target) => {
    align()
    const byteOffset = offset
    binParts.push(buf)
    offset += buf.length
    const view = { buffer: 0, byteOffset, byteLength: buf.length }
    if (target) view.target = target
    views.push(view)
    return views.length - 1
  }
  for (const g of groups) {
    const posBuf = Buffer.from(g.pos.buffer, g.pos.byteOffset, g.pos.byteLength)
    const uvBuf = Buffer.from(g.uv.buffer, g.uv.byteOffset, g.uv.byteLength)
    const count = g.n * 3
    const IndexArray = count > 65535 ? Uint32Array : Uint16Array
    const indices = new IndexArray(count)
    for (let i = 0; i < count; i++) indices[i] = i
    const idxBuf = Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength)
    const jpg = fs.readFileSync(path.join(texDir, `${g.tex}.jpg`))
    const posView = pushView(posBuf, 34962)
    const uvView = pushView(uvBuf, 34962)
    const idxView = pushView(idxBuf, 34963)
    const imgView = pushView(jpg)
    const posAcc = accessors.length
    accessors.push({ bufferView: posView, componentType: 5126, count, type: 'VEC3', min: g.min, max: g.max })
    const uvAcc = accessors.length
    accessors.push({ bufferView: uvView, componentType: 5126, count, type: 'VEC2' })
    const idxAcc = accessors.length
    accessors.push({ bufferView: idxView, componentType: count > 65535 ? 5125 : 5123, count, type: 'SCALAR' })
    const imageIndex = images.length
    images.push({ bufferView: imgView, mimeType: 'image/jpeg' })
    textures.push({ source: imageIndex })
    const material = materials.length
    materials.push({
      pbrMetallicRoughness: { baseColorTexture: { index: imageIndex }, metallicFactor: 0, roughnessFactor: 1 },
      doubleSided: true,
    })
    primitives.push({ attributes: { POSITION: posAcc, TEXCOORD_0: uvAcc }, indices: idxAcc, material, mode: 4 })
  }
  const bin = Buffer.concat(binParts)
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0', generator: 'tongshan-unit-split' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: unit.label, mesh: 0 }],
    meshes: [{ name: unit.name, primitives }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: views,
    accessors,
    images,
    textures,
    materials,
  }))
  const jsonPad = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4, 0)])
  const total = 12 + 8 + jsonPad.length + 8 + binPad.length
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(total, 8)
  const jh = Buffer.alloc(8)
  jh.writeUInt32LE(jsonPad.length, 0)
  jh.writeUInt32LE(0x4e4f534a, 4)
  const bh = Buffer.alloc(8)
  bh.writeUInt32LE(binPad.length, 0)
  bh.writeUInt32LE(0x004e4942, 4)
  const name = `${String(unit.unit).padStart(2, '0')}_${unit.name}.glb`
  const file = path.join(OUT, name)
  fs.writeFileSync(file, Buffer.concat([header, jh, jsonPad, bh, binPad]))
  return { file, bytes: total, tris: sink.tris, textures: groups.length }
}

const units = loadUnits()
console.log('units', units.map((u) => u.unit).join(','), 'grids ready')
const blockSet = new Set()
for (const u of units) for (const b of u.blocks) blockSet.add(b)
const blocks = [...blockSet]
console.log('blocks', blocks.length)

let meshCount = 0
for (const block of blocks) {
  const t0 = Date.now()
  const root = path.join(ROOT, block, `${block}.osgb`)
  const meshes = leavesOf(root)
  let kept = 0
  for (const mesh of meshes) kept += consumeMesh(mesh, units)
  meshCount += meshes.length
  const sec = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`${block} leaves=${meshes.length} keptTris=${kept} ${sec}s`)
}

const lines = ['编号,名称,三角面,贴图数,文件']
for (const unit of units) {
  if (!unit.sink.tris) {
    console.log('EMPTY', unit.name)
    lines.push(`${unit.unit},${unit.name},0,0,`)
    continue
  }
  const info = writeGlb(unit)
  console.log('wrote', info.file, 'tris', info.tris, 'tex', info.textures, 'MB', (info.bytes / 1048576).toFixed(1))
  lines.push(`${unit.unit},${unit.name},${info.tris},${info.textures},${info.file}`)
  unit.sink = null
}
fs.writeFileSync(path.join(OUT, '清单.csv'), '\uFEFF' + lines.join('\r\n'), 'utf8')
console.log('meshes', meshCount, 'textures', nextTex)
