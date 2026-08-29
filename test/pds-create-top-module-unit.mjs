// Regression: fpga_pds_create_project must honor the `top` param in the generated
// .pds top-module marker. It was hardcoded `+ "top"` (project.mjs), so any module
// not named "top" failed synthesis with `E: Specified top module "top" is not found
// in library` (found building the UART bring-up design with top=top_uart).
import { createMinimalPdsProject } from "../src/toolchains/pango-pds/project.mjs";
import { readFileSync, rmSync } from "node:fs";

const dir = "./.work/_pds_topmodule_probe";
const part = { family: "Logos2", device: "PG2L200H", speedgrade: "-6", package: "FBB676" };
let fails = 0;
for (const top of ["top", "top_uart", "my_design"]) {
  const r = createMinimalPdsProject({ projectDir: dir, name: "probe", top, part, force: true });
  const pds = readFileSync(r.pdsPath, "utf8");
  const m = /_file "[^"]*" \+ "([^"]*)"/.exec(pds);
  const ok = m && m[1] === top;
  console.log(`top=${top} -> marker ${m && m[1]} ${ok ? "OK" : "FAIL"}`);
  if (!ok) fails++;
}
rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAIL(s)` : "\nall tops honored");
process.exit(fails ? 1 : 0);
