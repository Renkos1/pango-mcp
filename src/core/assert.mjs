// Backend-agnostic declarative assertion evaluation over a sim log and/or a
// parsed VCD. Shared by fpga_assert (the standalone judge) and the sim tools'
// `assertions` composite (one call -> compile+sim+judge). Pure: takes the log
// text + a parseVcd() result + the assertion list, returns per-assertion results.

import { compareLogicValue, findVcdSignal, parseLogicValue, valueAt } from "./vcd.mjs";

export function evaluateAssertions({ log = "", vcd = null, assertions = [] }) {
  return assertions.map((a, index) => {
    const name = a.name || `assertion_${index + 1}`;
    try {
      if (a.type === "log_contains" || a.type === "log_not_contains") {
        const found = log.includes(a.pattern || "");
        const ok = a.type === "log_contains" ? found : !found;
        return { name, type: a.type, ok, detail: ok ? "ok" : `pattern ${found ? "unexpectedly found" : "not found"}: ${a.pattern}` };
      }
      if (a.type === "log_regex" || a.type === "log_not_regex") {
        const re = new RegExp(a.pattern || "", a.flags || "");
        const found = re.test(log);
        const ok = a.type === "log_regex" ? found : !found;
        return { name, type: a.type, ok, detail: ok ? "ok" : `regex ${found ? "unexpectedly matched" : "did not match"}: ${a.pattern}` };
      }
      if (!vcd) return { name, type: a.type, ok: false, detail: "VCD assertion requires a VCD" };
      const sig = findVcdSignal(vcd, a.signal || "");
      if (!sig) return { name, type: a.type, ok: false, detail: `signal not found: ${a.signal}` };
      const changes = vcd.changes.get(sig.code) || [];
      if (a.type === "vcd_never_eq") {
        const hit = changes.find((c) => compareLogicValue(c.value, a.value));
        return { name, type: a.type, ok: !hit, signal: sig.full, detail: hit ? `matched ${a.value} at ${hit.time}` : "ok" };
      }
      const actual = valueAt(changes, a.type === "vcd_at_eq" ? a.time : undefined);
      const ok = actual !== undefined && compareLogicValue(actual, a.value);
      // Echo a decimal reading of a multi-bit value so the agent doesn't misread
      // a raw binary string (e.g. "101") as the decimal number one-hundred-one.
      const actualBig = actual === undefined ? null : parseLogicValue(actual);
      const actualDec =
        actualBig !== null && String(actual).length > 1 && !/[xz]/i.test(String(actual)) && String(actualBig) !== String(actual) ? String(actualBig) : undefined;
      return { name, type: a.type, ok, signal: sig.full, actual, ...(actualDec !== undefined ? { actualDec } : {}), expected: String(a.value), detail: ok ? "ok" : "value mismatch" };
    } catch (err) {
      return { name, type: a.type, ok: false, detail: err.message };
    }
  });
}

export const ASSERTION_TYPES = ["log_contains", "log_not_contains", "log_regex", "log_not_regex", "vcd_final_eq", "vcd_at_eq", "vcd_never_eq"];
