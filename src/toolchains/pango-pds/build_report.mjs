// Generate a self-contained build-report viewer (one .html file) from a PDS
// build result — for the USER to inspect: stage/pass-fail, timing, resource
// utilization (bars), and any errors/warnings. Defensive about missing fields
// (PDS results vary by stage). Same flat dark/light aesthetic as the waveform
// viewer.

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Pull resource rows out of whatever utilization shape PDS produced.
function utilRows(result) {
  const rows = [];
  const u = result.utilization;
  if (u && typeof u === "object" && !Array.isArray(u)) {
    for (const [k, v] of Object.entries(u)) {
      if (v && typeof v === "object" && (v.used != null || v.total != null)) rows.push({ name: k, used: Number(v.used) || 0, total: Number(v.total) || 0, pct: v.total ? (100 * v.used) / v.total : null });
      else if (typeof v === "number") rows.push({ name: k, used: v, total: 0, pct: null });
    }
  }
  // some results carry top-level resource summaries (FF/LUT/etc.)
  for (const key of ["FF", "LUT", "DRM", "BRAM", "DSP", "USCM"]) {
    const v = result[key];
    if (v && typeof v === "object" && (v.used != null || v.after != null)) rows.push({ name: key, used: Number(v.used ?? v.after) || 0, total: Number(v.total) || 0, pct: v.total ? (100 * (v.used ?? v.after)) / v.total : null });
  }
  return rows;
}

export function renderBuildReportHtml(result, { title = "PDS build report" } = {}) {
  const ok = result.ok;
  const errors = result.errors || [];
  const warnings = (result.warnings && result.warnings.samples) || [];
  const rows = utilRows(result);
  const chips = [
    ["stage", result.stage],
    ["result", ok ? "pass" : "fail"],
    ["timing", result.timing ? (result.timing.met === true ? "met" : result.timing.met === false ? "violated" : "—") + (result.timing.worst != null ? ` (${result.timing.worst})` : "") : null],
    ["duration", result.durationMs != null ? Math.round(result.durationMs / 1000) + "s" : null],
    ["errors", errors.length || (result.errorCount ?? 0)],
    ["bitstream", result.artifacts && result.artifacts.sbit ? "yes" : null],
  ].filter((c) => c[1] != null && c[1] !== "");

  const chipHtml = chips
    .map((c) => {
      const danger = (c[0] === "result" && !ok) || (c[0] === "errors" && Number(c[1]) > 0) || c[1] === "violated";
      const good = (c[0] === "result" && ok) || c[1] === "met";
      const cls = danger ? "bad" : good ? "good" : "";
      return `<span class="chip ${cls}">${esc(c[0])} <b>${esc(c[1])}</b></span>`;
    })
    .join("");

  const barHtml = rows.length
    ? rows
        .map((r) => {
          const pct = r.pct != null ? Math.min(100, Math.round(r.pct)) : null;
          const label = r.total ? `${r.used} / ${r.total}` + (pct != null ? ` (${pct}%)` : "") : `${r.used}`;
          return `<div class="row"><div class="rn">${esc(r.name)}</div><div class="bar"><div class="fill" style="width:${pct ?? 0}%"></div></div><div class="rv">${esc(label)}</div></div>`;
        })
        .join("")
    : `<div class="muted">no resource utilization parsed</div>`;

  const listHtml = (arr, cls) => (arr.length ? `<ul class="${cls}">` + arr.map((e) => `<li>${esc(e)}</li>`).join("") + "</ul>" : `<div class="muted">none</div>`);

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0d1117;color:#c9d1d9;padding:18px;line-height:1.6}
h1{font-size:16px;margin:0 0 12px}h2{font-size:13px;color:#8b949e;text-transform:uppercase;letter-spacing:.04em;margin:20px 0 8px;font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:4px 10px;font-size:12px;color:#8b949e}
.chip b{color:#e6edf3}.chip.good b{color:#3fb950}.chip.bad b{color:#f85149}
.row{display:flex;align-items:center;gap:10px;margin:5px 0;font-size:12px}
.rn{width:90px;color:#8b949e;font-family:ui-monospace,monospace}
.bar{flex:1;height:14px;background:#161b22;border-radius:4px;overflow:hidden;border:1px solid #21262d}
.fill{height:100%;background:#1f6feb}
.rv{width:150px;text-align:right;font-variant-numeric:tabular-nums;color:#c9d1d9}
ul{margin:0;padding-left:18px}ul.err li{color:#f85149}ul.warn li{color:#d29922}li{font-size:12px;font-family:ui-monospace,monospace;margin:2px 0}
.muted{color:#6e7681;font-size:12px}
@media(prefers-color-scheme:light){body{background:#fff;color:#1f2328}.chip{background:#f6f8fa;border-color:#d0d7de;color:#57606a}.chip b{color:#1f2328}.bar{background:#eaeef2;border-color:#d0d7de}.rn,.muted{color:#57606a}h2{color:#57606a}}
</style></head><body>
<h1>${esc(title)}</h1>
<div class="chips">${chipHtml}</div>
<h2>resource utilization</h2>${barHtml}
<h2>errors (${errors.length || result.errorCount || 0})</h2>${listHtml(errors, "err")}
<h2>warnings (${(result.warnings && result.warnings.realCount) ?? warnings.length})</h2>${listHtml(warnings, "warn")}
</body></html>`;
}
