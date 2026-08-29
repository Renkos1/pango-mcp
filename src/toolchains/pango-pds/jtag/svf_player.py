"""Minimal SVF (Serial Vector Format) parser + player on the MPSSE transport.

Plays the subset that Pango's `cfg_one_step_create_svf` emits for CRAM (SRAM)
configuration: SIR / SDR (with TDO/MASK verify) / RUNTEST / STATE / ENDIR /
ENDDR / HIR / HDR / TIR / TDR / FREQUENCY / TRST. That is enough to configure
the FPGA bare-metal — no cdt_cfg/cdt_js/cable enumeration.

SVF semantics honored: scan values shift LSB-first; TDO check is
`(captured & MASK) == (expected & MASK)`; RUNTEST clocks TCK in Run-Test-Idle;
HIR/HDR/TIR/TDR are single-device padding (must be 0 here — asserted).

Default mode is DRY-RUN: parse, validate, and report (no hardware touched).
`--run` actually replays = this is the flash. Keep that gated.
"""

import argparse
import re
import sys
import time

from mpsse_jtag import MpsseJtag, FtError

_PAREN = {k: re.compile(k + r"\s*\(\s*([0-9A-Fa-f\s]*?)\s*\)") for k in ("TDI", "TDO", "MASK", "SMASK")}
_STRIP_PAREN = re.compile(r"(?:TDI|TDO|MASK|SMASK)\s*\([0-9A-Fa-f\s]*?\)")


def parse_svf(text):
    """Tokenize SVF text into a list of {cmd, scalars, params} statements."""
    out = []
    for raw in text.splitlines():
        for c in ("//", "!"):
            i = raw.find(c)
            if i >= 0:
                raw = raw[:i]
        out.append(raw)
    blob = " ".join(out)
    cmds = []
    for stmt in blob.split(";"):
        stmt = stmt.strip()
        if not stmt:
            continue
        head = stmt.split(None, 1)
        cmd = head[0].upper()
        rest = head[1] if len(head) > 1 else ""
        params = {}
        for key, rx in _PAREN.items():
            m = rx.search(rest)
            if m:
                hexs = re.sub(r"\s", "", m.group(1))
                params[key] = int(hexs, 16) if hexs else 0
        scalars = _STRIP_PAREN.sub("", rest).split()
        cmds.append({"cmd": cmd, "scalars": scalars, "params": params})
    return cmds


class SvfError(RuntimeError):
    pass


class SvfPlayer:
    def __init__(self, jtag=None):
        self.j = jtag
        self.checks = []        # (index, length, ok)
        self.shift_bits = 0
        self.runtest_tck = 0
        self.frequency = None
        self.errors = []

    def _runtest_counts(self, scalars):
        tck = sec = 0
        for i, t in enumerate(scalars):
            if t.upper() == "TCK" and i:
                tck = int(float(scalars[i - 1]))
            elif t.upper() == "SEC" and i:
                sec = float(scalars[i - 1])
        return tck, sec

    def run(self, cmds, dry_run=True, verbose=False, progress=None):
        for n, c in enumerate(cmds):
            cmd, sc, pr = c["cmd"], c["scalars"], c["params"]
            if cmd in ("TRST", "ENDIR", "ENDDR", "FREQUENCY"):
                if cmd == "FREQUENCY" and sc:
                    self.frequency = float(sc[0])
                continue
            if cmd in ("HIR", "HDR", "TIR", "TDR"):
                if sc and int(sc[0]) != 0:
                    raise SvfError(f"{cmd} length {sc[0]} != 0: multi-device chains unsupported")
                continue
            if cmd == "STATE":
                for st in sc:
                    st = st.upper()
                    if not dry_run:
                        if st == "RESET":
                            self.j.state_reset()
                        elif st in ("IDLE", "RUNTEST"):
                            self.j.state_idle()
                continue
            if cmd == "RUNTEST":
                tck, sec = self._runtest_counts(sc)
                self.runtest_tck += tck
                if not dry_run:
                    if tck:
                        self.j.tck_pulse(tck)
                    if sec:
                        time.sleep(sec)
                continue
            if cmd == "SIR":
                length = int(sc[0])
                if not dry_run:
                    self.j.shift_ir(pr.get("TDI", 0), length)
                continue
            if cmd == "SDR":
                length = int(sc[0])
                self.shift_bits += length
                tdi = pr.get("TDI", 0)
                if "TDO" in pr:
                    mask = pr.get("MASK", (1 << length) - 1)
                    if tdi != 0:
                        raise SvfError(f"SDR#{n}: TDO-check with nonzero TDI unsupported")
                    if dry_run:
                        self.checks.append((n, length, None))
                    else:
                        cap = self.j.read_dr(length)
                        ok = (cap & mask) == (pr["TDO"] & mask)
                        self.checks.append((n, length, ok))
                        if not ok:
                            self.errors.append(f"SDR#{n} len{length}: got 0x{cap & mask:X} "
                                               f"expected 0x{pr['TDO'] & mask:X} mask 0x{mask:X}")
                        if verbose:
                            print(f"  SDR#{n} check len{length}: {'OK' if ok else 'FAIL'}")
                else:
                    if not dry_run:
                        if progress and length > 1_000_000:
                            print(f"  shifting {length} bits ({length//8} bytes) ...", flush=True)
                        self.j.write_dr_long(tdi, length)
                continue
            raise SvfError(f"unknown SVF command: {cmd}")
        return self

    def report(self):
        lines = [f"commands parsed; total DR shift bits = {self.shift_bits} "
                 f"({self.shift_bits//8} bytes)",
                 f"RUNTEST total TCK = {self.runtest_tck}",
                 f"FREQUENCY = {self.frequency} Hz" if self.frequency else "FREQUENCY = (unset)",
                 f"TDO checks = {len(self.checks)}"]
        for n, length, ok in self.checks:
            status = {True: "OK", False: "FAIL", None: "(dry-run, not executed)"}[ok]
            lines.append(f"  - SDR#{n} len{length}: {status}")
        if self.errors:
            lines.append("ERRORS:")
            lines += ["  " + e for e in self.errors]
        return "\n".join(lines)


def main(argv=None):
    p = argparse.ArgumentParser(description="SVF parser/player (bare-metal Pango config)")
    p.add_argument("svf", help="path to .svf file")
    p.add_argument("--run", action="store_true",
                   help="ACTUALLY replay to the device (this is the flash). Default: dry-run.")
    p.add_argument("--channel", type=int, default=0)
    p.add_argument("--tck-hz", type=int, default=1_000_000)
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args(argv)

    with open(args.svf, encoding="ascii", errors="replace") as f:
        text = f.read()
    t0 = time.time()
    cmds = parse_svf(text)
    print(f"parsed {len(cmds)} SVF statements in {time.time()-t0:.1f}s")

    player = SvfPlayer(None)
    if not args.run:
        player.run(cmds, dry_run=True)
        print(player.report())
        est = player.shift_bits / args.tck_hz
        print(f"\nDRY-RUN ok. Est. shift time at {args.tck_hz/1e6:.0f} MHz TCK: ~{est:.1f}s")
        print("Re-run with --run to actually configure the device (this is the flash).")
        return 0

    with MpsseJtag(index=args.channel, tck_hz=args.tck_hz) as j:
        print(f"IDCODE = 0x{j.read_idcode():08X}; replaying SVF at {j.actual_tck/1e6:.3f} MHz ...")
        player.j = j
        t1 = time.time()
        player.run(cmds, dry_run=False, verbose=args.verbose, progress=True)
        print(f"replay done in {time.time()-t1:.1f}s")
        print(player.report())
    fails = [c for c in player.checks if c[2] is False]
    return 1 if (fails or player.errors) else 0


if __name__ == "__main__":
    sys.exit(main())
