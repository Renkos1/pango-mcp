// Waveform renderer unit test (no simulator needed — pure VCD->SVG logic).
import { buildTracks, buildWaveformHtml, fmtBus, renderWaveformSvg, segments } from "../src/core/waveform.mjs";

let fail = false;
const check = (cond, msg, extra) => {
  if (!cond) { console.error(`✗ ${msg}`, extra ?? ""); fail = true; } else console.log(`✓ ${msg}`);
};

// --- fmtBus: binary -> zero-padded hex; x/z passthrough ---
check(fmtBus("1010", 4) === "a", "fmtBus: 1010 -> a", fmtBus("1010", 4));
check(fmtBus("00000001", 8) === "01", "fmtBus: width-padded hex (01)", fmtBus("00000001", 8));
check(fmtBus("10x0", 4) === "10x0", "fmtBus: x kept as-is", fmtBus("10x0", 4));

// --- segments: leading x until first change, last extends to endTime ---
const segA = segments([{ time: 5, value: "1" }, { time: 10, value: "0" }], 20);
check(segA[0].value === "x" && segA[0].t0 === 0 && segA[0].t1 === 5, "segments: leading x [0,5)", segA[0]);
check(segA[segA.length - 1].t1 === 20, "segments: last extends to endTime", segA.at(-1));
check(segments([], 12)[0].value === "x" && segments([], 12)[0].t1 === 12, "segments: no changes -> one x cell", segments([], 12));

// --- renderWaveformSvg on a synthetic 2-signal VCD ---
const vcd = {
  signals: [
    { code: "!", ref: "clk", full: "tb.clk", width: 1 },
    { code: "#", ref: "d", full: "tb.d", width: 4 },
  ],
  changes: new Map([
    ["!", [{ time: 0, value: "0" }, { time: 5, value: "1" }, { time: 10, value: "0" }]],
    ["#", [{ time: 0, value: "0000" }, { time: 5, value: "1010" }]],
  ]),
  timescale: "1ns",
  endTime: 10,
};
const r = renderWaveformSvg(vcd);
check(r.svg.startsWith("<svg") && r.svg.includes("</svg>"), "render: well-formed svg envelope");
check(r.signalCount === 2, "render: 2 signals", r.signalCount);
check(r.svg.includes("tb.clk") || r.svg.includes(">clk<"), "render: signal name present");
check(r.svg.includes("<polyline"), "render: 1-bit clk -> polyline");
check(r.svg.includes("<path"), "render: 4-bit bus -> path envelope");
check(r.svg.includes(">a<"), "render: bus value 1010 shown as hex 'a'");
check(/\dns/.test(r.svg), "render: time axis labelled with unit (ns)");

// --- signal selection + missing report ---
const sel = renderWaveformSvg(vcd, { signals: ["clk", "nope"] });
check(sel.signalCount === 1 && sel.missing.includes("nope"), "render: select by name + report missing", { n: sel.signalCount, missing: sel.missing });

// --- bit-blasted bus coalescing (ModelSim VCD dumps q [3]..q [0] separately) ---
const blastVcd = {
  signals: [
    { full: "tb.clk", ref: "clk", width: 1, code: "c" },
    { full: "tb.q [3]", ref: "q [3]", width: 1, code: "a" },
    { full: "tb.q [2]", ref: "q [2]", width: 1, code: "b" },
    { full: "tb.q [1]", ref: "q [1]", width: 1, code: "d" },
    { full: "tb.q [0]", ref: "q [0]", width: 1, code: "e" },
  ],
  changes: new Map([
    ["c", [{ time: 0, value: "0" }]],
    ["a", [{ time: 0, value: "0" }, { time: 5, value: "1" }]],
    ["b", [{ time: 0, value: "0" }]],
    ["d", [{ time: 0, value: "0" }, { time: 5, value: "1" }]],
    ["e", [{ time: 0, value: "0" }]],
  ]),
  timescale: "1ns", endTime: 10,
};
const bt = buildTracks(blastVcd);
check(bt.tracks.length === 2, "tracks: clk + coalesced q-bus = 2 (not 5 bit rows)", bt.tracks.map((t) => `${t.name}:${t.width}`));
const qT = bt.tracks.find((t) => t.name === "q");
check(qT?.width === 4, "tracks: q coalesced to width 4", qT?.width);
check(qT?.changes.find((c) => c.time === 5)?.value === "1010", "tracks: combined bus value 1010 (MSB-first) at t=5", qT?.changes);
const rB = renderWaveformSvg(blastVcd);
check(rB.signalCount === 2 && rB.svg.includes(">a<"), "render: coalesced bus shows hex 'a' (1010)", rB.signalCount);

// --- html wrapper embeds the svg + title ---
const html = buildWaveformHtml("<svg>x</svg>", { title: "tb wave" });
check(html.includes("<svg>x</svg>") && html.includes("tb wave") && html.startsWith("<!doctype"), "html: wraps svg + title");

console.log(fail ? "\nWAVE-UNIT: FAIL" : "\nWAVE-UNIT: PASS");
process.exit(fail ? 1 : 0);
