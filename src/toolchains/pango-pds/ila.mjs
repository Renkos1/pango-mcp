// Pango on-chip ILA, MCP-native flow (supersedes raw cdt_ins driving).
//
// Two pure-code-generation primitives:
//   generateFic({ ficPath, part, designInputFile, clockNet, signals, ... })
//     -> writes a `.fic` INI per the format spec.
//   registerFicInPds({ pdsPath, ficPath })
//     -> wires the .fic into the project's Fabric-Inserter widget inside .pds,
//        so the standard `pds_shell -run gen_bit_stream` produces an
//        instrumented bitstream. Handles both PDS 2025.2 XML and the sexpr form.
//
// Rationale: doc/debug-ila.md warns that `cdt_ins` `ins_set_net` is index-based
// and the indices are unstable across processes, so scripted connect-by-index is
// unreliable. The `.fic` is the authoritative authoring form (hand-writable INI),
// generated directly here. The ONE thing this needs is the real post-synth net
// names — discovered by netlist.mjs (run_ads + parse), exposed as
// fpga_ila_list_nets and consumed by fpga_ila_build. (Driving cdt_ins standalone
// to list nets is a dead end: it can't decrypt the project DB — see alog.txt.)

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve as resolvePath } from "node:path";
import { nowStamp } from "../../core/exec.mjs";

const FIC_HEADER = "#Fabric Core Inserter Project File";

function forwardSlash(p) {
  return String(p).replace(/\\/g, "/");
}

// Render a .fic as text. `signals` is an array of post-synth net names (strings).
// busGroups (optional): [{ name, low, high }] for display grouping.
// triggerValue (optional): build-time Match Unit pattern, W chars of X/0/1/R/F/B/N,
// channel 0 = LAST char (the .fic value string is MSB-first: leftmost = highest
// trigger channel index). Defaults to all-X = match-anything (preserves the proven
// always-capture behavior); the runtime JTAG blob overrides it per capture.
export function renderFic({ part, designInputFile, clockNet, signals, dataDepth = 1024, busGroups = [], triggerValue = null }) {
  // Device-agnostic: the part is the board's physical identity, supplied in full
  // by the caller (project/.pds, user, or Target Profile). No field is defaulted.
  const missingPart = ["family", "device", "speedgrade", "package"].filter((f) => !part?.[f]);
  if (missingPart.length) throw new Error(`renderFic: part 不完整，缺 ${missingPart.join("/")}（family/device/speedgrade/package 须完整提供，工具不默认/不猜）`);
  if (!clockNet) throw new Error("renderFic: clockNet required");
  if (!Array.isArray(signals) || signals.length === 0) throw new Error("renderFic: signals[] must be non-empty");

  const W = signals.length;
  const lines = [
    FIC_HEADER,
    `Project.device.designInputFile=${forwardSlash(designInputFile || "")}`,
    "Project.device.ScanChain=1",
    "Project.device.UserJtag=0",
    `Project.device.deviceFamily=${part.family}`,
    `Project.device.deviceModel=${part.device}`,
    `Project.device.devicePackage=${part.package}`,
    `Project.device.deviceSpeedGrade=${part.speedgrade}`,
    "Project.Architecture=1 1 1",
    "Project.unit.dimension=1",
    `Project.unit<0>.clockChannel=${clockNet}`,
    "Project.unit<0>.clockEdge=Rising",
    "Project.unit<0>.ramType=1",
    `Project.unit<0>.dataDepth=${Number(dataDepth) || 1024}`,
    "Project.unit<0>.dataEqualsTrigger=true",
    "Project.unit<0>.enableStorageQualification=false",
    "Project.unit<0>.triggerSequencerLevels=1",
    "Project.unit<0>.enableMultiWindow=false",
    "Project.unit<0>.triggerPortCount=1",
  ];
  for (let i = 0; i < W; i += 1) lines.push(`Project.unit<0>.triggerChannel<0><${i}>=${signals[i]}`);
  lines.push(
    "Project.unit<0>.triggerMatchCount<0>=1",
    "Project.unit<0>.triggerMatchCountWidth<0>=0",
    "Project.unit<0>.triggerMatchType<0>=1",   // 1 = Basic w/Edges (supports level + R/F)
    "Project.unit<0>.triggerPortIsData<0>=true",
    `Project.unit<0>.triggerPortWidth<0>=${W}`
  );
  for (const g of busGroups || []) {
    if (!g?.name) continue;
    lines.push(`Project.unit<0>.triggerBus<0><${Number(g.low)}><${Number(g.high)}>=${g.name}`);
    lines.push(`Project.unit<0>.busInserter<0><0>=${g.name}`);
  }
  // Match Unit + Trigger Condition. Without these the inserter builds a trigger
  // PORT with no usable comparator/condition — the core can only free-run, so a
  // runtime value trigger never engages (HW-proven 2026-06-23; see jtag/FINDINGS).
  // This block mirrors a GUI-configured .fic: one match unit (== / Function 0),
  // binary radix, condition = TU0. Default value = all-X (match anything), runtime-
  // overridable via the JTAG ila_cmd blob.
  const value = (typeof triggerValue === "string" && triggerValue.length === W)
    ? triggerValue
    : "X".repeat(W);
  lines.push(
    "Project.unit<0>.MatchUnitFunction<0>=0",            // 0 = "=="
    `Project.unit<0>.MatchUnitValue<0>=${value}`,
    "Project.unit<0>.MatchUnitRadix<0>=0",               // 0 = binary
    "Project.unit<0>.MatchUnitCounterType<0>=0",
    "Project.unit<0>.MatchUnitCounterCycles<0>=1",
    "Project.unit<0>.TriggerConditionType<0>=1",
    "Project.unit<0>.TriggerCondition<0>=TU0",
    "Project.unit<0>.TriggerConditionName<0>=",
    "Project.unit<0>.StorageType=0",
    "Project.unit<0>.StorageWindows=1",
    "Project.unit<0>.StoragePosition=0",
    `Project.unit<0>.StorageSamples=${Number(dataDepth) || 1024}`,
    "Project.unit<0>.StorageEquation=All Data"
  );
  return lines.join("\n") + "\n";
}

export function generateFic({ ficPath, part, designInputFile, clockNet, signals, dataDepth = 1024, busGroups = [] }) {
  const abs = resolvePath(ficPath);
  const body = renderFic({ part, designInputFile, clockNet, signals, dataDepth, busGroups });
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  return { ficPath: abs, width: signals.length, dataDepth, clockNet, bytes: Buffer.byteLength(body, "utf8"), preview: body.split("\n").slice(0, 14).join("\n") };
}

function timespec() {
  return new Date().toISOString().replace(/\.\d+Z$/, "");
}

// Register a .fic into the project's Fabric-Inserter widget.
// Returns { pdsPath, ficPath, relFic, format, backup }.
export function registerFicInPds({ pdsPath, ficPath }) {
  const orig = readFileSync(pdsPath, "utf8");
  const isXml = /^\s*<\?xml|<project\s/.test(orig);
  const backup = `${pdsPath}.bak_${nowStamp()}`;
  copyFileSync(pdsPath, backup);
  if (isXml) {
    const updated = patchPdsXml(orig, pdsPath, ficPath);
    writeFileSync(pdsPath, updated, "utf8");
    return { pdsPath, ficPath, relFic: relative(dirname(pdsPath), ficPath).replace(/\\/g, "/"), format: "xml", backup };
  }
  const updated = patchPdsSexpr(orig, pdsPath, ficPath);
  writeFileSync(pdsPath, updated, "utf8");
  return { pdsPath, ficPath, relFic: relative(dirname(pdsPath), ficPath).replace(/\\/g, "/"), format: "sexpr", backup };
}

// PDS 2025.2 XML: rewrite the <action name="fic"> widget to carry our .fic as an
// <inputs><item type="FILE" .../></inputs>. We keep the widget id stable so the
// project's inner cross-references don't drift; we replace the whole block so a
// previously-registered file is cleanly superseded.
function patchPdsXml(orig, pdsPath, ficPath) {
  const relFic = relative(dirname(pdsPath), ficPath).replace(/\\/g, "/");
  const re = /<action\s+[^>]*\sname="fic"[^>]*>[\s\S]*?<\/action>/;
  const m = re.exec(orig);
  if (!m) throw new Error('未在 .pds 找到 Fabric-Inserter widget(<action name="fic" .../>); 可能不是标准 PDS XML 工程');
  const idMatch = /id="([^"]+)"/.exec(m[0]);
  const ficId = idMatch ? idMatch[1] : "fic_8";
  const ts = timespec();
  const block =
    `<action act_type="widget" id="${ficId}" name="fic" title="Fabric Inserter">\n` +
    `                <state name="state" value="INVALID"/>\n` +
    `                <options/>\n` +
    `                <arguments/>\n` +
    `                <inner_options>\n` +
    `                    <inner name="object_id" type="string" value="${ficId}"/>\n` +
    `                </inner_options>\n` +
    `                <inputs>\n` +
    `                    <item type="FILE" file="${relFic}" format="text" timespec="${ts}" library="work">\n` +
    `                        <options>\n` +
    `                            <option name="format" type="string" value="text"/>\n` +
    `                            <option name="library" type="string" value="work"/>\n` +
    `                        </options>\n` +
    `                    </item>\n` +
    `                </inputs>\n` +
    `            </action>`;
  return orig.replace(re, block);
}

// Minimal sexpr form (newly-created projects, before any pds_shell run rewrites
// them to XML): add a (_widget wgt_my_fic_src ...) into (_task tsk_synthesis ...).
// If one already exists, replace its file reference; otherwise append before the
// task's closing parenthesis.
function patchPdsSexpr(orig, pdsPath, ficPath) {
  const relFic = relative(dirname(pdsPath), ficPath).replace(/\\/g, "/");
  const ts = timespec();
  const widget = `(_widget wgt_my_fic_src (_input (_file "${relFic}" (_format text)(_timespec "${ts}"))))`;
  // Locate the tsk_synthesis task by balanced parens.
  const startIdx = orig.indexOf("(_task tsk_synthesis");
  if (startIdx < 0) throw new Error("未在 .pds(sexpr) 找到 (_task tsk_synthesis ...); 可能不是标准 PDS 工程");
  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx; i < orig.length; i += 1) {
    if (orig[i] === "(") depth += 1;
    else if (orig[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx < 0) throw new Error("(_task tsk_synthesis ...) 括号不平衡");
  const block = orig.slice(startIdx, endIdx + 1);
  let newBlock;
  const wStart = block.search(/\(_widget\s+wgt_my_fic_src/);
  if (wStart >= 0) {
    // Replace the existing widget by its BALANCED span (it nests 3 levels:
    // widget>input>file>(format)(timespec) — a regex can't match that reliably).
    let d = 0;
    let wEnd = -1;
    for (let i = wStart; i < block.length; i += 1) {
      if (block[i] === "(") d += 1;
      else if (block[i] === ")") {
        d -= 1;
        if (d === 0) { wEnd = i; break; }
      }
    }
    newBlock = wEnd >= 0 ? block.slice(0, wStart) + widget + block.slice(wEnd + 1) : block.slice(0, -1) + "\n        " + widget + ")";
  } else {
    newBlock = block.slice(0, -1) + "\n        " + widget + ")";
  }
  return orig.slice(0, startIdx) + newBlock + orig.slice(endIdx + 1);
}

export function ficExists(p) {
  return existsSync(p);
}
