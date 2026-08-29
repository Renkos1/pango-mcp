// Structured parser for Pango PDS `report_power` output (.ppr) — R2.
//
// The .ppr is a stack of pipe-delimited tables, each shaped:
//   |---------------------|
//   |        Title        |   (single cell)
//   |---------------------|
//   |col a |col b |col c   |   (header row)
//   |---------------------|
//   |val   |val   |val     |   (0+ data rows)
//   |---------------------|
// We pull out the Power Summary (total/static/margins), the per-device-type
// breakdown, per-rail draw, per-module hierarchy, and the confidence levels —
// and flag low-confidence (activity-underspecified) estimates so the agent does
// not treat a default-activity power number as trustworthy.

function splitRow(line) {
  return String(line).split("|").slice(1, -1).map((c) => c.trim());
}
function isSep(line) {
  return /^\|-+\|$/.test(String(line).trim());
}
function pnum(s) {
  if (s == null) return null;
  const t = String(s).replace(/^</, "").trim(); // "< 0.001" -> "0.001"
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
const round = (x) => Number(x.toFixed(6));

// Find the table whose single-cell title line equals `title`; return its column
// header names + data rows (cells).
function table(lines, title) {
  let i = lines.findIndex((l) => {
    const c = splitRow(l);
    return c.length === 1 && c[0] === title;
  });
  if (i < 0) return null;
  i += 1;
  while (i < lines.length && isSep(lines[i])) i += 1; // sep(s) after title
  if (i >= lines.length) return null;
  const headers = splitRow(lines[i]);
  i += 1;
  while (i < lines.length && isSep(lines[i])) i += 1; // sep after header
  const rows = [];
  for (; i < lines.length; i += 1) {
    if (isSep(lines[i])) break;
    if (!lines[i].includes("|")) break; // left the table region
    const cells = splitRow(lines[i]);
    if (cells.length === headers.length) rows.push(cells); // else: stray blank pipe row, skip
  }
  return { headers, rows };
}

// First data row of a table as a header->value object (for the 1-row tables).
function rowObject(lines, title) {
  const t = table(lines, title);
  if (!t || !t.rows[0]) return {};
  return Object.fromEntries(t.headers.map((h, i) => [h, t.rows[0][i]]));
}

export function parsePower(text) {
  const lines = String(text || "").split(/\r?\n/);

  const ds = rowObject(lines, "Device Settings");
  const header = {
    family: ds["Family"] ?? null,
    device: ds["Device"] ?? null,
    package: ds["Package"] ?? null,
    speedGrade: ds["Speed Grade"] ?? null,
    tempGrade: ds["Temp Grade"] ?? null,
    process: ds["Process"] ?? null,
    powerModel: ds["Power Model"] ?? null,
    confidenceLevel: ds["Confidence Level"] ?? null,
  };

  const ps = rowObject(lines, "Power Summary");
  const summary = {
    totalOnChip: pnum(ps["Total On Chip Power"]),
    static: pnum(ps["Static Power"]),
    external: pnum(ps["External Power"]),
    junctionTemp: pnum(ps["Junction Temperature"]),
    thermalMargin: pnum(ps["Thermal Margin"]),
    powerMargin: pnum(ps["Power Margin"]),
  };
  const dynamicPower =
    summary.totalOnChip != null && summary.static != null ? round(summary.totalOnChip - summary.static) : null;

  const cd = table(lines, "Confidence Level Details");
  const confidence = cd ? cd.rows.map((r) => ({ name: r[0], level: r[1], msg: r[2] })) : [];
  const lowConfidence =
    confidence.some((c) => /medium|low/i.test(c.level)) || /medium|low/i.test(header.confidenceLevel || "");

  const ld = table(lines, "Logic Device Summary");
  const logicDevice = ld ? ld.rows.map((r) => ({ device: r[0], power: pnum(r[1]), percent: pnum(r[2]) })) : [];

  const pr = table(lines, "Power Rail Summary");
  const powerRail = pr
    ? pr.rows.map((r) => ({ rail: r[0], voltage: pnum(r[1]), current: pnum(r[2]), externalCurrent: pnum(r[3]), onChipPower: pnum(r[4]) }))
    : [];

  const ph = table(lines, "Power Hierarchy Summary");
  const hierarchy = ph
    ? ph.rows.map((r) => ({ utilizationW: pnum(r[0]), name: r[1], net: pnum(r[2]), clock: pnum(r[3]), clm: pnum(r[4]), io: pnum(r[5]) }))
    : [];

  const note = lowConfidence
    ? "动态功耗为低置信估计：活动率/内部节点未充分指定（confidence<High），数值偏静态主导；要可信功耗请提供活动率/SAIF 或设 SCBV。"
    : undefined;

  return { header, summary, dynamicPower, confidence, lowConfidence, logicDevice, powerRail, hierarchy, note };
}
