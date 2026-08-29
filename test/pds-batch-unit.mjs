import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePdsBatch, validatePdsBatchVariants } from "../src/toolchains/pango-pds/batch.mjs";

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}

const root = join(tmpdir(), `fpga-pds-batch-${Date.now()}`);
const makeProject = (name, outputDir = ".") => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const pdsPath = join(dir, `${name}.pds`);
  writeFileSync(pdsPath, `(_flow fab_demo \"2022.2\" (_project (_option prj_work_dir (_string \"${outputDir}\")) (_option prj_impl_dir (_string \".\"))))`, "utf8");
  return pdsPath;
};

await check("accepts independent non-overlapping project clones", () => {
  const variants = validatePdsBatchVariants([
    { id: "a", pdsPath: makeProject("a") },
    { id: "b", pdsPath: makeProject("b") },
  ]);
  assert.equal(variants.length, 2);
  assert.notEqual(variants[0].projectDir, variants[1].projectDir);
});

await check("rejects two variants that share one project directory", () => {
  const dir = join(root, "shared");
  mkdirSync(dir, { recursive: true });
  const a = join(dir, "a.pds");
  const b = join(dir, "b.pds");
  writeFileSync(a, "(_flow fab_demo)", "utf8");
  writeFileSync(b, "(_flow fab_demo)", "utf8");
  assert.throws(() => validatePdsBatchVariants([{ id: "a", pdsPath: a }, { id: "b", pdsPath: b }]), /独立、非重叠 clone/);
});

await check("rejects external PDS work/implementation directories", () => {
  assert.throws(() => validatePdsBatchVariants([{ id: "external", pdsPath: makeProject("external", "../shared-output") }]), /prj_work_dir 必须为项目本地/);
  const xmlDir = join(root, "external-xml");
  mkdirSync(xmlDir, { recursive: true });
  const xmlPds = join(xmlDir, "external.pds");
  writeFileSync(xmlPds, '<project><options><option name="prj_impl_dir" type="string" value="../shared-output"/></options></project>', "utf8");
  assert.throws(() => validatePdsBatchVariants([{ id: "external_xml", pdsPath: xmlPds }]), /prj_impl_dir 必须为项目本地/);
});

await check("scheduler caps concurrency, preserves order, and fails closed", async () => {
  const variants = ["a", "b", "c"].map((id) => ({ id, pdsPath: `/${id}.pds`, projectDir: `/${id}`, runTarget: "compile" }));
  let active = 0;
  let peak = 0;
  const result = await executePdsBatch(variants, {
    maxParallel: 2,
    runVariant: async (variant) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { structuredContent: { ok: variant.id !== "b", exitCode: 0, errors: variant.id === "b" ? ["synthetic failure"] : [] } };
    },
  });
  assert.equal(peak, 2);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ["b"]);
  assert.deepEqual(result.variants.map((variant) => variant.id), ["a", "b", "c"]);
});

rmSync(root, { recursive: true, force: true });
console.log(`\npds-batch-unit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
