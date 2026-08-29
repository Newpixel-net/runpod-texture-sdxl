#!/usr/bin/env node
// Submits the texture workflow to a RunPod serverless endpoint once per material,
// saves every returned map under ./out/<material>/, and auto-checks tileability
// by comparing the wrap seam against the image's own interior noise floor.
//
// No dependencies: plain node >= 18 (global fetch, node:zlib for the PNG decode).
//
//   ENDPOINT_ID=xxxx RUNPOD_API_KEY=yyyy node test_endpoint.mjs
//   ENDPOINT_ID=... RUNPOD_API_KEY=... node test_endpoint.mjs --fast --only "castle brick,meadow grass"
//
// Env / flags:
//   ENDPOINT_ID       (required) RunPod serverless endpoint id
//   RUNPOD_API_KEY    (required) RunPod API key
//   --fast            use workflow.texture.fast.api.json (albedo only)
//   --workflow <path> explicit workflow file
//   --only <a,b,c>    subset of material names (substring match)
//   --seed <n>        base seed; material i uses seed+i (0 = random per material)
//   --out <dir>       output root, default ./out
//   --concurrency <n> parallel jobs, default 2 (match the endpoint's max workers)
//   --timeout <sec>   per-job wall clock, default 900

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Guarded so the decoder and the edge check can be imported and unit-tested
// without firing a real endpoint request.
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// ---------------------------------------------------------------- cli / env

function flag(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const ENDPOINT_ID = process.env.ENDPOINT_ID;
const API_KEY = process.env.RUNPOD_API_KEY;
if (IS_MAIN && (!ENDPOINT_ID || !API_KEY)) {
  console.error("ENDPOINT_ID and RUNPOD_API_KEY must be set in the environment.");
  process.exit(2);
}

const FAST = flag("fast") === true;
const WORKFLOW_PATH = resolve(
  HERE,
  flag("workflow") || (FAST ? "workflow.texture.fast.api.json" : "workflow.texture.api.json"),
);
const OUT_ROOT = resolve(process.cwd(), flag("out") || "out");
const ONLY = flag("only");
const BASE_SEED = Number(flag("seed", process.env.SEED ?? "0"));
const CONCURRENCY = Math.max(1, Number(flag("concurrency", "2")));
const TIMEOUT_MS = Number(flag("timeout", "900")) * 1000;
const API = `https://api.runpod.ai/v2/${ENDPOINT_ID}`;

// Tileability verdict. A fixed absolute threshold is useless across materials -
// a smooth plaster and a gravel scatter have wildly different local contrast -
// so the seam delta is judged against the interior adjacent-pixel delta of the
// same image. RATIO is the multiplier of that noise floor we still call clean;
// FLOOR keeps a near-flat texture from failing on rounding noise.
const RATIO = Number(process.env.TILE_RATIO ?? "1.6");
const FLOOR = Number(process.env.TILE_FLOOR ?? "2.0"); // 0-255 scale

// ---------------------------------------------------------------- prompts

// PROMPTS.md carries the human-readable table plus one machine-readable JSON
// fence at the end. Parsing that fence keeps a single source of truth.
function loadPrompts() {
  const md = readFileSync(join(HERE, "PROMPTS.md"), "utf8");
  const fences = [...md.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (!fences.length) throw new Error("PROMPTS.md has no ```json fence");
  const list = JSON.parse(fences[fences.length - 1][1]);
  if (!Array.isArray(list) || !list.length) throw new Error("PROMPTS.md json fence is not a non-empty array");
  for (const p of list) {
    if (!p.name || !p.positive || !p.negative) {
      throw new Error(`prompt entry missing name/positive/negative: ${JSON.stringify(p)}`);
    }
  }
  return list;
}

// ---------------------------------------------------------------- workflow

function buildWorkflow(template, { positive, negative, seed }) {
  const wf = JSON.parse(JSON.stringify(template));
  let patchedPos = 0, patchedNeg = 0, patchedSeed = 0;
  for (const node of Object.values(wf)) {
    const inp = node.inputs || {};
    if (inp.text === "__POSITIVE__") { inp.text = positive; patchedPos++; }
    if (inp.text === "__NEGATIVE__") { inp.text = negative; patchedNeg++; }
    if (node.class_type === "KSampler") { inp.seed = seed; patchedSeed++; }
  }
  if (!patchedPos || !patchedNeg || !patchedSeed) {
    throw new Error(
      `workflow template did not expose the expected placeholders ` +
      `(positive=${patchedPos} negative=${patchedNeg} ksampler=${patchedSeed})`,
    );
  }
  return wf;
}

// ---------------------------------------------------------------- runpod io

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runJob(workflow) {
  // worker-comfyui contract (>=5.0.0): {"input":{"workflow":{...}}} in,
  // {"output":{"images":[{filename,type,data}]}} out.
  const started = Date.now();
  const submitted = await api("/run", {
    method: "POST",
    body: JSON.stringify({ input: { workflow } }),
  });
  const jobId = submitted.id;
  if (!jobId) throw new Error(`/run returned no job id: ${JSON.stringify(submitted).slice(0, 300)}`);

  let delay = 2000;
  for (;;) {
    if (Date.now() - started > TIMEOUT_MS) {
      await api(`/cancel/${jobId}`, { method: "POST" }).catch(() => {});
      throw new Error(`job ${jobId} timed out after ${TIMEOUT_MS / 1000}s`);
    }
    await sleep(delay);
    delay = Math.min(delay * 1.25, 10000);
    const s = await api(`/status/${jobId}`);
    if (s.status === "COMPLETED") return { job: s, elapsedMs: Date.now() - started, jobId };
    if (s.status === "FAILED" || s.status === "CANCELLED" || s.status === "TIMED_OUT") {
      throw new Error(`job ${jobId} ${s.status}: ${JSON.stringify(s.error ?? s.output ?? {}).slice(0, 600)}`);
    }
  }
}

// ---------------------------------------------------------------- png decode

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error("not a PNG");
  let off = 8, ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len; // len + type + data + crc
  }
  if (!ihdr) throw new Error("PNG has no IHDR");
  if (ihdr.bitDepth !== 8) throw new Error(`unsupported bit depth ${ihdr.bitDepth} (need 8)`);
  if (ihdr.interlace !== 0) throw new Error("interlaced PNG not supported");
  const ch = CHANNELS[ihdr.colorType];
  if (!ch || ihdr.colorType === 3) throw new Error(`unsupported colour type ${ihdr.colorType}`);

  const { width: w, height: h } = ihdr;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  if (raw.length < (stride + 1) * h) throw new Error("truncated PNG data");

  // Undo the per-scanline filters in place (PNG spec 9.2).
  const out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    line.copy(cur);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = cur[i];
      switch (ft) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`bad PNG filter type ${ft} on row ${y}`);
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return { width: w, height: h, channels: ch, data: out };
}

// ---------------------------------------------------------------- tile check

function meanColumnDelta(img, x1, x2) {
  const { data, width, height, channels } = img;
  const cmp = Math.min(channels, 3); // ignore alpha
  let sum = 0;
  for (let y = 0; y < height; y++) {
    const r = y * width * channels;
    for (let c = 0; c < cmp; c++) {
      sum += Math.abs(data[r + x1 * channels + c] - data[r + x2 * channels + c]);
    }
  }
  return sum / (height * cmp);
}

function meanRowDelta(img, y1, y2) {
  const { data, width, channels } = img;
  const cmp = Math.min(channels, 3);
  let sum = 0;
  for (let x = 0; x < width; x++) {
    const a = y1 * width * channels + x * channels;
    const b = y2 * width * channels + x * channels;
    for (let c = 0; c < cmp; c++) sum += Math.abs(data[a + c] - data[b + c]);
  }
  return sum / (width * cmp);
}

// Interior noise floor: the average adjacent-pixel delta sampled across the
// image, i.e. what "no seam" looks like for THIS material.
function interiorFloor(img, axis) {
  const n = axis === "x" ? img.width : img.height;
  const samples = [];
  const step = Math.max(1, Math.floor(n / 64));
  for (let i = step; i < n - step; i += step) {
    samples.push(axis === "x" ? meanColumnDelta(img, i, i + 1) : meanRowDelta(img, i, i + 1));
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] || 0; // median, robust to a local feature
}

function checkTileable(pngBuffer) {
  const img = decodePng(pngBuffer);
  // A tileable image wraps: column W-1 must sit next to column 0 as naturally
  // as any interior neighbour pair does. Same for row H-1 next to row 0.
  const seamX = meanColumnDelta(img, img.width - 1, 0);
  const seamY = meanRowDelta(img, img.height - 1, 0);
  const floorX = interiorFloor(img, "x");
  const floorY = interiorFloor(img, "y");
  const limitX = Math.max(FLOOR, RATIO * floorX);
  const limitY = Math.max(FLOOR, RATIO * floorY);
  return {
    size: `${img.width}x${img.height}`,
    seamX, seamY, floorX, floorY, limitX, limitY,
    pass: seamX <= limitX && seamY <= limitY,
  };
}

// ---------------------------------------------------------------- driver

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ComfyUI appends "_00001_.png" to the SaveImage prefix; recover the map name.
function mapName(filename) {
  const base = filename.split(/[\\/]/).pop();
  return base.replace(/_\d+_?\.png$/i, "").replace(/\.png$/i, "");
}

async function runMaterial(prompt, index, template) {
  const name = prompt.name;
  const dir = join(OUT_ROOT, slug(name));
  mkdirSync(dir, { recursive: true });
  const seed = BASE_SEED === 0
    ? Math.floor(Math.random() * 0xffffffff)
    : BASE_SEED + index;

  const wf = buildWorkflow(template, { positive: prompt.positive, negative: prompt.negative, seed });
  const { job, elapsedMs, jobId } = await runJob(wf);

  const images = job.output?.images ?? [];
  if (!images.length) {
    throw new Error(`no images returned (output=${JSON.stringify(job.output ?? {}).slice(0, 300)})`);
  }

  const saved = {};
  let tile = null;
  for (const img of images) {
    if (img.type !== "base64") {
      // S3 mode: record the URL, skip the local edge check.
      saved[mapName(img.filename)] = img.data;
      continue;
    }
    const key = mapName(img.filename);
    const buf = Buffer.from(img.data, "base64");
    const path = join(dir, `${key}.png`);
    writeFileSync(path, buf);
    saved[key] = path;
    // albedo2k is the shipping map; fall back to albedo1k on the fast graph.
    if (key === "albedo2k" || (key === "albedo1k" && !tile)) {
      try { tile = { key, ...checkTileable(buf) }; } catch (e) { tile = { key, error: e.message }; }
    }
  }

  writeFileSync(join(dir, "meta.json"), JSON.stringify({
    material: name, seed, jobId,
    delayTimeMs: job.delayTime, executionTimeMs: job.executionTime,
    wallClockMs: elapsedMs,
    positive: prompt.positive, negative: prompt.negative,
    maps: Object.keys(saved), tile,
  }, null, 2) + "\n");

  return { name, seed, jobId, elapsedMs, maps: Object.keys(saved).sort(), tile };
}

async function main() {
  if (!existsSync(WORKFLOW_PATH)) throw new Error(`workflow not found: ${WORKFLOW_PATH}`);
  const template = JSON.parse(readFileSync(WORKFLOW_PATH, "utf8"));

  let prompts = loadPrompts();
  if (typeof ONLY === "string") {
    const wanted = ONLY.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    prompts = prompts.filter((p) => wanted.some((w) => p.name.toLowerCase().includes(w)));
    if (!prompts.length) throw new Error(`--only "${ONLY}" matched no material`);
  }

  console.log(`endpoint ${ENDPOINT_ID}`);
  console.log(`workflow ${WORKFLOW_PATH}`);
  console.log(`materials ${prompts.length}, concurrency ${CONCURRENCY}, out ${OUT_ROOT}\n`);

  mkdirSync(OUT_ROOT, { recursive: true });
  const results = new Array(prompts.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= prompts.length) return;
      const p = prompts[i];
      try {
        const r = await runMaterial(p, i, template);
        results[i] = r;
        const t = r.tile;
        const verdict = !t ? "no-check"
          : t.error ? `check-error (${t.error})`
          : t.pass ? "TILEABLE" : "SEAM";
        console.log(
          `[${i + 1}/${prompts.length}] ${p.name} -> ${verdict}  ` +
          `${Math.round(r.elapsedMs / 1000)}s  maps: ${r.maps.join(", ")}`,
        );
      } catch (e) {
        results[i] = { name: p.name, error: e.message };
        console.log(`[${i + 1}/${prompts.length}] ${p.name} -> ERROR ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, prompts.length) }, worker));

  console.log("\n--- tileability ---");
  console.log("material                    size        seamX  limitX   seamY  limitY  verdict");
  let passes = 0, checked = 0;
  for (const r of results) {
    if (!r) continue;
    if (r.error) { console.log(`${r.name.padEnd(26)} ERROR  ${r.error}`); continue; }
    const t = r.tile;
    if (!t || t.error) {
      console.log(`${r.name.padEnd(26)} ${(t?.size ?? "-").padEnd(11)} ${t?.error ?? "not checked"}`);
      continue;
    }
    checked++;
    if (t.pass) passes++;
    const f = (n) => n.toFixed(2).padStart(6);
    console.log(
      `${r.name.padEnd(26)} ${t.size.padEnd(11)} ${f(t.seamX)}  ${f(t.limitX)}  ` +
      `${f(t.seamY)}  ${f(t.limitY)}  ${t.pass ? "PASS" : "FAIL"}`,
    );
  }
  const failures = results.filter((r) => r && r.error).length;
  console.log(`\n${passes}/${checked} tileable, ${failures} job error(s). Outputs in ${OUT_ROOT}`);
  writeFileSync(join(OUT_ROOT, "report.json"), JSON.stringify(results, null, 2) + "\n");
  process.exit(failures === 0 && checked > 0 && passes === checked ? 0 : 1);
}

if (IS_MAIN) {
  main().catch((e) => {
    console.error(e.stack || String(e));
    process.exit(1);
  });
}

export { decodePng, checkTileable, loadPrompts, buildWorkflow, mapName };
