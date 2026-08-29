import assert from "node:assert/strict";
import { extractDebuggerIdcode, register } from "../src/toolchains/pango-pds/index.mjs";

const tools = new Map();
register({
  registerTool(name, schema, handler) {
    tools.set(name, { schema, handler });
  },
});

function content(response) {
  return response.structuredContent ?? JSON.parse(response.content[0].text);
}

const flow = tools.get("fpga_ila_flow");
assert.ok(flow, "fpga_ila_flow must be registered");
assert.ok(flow.schema.inputSchema.confirm, "fpga_ila_flow schema must expose confirm");
const flowGate = content(await flow.handler({
  sbit: "C:/definitely-not-read-before-confirm.sbit",
  projectDir: "C:/definitely-not-read-before-confirm",
  expectIdcode: "PG2L200H",
}));
assert.equal(flowGate.ok, false);
assert.equal(flowGate.phase, "confirm");
assert.match(flowGate.hint, /confirm:true/);

const consoleTool = tools.get("fpga_ila_console");
assert.ok(consoleTool, "fpga_ila_console must be registered");
assert.ok(consoleTool.schema.inputSchema.expectIdcode, "fpga_ila_console schema must expose expectIdcode");
const consoleGate = content(await consoleTool.handler({ tcl: "dbg_program -device 0 -file x.sbit" }));
assert.equal(consoleGate.ok, false);
assert.equal(consoleGate.phase, "confirm");
assert.match(consoleGate.hint, /expectIdcode/);

const missingId = await consoleTool.handler({ tcl: "dbg_program -device 0 -file x.sbit", confirm: true });
assert.equal(missingId.isError, true);
assert.match(missingId.content[0].text, /expectIdcode/);

assert.equal(extractDebuggerIdcode("Device ID: 0x00603899"), "0x00603899");
assert.equal(extractDebuggerIdcode("no device id"), null);

console.log("ila-write-guard-unit: PASS (flow and console writes require confirm + IDCODE)");
