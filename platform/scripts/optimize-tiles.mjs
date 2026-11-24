// 保留全部 LOD，只压缩 b3dm 里的网格。贴图仍是 JPEG。
// 依赖装在 _work/tiles-opt（该目录不进 git）。
//
// node platform/scripts/optimize-tiles.mjs --src platform/public/3dtiles/tongshan --dst H:\tongshan-3dtiles-opt --shards 4 --shard 0
// 试跑：加 --limit 8

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const nm = path.resolve(here, "../../_work/tiles-opt/node_modules")

function load(rel) {
  return import(pathToFileURL(path.join(nm, rel)).href)
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  return process.argv[i + 1]
}

const srcRoot = path.resolve(arg("src", "platform/public/3dtiles/tongshan"))
const dstRoot = path.resolve(arg("dst", "H:/tongshan-3dtiles-opt"))
const shards = Math.max(1, Number(arg("shards", "1")))
const shard = Number(arg("shard", "0"))
const limit = Number(arg("limit", "0"))
const mode = arg("mode", "meshopt")

const { Logger, NodeIO } = await load("@gltf-transform/core/dist/index.js")
const { EXTMeshoptCompression, KHRONOS_EXTENSIONS } = await load(
  "@gltf-transform/extensions/dist/index.js",
)
const functions = await load("@gltf-transform/functions/dist/index.js")
const { MeshoptEncoder } = await load("meshoptimizer/meshopt_encoder.js")
const { MeshoptDecoder } = await load("meshoptimizer/meshopt_decoder.mjs")

await MeshoptEncoder.ready
const io = new NodeIO()
  .registerExtensions([...KHRONOS_EXTENSIONS, EXTMeshoptCompression])
  .registerDependencies({
  "meshopt.encoder": MeshoptEncoder,
  "meshopt.decoder": MeshoptDecoder,
})

let sharp = null
if (mode === "both") {
  sharp = (await load("sharp/lib/index.js")).default
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

function splitB3dm(buf) {
  if (buf.toString("utf8", 0, 4) !== "b3dm") throw new Error("不是 b3dm")
  const ftJSON = buf.readUInt32LE(12)
  const ftBin = buf.readUInt32LE(16)
  const btJSON = buf.readUInt32LE(20)
  const btBin = buf.readUInt32LE(24)
  const glbStart = 28 + ftJSON + ftBin + btJSON + btBin
  if (buf.toString("utf8", glbStart, glbStart + 4) !== "glTF") throw new Error("b3dm 内没有 glb")
  return { prefix: buf.subarray(0, glbStart), glb: buf.subarray(glbStart) }
}

function packB3dm(prefix, glb) {
  const out = Buffer.concat([Buffer.from(prefix), Buffer.from(glb)])
  out.writeUInt32LE(out.length, 8)
  return out
}

// fanvanzh 写的是已废弃的 KHR_techniques_webgl。先改成无光照 PBR，后续工具才能压缩。
function rewriteLegacy(glb) {
  const jsonLen = glb.readUInt32LE(12)
  const jsonStart = 20
  const json = JSON.parse(glb.subarray(jsonStart, jsonStart + jsonLen).toString("utf8"))
  if (!json.extensionsRequired?.includes("KHR_techniques_webgl")) return glb
  for (const mat of json.materials ?? []) {
    const diffuse = mat.extensions?.KHR_techniques_webgl?.values?.u_diffuse
    if (diffuse && typeof diffuse.index === "number") {
      mat.pbrMetallicRoughness = {
        baseColorTexture: { index: diffuse.index, texCoord: diffuse.texCoord ?? 0 },
        metallicFactor: 0,
        roughnessFactor: 1,
      }
    }
    mat.extensions = { KHR_materials_unlit: {} }
  }
  json.extensionsUsed = ["KHR_materials_unlit"]
  json.extensionsRequired = ["KHR_materials_unlit"]
  delete json.extensions
  const raw = Buffer.from(JSON.stringify(json))
  const pad = (4 - (raw.length % 4)) % 4
  const jsonChunk = Buffer.concat([raw, Buffer.alloc(pad, 0x20)])
  const chunk0 = Buffer.alloc(8)
  chunk0.writeUInt32LE(jsonChunk.length, 0)
  chunk0.writeUInt32LE(0x4e4f534a, 4)
  const rest = glb.subarray(jsonStart + jsonLen)
  const out = Buffer.concat([glb.subarray(0, 12), chunk0, jsonChunk, rest])
  out.writeUInt32LE(out.length, 8)
  return out
}

async function optimizeGlb(glb) {
  const doc = await io.readBinary(rewriteLegacy(glb))
  doc.setLogger(new Logger(Logger.Verbosity.ERROR))
  const steps = [
    functions.prune(),
    functions.meshopt({
      encoder: MeshoptEncoder,
      level: "high",
      quantizePosition: 16,
      quantizeTexcoord: 14,
      quantizeNormal: 10,
    }),
  ]
  if (sharp) {
    steps.unshift(
      functions.textureCompress({
        encoder: sharp,
        targetFormat: "jpeg",
        quality: 80,
        resize: [1024, 1024],
      }),
    )
  }
  await doc.transform(...steps)
  return Buffer.from(await io.writeBinary(doc))
}

async function optimizeB3dm(buf) {
  const { prefix, glb } = splitB3dm(buf)
  const nextGlb = await optimizeGlb(glb)
  if (!nextGlb.includes(Buffer.from("EXT_meshopt_compression"))) {
    throw new Error("压缩后没有 meshopt 扩展")
  }
  const packed = packB3dm(prefix, nextGlb)
  if (packed.length >= buf.length * 0.98) return { buf, kept: true }
  return { buf: packed, kept: false }
}

const all = walk(srcRoot)
const jsons = all.filter((f) => f.endsWith(".json") && !f.endsWith(".web.json"))
const b3dms = all.filter((f) => f.endsWith(".b3dm"))
const selected = b3dms.filter((_, i) => i % shards === shard)
const todo = limit > 0 ? selected.slice(0, limit) : selected

if (shard === 0) {
  for (const file of jsons) {
    const rel = path.relative(srcRoot, file)
    const dest = path.join(dstRoot, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(file, dest)
  }
}

let done = 0
let skipped = 0
let kept = 0
let failed = 0
let srcBytes = 0
let dstBytes = 0
const started = Date.now()

for (const file of todo) {
  const rel = path.relative(srcRoot, file)
  const dest = path.join(dstRoot, rel)
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0 && limit === 0) {
    skipped++
    continue
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const input = fs.readFileSync(file)
  try {
    const result = await optimizeB3dm(input)
    fs.writeFileSync(dest, result.buf)
    if (result.kept) kept++
    srcBytes += input.length
    dstBytes += result.buf.length
  } catch (err) {
    failed++
    fs.copyFileSync(file, dest)
    srcBytes += input.length
    dstBytes += input.length
    console.error(`FAIL ${rel} ${err.message}`)
  }
  done++
  if (done % 20 === 0 || done === todo.length) {
    const sec = (Date.now() - started) / 1000
    const ratio = srcBytes ? (dstBytes / srcBytes).toFixed(3) : "-"
    const line = `shard ${shard}/${shards} ${done}/${todo.length} skip ${skipped} kept ${kept} fail ${failed} ratio ${ratio} ${sec.toFixed(0)}s`
    console.log(line)
    fs.mkdirSync(dstRoot, { recursive: true })
    fs.writeFileSync(path.join(dstRoot, `status-${shard}.txt`), line)
  }
}

console.log(
  `finished shard ${shard} files ${done} skip ${skipped} kept ${kept} fail ${failed} ${srcBytes} -> ${dstBytes}`,
)
