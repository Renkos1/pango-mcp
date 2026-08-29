// The device-write gate, in its own module because both the generic CDT entry
// points (index.mjs) and the ILA capture path (ila_capture.mjs) have to consult
// it, and importing index.mjs from ila_capture.mjs would close an import cycle.
//
// What it decides: whether a script about to run on the device would MUTATE it
// (configure, flash, blow efuses). Anything it names requires confirm:true plus
// a matching expectIdcode read back from a real scan first.

// Matching these against free text is only sound while the command names in that
// text are literal. Tcl can build a name at run time, so the callers restrict
// what they accept before relying on this — see validateCdtCommands.
const MUTATING_CDT = [
  /\bcfg_program\b/i,
  /\bcfg_jtag_flash_(erase|program)\b/i,
  /\bcfg_flash_(erase|program)\b/i,
  /\bcfg_efuse_program\b/i,
  /\bdbg_program\b/i,
];

// Return the distinct device-mutating commands found in a script (empty => read-only).
export function detectMutatingCdt(text) {
  const found = [];
  for (const re of MUTATING_CDT) {
    const m = re.exec(String(text || ""));
    if (m) found.push(m[0].toLowerCase());
  }
  return [...new Set(found)];
}
