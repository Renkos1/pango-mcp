// The device-write gate matches command names out of the script text, which is
// only sound while those names are literal. Tcl can build them at run time, so
// commands[] is restricted to one literal vendor command per line. These cases
// are the bypasses that restriction exists to stop.
import assert from "node:assert/strict";
import { validateCdtCommands } from "../src/toolchains/pango-pds/index.mjs";
import { detectSuspiciousDo } from "../src/toolchains/modelsim/index.mjs";

const rejected = (commands) => {
  const { problems } = validateCdtCommands(commands);
  assert.ok(problems.length > 0, `should have been rejected: ${JSON.stringify(commands)}`);
  return problems;
};

// --- the bypass this exists for -------------------------------------------
// None of these contain the literal "cfg_program", so the MUTATING_CDT match
// finds nothing to gate, yet Tcl runs the write.
rejected(["set a cfg_", "set b program", "$a$b -index 0"]);
rejected(["[format cfg_%s program]"]);
rejected(["eval cfg_pro gram"]);
rejected(["cfg_scan_chain; cfg_program -index 0"]);
rejected(["cfg_read_device_property [cfg_program]"]);
rejected(["cfg_program -file $env(HOME)/x.sbit"]);

// A newline inside one array element would smuggle a second command past a
// caller reading the array as one-command-per-entry.
rejected(["cfg_scan_chain\ncfg_program -index 0"]);

// --- Tcl builtins are outside the vendor namespace and stay out ------------
for (const builtin of ["set", "eval", "exec", "source", "open", "puts", "subst", "after"]) {
  rejected([`${builtin} whatever`]);
}

// --- what must keep working ------------------------------------------------
const ok = validateCdtCommands([
  "cfg_scan_chain",
  "cfg_read_device_property -index 0",
  "cfg_assign_file -index 0 -file {C:/work/top.sbit}",
  "cfg_program -index 0",
  "dbg_fla_set_trig_cond -core 0 -cond 10100101",
  "ins_set_net -core 0 -net {u_top/rx_data[0]}",
  "   ",
]);
assert.deepEqual(ok.problems, []);
assert.deepEqual(ok.names, [
  "cfg_scan_chain",
  "cfg_read_device_property",
  "cfg_assign_file",
  "cfg_program",
  "dbg_fla_set_trig_cond",
  "ins_set_net",
]);

// The names come back so the caller gates on a token the request cannot
// disguise, rather than on a substring of free text.
assert.ok(ok.names.includes("cfg_program"));

// Empty input is not an error here — fpga_cdt reports "no commands" itself.
assert.deepEqual(validateCdtCommands([]), { problems: [], names: [] });
assert.deepEqual(validateCdtCommands(undefined), { problems: [], names: [] });

// --- braces are the escape hatch real arguments depend on -----------------
// A tapped net carries its bus index in brackets. Rejecting those would break
// every ILA recipe, so the scan only rejects substitution where Tcl would
// actually perform it.
assert.deepEqual(validateCdtCommands(["ins_set_net -core 0 -net {u_cnt/q[3]}"]).problems, []);
assert.deepEqual(validateCdtCommands(["cfg_assign_file -file {C:/a b/top.sbit}"]).problems, []);
// ...but a double-quoted string is not a safe harbour: Tcl substitutes in it.
rejected(['cfg_assign_file -file "$env(HOME)/top.sbit"']);
// An unbalanced brace would swallow the rest of the line's parse.
rejected(["cfg_program -file {C:/top.sbit"]);

// --- the same class of bypass in ModelSim do scripts ----------------------
// Here the gate asks for confirm rather than rejecting, because a .do file is
// free-form by design. What must not happen is a script reaching exec or
// file delete while the gate reports nothing to confirm.
const flagged = (body, why) =>
  assert.ok(detectSuspiciousDo(body).length > 0, `should have been flagged (${why}): ${body}`);

flagged("eval $cmd", "eval runs text built at run time");
flagged("subst {$x}", "subst expands before evaluation");
flagged("source /tmp/other.do", "source pulls in unseen text");
flagged("uplevel 1 $script", "uplevel runs a caller-supplied body");
flagged("[format ex%s ec] rm -rf /", "substitution in command position");
flagged("set c exec\n$c rm -rf /", "variable in command position");
flagged("run 100ns; $c whatever", "second segment of a chained line");

// Still flagged the literal way, unchanged.
flagged("exec rm -rf /", "literal exec");
flagged("file delete {*}$paths", "literal file delete");

// And the benign shapes stay quiet, or the operator learns to wave confirm
// through without reading — substitution in ARGUMENT position cannot rename
// the command it is an argument to.
assert.deepEqual(detectSuspiciousDo('set fh [open "in.txt" r]'), []);
assert.deepEqual(detectSuspiciousDo("vsim -c tb\nrun -all\nquit -f"), []);
assert.deepEqual(detectSuspiciousDo("add wave -r /tb/*\nexamine /tb/dut/q"), []);

console.log("cdt-command-guard-unit: PASS");
