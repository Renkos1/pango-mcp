// Backend-agnostic VCD -> SVG waveform renderer + standalone HTML wrapper.
// Turns a parsed VCD (core/vcd.parseVcd) into a digital timing diagram so the
// MCP can give VISUAL feedback for any simulator backend (iverilog / ModelSim)
// without a native/canvas dependency — pure string output. Colors are explicit
// (this is a standalone artifact opened in a browser / returned as an image,
// not the in-chat themed widget). 1-bit signals render as step lines; multi-bit
// buses render as hex-labelled envelopes; x/z is highlighted.

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseVcd, valueAt } from "./vcd.mjs";
import { run } from "./exec.mjs";

const COLORS = {
  bg: "#ffffff",
  panel: "#f8fafc",
  grid: "#e5e7eb",
  axis: "#6b7280",
  name: "#0f172a",
  hi: "#2563eb",
  bus: "#7c3aed",
  xz: "#dc2626",
  text: "#0f172a",
};

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Compact a VCD bus value (binary string, may contain x/z) to hex when pure.
export function fmtBus(value, width) {
  const v = String(value);
  if (/[xz]/.test(v)) return v.length > 10 ? `${v.slice(0, 9)}…` : v;
  if (/^[01]+$/.test(v)) {
    try {
      const hex = BigInt(`0b${v}`).toString(16);
      const nibbles = Math.max(1, Math.ceil((width || v.length) / 4));
      return `${hex.padStart(nibbles, "0")}`;
    } catch {
      return v;
    }
  }
  return v;
}

// Build [{t0,t1,value}] segments covering [0, endTime] from sorted changes.
export function segments(changes, endTime) {
  if (!changes || !changes.length) return [{ t0: 0, t1: endTime, value: "x" }];
  const segs = [];
  if (changes[0].time > 0) segs.push({ t0: 0, t1: changes[0].time, value: "x" });
  for (let i = 0; i < changes.length; i++) {
    const t0 = changes[i].time;
    const t1 = i + 1 < changes.length ? changes[i + 1].time : Math.max(endTime, t0);
    segs.push({ t0, t1, value: changes[i].value });
  }
  return segs;
}

// Combine per-bit change arrays (MSB-first) into one bus change timeline.
function combineBits(bitsMsbFirst) {
  const times = new Set([0]);
  for (const b of bitsMsbFirst) for (const c of b) times.add(c.time);
  const out = [];
  let last = null;
  for (const t of [...times].sort((a, b) => a - b)) {
    let v = "";
    for (const b of bitsMsbFirst) {
      const bv = valueAt(b, t);
      v += bv === undefined ? "x" : bv;
    }
    if (v !== last) {
      out.push({ time: t, value: v });
      last = v;
    }
  }
  return out;
}

// Turn parseVcd() signals into render tracks, coalescing ModelSim's bit-blasted
// buses (per-bit vars `q [7]`..`q [0]`) back into a single bus track. Each track
// = { name, width, changes }. Honors a `signals` name filter and `maxSignals`.
export function buildTracks(vcd, { signals = null, maxSignals = 40 } = {}) {
  const all = vcd.signals || [];
  let picked;
  const missing = [];
  if (signals && signals.length) {
    picked = [];
    for (const name of signals) {
      const s = all.find((x) => x.full === name || x.ref === name || x.full.endsWith(`.${name}`) || x.ref.replace(/\s+\[[^\]]+\]$/, "") === name);
      if (s) picked.push(s);
      else missing.push(name);
    }
  } else {
    picked = all;
  }

  const tracks = [];
  const busAcc = new Map(); // key -> { name, bits: Map(idx->changes), order }
  for (const s of picked) {
    const m = /^(.+?)\s*\[(\d+)\]$/.exec(s.ref); // single-bit member like "q [7]"
    const scope = s.full.replace(/\s+\[[^\]]+\]$/, "");
    const scopePrefix = scope.includes(".") ? scope.slice(0, scope.lastIndexOf(".") + 1) : "";
    if (s.width === 1 && m) {
      const base = m[1].trim();
      const key = `${scopePrefix}${base}`;
      if (!busAcc.has(key)) {
        busAcc.set(key, { name: base, bits: new Map(), order: tracks.length });
        tracks.push({ __busKey: key });
      }
      busAcc.get(key).bits.set(Number(m[2]), vcd.changes.get(s.code) || []);
    } else {
      tracks.push({ name: s.ref.replace(/\s+\[[^\]]+\]$/, ""), width: s.width, changes: vcd.changes.get(s.code) || [] });
    }
  }
  // Resolve bus placeholders.
  const resolved = tracks.map((t) => {
    if (!t.__busKey) return t;
    const acc = busAcc.get(t.__busKey);
    const idxs = [...acc.bits.keys()].sort((a, b) => b - a); // MSB first
    if (idxs.length === 1) {
      return { name: `${acc.name}[${idxs[0]}]`, width: 1, changes: acc.bits.get(idxs[0]) };
    }
    return { name: acc.name, width: idxs.length, changes: combineBits(idxs.map((i) => acc.bits.get(i))) };
  });
  const truncated = !signals && resolved.length > maxSignals;
  return { tracks: resolved.slice(0, maxSignals), truncated, missing };
}

// Render a digital timing diagram. `vcd` is the parseVcd() result. Options:
//   signals?: string[]  — names to include (default: all, capped at maxSignals)
//   maxSignals?: number — default 40
//   width?: number      — default 1100
//   endTime?: number    — default vcd.endTime
export function renderWaveformSvg(vcd, { signals = null, maxSignals = 40, width = 1100, endTime = null } = {}) {
  const { tracks, truncated, missing } = buildTracks(vcd, { signals, maxSignals });
  const tEnd = Math.max(1, endTime ?? vcd.endTime ?? 0);

  const Lg = 180; // left gutter for names
  const Rm = 28; // right margin
  const Tm = 46; // top margin (title + time axis)
  const Rh = 34; // per-signal row height
  const wh = 18; // wave height within a row
  const W = Math.max(520, width);
  const H = Tm + tracks.length * Rh + 22;
  const x0 = Lg;
  const x1 = W - Rm;
  const xOf = (t) => x0 + ((Math.max(0, Math.min(t, tEnd))) / tEnd) * (x1 - x0);

  const parts = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="Consolas,Menlo,monospace">`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${COLORS.bg}"/>`);
  parts.push(`<rect x="0" y="0" width="${Lg}" height="${H}" fill="${COLORS.panel}"/>`);

  // Time axis (top): ~8 ticks.
  const unit = vcd.timescale ? vcd.timescale.replace(/^1/, "") : "";
  const ticks = 8;
  for (let i = 0; i <= ticks; i++) {
    const t = (tEnd * i) / ticks;
    const x = xOf(t);
    parts.push(`<line x1="${x.toFixed(1)}" y1="${Tm - 8}" x2="${x.toFixed(1)}" y2="${H - 12}" stroke="${COLORS.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${x.toFixed(1)}" y="${Tm - 12}" fill="${COLORS.axis}" font-size="11" text-anchor="middle">${Math.round(t)}${esc(unit)}</text>`);
  }

  tracks.forEach((trk, row) => {
    const yTop = Tm + row * Rh + (Rh - wh) / 2;
    const yBot = yTop + wh;
    const yMid = (yTop + yBot) / 2;
    parts.push(`<text x="12" y="${(yMid + 4).toFixed(1)}" fill="${COLORS.name}" font-size="12">${esc(trk.name)}${trk.width > 1 ? `[${trk.width - 1}:0]` : ""}</text>`);
    const segs = segments(trk.changes, tEnd);
    if (trk.width > 1) {
      // Bus: hex-labelled envelope, one cell per segment.
      for (const s of segs) {
        const a = xOf(s.t0);
        const b = xOf(s.t1);
        if (b - a < 0.5) continue;
        const slope = Math.min(4, (b - a) / 2);
        const bad = /[xz]/.test(String(s.value));
        const stroke = bad ? COLORS.xz : COLORS.bus;
        parts.push(
          `<path d="M${a.toFixed(1)},${yMid.toFixed(1)} L${(a + slope).toFixed(1)},${yTop.toFixed(1)} L${(b - slope).toFixed(1)},${yTop.toFixed(1)} L${b.toFixed(1)},${yMid.toFixed(1)} L${(b - slope).toFixed(1)},${yBot.toFixed(1)} L${(a + slope).toFixed(1)},${yBot.toFixed(1)} Z" fill="${bad ? "#fef2f2" : "#f5f3ff"}" stroke="${stroke}" stroke-width="1.4"/>`
        );
        if (b - a > 18) {
          parts.push(`<text x="${((a + b) / 2).toFixed(1)}" y="${(yMid + 4).toFixed(1)}" fill="${COLORS.text}" font-size="11" text-anchor="middle">${esc(fmtBus(s.value, trk.width))}</text>`);
        }
      }
    } else {
      // 1-bit: step line (high near top, low near bottom; x/z mid in red).
      const pts = [];
      const yFor = (v) => (v === "1" ? yTop : v === "0" ? yBot : yMid);
      for (const s of segs) {
        pts.push(`${xOf(s.t0).toFixed(1)},${yFor(s.value).toFixed(1)}`);
        pts.push(`${xOf(s.t1).toFixed(1)},${yFor(s.value).toFixed(1)}`);
      }
      const anyBad = segs.some((s) => /[xz]/.test(String(s.value)));
      parts.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${anyBad ? COLORS.xz : COLORS.hi}" stroke-width="1.6"/>`);
    }
    parts.push(`<line x1="${x0}" y1="${(yBot + (Rh - wh) / 2).toFixed(1)}" x2="${x1}" y2="${(yBot + (Rh - wh) / 2).toFixed(1)}" stroke="${COLORS.grid}" stroke-width="0.5"/>`);
  });

  parts.push("</svg>");
  return { svg: parts.join("\n"), signalCount: tracks.length, truncated, missing, endTime: tEnd, timescale: vcd.timescale || null };
}

// Wrap an SVG in a minimal standalone HTML page (opened in a browser as the
// "pop up to the user" channel).
export function buildWaveformHtml(svg, { title = "ModelSim waveform" } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{margin:0;background:#0f172a;color:#e2e8f0;font-family:system-ui,Segoe UI,sans-serif}
header{padding:10px 16px;font-size:14px;background:#1e293b;position:sticky;top:0}
.wrap{padding:16px;overflow:auto}svg{background:#fff;border:1px solid #334155;border-radius:6px}</style>
</head><body><header>${esc(title)}</header><div class="wrap">${svg}</div></body></html>`;
}

// Open a file in the OS default app (browser for .html) — the "pop up to the
// user" channel. Detached-ish: run with a short timeout, never blocks the tool.
export async function openInDefaultApp(file) {
  if (process.platform === "win32") return run("cmd", ["/c", "start", "", file], { timeoutSec: 10 });
  if (process.platform === "darwin") return run("open", [file], { timeoutSec: 10 });
  return run("xdg-open", [file], { timeoutSec: 10 });
}

// Render a VCD to <base>.wave.svg + <base>.wave.html beside it (or in outDir),
// returning the paths + inline SVG + render info. Optionally pop the HTML open
// in the user's default browser. Shared by fpga_wave and the sim tools' wave:true.
export async function renderVcdToFiles(vcdPath, { signals = null, outDir = null, maxSignals = 40, width = 1100, title = null, open = false } = {}) {
  const vcd = parseVcd(vcdPath);
  const { svg, ...info } = renderWaveformSvg(vcd, { signals, maxSignals, width });
  const base = basename(vcdPath).replace(/\.[^.]+$/, "");
  const dir = outDir || dirname(vcdPath);
  mkdirSync(dir, { recursive: true });
  const svgPath = join(dir, `${base}.wave.svg`);
  const htmlPath = join(dir, `${base}.wave.html`);
  writeFileSync(svgPath, svg, "utf8");
  writeFileSync(htmlPath, buildWaveformHtml(svg, { title: title || `${base} waveform` }), "utf8");
  let opened = false;
  if (open) {
    try { await openInDefaultApp(htmlPath); opened = true; } catch {}
  }
  return { svgPath, htmlPath, svg, opened, ...info };
}
