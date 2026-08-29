// Unit tests for two real-project usability fixes:
// 1) S-expression .pds top markers are module names (`+ "rk_ps2_monitor_top"`),
//    not the literal word "top".
// 2) PDS report collection must not mix stale backup/runstore logs into the
//    current run summary.
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePdsProject } from "../src/toolchains/pango-pds/project.mjs";
import { collectPdsReports } from "../src/toolchains/pango-pds/reports.mjs";

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`ok   ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}

const base = join(tmpdir(), `fpga-pds-project-reports-${Date.now()}`);
mkdirSync(base, { recursive: true });

function writeDemoPds(dir, top = "rk_ps2_monitor_top") {
  mkdirSync(join(dir, "rtl"), { recursive: true });
  mkdirSync(join(dir, "constraints"), { recursive: true });
  const pdsPath = join(dir, "demo.pds");
  writeFileSync(join(dir, "rtl", `${top}.v`), `module ${top}(); endmodule\n`, "utf8");
  writeFileSync(join(dir, "constraints", "top.fdc"), "# empty\n", "utf8");
  writeFileSync(
    pdsPath,
    `(_flow fab_demo "2022.2-rc2"
    (_task tsk_setup
        (_widget wgt_select_arch (_input (_part (_family Logos2)(_device PG2L50H)(_speedgrade -6)(_package MBG324))))
        (_widget wgt_my_design_src (_input (_file "rtl/${top}.v" + "${top}" (_format verilog)(_timespec "2026-07-03T00:00:00"))))
        (_widget wgt_import_logic_con_file (_input (_file "constraints/top.fdc" (_format fdc)(_timespec "2026-07-03T00:00:00"))))))`,
    "utf8"
  );
  return pdsPath;
}

check("sexpr parser treats + \"module_name\" as top marker", () => {
  const dir = join(base, "sexpr-top");
  const pdsPath = writeDemoPds(dir);
  const info = parsePdsProject(pdsPath);
  assert.equal(info.topModule, "rk_ps2_monitor_top");
  assert.equal(info.topSource, "rtl/rk_ps2_monitor_top.v");
  assert.equal(info.sources.length, 1);
});

check("collectPdsReports ignores stale backup and .pango-mcp logs", () => {
  const dir = join(base, "reports");
  const pdsPath = writeDemoPds(dir, "top");
  mkdirSync(join(dir, "prj_tasks", "syn_1", "compile"), { recursive: true });
  writeFileSync(join(dir, "prj_tasks", "syn_1", "compile", "run.log"), "W: live warning\n", "utf8");
  mkdirSync(join(dir, "_pds_build_bak_2026-07-03T00-00-00-000Z", "prj_tasks", "syn_1", "compile"), { recursive: true });
  writeFileSync(
    join(dir, "_pds_build_bak_2026-07-03T00-00-00-000Z", "prj_tasks", "syn_1", "compile", "run.log"),
    "E: Verilog-4072: [old.v(line number: 1)] stale backup error\n",
    "utf8"
  );
  mkdirSync(join(dir, ".pango-mcp", "runs", "old"), { recursive: true });
  writeFileSync(
    join(dir, ".pango-mcp", "runs", "old", "build.log"),
    "E: ConstraintEditor-0046: [old.fdc(line number: 2)] stale runstore error\n",
    "utf8"
  );
  mkdirSync(join(dir, "prj_tasks", "syn_1", "compile", "logbackup"), { recursive: true });
  writeFileSync(
    join(dir, "prj_tasks", "syn_1", "compile", "logbackup", "run_old.log"),
    "E: Flow-0037: stale logbackup error\n",
    "utf8"
  );

  const reports = collectPdsReports({ pdsPath, buildDir: dir, log: "The bitstream file is \"generate_bitstream/top.sbit\"" });
  assert.equal(reports.ok, true);
  assert.deepEqual(reports.errors, []);
  assert.equal(reports.warnings.length, 1);
  assert.match(reports.warnings[0], /live warning/);
  assert.ok(reports.reports.logs.every((p) => !/_pds_build_bak_|\.pango-mcp|logbackup/i.test(p)));
});

check("collectPdsReports exposes top-level health when ok:true but timing fails", () => {
  const dir = join(base, "reports-health-timing");
  const pdsPath = writeDemoPds(dir, "top");
  const reportDir = join(dir, "prj_tasks", "pnr_1", "report_timing");
  mkdirSync(reportDir, { recursive: true });
  copyFileSync(join(here, "fixtures", "timing", "blink_violated.rtr"), join(reportDir, "top.rtr"));

  const reports = collectPdsReports({ pdsPath, buildDir: dir, log: "The bitstream file is \"generate_bitstream/top.sbit\"" });
  assert.equal(reports.ok, true);
  assert.equal(reports.timing.met, false);
  assert.equal(reports.health.verdict, "timing_failed");
  assert.equal(reports.health.logOk, true);
  assert.equal(reports.health.timingOk, false);
  assert.match(reports.hint, /Timing report says constraints are not met/);
  assert.ok(reports.health.issues.some((i) => i.code === "timing_not_met"));
});

check("collectPdsReports marks missing create_clock even when timing summary says met", () => {
  const dir = join(base, "reports-health-clock");
  const pdsPath = writeDemoPds(dir, "top");
  const reportDir = join(dir, "prj_tasks", "pnr_1", "report_timing");
  mkdirSync(reportDir, { recursive: true });
  copyFileSync(join(here, "fixtures", "timing", "no_clock.rtr"), join(reportDir, "top.rtr"));

  const reports = collectPdsReports({
    pdsPath,
    buildDir: dir,
    log: "C: SDC-2025: clock net clk need a clock constraint such as create_clock\n",
  });
  assert.equal(reports.ok, true);
  assert.equal(reports.timing.met, true);
  assert.equal(reports.health.verdict, "constraint_risk");
  assert.equal(reports.health.clockConstraintOk, false);
  assert.match(reports.hint, /missing create_clock/);
  assert.ok(reports.health.issues.some((i) => i.code === "clock_constraint_missing"));
});

check("unconstrained I/O delay warnings do not masquerade as a missing clock", () => {
  const dir = join(base, "reports-health-io-delay");
  const pdsPath = writeDemoPds(dir, "top");
  const reportDir = join(dir, "prj_tasks", "pnr_1", "report_timing");
  const reportDbDir = join(reportDir, "report_db");
  mkdirSync(reportDbDir, { recursive: true });
  copyFileSync(join(here, "fixtures", "timing", "blink_declared_clk.rtr"), join(reportDir, "top.rtr"));
  copyFileSync(join(here, "fixtures", "timing", "check_timing_io_delay_only.db"), join(reportDbDir, "check_timing_summary.db"));
  const log = readFileSync(join(here, "fixtures", "timing", "io_delay_only.txt"), "utf8");

  const reports = collectPdsReports({ pdsPath, buildDir: dir, log });
  assert.equal(reports.timing.met, true);
  assert.equal(reports.timing.clockPinsWithoutClock.count, 0);
  assert.equal(reports.timing.portsWithoutIoDelay.count, 2);
  assert.equal(reports.timing.portsWithoutIoDelay.inputCount, 1);
  assert.equal(reports.timing.portsWithoutIoDelay.outputCount, 1);
  assert.deepEqual(reports.timing.portsWithoutIoDelay.ports.map((p) => p.direction), ["input", "output"]);
  assert.equal(reports.timing.note, undefined);
  assert.equal(reports.health.clockConstraintOk, true);
  assert.equal(reports.health.verdict, "warnings");
  assert.ok(reports.health.issues.some((i) => i.code === "ports_without_io_delay"));
  assert.ok(!reports.health.issues.some((i) => i.code === "clock_constraint_missing"));
});

check("positive no-clock summary is definite clock-missing evidence", () => {
  const dir = join(base, "reports-health-no-clock-summary");
  const pdsPath = writeDemoPds(dir, "top");
  const reportDir = join(dir, "prj_tasks", "pnr_1", "report_timing");
  const reportDbDir = join(reportDir, "report_db");
  mkdirSync(reportDbDir, { recursive: true });
  copyFileSync(join(here, "fixtures", "timing", "no_clock.rtr"), join(reportDir, "top.rtr"));
  writeFileSync(
    join(reportDbDir, "check_timing_summary.db"),
    '<tables><table id="check_timing_summary"><row><data>There are 1 clock pins with no clock driven</data></row></table></tables>',
    "utf8"
  );

  const reports = collectPdsReports({ pdsPath, buildDir: dir, log: "W: Timing-4087: Port 'status_out' is not constrained, it is treated as combinational output.\n" });
  assert.equal(reports.timing.clockPinsWithoutClock.count, 1);
  assert.equal(reports.health.clockConstraintOk, false);
  assert.equal(reports.health.verdict, "constraint_risk");
  assert.match(reports.timing.note, /时钟未真正约束/);
});

rmSync(base, { recursive: true, force: true });
console.log(`\npds-project-reports-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
