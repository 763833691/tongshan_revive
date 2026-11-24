// 把每个区块 L17（没有则用更粗的一层）收成 4 个总览瓦片。
// 全城第一眼只下这 4 个文件；拉近后仍走原来的 L18–L22。
// 不改任何 b3dm，只新增 overview/ 并改写根 tileset.json。
// 原始 64 块索引备份为 tileset.blocks.json。
//
// node platform/scripts/build-overview.mjs

import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const rootDir = path.resolve(process.argv[2] || "H:/tongshan-3dtiles-opt")
const OVERVIEW_GE = 4
const MAX_LEVEL = 15

const nm = path.resolve("platform/scripts/../../_work/tiles-opt/node_modules")
const { Logger, NodeIO } = await import(pathToFileURL(path.join(nm, "@gltf-transform/core/dist/index.js")).href)
const { EXTMeshoptCompression, KHRONOS_EXTENSIONS } = await import(
  pathToFileURL(path.join(nm, "@gltf-transform/extensions/dist/index.js")).href
)
const functions = await import(pathToFileURL(path.join(nm, "@gltf-transform/functions/dist/index.js")).href)
const { MeshoptEncoder } = await import(pathToFileURL(path.join(nm, "meshoptimizer/meshopt_encoder.js")).href)
const { MeshoptDecoder } = await import(pathToFileURL(path.join(nm, "meshoptimizer/meshopt_decoder.mjs")).href)
const sharp = (await import(pathToFileURL(path.join(nm, "sharp/dist/index.mjs")).href)).default

await MeshoptEncoder.ready
await MeshoptDecoder.ready

const io = new NodeIO()
  .registerExtensions([...KHRONOS_EXTENSIONS, EXTMeshoptCompression])
  .registerDependencies({
    "meshopt.encoder": MeshoptEncoder,
    "meshopt.decoder": MeshoptDecoder,
  })

function splitB3dm(buf) {
  if (buf.toString("utf8", 0, 4) !== "b3dm") throw new Error("不是 b3dm")
  const ftJSON = buf.readUInt32LE(12)
  const ftBin = buf.readUInt32LE(16)
  const btJSON = buf.readUInt32LE(20)
  const btBin = buf.readUInt32LE(24)
  const glbStart = 28 + ftJSON + ftBin + btJSON + btBin
  return buf.subarray(glbStart)
}

function packB3dm(glb) {
  const ft = Buffer.from('{"BATCH_LENGTH":0}  ')
  const header = Buffer.alloc(28)
  header.write("b3dm", 0, "ascii")
  header.writeUInt32LE(1, 4)
  header.writeUInt32LE(28 + ft.length + glb.length, 8)
  header.writeUInt32LE(ft.length, 12)
  return Buffer.concat([header, ft, Buffer.from(glb)])
}

function aabbOf(box) {
  const hx = Math.hypot(box[3], box[4], box[5])
  const hy = Math.hypot(box[6], box[7], box[8])
  const hz = Math.hypot(box[9], box[10], box[11])
  return {
    min: [box[0] - hx, box[1] - hy, box[2] - hz],
    max: [box[0] + hx, box[1] + hy, box[2] + hz],
  }
}

function unionBox(boxes) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const box of boxes) {
    const a = aabbOf(box)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], a.min[i])
      max[i] = Math.max(max[i], a.max[i])
    }
  }
  return [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
    (max[0] - min[0]) / 2,
    0,
    0,
    0,
    (max[1] - min[1]) / 2,
    0,
    0,
    0,
    (max[2] - min[2]) / 2,
  ]
}

function quadrant(center, origin) {
  const ix = center[0] >= origin[0] ? 1 : 0
  const iy = center[1] >= origin[1] ? 1 : 0
  return iy * 2 + ix
}

function collectContent(node, out) {
  const uri = node.content?.uri
  if (uri && uri.endsWith(".b3dm")) {
    const m = uri.match(/_L(\d+)_/)
    out.push({
      uri,
      level: m ? Number(m[1]) : 0,
      center: node.boundingVolume.box.slice(0, 3),
    })
  }
  for (const child of node.children || []) collectContent(child, out)
}

const blocksPath = path.join(rootDir, "tileset.blocks.json")
const tilesetPath = path.join(rootDir, "tileset.json")
if (!fs.existsSync(blocksPath)) fs.copyFileSync(tilesetPath, blocksPath)
const tileset = JSON.parse(fs.readFileSync(blocksPath, "utf8"))
const origin = tileset.root.boundingVolume.box.slice(0, 3)
const groups = [[], [], [], []]
const blockGroups = [[], [], [], []]

for (const block of tileset.root.children || []) {
  const tilesetRel = block.content?.uri
  if (!tilesetRel) continue
  const blockJsonPath = path.join(rootDir, tilesetRel)
  const blockJson = JSON.parse(fs.readFileSync(blockJsonPath, "utf8"))
  const found = []
  collectContent(blockJson.root, found)
  const eligible = found.filter((t) => t.level > 0 && t.level <= MAX_LEVEL)
  const pool = eligible.length ? eligible : found
  const level = Math.max(...pool.map((t) => t.level))
  const chosen = pool.filter((t) => t.level === level)
  const blockDir = path.dirname(blockJsonPath)
  const q = quadrant(block.boundingVolume.box, origin)
  blockGroups[q].push(block)
  for (const tile of chosen) {
    groups[q].push(path.join(blockDir, tile.uri))
  }
}

console.log(groups.map((g, i) => `q${i} tiles=${g.length} blocks=${blockGroups[i].length}`).join(" | "))

async function buildOne(files) {
  let target = null
  let sceneA = null
  for (const file of files) {
    const doc = await io.readBinary(splitB3dm(fs.readFileSync(file)))
    if (!target) {
      target = doc
      sceneA = target.getRoot().listScenes()[0]
      continue
    }
    const map = functions.mergeDocuments(target, doc)
    const srcScene = doc.getRoot().listScenes()[0]
    const sceneB = map.get(srcScene)
    if (sceneB && sceneA) {
      for (const node of sceneB.listChildren()) sceneA.addChild(node)
      sceneB.dispose()
    }
  }
  if (!target) throw new Error("空象限")
  target.setLogger(new Logger(Logger.Verbosity.ERROR))
  await target.transform(
    functions.dequantize(),
    functions.flatten(),
    functions.prune(),
    functions.textureCompress({
      encoder: sharp,
      targetFormat: "jpeg",
      quality: 55,
      resize: [256, 256],
    }),
    functions.unpartition(),
    functions.meshopt({
      encoder: MeshoptEncoder,
      level: "high",
      quantizePosition: 14,
      quantizeTexcoord: 12,
      quantizeNormal: 8,
    }),
  )
  return Buffer.from(await io.writeBinary(target))
}

const overviewDir = path.join(rootDir, "overview")
fs.mkdirSync(overviewDir, { recursive: true })
const children = []
for (let i = 0; i < 4; i++) {
  if (!groups[i].length) continue
  const started = Date.now()
  const glb = await buildOne(groups[i])
  const packed = packB3dm(glb)
  const name = `q${i}.b3dm`
  fs.writeFileSync(path.join(overviewDir, name), packed)
  const box = unionBox(blockGroups[i].map((b) => b.boundingVolume.box))
  children.push({
    boundingVolume: { box },
    geometricError: OVERVIEW_GE,
    refine: "REPLACE",
    content: { uri: `./overview/${name}` },
    children: blockGroups[i],
  })
  console.log(`${name} ${(packed.length / 1e6).toFixed(1)} MB  ${groups[i].length} tiles  ${(Date.now() - started) / 1000}s`)
}

const next = {
  asset: tileset.asset,
  geometricError: tileset.geometricError,
  root: {
    boundingVolume: tileset.root.boundingVolume,
    geometricError: tileset.root.geometricError ?? tileset.geometricError,
    refine: "REPLACE",
    transform: tileset.root.transform,
    children,
  },
}
fs.writeFileSync(tilesetPath, JSON.stringify(next))
console.log("wrote", tilesetPath)
