// Backend-agnostic VCD waveform parsing + logic-value comparison helpers.
// Used by the assertion tool (the closed-loop "ruler"); independent of any
// particular simulator backend.

import { readText } from "./exec.mjs";

export function parseVcd(vcdPath) {
  const text = readText(vcdPath);
  const scopes = [];
  const signals = new Map();
  const changes = new Map();
  const tsM = /\$timescale\s+([^$]+?)\s*\$end/.exec(text);
  const timescale = tsM ? tsM[1].replace(/\s+/g, "") : null;
  let lastTime = 0;
  let inDefinitions = true;
  let time = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (inDefinitions) {
      const scope = /^\$scope\s+\S+\s+(\S+)/.exec(line);
      if (scope) scopes.push(scope[1]);
      if (/^\$upscope\b/.test(line)) scopes.pop();
      const v = /^\$var\s+\S+\s+(\d+)\s+(\S+)\s+(.+?)\s+\$end/.exec(line);
      if (v) {
        const [, width, code, ref] = v;
        // Strip the iverilog VCD wrapper scope fpga_sim injects
        // (__fpga_vcd_wrapper.__dut) so signal names surface as the user's own
        // hierarchy, not a harness artifact. No-op for ModelSim/other VCDs.
        let full = [...scopes, ref].join(".").replace(/^__fpga_vcd_wrapper\.__dut\.?/, "").replace(/^__fpga_vcd_wrapper\.?/, "");
        if (!full) full = ref;
        signals.set(full, { code, ref, full, width: Number(width) });
        changes.set(code, []);
      }
      if (/^\$enddefinitions\b/.test(line)) inDefinitions = false;
      continue;
    }
    if (line.startsWith("#")) {
      time = Number(line.slice(1));
      if (time > lastTime) lastTime = time;
      continue;
    }
    let value;
    let code;
    if (/^[01xXzZ]/.test(line[0])) {
      value = line[0].toLowerCase();
      code = line.slice(1);
    } else {
      const m = /^([bBrR])([^\s]+)\s+(\S+)/.exec(line);
      if (!m) continue;
      value = m[2].toLowerCase();
      code = m[3];
    }
    if (!changes.has(code)) changes.set(code, []);
    changes.get(code).push({ time, value });
  }
  return { signals: [...signals.values()], changes, timescale, endTime: lastTime };
}

export function findVcdSignal(vcd, name) {
  return vcd.signals.find(
    (s) => s.full === name || s.ref === name || s.full.endsWith(`.${name}`) || s.ref.replace(/\s+\[[^\]]+\]$/, "") === name
  );
}

export function parseLogicValue(value) {
  if (typeof value === "number") return BigInt(value);
  const s = String(value).toLowerCase().replace(/_/g, "");
  if (/^0x[0-9a-f]+$/.test(s)) return BigInt(s);
  if (/^0b[01]+$/.test(s)) return BigInt(`0b${s.slice(2)}`);
  const sizedBin = /^\d+'b([01]+)$/.exec(s);
  if (sizedBin) return BigInt(`0b${sizedBin[1]}`);
  if (/^[01]+$/.test(s)) return BigInt(`0b${s}`);
  if (/^\d+$/.test(s)) return BigInt(s);
  return null;
}

export function compareLogicValue(actual, expected) {
  const a = String(actual).toLowerCase().replace(/_/g, "");
  const e = String(expected).toLowerCase().replace(/_/g, "");
  if (/[xz]/.test(a) || /[xz]/.test(e)) return a === e.replace(/^0b/, "").replace(/^\d+'b/, "");
  const av = parseLogicValue(actual);
  const ev = parseLogicValue(expected);
  return av !== null && ev !== null ? av === ev : a === e;
}

export function valueAt(changes, at) {
  if (!changes?.length) return undefined;
  if (at === undefined || at === null) return changes[changes.length - 1].value;
  let seen;
  for (const c of changes) {
    if (c.time <= Number(at)) seen = c.value;
    else break;
  }
  return seen;
}
