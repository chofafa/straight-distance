// node test.mjs — index.html 의 표고·보정 로직 검증. 의존성 없음, 브라우저 없어도 된다.
//   서버(10.1.0.37)처럼 브라우저가 없는 곳에서 고칠 때 이걸로 확인하고 push 한다.
//   --unit  네트워크 없이 단위 테스트만
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { inflateSync, deflateSync } from "node:zlib";
import assert from "node:assert";

const ONLY_UNIT = process.argv.includes("--unit");
let failed = 0;
function ok(name, extra) { console.log("  PASS", name, extra ?? ""); }
function bad(name, e) { failed++; console.log("  FAIL", name, "—", e.message); }
async function test(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

// index.html 안의 표고 모듈만 떼어 VM 에 올린다 (브라우저 전역은 스텁으로)
const src = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const A = src.indexOf("  var TZ="), B = src.indexOf("  // ── 핀");
if (A < 0 || B < 0 || A >= B) { console.error(`index.html 에서 표고 모듈을 못 찾았다 — 마커 위치 시작=${A} 끝=${B}. index.html 을 고치면서 마커(  var TZ= / ── 핀)를 지웠나?`); process.exit(1); }
const code = src.slice(A, B);
for (const need of ["function loadTile", "function elevAt", "function playsLike", "function updatePlays"])
  if (!code.includes(need)) { console.error(`잘라낸 모듈에 ${need} 가 없다 — 마커 사이로 옮겼는지 확인`); process.exit(1); }
function mod(extra = {}) {
  const c = { Promise, Uint8ClampedArray, Math, setTimeout, clearTimeout, isFinite, console,
    load: () => null, save: () => true, localStorage: { removeItem() {} },
    playsEl: { hidden: true, innerHTML: "" }, pins: [], ...extra };
  createContext(c); runInContext(code, c); return c;
}

console.log("\n[단위]");

await test("playsLike — dh=0 항등 · 부호 · 80/220 클램프", () => {
  const c = mod();
  assert.strictEqual(c.playsLike(150, 0), 150);
  assert.ok(c.playsLike(150, 10) > 150 && c.playsLike(150, -10) < 150);
  const k = (s) => 1 / Math.tan((65 - 0.12 * s) * Math.PI / 180);
  assert.ok(Math.abs(c.playsLike(20, 5) - (20 + 5 * k(80))) < 1e-9);
  assert.ok(Math.abs(c.playsLike(400, 5) - (400 + 5 * k(220))) < 1e-9);
});

await test("보정계수 (80m 0.69 … 220m 1.25)", () => {
  const c = mod(), want = { 80: 0.69, 120: 0.82, 150: 0.93, 180: 1.06, 220: 1.25 };
  for (const d of Object.keys(want)) {
    const got = (c.playsLike(+d, 1e-6) - +d) / 1e-6;
    assert.ok(Math.abs(got - want[d]) < 0.005, `${d}m: ${got.toFixed(3)} != ${want[d]}`);
  }
});

await test("elevAt — 네 점이 4개 타일에 걸쳐도 bilinear 가 맞는다", async () => {
  const c = mod();
  c.loadTile = async (x, y) => {                  // 픽셀마다 h = f(전역 픽셀좌표) 인 가짜 타일
    const o = new Uint8ClampedArray(256 * 256 * 4);
    for (let py = 0; py < 256; py++) for (let px = 0; px < 256; px++) {
      const h = 100 + (x * 256 + px - 100 * 256) + (y * 256 + py - 100 * 256) * 2;
      const e = (h + 32768) * 256, i = (py * 256 + px) * 4;
      o[i] = Math.floor(e / 65536); o[i + 1] = Math.floor(e / 256) % 256; o[i + 2] = e % 256; o[i + 3] = 255;
    }
    return o;
  };
  const N = 2 ** 15 * 256, edge = 100 * 256;      // 정확히 타일 경계에 놓인 점
  const lng = edge / N * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * edge / N))) * 180 / Math.PI;
  assert.ok(Math.abs(await c.elevAt(lat, lng) - 98.5) < 1e-6);
});

await test("elevAt — 날짜변경선에서 타일 x 가 되감긴다", async () => {
  const c = mod(); let req = [];
  c.loadTile = async (x, y) => { req.push([x, y]); return null; };
  for (const lng of [180, -180]) {
    req = []; await c.elevAt(0, lng);
    assert.strictEqual(req.length, 4, `lng=${lng}: 네 점이면 타일 요청 4건이어야 한다 (${req.length}건)`);
    for (const [x, y] of req) assert.ok(x >= 0 && x < 32768 && y >= 0 && y < 32768, `범위 밖 타일 ${x}/${y} (lng=${lng})`);
    const xs = [...new Set(req.map((t) => t[0]))].sort((a, b) => a - b);
    assert.deepStrictEqual(xs, [0, 32767], `lng=${lng}: 경계 양쪽 x 는 0 과 32767 이어야 한다 (${xs})`);
  }
});

await test("elevAt — 극지방은 타일을 안 부르고 null", async () => {
  const c = mod(); const req = [];
  c.loadTile = async (x, y) => { req.push([x, y]); return null; };
  assert.strictEqual(await c.elevAt(89.99, 127), null);
  assert.strictEqual(await c.elevAt(-89.99, 127), null);
  assert.strictEqual(req.length, 0);
});

await test("loadTile — 요청 공유 · 실패는 null · 재시도 · 픽셀 그대로 · 메모리 캐시", async () => {
  const imgs = []; let drawn = 0;
  const MARK = new Uint8ClampedArray(256 * 256 * 4);       // 길이만 맞는 빈 배열과 구분되게 표식을 박는다
  for (let i = 0; i < MARK.length; i++) MARK[i] = (i * 7 + 13) & 255;
  class Image { constructor() { imgs.push(this); } set src(v) { this.url = v; } }
  const c = mod({ Image, document: { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ drawImage() { drawn++; }, getImageData: () => ({ data: MARK }) }),
    toDataURL: () => "" }) } });
  const p = c.loadTile(1, 2);
  assert.strictEqual(c.loadTile(1, 2), p, "같은 타일을 두 번 받으면 안 된다");
  assert.strictEqual(imgs.length, 1);
  imgs[0].onerror();
  assert.strictEqual(await p, null, "실패는 null (표고 0 과 구분)");
  const again = c.loadTile(1, 2);
  assert.strictEqual(imgs.length, 2, "실패한 타일은 다음에 재시도해야 한다");
  imgs[1].onload();
  const got = await again;
  assert.ok(drawn > 0, "이미지를 canvas 에 그리지 않았다");
  assert.deepStrictEqual([...got.slice(0, 8)], [...MARK.slice(0, 8)], "디코드한 픽셀이 그대로 나와야 한다");
  assert.strictEqual(got.length, 256 * 256 * 4);
  assert.deepStrictEqual([...(await c.loadTile(1, 2)).slice(0, 8)], [...MARK.slice(0, 8)]);
  assert.strictEqual(imgs.length, 2, "성공한 타일은 메모리에서 나와야 한다");
});

await test("updatePlays — 핀을 지운 뒤 늦게 온 응답이 되살아나지 않는다", async () => {
  const mk = () => {
    const pending = [];
    const c = mod({ L: { latLng: () => ({ distanceTo: () => 100 }) } });
    c.elevAt = () => new Promise((r) => pending.push(r));
    c.pins = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }];
    return { c, pending };
  };
  // (양성 대조) 그냥 두면 보정줄이 떠야 한다 — 이게 없으면 아래 검사가 무조건 통과한다
  const a = mk(); a.c.updatePlays();
  assert.strictEqual(a.pending.length, 2, "핀 2개면 표고 요청이 2건 걸려야 한다");
  a.pending[0](0); a.pending[1](30);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(a.c.playsEl.hidden, false, "정상 경로에서 보정줄이 떠야 한다");
  // (본 검사) 응답 오기 전에 핀을 다 지우면, 늦게 온 응답은 버려야 한다
  const b = mk(); b.c.updatePlays();
  assert.strictEqual(b.pending.length, 2);
  b.c.pins = []; b.c.updatePlays();
  b.pending[0](0); b.pending[1](30);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(b.c.playsEl.hidden, true);
});

// ── 실측 대조: 실제 타일을 받아 베어크리크 춘천 공략도와 비교 ──
// 좌표는 CJ 가 위성지도에서 직접 찍은 화이트티/그린. 공략도 기준값도 화이트티 환산.
const HOLES = [
  { hole: "18번", tee: [37.770727, 127.724449], green: [37.768701, 127.721102], guide: -34 },
  { hole: "16번", tee: [37.767929, 127.720023], green: [37.769557, 127.723939], guide: +30 },
  { hole: "17번", tee: [37.768798, 127.724374], green: [37.770291, 127.724733], guide: +2 },
];
const TOL = 5;                                     // 오늘(2026-09-11) 실측 오차는 2~3m. 5m 넘으면 소스가 바뀐 것

// 최소 PNG 디코더 — canvas 대용. terrarium 타일(8bit RGB, 256×256, non-interlaced) 만 받고
// 조금이라도 다르면 던진다. 조용히 틀린 픽셀을 내놓는 쪽이 훨씬 위험하다.
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("PNG 시그니처가 아니다");
  let p = 8, w = 0, h = 0, seenIHDR = false; const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("ascii", p + 4, p + 8);
    if (p + 12 + len > buf.length) throw new Error(`청크 ${type} 길이가 파일을 넘는다`);
    if (type === "IHDR") {
      seenIHDR = true;
      w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12);
      const depth = buf[p + 16], color = buf[p + 17], interlace = buf[p + 20];
      if (depth !== 8 || color !== 2) throw new Error(`8bit RGB 만 지원 (depth=${depth} color=${color})`);
      if (interlace !== 0) throw new Error("인터레이스는 지원 안 함");
      if (w !== 256 || h !== 256) throw new Error(`타일이 256×256 이 아니다 (${w}×${h})`);
    } else if (type === "IDAT") idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  if (!seenIHDR || !idat.length) throw new Error("IHDR/IDAT 없음");
  const raw = inflateSync(Buffer.concat(idat)), bpp = 3, stride = w * bpp;
  if (raw.length !== h * (stride + 1)) throw new Error(`압축 해제 길이가 안 맞는다 (${raw.length} != ${h * (stride + 1)})`);
  const out = Buffer.alloc(w * h * bpp);
  let o = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    if (ft > 4) throw new Error(`필터 타입 ${ft} (0~4 만 유효)`);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[o + i - bpp] : 0, b = y > 0 ? out[o - stride + i] : 0, c = (i >= bpp && y > 0) ? out[o - stride + i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      out[o + i] = v & 255;
    }
    o += stride;
  }
  return { w, data: out, bpp };
}

console.log("\n[디코더]");
// 합성 PNG 로 디코더를 검사한다. decodePNG 는 CRC 를 안 보므로 체크섬 자리는 0 으로 둔다.
function mkPNG({ w = 256, h = 256, depth = 8, color = 2, interlace = 0, rows, raw }) {
  const chunk = (type, body) => {
    const b = Buffer.alloc(body.length + 12);
    b.writeUInt32BE(body.length, 0); b.write(type, 4, "ascii"); body.copy(b, 8);
    return b;                                       // CRC 는 0 (decodePNG 가 검사하지 않음)
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth; ihdr[9] = color; ihdr[12] = interlace;
  const body = raw ?? Buffer.concat(rows.map((r) => Buffer.from(r)));
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(body)), chunk("IEND", Buffer.alloc(0))]);
}
const flat = (v) => { const rows = []; for (let y = 0; y < 256; y++) { const r = Buffer.alloc(256 * 3 + 1); r[0] = 0; r.fill(v, 1); rows.push(r); } return rows; };

await test("decodePNG — 정상 타일을 그대로 푼다", () => {
  const t = decodePNG(mkPNG({ rows: flat(77) }));
  assert.strictEqual(t.w, 256); assert.strictEqual(t.bpp, 3);
  assert.strictEqual(t.data.length, 256 * 256 * 3);
  assert.ok(t.data.every((v) => v === 77));
});
for (const [why, opt] of [
  ["RGBA(color=6)", { color: 6, rows: flat(0) }],
  ["16bit(depth=16)", { depth: 16, rows: flat(0) }],
  ["인터레이스", { interlace: 1, rows: flat(0) }],
  ["256×256 아님", { w: 128, h: 128, rows: flat(0) }],
  ["스캔라인 잘림", { raw: Buffer.alloc(256 * 3) }],
  ["필터 타입 5", { rows: flat(0).map((r, i) => (i ? r : Buffer.concat([Buffer.from([5]), r.subarray(1)]))) }],
])
  await test(`decodePNG — ${why} 는 거부한다`, () => {
    assert.throws(() => decodePNG(mkPNG(opt)), /./, `${why} 를 조용히 받아들였다`);
  });
await test("decodePNG — PNG 가 아니면 거부한다", () => {
  assert.throws(() => decodePNG(Buffer.alloc(64)), /시그니처/);
});

if (ONLY_UNIT) { console.log("\n[실측] --unit 이라 건너뜀"); }
else {
  console.log("\n[실측] 실제 타일 ↔ 베어크리크 춘천 공략도 (허용 ±" + TOL + "m)");
  const cache = new Map();
  const c = mod();
  c.loadTile = async (x, y) => {                   // index.html 의 브라우저 로더 대신 fetch + 직접 디코드
    const k = `${x}/${y}`;
    if (!cache.has(k)) {
      let r;
      try {                                        // 네트워크 실패만 offline 표시 — 그 밖의 예외는 진짜 실패다
        r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/15/${x}/${y}.png`);
      } catch (e) { e.offline = true; throw e; }
      if (r.status >= 500 || r.status === 429) { const e = new Error(`타일 ${k} HTTP ${r.status}`); e.offline = true; throw e; }
      if (!r.ok) throw new Error(`타일 ${k} HTTP ${r.status} — 주소나 소스가 바뀐 것`);
      const t = decodePNG(Buffer.from(await r.arrayBuffer()));
      const rgba = new Uint8ClampedArray(256 * 256 * 4);
      for (let i = 0; i < 256 * 256; i++) { rgba[i * 4] = t.data[i * 3]; rgba[i * 4 + 1] = t.data[i * 3 + 1]; rgba[i * 4 + 2] = t.data[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
      cache.set(k, rgba);
    }
    return cache.get(k);
  };
  for (const h of HOLES) {
    let dh;
    try {
      dh = (await c.elevAt(...h.green)) - (await c.elevAt(...h.tee));
    } catch (e) {
      if (e.offline) { console.log("  SKIP 네트워크 없음 —", e.message); break; }
      bad(`${h.hole} 실측`, e); continue;          // 디코드·로직 오류는 실패로 센다
    }
    const off = Math.abs(dh - h.guide);
    const line = `${h.hole} DEM ${dh >= 0 ? "+" : ""}${dh.toFixed(1)}m · 공략도 ${h.guide >= 0 ? "+" : ""}${h.guide}m · 차 ${off.toFixed(1)}m`;
    if (off <= TOL) ok(line); else bad(line, new Error(`허용 ${TOL}m 초과 — 표고 소스가 바뀌었는지 확인`));
  }
}

console.log(failed ? `\n실패 ${failed}건\n` : "\n전부 통과\n");
process.exit(failed ? 1 : 0);
