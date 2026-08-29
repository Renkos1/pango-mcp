# Headless JTAG / FLA findings (Pango Logos2, PG2L200H)

Durable record — this context was repeatedly lost to compaction. Read before
touching `mpsse_jtag.py` / `fla_pango.py`.

## v0.3.1 live MCP hardware proof (2026-07-10)

The connected Target Profile was `pg2l200h` (PG2L200H/FBB676/-6, clock D18).
After a physical cable replug, D2XX reported two healthy FT2232H channels with
`opened:false`. Bare scan read `0x10603899`; PDS scan read `0x00603899`. Their
lower 28 bits match, which is the repository's device identity rule.

The first clean full run (`e4c2bb6`) proved software, normal PDS build, ILA build,
PDS scan, SRAM image, and FLA core, but the GUI `open`/capture layer failed after
491.173s and the integration reporter hid its inner stage. Immediately afterward
the already-loaded FLA returned 1024×4 samples, 16 distinct values, only step
`[1]`, monotonic wrap. This selected structured capture reporting and a GUI-free
local path.

The next clean run (`b6dd829`) passed PDS scan and guarded PDS SRAM programming
(`done bit is 1`), then both bare capture attempts failed in 151ms/102ms because
D2XX reported the channels open elsewhere. This was not a delay problem:
`ensureCdtServer()` had started a detached resident `cdt_js`, so logical
`cfg_disconnect` did not release its physical D2XX handle during the persistent
MCP process. After that MCP exited, inventory immediately returned
`opened:false`, and the same capture passed in 1.6s with `[1]` monotonic data.

The durable rule is therefore **one driver for one local hardware loop**, not
"wait longer" and not "kill cdt_js":

```text
fpga_jtag_scan -> fpga_jtag_flash -> fpga_jtag_capture
```

On clean SHA `442aae8`, the complete hardware integration passed in 472.7s:
normal bitstream 195.556s (timing met), ILA build 242.670s, bare scan 443ms,
guarded CRAM/SRAM replay 23.806s with `doneBit:true`, capture 1.245s with
`sampleCount:1024`, `width:4`, `distinct:16`, `steps:[1]`, `monotonic:true`, and
the final `q increments by one` verdict. The MCP trace shows only
`fpga_jtag_scan`, `fpga_jtag_flash`, and `fpga_jtag_capture` for the local
post-build hardware stages. No SPI/persistent flash, process termination, USB
reset, or driver change was performed.

`fpga_jtag_flash` now enforces `confirm:true + expectIdcode`, performs a fresh
bare scan before replay, compares the lower 28 IDCODE bits, and retains the SVF
IDCODE/done-bit checks as the second guard. D2XX inventory errors are structured;
a busy flag no longer claims a specific owner without evidence.

## What is PROVEN on hardware

- **Headless bare-metal JTAG works** over the USB Cable II (FT2232H) via the
  already-installed `ftd2xx.dll` + MPSSE — no zadig/WinUSB swap, no PDS.
- IDCODE read back as **`0x10603899`** (PG2L200H) via *both* the default-DR path
  and the `shift_ir(0x283)`+`read_dr` path, **10/10** each. `RESULT: PASS`.
- Cable layout: JTAG on **channel A**; `TCK=AD0 TDI=AD1 TDO=AD2 TMS=AD3`, and
  **AD7 = buffer output-enable, must be driven HIGH** (low=0x88, dir=0x8B) or TDO
  floats to 0xFFFFFFFF.

## Root-cause bug that blocked everything (FIXED)

MPSSE **byte-mode** clock opcodes (0x19, 0x39, …) take a **TWO-byte length**
field `(lengthL, lengthH)`; #bytes = length+1. The code emitted only ONE length
byte:
- `read_idcode` worked **by accident** — its TDI data is all zeros, so the first
  0x00 data byte landed as `lengthH=0` and the count came out right.
- `shift_ir` (`_clock_out`) broke: `[0x19, nbytes-1, <data 0x83>...]` → the real
  data byte `0x83` was parsed as `lengthH` → length `0x8300` → MPSSE waited for
  33537 data bytes, **swallowing every following command** including the next
  `read_dr`'s 0x39 → `FT_Read timeout: got 0/4`, deterministically.

Fix (in `mpsse_jtag.py`): emit the high byte in both byte-mode sites
(`_clock_out` 0x19, `_clock_in_bytes` 0x39). Verified 10/10 after.

### Debugging note (process)
The "intermittent" timeout was **not** flakiness and **not** cable/settle time.
Loop test isolated it cleanly: `read_idcode` 10/10, `read_idcode_via_ir` 0/10 —
i.e. anything after a `shift_ir` failed. Empty read queue (0 bytes, not garbage)
proved an MPSSE command-stream desync, not a JTAG-level problem. Bumping `settle`
to 0.15s was a red herring.

### Decoupling note
Do not mix PDS/CDT cable operations with bare D2XX operations inside one
persistent local MCP process: resident `cdt_js` keeps the physical handle even
after `cfg_disconnect`. Do not automatically kill it because it may belong to
another user/session. Direct CLI users should close their owning PDS/debugger
session first; the MCP hardware hook avoids handoff entirely by using the
all-bare local sequence. See [[host-wlan-drops-on-jtag-scan]].

## FLA capture layer (`fla_pango.py`) — WORKING end-to-end on hardware (2026-06-23)

**Headless waveform capture PROVEN.** Against a locally-built+flashed instrumented
bitstream (counter + FLA on `counter[7:0]`, depth 1024, PDS 2025.2), `fla_pango.py
8 1024` reads back **1024 samples × 8 bits = the free-running counter, every
transition exactly +1**. No GUI, no cdt_dbg, no vendor debugger — pure MPSSE.

Sample framing is `[4 leading bits] + depth×(logical data LSB-first + physical
padding/marker lanes) + [2 trailing bits]`. PDS does not encode the physical
JTAG stride in `.fic`, and logical width alone is not a sufficient oracle. The
vendor core declares a canonical `DATA_CHAIN_BIT = DATA_BIT + 1`, and a generic
34-bit/depth-64 inserted-core build reports a 35-bit RAM. That matches a hardware
stream whose static words realign every 35 bits. Independently, a complete
20-bit/depth-1024 hardware stream requires stride 23 and has three zero protocol
lanes. A generic 20-bit inserted-core build still reports RAM width 21, proving
that the storage width cannot determine the external readback framing either.

The runtime geometry is therefore:

```
padding_bits = runtime-selected protocol lane count
sample_stride = width + padding_bits
frame_bit_length = 4 + sample_stride * depth + 2
```

The reader first takes an exact canonical `width+1` capture. If that assumed
protocol lane is not sparse, it re-arms, reads a bounded compatibility upper
bound (`width+ceil(width/8)`), and scores candidate strides only by their
padding-lane one counts. A selected smaller candidate is re-read at its exact
length; equal-score candidates with different decoded samples fail closed.
Callers can then preserve `--raw` evidence and retry with explicit
`--padding-bits`. `unpack()` consumes only the logical low `width` bits, while
the CLI/MCP framing record always returns the lane counts, header/tail values,
candidate scores, selection source, and frame/read lengths.

The status-poll (`wait_triggered`, reference `TDO[31:29]==010`) bit-alignment is
still not decoded — status read stuck at `0x01002000` — but it's moot for an
always-true trigger: `capture()` arms, reads, and validates the buffer is
non-degenerate (retry x4). For real event-triggered captures the status decode
would need finishing (left as a TODO in `wait_triggered`).

## Event-trigger on the PDS-inserted FLA — DOES NOT work via the reference recipe (HW-proven 2026-06-23)

We tried to add real value/edge triggering by transcribing the reference's
per-channel **3-bit trigger codes** (`x/0/1/r/f` = `0b000/001/010/011/100`,
per the vendor's JTAG-ILA encoder) into the step-16 `capture_len = width*3+1` blob. The
structure matches perfectly (8 channels × 3 bits + 1 = 25 = capture_len), and
the design's `.fic` confirms the trigger channels ARE the data signal
(`dataEqualsTrigger=true`, `triggerChannel<0><0..7>=counter[0..7]`,
`triggerPortIsData=true`), so a `counter==V` trigger *should* lock.

**It does not.** `test/fla-trig-cal.py` brute-forced all 4 bit-layouts (channel
order × within-channel order) on hardware against the free-running counter, with
a decisive tell: a working value-trigger makes `sample[trig_pos]` (hence the
first sample) **constant across runs**; free-run makes it **random**.

```
chan_reversed=True  code_msb_first=True : first=[39 3C 8D]   random
chan_reversed=True  code_msb_first=False: first=[2A 10 F9]   random
chan_reversed=False code_msb_first=True : first=[A2 4C FC]   random
chan_reversed=False code_msb_first=False: first=[2D 89 09]   random
```

All random → the FLA never locks; it free-runs / triggers immediately. The
step-20 `trig_position` field is **also** ignored (earlier sweep of pos
1024/512/0 likewise gave random windows). Yet **arm + readback are bit-perfect**
(capture is monotonic). 

### UPDATE 2026-06-23 (deeper) — found the vendor's authoritative encoding; fixed a real bug; still free-runs

The vendor's reference setup is a JTAG master driving an external target — a
`top_jtag` block driving the board's JTAG chain via `o_tck/i_tdo/o_tms/o_tdi`,
i.e. **exactly our FT2232+mpsse_jtag role**. The FLA is PDS-inserted (the
`.fic`), and the vendor debugger changes its trigger via the **0xE5/0x82** config
frame, whose trigger field becomes `i_ila_cmd_data`, shifted by the vendor's
JTAG-ILA FSM into the FLA. So this path SHOULD be replayable headless by us.

**Bug found + fixed:** the 3-bit per-channel code map I first used was the
*internal*-LA one (`LOGIC_ANALYZER_TRIGGER_CODES` x000/0:001/1:010). The
JTAG-FLA path uses a DIFFERENT map (the vendor's `TRIGGER_ENCODING`):
`x000 / 0:010 / 1:011 / r:101 / f:100` (bit0=level, bit1=level-enable, bit2=edge).
With the wrong map every channel was a non-matching/disabled code. Fixed in
`fla_pango.TRIG_CODES`. Traced the config-frame byte assembly and the
on-target `{prev,byte}` decode end-to-end: our `encode_trigger(chan_reversed=False,
code_msb_first=False)` now reproduces `i_ila_cmd_data[0..24]` **byte-for-byte**.
The arm() sequence also matches the vendor's steps 0..22 exactly.

**Yet it STILL free-runs.** `fla-trig-cal.py` now arms, **sleeps so the trigger
can fire and freeze the buffer**, then reads (capture() read-immediately was a
methodology trap — a free-running counter's pre-trigger window always looks
monotonic). With the corrected codes + sleep, all 4 layouts STILL give a random
`sample[trig_pos]` across runs → the FLA never freezes → the trigger config is
not engaging.

### UPDATE 2026-06-23 (definitive) — both hypotheses RESOLVED; points at the FLA build

Re-ran the whole thing on hardware with better oracles. Net: **arm/transport/recipe
are correct; the value comparator does not engage for ANY encoding; the `.fic`
matches known-working examples.** The two old hypotheses are settled:

1. **H-A (the `0x07` pre-frame) REFUTED.** The vendor command decoder shows `0x07`
   and `0x03` frames are byte-identical except `byte[0][2:0]`→`o_jtag_ila_cmd`
   (=`i_jtag_cmd`). The vendor ILA FSM runs only on `i_jtag_cmd==3'd3` (one
   pass = program-trigger steps 15-16 + arm + poll + read). `0x07`→cmd=7 runs NO
   FSM; it only pre-latches width/depth/blob into the decoder regs to beat the
   SPI-receive-vs-cmd=3 race. Our bare-metal shifts the blob directly into the
   step-16 DR, so there is no race and nothing to replicate. Single cmd=3 pass is
   complete.

2. **Status decode is a dead end (and the old "stuck 0x01002000" was a red
   herring).** Fixed the real bug: step-27 status read is `r_ila_depth_len` bits
   per the vendor sequence, not 32 (the `32'd32` DR there is the loop-RE-ARM dummy).
   But with the correct length, the status register reads a CONSTANT `0x01002000`
   for BOTH always-true (which definitely triggers — buffer is monotonic) AND a
   value trigger. So this status path does not expose trigger state; `010` is
   never reachable. Don't gate on it.

**The real oracle = inter-arm window alignment.** The FLA always captures-then-
freezes per arm (so per-arm "frozen" and "target present in a free-running counter"
are trivially true). The true tell: if the value trigger works, every arm freezes
with the window locked to the match, so `sample[0]` (and the target's index) is
CONSTANT across arms; free-run gives a random `sample[0]`. `test/fla-trig-align.py`
swept the FULL bit-order space — `blob_rev × chan_rev × code_msb_first × cond` = 16
combos × 4 arms each, value 0xA5 — and **every combo gives random `sample[0]`**.
Bit-order is exhausted; not one aligns.

**The `.fic` is NOT obviously wrong.** Our generated config (ila.mjs:55-66:
`dataEqualsTrigger=true`, `triggerMatchType<0>=1`, `triggerPortIsData<0>=true`)
is IDENTICAL to two known-working FLA cores: the lab's `hdmi_loop_syn.fic` and
PDS's own `example/PGL25G_lvds8to1/pnr/lvds8to1_debug.fic`. (One cosmetic diff:
those emit `triggerMatchCountWidth<0>=0`; we omit it.)

**ROOT CAUSE CONFIRMED — the `.fic` omits the Match Unit + Trigger Condition.**
Docs first (UG990403 Fabric Inserter UG): `dataEqualsTrigger=true` does NOT mean
"always trigger" — it means **"trigger port signals are ALSO used as data"**
(Used As Data / Data Same As Trigger, p22/p55). `triggerMatchType=1` = **Basic
w/Edges** (p56: 0 Basic, 1 Basic w/Edges, 2 Extended, …). The per-bit value symbols
are X/0/1/R/F/B/N (p31). A real trigger needs a **Match Unit** (a Function `==`/
`<>`/`>=`… + a Value) and a **Trigger Condition** expression over the units.

A GUI-configured `.fic` (`PDS_Prj/RemoteBox1/.../Top_syn.fic`, made by hand in the
inserter) proved it — it carries the fields our generator NEVER emitted:
```
MatchUnitFunction<0>=0                 # 0 == "=="
MatchUnitValue<0>=XXXX…0XXXRXFB1       # per-bit X/0/1/R/F/B trigger pattern
MatchUnitRadix<0>=0                    # binary
MatchUnitCounterType<0>=0 / CounterCycles<0>=1
TriggerConditionType<0>=1
TriggerCondition<0>=TU0(->TU0…)        # which units, sequenced
StorageType/StorageWindows/StoragePosition/StorageSamples/StorageEquation
```
Our old `.fic` (ila.mjs) defined only the trigger PORT + `triggerMatchCount=1`,
with NO `MatchUnit*` and NO `TriggerCondition`. So PDS synthesized a port with no
usable comparator/condition → the core can only free-run/always-capture → exactly
the HW behavior (always-true works; every value trigger free-runs; status constant).
The earlier "the lab/PDS examples use the same config and work" was a false lead:
those example `.fic`s are also comparator-less and (for these designs) capture-only.

**FIX (ila.mjs `renderFic`, 2026-06-23):** always emit a Match Unit
(`MatchUnitFunction=0` ==, `MatchUnitRadix=0` binary, default `MatchUnitValue` =
all-X = runtime-overridable) + `TriggerCondition<0>=TU0` + Storage fields +
`triggerMatchCountWidth<0>=0`. New optional `triggerValue` param bakes a build-time
pattern (W chars X/0/1/R/F/B, MSB-first) for a decisive hardcoded-value test.

**Decisive next step:** regenerate the instrumented `.fic` with
`triggerValue="10100101"` (counter==0xA5), re-insert + rebuild + flash, then plain-
capture: if the buffer freezes with 0xA5 at a stable position, the comparator now
works → confirms the root cause. Then wire runtime value-override (the JTAG blob,
already protocol-correct) and re-test with `test/fla-trig-align.py`.

### UPDATE 2026-06-23 (rebuilt with comparator) — `.fic` fix VALIDATED at HW synthesis; recipe still doesn't program it

Rebuilt `verify/.work/pdsblink` with the comparator `.fic` (`MatchUnitValue=10100101`,
`MatchUnitFunction=0` ==, `TriggerCondition<0>=TU0`). gen_bit_stream OK in ~3m,
new `top.sbit` 22:16. **Proof the fix changed the silicon:** the inserter log
(`prj_tasks/pnr_1/device_map/ins_ads.log`) now elaborates the trigger IP that the
old comparator-less build never pulled in — `ips_dbc_trigger_condition_v1_3`,
`ips_dbc_trigger_output_v1_2`, instance `u_Trigger_Condition`. So PDS DID synthesize
a real trigger comparator/condition. Flashed bare-metal (done-bit OK).

### RESOLVED 2026-06-23 — value/edge trigger WORKS headless. It was the `.fic` (no comparator) PLUS a wrong oracle.

The rebuilt core DOES trigger — the blob and recipe were right all along; our
read-back ORACLE was wrong. `fla-trig-align.py`'s "`sample[0]` const across arms"
is invalid because the FLA buffer is **CIRCULAR**: on trigger-freeze the write
pointer stops at a position set by the (free-running) counter, so a linear readout
is a RANDOM rotation each arm → `sample[0]` looks random even when the trigger fired
perfectly. (Same reason the status register looked useless.)

**The real marker = the per-sample padding/marker field** (the physical lanes in
the formula above). `test/fla-trig-guard.py` reads it:
- always-true: one marker at a RANDOM data value (immediate trigger, random phase).
- value==0xA5: marker=1 ALWAYS at the `0xA4→0xA5` boundary (marker on the sample
  just before the match), every arm. value==0x3C → marker at `0x3B→0x3C`. The
  absolute index moves with the circular rotation; the marker-relative-to-value is
  CONSTANT. **The FLA triggers exactly on counter==value.**

And it's the RUNTIME blob, not just the baked default: built with
`MatchUnitValue=0xA5` but a runtime `--trig 0x3C` blob freezes at 0x3C → the JTAG
blob overrides the build-time value. The blob is provably the lab host's exact
bits: running `buildJtagIlaConfigFrame(8,1024,<0xA5>,0x03)` → `i_ila_cmd_data =
0x069A4D3`, **identical** to our `encode_trigger(chan_reversed=False,
code_msb_first=False)`.

**So both halves were needed:** (1) the `.fic` must build a Match Unit +
TriggerCondition (fixed in ila.mjs — the old comparator-less `.fic` was a genuine
blocker); (2) read the trigger via the padding/marker field, not status / linear
`sample[0]`.

**Productized:** `fla_pango.PangoFla.trigger_index(raw)` returns the padding/marker
index (None = not fired); `capture()` retries until the marker appears and returns
a trigger-ALIGNED window (rotates so the trigger sample is index 0), setting
`last_trigger_index`. `cli.py capture --trig <pat>` prints "triggered … aligned"
and emits the aligned VCD/JSON. `--trig` is no longer EXPERIMENTAL. Verified e2e:
`cli.py capture --fic … --trig 00111100` → "triggered", window `3B 3C 3D 3E …`.
`wait_triggered`/`poll_status` stay as diagnostics only (status is constant here).

Status: **always-true → bare-metal (proven); value trigger → fix in hand (.fic
Match Unit/Condition), pending a rebuild to confirm on HW.** Status-read length is
fixed; capture() waits on `wait_triggered` for real triggers. `--trig` stays
EXPERIMENTAL until the rebuilt core verifies. Test scaffolds: `fla-trig-align.py`
(the real inter-arm oracle), `fla-status-cmp.py`/`fla-trig-sweep.py` (show status
is moot on a comparator-less core), `fla-freeze.py` (intra-arm — moot).

### Channel order — CORRECTED 2026-06-24 (re-verification caught two latent bugs)

Re-running the value trigger on a freshly re-flashed board exposed two bugs the
2026-06-23 run could not see, because **every value tested that day (0xA5, 0x3C)
is a BIT-PALINDROME** — it reads the same with channels reversed, so it matched
regardless of channel order. The "identical to `encode_trigger(chan_reversed=
False)`" note above was therefore only ever true for palindromes; it overclaimed.

1. **Reversed channel order.** Asking for a non-palindrome value `0x50`
   (`pattern 00001010`) froze the FLA at **`0x0A`** — the bit-reverse of `0x50`.
   The real PG2L200H FLA reverses trigger channels: **blob slot s drives counter
   bit (width-1-s)**. Confirmed by sending the reversed pattern `01010000` →
   matched `0x50` exactly. Fix: `encode_trigger`/`PangoFla` now default
   **`chan_reversed=True`**. HW-proven after the fix with the NATURAL pattern:
   `0x50`→window `4f 50 …`, `0x07`→`06 07 …`, `0x3C`→`3b 3c …`. Regression test:
   `test/fla-trig-encode-unit.py` (hardware-free; round-trips every value incl.
   the non-palindromes the palindromes hid). The calibration script
   `test/fla-trig-cal.py` defaulted to `0xA5` (palindrome), so its sweep "locked"
   for BOTH channel orders — that ambiguity is how the wrong default got picked.

2. **Degenerate readback = false "triggered".** A power-cycle wiped the volatile
   SRAM config; the FLA bus then read all-`0xFF`. That sets EVERY
   padding/marker field, so
   `trigger_index` returned 0 and `capture()` falsely reported "triggered" on a
   blank board. Fix: `_is_degenerate_readback` flags an all-guard-set read so
   `capture()` re-arms/retries and never claims a trigger when no design is
   loaded. Regression test: `test/fla-trig-degenerate-unit.py` (synthetic all-1s
   raw = exact controlled repro of the blank-board read).

Takeaway: a single-value HW check is not enough for a bit-mapping — always test a
non-palindrome (and a no-design case). Same "wrong oracle" failure mode as the
2026-06-23 `sample[0]` bug, just inverted (false-positive instead of -negative).

### Original transcription notes (kept for reference)

Source of truth: the vendor's PANGO200 JTAG-FLA access sequence
(`case r_cmd_cnt` 0..36). Transcribed 1:1 onto shift_ir/write_dr/read_dr.

Key map: IR `0x286` = FLA register access; DR `0x038` = status (ready when
`TDO[31:29]==0b010`); sample readout selected via DR `0x03c` then a long
`read_dr`. Derived sizes (from the vendor FLA register widths):
- `capture_len  = width*3 + 1`
- `padding_bits` is runtime-selected (canonical `1`, bounded wider probe when
  needed); `sample_stride = width + padding_bits`
- `frame_bit_length = sample_stride*depth + 6` (full buffer, in BITS)
- `depth_len    = log2(depth) + 6`,  `trig_position = depth` (end-trigger default)

Smoke test (`fla_pango.py 8 1024`) runs arm + poll end-to-end with **no desync**
and correctly reports "never triggered" (no FLA in the loaded bitstream). So the
recipe drives the transport cleanly across all odd lengths (33/9/8/6/36/14/63/
depth_len bits) and the big 9222-bit readback path is wired.

### Gate cleared (2026-06-23)
Verified against a loaded+armed instrumented bitstream (the free-running counter).
Calibration used the local build at `verify/.work/pdsblink` (PG2L200H/FBB676/-6,
clk@D18 — LEDs blink so the design clock is live), flashed via `fpga_flash_sram`.
Of the two PENDING spots, #2 (sample readback framing) is solved & calibrated;
#1 (status bit) is left as a TODO but doesn't block always-true triggers.

Repro: build/flash the instrumented sbit, `Stop-Process cdt_js`, then
`python fla_pango.py 8 1024 0` → 1024 counter samples, step==1.

ILA config comes from the design's `.fic` (see `ila.mjs`): `signals[]` → width,
`dataDepth` → depth, plus `clockNet`. No device specifics are baked in — width
and depth are caller-supplied. See [[device-agnostic-no-embedded-specifics]].

## ftd2xx.dll path — made portable (2026-06-28)

`mpsse_jtag.py` hardcoded `C:\Windows\System32\ftd2xx.dll`. That only exists on a
host with the standalone FTDI D2XX driver installed; on a **PDS-only host** the
DLL ships ONLY inside `D:\pango\PDS_*/bin/ftd2xx.dll`, so every bare-metal command
died with "Could not find module". `_resolve_ftd2xx()` now tries, in order:
`$PANGO_MCP_FTD2XX` → System32/SysWOW64 → the cdt bins discovered from
`pango-mcp.config.json` (`hosts.*.pds`) → bare `ftd2xx.dll` (loader searches PATH).
Verified on this PDS-only host: resolves to the 2025.2 bin and `WinDLL` loads; a
cable-less `scan` then reaches `FT_Open -> FT_STATUS 2` (DEVICE_NOT_FOUND) cleanly
instead of failing at DLL load.

## MCP exposure — bare-metal JTAG is now MCP-callable (2026-06-28)

The proven cli.py path is wrapped as MCP tools (pango-pds/index.mjs): `fpga_jtag_scan`
/ `fpga_jtag_gen_svf` / `fpga_jtag_flash` / `fpga_jtag_capture`, shelling out to
`python cli.py <sub>` (cwd=jtag/). They return structured D2XX inventory and
ownership diagnostics on a busy FT_Open without claiming a specific owner.
**Offline-validated:** registration + `fpga_jtag_gen_svf` produced a
real 18.5MB CRAM SVF with no cable; `fpga_jtag_scan` returns the graceful no-cable
result. **HW-verified (2026-07-10):** MCP scan/guarded flash/capture passed in one
persistent server on PG2L200H; see the v0.3.1 proof above.

## Bare-metal flashing via SVF replay — WORKING end-to-end (2026-06-23)

Replaces PDS/cdt_cfg cable-flashing (slow+flaky: observed `get_cable_paras`
99.8s + `No response in 60 secs`) with bare-metal config over our MPSSE engine.
**Path A: SVF replay** (vendor generates standard JTAG vectors offline; we replay
bit-exact — no `.sbit` format RE, no recipe guessing).

**PROVEN:** `cli.py flash --svf top_cram.svf` configured the FPGA in **15s @6MHz**,
both TDO checks OK (IDCODE `SDR#12`, **done bit `SDR#26`**), then `cli.py capture`
read back the live counter (monotonic) — a self-contained flash+verify loop with
no cdt_dbg/GUI/cdt_cfg-on-cable.

### DONE
- **SVF generation works OFFLINE (no cable):** cdt_cfg's `cfg_one_step_create_svf`
  converts `.sbit`→`.svf`. Command (license env `PANGO_LICENSE_FILE` from
  `pango-mcp.env`), run via `cdt_cfg_shell.exe -file <tcl>`:
  ```
  cfg_one_step_create_svf -sbit <top.sbit> -svf_file_name <out.svf> \
      -svf_property 0x40C4E -device_index 0 -jtag_chain 0
  ```
  `-svf_property 0x40C4E` = mode bits17-16=0 (**CRAM/SRAM**) + bit11 (check done) +
  bit18 (1MHz) + sensible defaults. `-jtag_chain 0` avoids a live scan (was the
  fix for `Configuration-0010: no device in chain`). Produced
  `verify/.work/pdsblink/prj_tasks/pnr_1/generate_bitstream/top_cram.svf` (18.5MB).
- **SVF structure confirmed** (only SIR/SDR/RUNTEST/STATE + setup): IDCODE check
  `SDR#12` (TDO 00603899 MASK 0FFFFFFF); CFGI `SIR 28B` + `RUNTEST 500000 TCK`;
  the bitstream `SDR 73508416`; `SIR 28D` (JWAKEUP); done check `SDR#26`
  (TDO 00001000 MASK 00001000 = status bit12). Matches the vendor recipe.
- **`svf_player.py` written** (parser + player; DRY-RUN default, `--run` = actual
  flash, gated). Engine primitives added to `mpsse_jtag.py`: `tck_pulse` (drives
  TMS low for RUNTEST clock-only 0x8F, else it would walk out of RTI),
  `write_dr_long` (chunked streaming shift for the 73Mbit DR), `state_reset/idle`.
- **DRY-RUN PASSED:** `python svf_player.py top_cram.svf` → 28 stmts, 73,508,480
  shift bits, 2 TDO checks, est ~73.5s @1MHz.

### DONE (cont.)
- **Actual flash works** via `cli.py flash --svf <svf>` (or `svf_player.py <svf>
  --run`): re-checks IDCODE, JRST, CFGI, shifts 73.5Mbit, JWAKEUP, verifies done
  bit. **6MHz → ~15s** (1MHz default in svf_player was ~73s; 6MHz proven safe, it's
  within the SVF's own 100KHz–10MHz range). Low/reversible (SRAM volatile).
- **Verified**: done-bit OK + FLA capture reads the live counter.
- **Productized**: `cli.py` now has `scan` / `flash` / `capture`.

### NEXT (optional polish)
1. ~~Wire the offline SVF-gen (cdt_cfg `cfg_one_step_create_svf`) into a `gen-svf`
   subcommand so `.sbit → flash` is one tool (currently a documented one-liner).~~
   **DONE (2026-06-23):** `cli.py gen-svf --sbit <x.sbit>` is the offline-only
   converter; `cli.py flash --sbit <x.sbit>` is the one-shot path (caches the
   CRAM SVF alongside the .sbit, mtime-checked, auto-regen if stale).
2. ~~Add a parser unit test for `svf_player.parse_svf` (regression).~~
   **DONE:** `test/svf-parse-unit.py` (no hardware, no PDS) — covers comments,
   multi-line hex, dry-run tallies, HIR/unknown-cmd/TDO+nonzero-TDI guards,
   STATE multi-token, RUNTEST TCK+SEC.
3. Try 10MHz for an even faster shift (CLI already exposes `--tck-hz`; 6MHz
   proven safe, the SVF's own range is 100KHz–10MHz). Not yet HW-verified.

### Why SVF (vs Path B = raw .sbit RE)
`.sbit` = tagged header (ASCII meta, ends at tag `i`/0x69) + sparse mostly-zero
payload + `a0000000`×100 tail. Reversing payload bit-order/framing + transcribing
the download recipe + debugging 73Mbit with only a done-bit oracle = high risk.
SVF sidesteps all of it. Path B remains a future "zero vendor dependency" stretch.
