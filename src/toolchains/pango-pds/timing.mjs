// Structured parser for Pango PDS `report_timing` output (.rtr) — R1.
//
// The .rtr is a sequence of titled tables (Clock Summary / Clock Groups /
// Performance Summary / then per-corner Setup|Hold|Recovery|Removal|Skew|
// MinPulseWidth), each shaped:
//
//   <Title>:
//   ************************...
//   <column headers, 1-2 lines>
//   ------------------------...
//   <0+ data rows>
//   ========================...
//
// We parse it into a structured object so the agent gets per-clock Fmax,
// per-corner worst slack, failing-endpoint counts and a real met/violated
// verdict — instead of the old regex that scraped WNS/TNS out of free text.

const DASH = /^-{10,}/;
const EQ = /^={10,}/;

function num(s) {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Frequency value + unit (e.g. "705.7163 MHz") normalized to MHz.
function toMHz(value, unit) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  switch ((unit || "MHz").toUpperCase()) {
    case "GHZ": return v * 1000;
    case "KHZ": return v / 1000;
    case "HZ": return v / 1e6;
    default: return v; // MHz
  }
}

function header(lines) {
  const grab = (re) => {
    for (const l of lines) {
      const m = re.exec(l);
      if (m) return m[1].trim();
    }
    return null;
  };
  return {
    toolVersion: grab(/\|\s*Tool Version\s*:\s*(.+)/),
    design: grab(/\|\s*Design\s*:\s*(.+)/),
    device: grab(/\|\s*Device\s*:\s*(.+)/),
    speedGrade: grab(/\|\s*Speed Grade\s*:\s*(.+)/),
    package: grab(/\|\s*Package\s*:\s*(.+)/),
  };
}

// A line that begins a *new* report section (so it terminates the current one).
// Used to bound a section in the compact "summary-only" layout, where PDS omits
// the ****/----/==== rules that normally close a table — without it, e.g. the
// Setup table would bleed into the following Hold rows.
const SECTION_BOUNDARY =
  /(?:Summary|Groups)\s*(?:\([^)]*\))?\s*:\s*$|^Design Summary\b|^Slack\s*\(|^Startpoint\b|^(?:Slow|Fast) Corner\s*$|^Inputs and Outputs\b|^Flow Command\b/i;

// Data rows of the first section whose title line matches `titleRe`. The full PDS
// layout fences the table as `****` / column headers / `----` / data / `====`, so
// the data is everything between the `----` rule and the closing `====`. The
// compact summary-only layout drops those rules; there the section runs from the
// title to the next section heading (or a blank line / `====`), and the leading
// column-header line is left for the per-row parsers to reject.
function sectionRows(lines, titleRe) {
  const start = lines.findIndex((l) => titleRe.test(l));
  if (start < 0) return [];
  // Walk to the section's end, remembering the last `----` rule seen on the way.
  let end = start + 1;
  let dash = -1;
  for (; end < lines.length; end += 1) {
    const t = lines[end].trim();
    if (EQ.test(t)) break; // closing `====` (full layout)
    if (DASH.test(t)) {
      dash = end;
      continue;
    }
    if (!t || SECTION_BOUNDARY.test(t)) break; // blank / next heading (compact layout)
  }
  // Full layout: data is strictly after the `----`. Compact layout (no rule):
  // everything after the title, header rows filtered out downstream.
  const out = [];
  for (let i = dash >= 0 ? dash + 1 : start + 1; i < end; i += 1) {
    if (lines[i].trim()) out.push(lines[i]);
  }
  return out;
}

function stripBraces(s) {
  return s ? s.replace(/^\{|\}$/g, "").trim() : s;
}

// Clock Summary: name | period | {waveform} | type | clockLoads | nonClkLoads | {sources}
function parseClock(line) {
  const m = /^\s*(\S+)\s+([\d.]+)\s+(\{[^}]*\})\s+(\S+)\s+(\d+)\s+(\d+)\s+(\{[^}]*\}|\S+)/.exec(line);
  if (!m) return null;
  return {
    name: m[1],
    period: num(m[2]),
    waveform: m[3],
    type: m[4],
    clockLoads: num(m[5]),
    nonClockLoads: num(m[6]),
    sources: stripBraces(m[7]),
  };
}

// Performance Summary: clock | reqFreq unit | estFreq unit | reqPeriod | estPeriod | slack
function parsePerf(line) {
  const m = /^\s*(\S+)\s+([\d.]+)\s*([kMG]?Hz)\s+([\d.]+)\s*([kMG]?Hz)\s+([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)/.exec(line);
  if (!m) return null;
  return {
    clock: m[1],
    reqFreqMHz: toMHz(m[2], m[3]),
    estFreqMHz: toMHz(m[4], m[5]),
    reqPeriod: num(m[6]),
    estPeriod: num(m[7]),
    slack: num(m[8]),
  };
}

// Setup/Hold/Recovery/Removal/Skew: launch | capture | W*S | T*S | failing | total
function parsePathRow(line) {
  const m = /^\s*(\S+)\s+(\S+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(\d+)\s+(\d+)/.exec(line);
  if (!m) return null;
  return { launch: m[1], capture: m[2], worstSlack: num(m[3]), totalNegSlack: num(m[4]), failingEndpoints: num(m[5]), totalEndpoints: num(m[6]) };
}

// Minimum Pulse Width: clock | WPWS | TPWS | failing | total (single clock column)
function parseMpwRow(line) {
  const m = /^\s*(\S+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(\d+)\s+(\d+)/.exec(line);
  if (!m) return null;
  return { clock: m[1], worstSlack: num(m[2]), totalNegSlack: num(m[3]), failingEndpoints: num(m[4]), totalEndpoints: num(m[5]) };
}

function corner(lines, title, rowFn) {
  const slow = sectionRows(lines, new RegExp(`^${title}\\(Slow Corner\\)`)).map(rowFn).filter(Boolean);
  const fast = sectionRows(lines, new RegExp(`^${title}\\(Fast Corner\\)`)).map(rowFn).filter(Boolean);
  return { slow: { rows: slow }, fast: { rows: fast } };
}

function minSlack(...rowSets) {
  const vals = rowSets.flat().map((r) => r.worstSlack).filter((v) => typeof v === "number");
  return vals.length ? Math.min(...vals) : null;
}

// Parse the per-path detail blocks (in the "Slow/Fast Corner" detail sections):
// each begins "Startpoint  : ..." and ends with "Slack (MET|VIOLATED) <value>".
// Returns the worst paths the report chose to expand (start/end/slack/levels) —
// the actionable "where does timing fail" detail, not the full delay table.
function parsePaths(text) {
  const blocks = String(text || "").split(/^Startpoint\s*:/m).slice(1);
  const grab = (b, re) => {
    const m = re.exec(b);
    return m ? m[1].trim() : null;
  };
  return blocks
    .map((b) => {
      const sl = /Slack\s*\((MET|VIOLATED|FAILED)\)\s*(-?[\d.]+)/i.exec(b);
      const ll = /Logic Levels:\s*(\d+)/.exec(b);
      return {
        startpoint: grab(b, /^\s*(.+)/),
        endpoint: grab(b, /Endpoint\s*:\s*(.+)/),
        pathGroup: grab(b, /Path Group\s*:\s*(.+)/),
        pathType: grab(b, /Path Type\s*:\s*(.+)/),
        logicLevels: ll ? Number(ll[1]) : null,
        slack: sl ? Number(sl[2]) : null,
        status: sl ? sl[1].toUpperCase() : null,
      };
    })
    .filter((p) => p.startpoint && p.slack !== null);
}

export function parseRtr(text) {
  const lines = String(text || "").split(/\r?\n/);
  const designSummary = (() => {
    const m = lines.map((l) => /Design Summary\s*:\s*(.+)/.exec(l)).find(Boolean);
    return m ? m[1].trim() : null;
  })();

  const clocks = sectionRows(lines, /^\s*Clock Summary:/).map(parseClock).filter(Boolean);
  const clockGroups = sectionRows(lines, /^\s*Clock Groups:/)
    .map((l) => {
      const m = /^\s*(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(l);
      return m ? { group: m[1], type: m[2], clocks: m[3].trim() } : null;
    })
    .filter(Boolean);
  const performance = sectionRows(lines, /^\s*Performance Summary:/).map(parsePerf).filter(Boolean);

  const checks = {
    setup: corner(lines, "Setup Summary", parsePathRow),
    hold: corner(lines, "Hold Summary", parsePathRow),
    recovery: corner(lines, "Recovery Summary", parsePathRow),
    removal: corner(lines, "Removal Summary", parsePathRow),
    skew: corner(lines, "Skew Summary", parsePathRow),
    minPulseWidth: corner(lines, "Minimum Pulse Width Summary", parseMpwRow),
  };

  const allRows = Object.values(checks).flatMap((c) => [...c.slow.rows, ...c.fast.rows]);
  const failingEndpoints = allRows.reduce((s, r) => s + (r.failingEndpoints || 0), 0);
  const worstSetupSlack = minSlack(checks.setup.slow.rows, checks.setup.fast.rows);
  const worstHoldSlack = minSlack(checks.hold.slow.rows, checks.hold.fast.rows);

  const paths = parsePaths(text);
  const failingPaths = paths
    .filter((p) => p.status === "VIOLATED" || p.status === "FAILED" || (typeof p.slack === "number" && p.slack < 0))
    .sort((a, b) => a.slack - b.slack); // most-negative (worst) first, regardless of report order

  const summaryMet = /all constraints met/i.test(designSummary || "");
  const noNegative =
    (worstSetupSlack === null || worstSetupSlack >= 0) && (worstHoldSlack === null || worstHoldSlack >= 0) && failingEndpoints === 0;
  const met = summaryMet && noNegative;

  return {
    header: header(lines),
    designSummary,
    clocks,
    clocksConstrained: clocks.length,
    clockGroups,
    performance,
    checks,
    worstSetupSlack,
    worstHoldSlack,
    failingEndpoints,
    failingPaths,
    met,
  };
}
