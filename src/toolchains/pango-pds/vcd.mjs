// VCD parsing + signal grouping + token-efficient capture summary for FLA waves.
//
// The Fabric Debugger exports a simple VCD: each captured channel is a 1-bit
// `$var wire 1 <id> <name> $end` (names like `DataPort[3]`), and value-change
// lines `#<t>` / `<value><id>`. We parse it, GROUP bit channels into buses
// (so a 16-bit value shows as one row, not 16 wires), and produce a compact
// summary for the AI (ranges/transitions/preview — never the raw N×W matrix).

// Parse VCD text -> { timescale, signals:[{id,name,base,bit}], nSamples, frames:[{t, state:Uint(byId)}] }
export function parseVcd(text) {
  const lines = String(text).split(/\r?\n/);
  const signals = [];
  const byId = new Map();
  let timescale = null;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s.startsWith("$timescale")) {
      timescale = (lines[i + 1] || "").trim() || s.replace("$timescale", "").trim();
    }
    const m = /^\$var\s+wire\s+1\s+(\S+)\s+(\S+)\s*\$end/.exec(s);
    if (m) {
      const name = m[2];
      const bm = /^(.*?)\[(\d+)\]$/.exec(name);
      const sig = { id: m[1], name, base: bm ? bm[1] : name, bit: bm ? Number(bm[2]) : null };
      signals.push(sig);
      byId.set(sig.id, sig);
    }
  }
  // value reconstruction
  const state = new Map(); // id -> 0/1
  for (const sig of signals) state.set(sig.id, 0);
  const frames = [];
  let t = null;
  let started = false;
  const dumpStart = lines.findIndex((l) => l.trim() === "$enddefinitions $end");
  for (let i = dumpStart >= 0 ? dumpStart + 1 : 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    if (s[0] === "#") {
      if (t !== null) frames.push({ t, state: new Map(state) });
      t = Number(s.slice(1));
      started = true;
      continue;
    }
    if (!started) continue;
    const vm = /^([01xz])(\S+)$/.exec(s);
    if (vm && state.has(vm[2])) state.set(vm[2], vm[1] === "1" ? 1 : 0);
  }
  if (t !== null) frames.push({ t, state: new Map(state) });
  return { timescale, signals, nSamples: frames.length, frames };
}

// Group bit-signals into buses by their base name. `alias` optionally renames a
// base (e.g. exported "DataPort" -> meaningful "counter"). Returns groups with a
// per-sample integer value array, plus any ungrouped scalar signals.
export function groupSignals(parsed, { alias = {}, names = null } = {}) {
  const { signals, frames } = parsed;
  const baseMap = new Map(); // base -> [{id,bit}]
  const scalars = [];
  for (const sig of signals) {
    if (sig.bit == null) scalars.push(sig);
    else {
      if (!baseMap.has(sig.base)) baseMap.set(sig.base, []);
      baseMap.get(sig.base).push(sig);
    }
  }
  const groups = [];
  for (const [base, bits] of baseMap) {
    bits.sort((a, b) => a.bit - b.bit);
    const width = Math.max(...bits.map((b) => b.bit)) + 1;
    const values = frames.map((f) => {
      let v = 0;
      for (const b of bits) v += (f.state.get(b.id) ? 1 : 0) << b.bit;
      return v;
    });
    groups.push({
      name: alias[base] || base,
      base,
      width,
      bitNames: bits.map((b) => (names && names[b.bit]) || `${alias[base] || base}[${b.bit}]`),
      bitIds: bits.map((b) => b.id),
      values,
    });
  }
  const scalarSeries = scalars.map((s) => ({ name: s.name, values: frames.map((f) => (f.state.get(s.id) ? 1 : 0)) }));
  return { groups, scalars: scalarSeries };
}

// Compact, token-bounded summary for the AI. No raw per-sample matrix — instead
// ranges, transition counts, monotonicity, and a small downsampled preview.
export function summarizeCapture(parsed, grouped, { previewPoints = 16 } = {}) {
  const n = parsed.nSamples;
  const downsample = (arr) => {
    if (arr.length <= previewPoints) return arr.slice();
    const step = (arr.length - 1) / (previewPoints - 1);
    return Array.from({ length: previewPoints }, (_, i) => arr[Math.round(i * step)]);
  };
  const transitions = (arr) => {
    let c = 0;
    for (let i = 1; i < arr.length; i++) if (arr[i] !== arr[i - 1]) c++;
    return c;
  };
  const groups = grouped.groups.map((g) => {
    const min = Math.min(...g.values);
    const max = Math.max(...g.values);
    let inc = true;
    const mod = 1 << g.width;
    for (let i = 1; i < g.values.length && inc; i++) if (g.values[i] !== (g.values[i - 1] + 1) % mod) inc = false;
    return {
      name: g.name,
      width: g.width,
      min,
      max,
      transitions: transitions(g.values),
      monotonicIncrement: inc,
      firstValue: g.values[0],
      lastValue: g.values[g.values.length - 1],
      previewHex: downsample(g.values).map((v) => "0x" + v.toString(16)),
    };
  });
  return {
    nSamples: n,
    timescale: parsed.timescale,
    channelCount: parsed.signals.length,
    groups,
    scalars: grouped.scalars.map((s) => ({ name: s.name, transitions: transitions(s.values), preview: downsample(s.values) })),
  };
}
