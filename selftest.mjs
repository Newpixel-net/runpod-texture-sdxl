import { deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { checkTileable, decodePng, loadPrompts, buildWorkflow, mapName } from
  "./test_endpoint.mjs";

const crc32 = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return (buf) => { let c = -1; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// filterMode: 0 = none, 1 = sub, 4 = paeth (exercise the unfilter paths)
function makePng(w, h, fn, filterMode = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const line = Buffer.alloc(stride);
    for (let x = 0; x < w; x++) { const [r, g, b] = fn(x, y); line[x*3] = r; line[x*3+1] = g; line[x*3+2] = b; }
    raw[y * (stride + 1)] = filterMode;
    const enc = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? line[i - 3] : 0, b2 = prev[i], c = i >= 3 ? prev[i - 3] : 0;
      let v = line[i];
      if (filterMode === 1) v -= a;
      else if (filterMode === 4) {
        const p = a + b2 - c, pa = Math.abs(p-a), pb = Math.abs(p-b2), pc = Math.abs(p-c);
        v -= pa <= pb && pa <= pc ? a : pb <= pc ? b2 : c;
      }
      enc[i] = v & 0xff;
    }
    line.copy(prev);
  }
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const W = 256;
// A texture that genuinely wraps: period divides the width exactly, plus noise.
const rnd = (x, y) => ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 + 1) % 1;
const tileable = (x, y) => {
  const v = 128 + 60 * Math.sin(2*Math.PI*4*x/W) * Math.cos(2*Math.PI*4*y/W) + 25 * (rnd(x,y) - 0.5);
  const c = Math.max(0, Math.min(255, Math.round(v)));
  return [c, c, c];
};
// Same field but with a hard discontinuity at the wrap: the right half is
// brightened, so column W-1 does not continue into column 0.
const seamed = (x, y) => {
  const [c] = tileable(x, y);
  const v = x > W / 2 ? Math.min(255, c + 40) : c;
  return [v, v, v];
};

let fails = 0;
function t(name, cond, extra = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
}

for (const fm of [0, 1, 4]) {
  const img = decodePng(makePng(W, W, tileable, fm));
  t(`decode filter=${fm} dims`, img.width === W && img.height === W && img.channels === 3);
  let exact = true;
  for (let y = 0; y < W && exact; y += 37) for (let x = 0; x < W; x += 41) {
    if (img.data[(y*W+x)*3] !== tileable(x, y)[0]) exact = false;
  }
  t(`decode filter=${fm} pixels round-trip`, exact);
}

const good = checkTileable(makePng(W, W, tileable, 4));
t("tileable image passes", good.pass,
  `seamX=${good.seamX.toFixed(2)} limitX=${good.limitX.toFixed(2)} seamY=${good.seamY.toFixed(2)} limitY=${good.limitY.toFixed(2)}`);

const bad = checkTileable(makePng(W, W, seamed, 4));
t("seamed image fails", !bad.pass,
  `seamX=${bad.seamX.toFixed(2)} limitX=${bad.limitX.toFixed(2)}`);

t("mapName strips ComfyUI suffix", mapName("albedo2k_00001_.png") === "albedo2k", mapName("albedo2k_00001_.png"));
t("mapName handles subfolder", mapName("texture/normal_00012_.png") === "normal");

const prompts = loadPrompts();
t("PROMPTS.md yields 12 materials", prompts.length === 12, String(prompts.length));
t("every prompt carries the LoRA trigger", prompts.every(p => p.positive.startsWith("colormap,")));

for (const [file, expectSaves] of [["workflow.texture.api.json", 6], ["workflow.texture.fast.api.json", 2]]) {
  const tpl = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
  const wf = buildWorkflow(tpl, { positive: prompts[0].positive, negative: prompts[0].negative, seed: 4242 });
  const nodes = Object.values(wf);
  t(`${file}: no placeholders left`, !JSON.stringify(wf).includes("__POSITIVE__") && !JSON.stringify(wf).includes("__NEGATIVE__"));
  t(`${file}: seed applied`, nodes.every(n => n.class_type !== "KSampler" || n.inputs.seed === 4242));
  t(`${file}: SaveImage count`, nodes.filter(n => n.class_type === "SaveImage").length === expectSaves);
  // every link target must exist with a legal slot
  let linksOk = true;
  for (const [id, n] of Object.entries(wf)) for (const [k, v] of Object.entries(n.inputs)) {
    if (Array.isArray(v) && !(v[0] in wf)) { console.log(`  dangling ${id}.${k} -> ${v[0]}`); linksOk = false; }
  }
  t(`${file}: all links resolve`, linksOk);
}

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall checks passed");
process.exit(fails ? 1 : 0);
