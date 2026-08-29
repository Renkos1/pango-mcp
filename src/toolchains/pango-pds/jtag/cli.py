"""pango_jtag — standalone headless bare-metal JTAG tool for Pango (Logos2).

Wraps the proven MPSSE transport (mpsse_jtag.py), FLA capture (fla_pango.py)
and SVF player (svf_player.py) into a general CLI. No vendor exe, no GUI, no
MCP at runtime (gen-svf shells out to cdt_cfg_shell, offline, no cable).

Subcommands:
  scan      detect device(s) + IDCODE on the FT2232 cable
  gen-svf   convert a .sbit to a CRAM .svf via cdt_cfg (offline, no cable)
  flash     bare-metal configure SRAM by replaying a CRAM .svf (or --sbit shortcut)
  poll      arm + repeatedly read the FLA status DR (0x038) — diagnostic
  capture   arm the on-chip FLA, read back the sample buffer, export

Capture width/depth/signal-names come from the design's .fic (--fic) or are
given explicitly (--width/--depth/--signals); nothing device-specific is baked
in.

Run bare-JTAG decoupled: stop cdt_js first and do NOT touch the fpga MCP while
this holds the cable (it owns cdt_js). Example:
  python cli.py flash --sbit verify/.work/pdsblink/.../top.sbit
  python cli.py capture --fic debug/counter_ila.fic --vcd out.vcd --json out.json
"""

import argparse
import json
import os
import re
import sys
import time

from mpsse_jtag import MpsseJtag, d2xx_inventory
from fla_pango import FlaFramingError, PangoFla
from svf_player import parse_svf, SvfPlayer
import export


D2XX_INVENTORY_MARKER = "JTAG_D2XX_JSON:"
FLA_FRAMING_MARKER = "FLA_FRAMING_JSON:"


def parse_fic(path):
    """Pull (signals LSB-first, depth) from a Pango Fabric Inserter .fic.
    Signals come from triggerChannel<0><i>=<net>; depth from dataDepth."""
    chans = {}
    depth = None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            m = re.search(r"triggerChannel<\d+><(\d+)>\s*=\s*(.+?)\s*$", line)
            if m:
                chans[int(m.group(1))] = m.group(2)
                continue
            m = re.search(r"dataDepth\s*=\s*(\d+)", line)
            if m:
                depth = int(m.group(1))
    signals = [chans[i] for i in sorted(chans)] if chans else None
    return signals, depth


def cmd_scan(args):
    found = []
    for ch in ([args.channel] if args.channel is not None else range(2)):
        try:
            with MpsseJtag(index=ch, tck_hz=args.tck_hz) as j:
                idc = j.read_idcode()
            valid = idc not in (0x00000000, 0xFFFFFFFF)
            print(f"channel {ch}: IDCODE = 0x{idc:08X}" + ("" if valid else "  (no device / floating)"))
            if valid:
                found.append((ch, idc))
        except Exception as e:
            print(f"channel {ch}: {e}")
    return 0 if found else 1


def cmd_capture(args):
    signals, fic_depth = (None, None)
    if args.fic:
        signals, fic_depth = parse_fic(args.fic)
    if args.signals:
        signals = [s.strip() for s in args.signals.split(",") if s.strip()]

    width = args.width or (len(signals) if signals else None)
    depth = args.depth or fic_depth
    if not width or not depth:
        print("error: need --width and --depth (or a --fic that supplies them)", file=sys.stderr)
        return 2
    if signals and len(signals) != width:
        print(f"warning: {len(signals)} signal names but width={width}; ignoring names", file=sys.stderr)
        signals = None

    with MpsseJtag(index=args.channel, tck_hz=args.tck_hz) as j:
        idc = j.read_idcode()
        print(f"channel {args.channel}: IDCODE = 0x{idc:08X}  (TCK {j.actual_tck/1e6:.3f} MHz)")
        fla = PangoFla(j, width=width, depth=depth, trigger=args.trig,
                       condition_bit=args.cond, trig_position=args.trig_pos,
                       padding_bits=args.padding_bits)
        if args.trig:
            print(f"trigger: {args.trig!r}  cond={args.cond}  "
                  f"(value=0x{fla.trigger_value:0{(fla.capture_len+3)//4}X}, {fla.capture_len}b)")
        capture_error = None
        try:
            raw, samples = fla.capture()
        except FlaFramingError as exc:
            raw, samples = exc.raw, []
            capture_error = str(exc)
        print(FLA_FRAMING_MARKER + json.dumps(fla.framing(), separators=(",", ":")))
        if args.trig and not capture_error:
            ti = getattr(fla, "last_trigger_index", None)
            print("triggered: marker found, window aligned to trigger@0"
                  if ti is not None else
                  "WARNING: trigger never fired in budget (check value/clock)")

    if args.raw:
        export.write_raw(args.raw, raw, fla.last_read_bit_length)
        print(f"wrote RAW  -> {args.raw} ({fla.last_read_bit_length} bits)")
    if capture_error:
        print(f"error: {capture_error}", file=sys.stderr)
        return 1

    if not args.no_summary:
        print(export.summarize(samples, width))

    # Trigger metadata so downstream plotters can MARK the trigger and know the
    # buffer is circular. With a value/edge trigger the window is rotated to
    # trigger@0 (aligned), which puts the acquisition seam (freeze point, where
    # newest meets oldest) mid-array — a naive index-order plot splices across it
    # and looks illogical. `trigger_index` is 0 when aligned;
    # `aligned` flags the rotation; `circular` warns the seam exists.
    ti = getattr(fla, "last_trigger_index", None) if args.trig else None
    meta = {"idcode": f"0x{idc:08X}", "width": width, "depth": depth,
            "channel": args.channel, "signals": signals,
            "trigger": args.trig or None, "trigger_index": ti,
            "aligned": bool(args.trig) and ti is not None, "circular": True,
            "framing": fla.framing(),
            "rawPath": os.path.abspath(args.raw) if args.raw else None}
    if args.vcd:
        export.write_vcd(args.vcd, samples, width, signal_names=signals)
        print(f"wrote VCD  -> {args.vcd}")
    if args.json:
        export.write_json(args.json, samples, width, meta=meta)
        print(f"wrote JSON -> {args.json}")
    if args.csv:
        export.write_csv(args.csv, samples, width, signal_names=signals)
        print(f"wrote CSV  -> {args.csv}")
    return 0


def cmd_poll(args):
    """Arm the FLA, then read its status DR repeatedly and print the raw value.
    Use this on hardware to verify the status bit-alignment guess (low 3 bits
    == 0b010 means triggered+ready). Useful when chasing event-trigger work
    against a real bitstream — no readback/teardown, safe to spam."""
    if not args.width or not args.depth:
        if args.fic:
            signals, fic_depth = parse_fic(args.fic)
            args.width = args.width or (len(signals) if signals else None)
            args.depth = args.depth or fic_depth
    if not args.width or not args.depth:
        print("error: need --width and --depth (or --fic that supplies them)", file=sys.stderr)
        return 2

    with MpsseJtag(index=args.channel, tck_hz=args.tck_hz) as j:
        idc = j.read_idcode()
        print(f"channel {args.channel}: IDCODE = 0x{idc:08X}  (TCK {j.actual_tck/1e6:.3f} MHz)")
        fla = PangoFla(j, width=args.width, depth=args.depth, trigger=args.trig,
                       condition_bit=args.cond)
        print(f"capture_len={fla.capture_len} padding_bits={fla.padding_bits} "
              f"sample_stride={fla.sample_stride} all_data_len={fla.all_data_len} "
              f"depth_len={fla.depth_len} trig_position={fla.trig_position}")
        if args.trig:
            print(f"trigger: {args.trig!r}  cond={args.cond}  "
                  f"(value=0x{fla.trigger_value:0{(fla.capture_len+3)//4}X}, {fla.capture_len}b)")
        fla.arm()
        print(f"armed; polling status DR (0x038) x{args.attempts}, "
              f"{args.poll_wait_s*1000:.0f}ms between polls, shift={args.nbits}b")
        ready_at = None
        for i in range(args.attempts):
            time.sleep(args.poll_wait_s)
            status = fla.poll_status(nbits=args.nbits)
            hexw = (args.nbits + 3) // 4
            top3 = (status >> (args.nbits - 3)) & 0b111
            low3 = status & 0b111
            tag = "  READY" if top3 == 0b010 else ""
            print(f"  #{i+1:3d}: raw=0x{status:0{hexw}X} top3=0b{top3:03b} low3=0b{low3:03b}{tag}")
            if top3 == 0b010 and ready_at is None:
                ready_at = i + 1
                if args.stop_on_ready:
                    break
    if ready_at is not None:
        print(f"first ready at poll #{ready_at}")
        return 0
    print("never reached ready in budget — check trigger / clock / interpretation")
    return 1


def _pkg_root():
    # cli.py lives at packages/pango-mcp/src/toolchains/pango-pds/jtag/cli.py;
    # the package root (with config + env) is 4 dirs up.
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))


def _has_cfg_exe(bin_dir):
    return bool(bin_dir) and os.path.exists(os.path.join(bin_dir, "cdt_cfg_shell.exe"))


def _pds_bin_from_env_file():
    """Parse the MCP's pango-mcp.env for PANGO_MCP_PDS_2025/_2022/_BIN. This is the
    file the MCP loads but a bare PowerShell shell does NOT, which is exactly why
    the standalone JTAG tool failed before this was added — the var was set for
    the MCP, not for the ad-hoc shell running cli.py."""
    env_path = os.path.join(_pkg_root(), "pango-mcp.env")
    if not os.path.exists(env_path):
        return None
    vals = {}
    try:
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                vals[k.strip()] = v.strip().strip('"').strip("'")
    except Exception:
        return None
    for key in ("PANGO_MCP_PDS_BIN", "PANGO_MCP_PDS_2025", "PANGO_MCP_PDS_2022"):
        val = vals.get(key)
        if not val:
            continue
        cand = val if key.endswith("_BIN") else os.path.dirname(val)
        if _has_cfg_exe(cand):
            return cand
    return None


def _pds_bin_from_config():
    """Find a dir containing cdt_cfg_shell.exe — first from pango-mcp.config.json's
    pdsInstalls[].shell (prefer 2025), then from pango-mcp.env. Lets gen-svf/flash
    work in a bare shell with no PANGO_MCP_PDS_* env exported."""
    import json
    cfg = os.path.join(_pkg_root(), "pango-mcp.config.json")
    if os.path.exists(cfg):
        try:
            with open(cfg, encoding="utf-8") as f:
                data = json.load(f)
            installs = data.get("pdsInstalls") or []
            for want in ("2025", "2022", ""):
                for inst in installs:
                    if want and want not in str(inst.get("id", "")):
                        continue
                    shell = inst.get("shell") or (os.path.join(inst["binDir"], "pds_shell.exe") if inst.get("binDir") else None)
                    if shell and _has_cfg_exe(os.path.dirname(shell)):
                        return os.path.dirname(shell)
        except Exception:
            pass
    return _pds_bin_from_env_file()


def cmd_gen_svf(args):
    """Offline .sbit -> CRAM .svf via cdt_cfg (no cable). One-time per bitstream."""
    import os
    import subprocess
    import tempfile
    pds_bin = args.pds_bin or os.environ.get("PANGO_MCP_PDS_BIN")
    if not pds_bin:
        sh = os.environ.get("PANGO_MCP_PDS_2025") or os.environ.get("PANGO_MCP_PDS_2022")
        if sh:
            pds_bin = os.path.dirname(sh)
    if not pds_bin:
        pds_bin = _pds_bin_from_config()
    if not pds_bin:
        print("error: need --pds-bin (dir with cdt_cfg_shell.exe), env "
              "PANGO_MCP_PDS_BIN / PANGO_MCP_PDS_2025, or a pdsInstalls entry in "
              "pango-mcp.config.json", file=sys.stderr)
        return 2
    shell = os.path.join(pds_bin, "cdt_cfg_shell.exe")
    out = args.svf or (os.path.splitext(args.sbit)[0] + "_cram.svf")
    sbit_fwd = args.sbit.replace("\\", "/")
    out_fwd = out.replace("\\", "/")
    tcl = (f"cfg_one_step_create_svf -sbit {sbit_fwd} -svf_file_name {out_fwd} "
           f"-svf_property {args.property} -device_index 0 -jtag_chain 0\n")
    with tempfile.NamedTemporaryFile("w", suffix=".tcl", delete=False) as tf:
        tf.write(tcl)
        tcl_path = tf.name
    env = dict(os.environ)
    if args.license:
        env["PANGO_LICENSE_FILE"] = args.license
    print(f"generating CRAM SVF: {args.sbit} -> {out} (property {args.property})")
    r = subprocess.run([shell, "-file", tcl_path], capture_output=True, text=True,
                       env=env, timeout=args.timeout)
    os.unlink(tcl_path)
    tail = "\n".join((r.stdout or "").strip().splitlines()[-4:])
    if not os.path.exists(out) or os.path.getsize(out) == 0:
        print(tail, file=sys.stderr)
        print("FAILED: SVF not created", file=sys.stderr)
        return 1
    print(f"wrote SVF -> {out} ({os.path.getsize(out)} bytes)")
    return 0


def _ensure_svf_for_sbit(args):
    """Return a CRAM .svf path for args.sbit, generating it (offline, cdt_cfg)
    if missing or older than the .sbit. Cache lives alongside the .sbit as
    `<sbit_basename>_cram.svf` so it's reused across flashes."""
    import os
    sbit = args.sbit
    if not os.path.exists(sbit):
        print(f"error: --sbit not found: {sbit}", file=sys.stderr)
        return None
    svf = os.path.splitext(sbit)[0] + "_cram.svf"
    if os.path.exists(svf) and os.path.getmtime(svf) >= os.path.getmtime(sbit) \
            and os.path.getsize(svf) > 0:
        print(f"using cached CRAM SVF -> {svf}")
        return svf
    print(f"CRAM SVF missing or stale; generating offline from {sbit}")
    gen = argparse.Namespace(sbit=sbit, svf=svf, pds_bin=args.pds_bin,
                             license=args.license, property=args.property,
                             timeout=args.timeout)
    rc = cmd_gen_svf(gen)
    if rc != 0 or not os.path.exists(svf):
        return None
    return svf


def cmd_flash(args):
    """Bare-metal SRAM config by replaying a CRAM SVF (this IS the flash).
    The SVF is generated offline via cdt_cfg `cfg_one_step_create_svf` (CRAM
    mode) — either by passing --sbit (we cache+regen as needed) or by passing
    --svf directly (see gen-svf for the offline-only conversion).
    No cdt_cfg/cdt_js/cable enumeration here."""
    svf_path = args.svf
    if not svf_path:
        svf_path = _ensure_svf_for_sbit(args)
        if not svf_path:
            return 1
    with open(svf_path, encoding="ascii", errors="replace") as f:
        cmds = parse_svf(f.read())
    print(f"flashing {svf_path} ({len(cmds)} SVF stmts) on channel {args.channel} "
          f"@ {args.tck_hz/1e6:.0f} MHz")
    with MpsseJtag(index=args.channel, tck_hz=args.tck_hz) as j:
        player = SvfPlayer(j)
        print(f"IDCODE = 0x{j.read_idcode():08X}")
        t = time.time()
        player.run(cmds, dry_run=False, verbose=args.verbose, progress=True)
        print(f"replay done in {time.time()-t:.1f}s")
        print(player.report())
    ok = not ([c for c in player.checks if c[2] is False] or player.errors)
    print("FLASH OK (done bit verified)" if ok else "FLASH FAILED (see checks above)")
    return 0 if ok else 1


def build_parser():
    p = argparse.ArgumentParser(prog="pango_jtag", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--channel", type=int, default=0, help="FT2232 channel index (default 0)")
    p.add_argument("--tck-hz", type=int, default=1_000_000, help="JTAG TCK in Hz (default 1e6)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="detect device(s) + IDCODE")
    s.add_argument("--channel", type=int, default=None, help="single channel (default: probe 0 and 1)")
    s.set_defaults(func=cmd_scan)

    c = sub.add_parser("capture", help="arm FLA, read back samples, export")
    c.add_argument("--width", type=int, help="sample width in bits")
    c.add_argument("--depth", type=int, help="capture depth (power of two)")
    c.add_argument("--fic", help="Pango .fic to derive signals/depth from")
    c.add_argument("--signals", help="comma-separated bit names, LSB first (overrides .fic)")
    c.add_argument("--vcd", help="write VCD to this path")
    c.add_argument("--json", help="write JSON to this path")
    c.add_argument("--csv", help="write CSV to this path")
    c.add_argument("--raw", help="write exact step-29 raw bits as LSB-first packed bytes")
    c.add_argument("--padding-bits", type=int,
                   help="explicit physical protocol bits/sample; default probes/infer fail-closed")
    c.add_argument("--no-summary", action="store_true", help="suppress the terminal summary")
    c.add_argument("--trig", help="per-channel trigger pattern, width chars from ch0, codes "
                   "x/0/1/r/f (value match; HW-proven). Requires a Match-Unit-built FLA "
                   "(ila.mjs renderFic). Default (omitted / all-x) = always-true capture. "
                   "The window is returned trigger-aligned (trigger sample at index 0).")
    c.add_argument("--cond", type=int, default=0, choices=[0, 1],
                   help="trailing condition bit at capture_len-1 (default 0)")
    c.add_argument("--trig-pos", type=int, default=None, help="trigger position in buffer (default depth)")
    c.set_defaults(func=cmd_capture)

    po = sub.add_parser("poll", help="arm FLA + read status DR (0x038) repeatedly (diagnostic)")
    po.add_argument("--width", type=int, help="sample width in bits")
    po.add_argument("--depth", type=int, help="capture depth (power of two)")
    po.add_argument("--fic", help="Pango .fic to derive depth from")
    po.add_argument("--attempts", type=int, default=20, help="how many polls (default 20)")
    po.add_argument("--poll-wait-s", type=float, default=0.01, help="sleep between polls (default 0.01s)")
    po.add_argument("--nbits", type=int, default=32, help="status DR shift length (default 32, matches the "
                    "vendor loop-iteration DR; try 16 for first-iter match)")
    po.add_argument("--stop-on-ready", action="store_true", help="stop the first time top3=0b010")
    po.add_argument("--trig", help="trigger pattern (see capture --trig)")
    po.add_argument("--cond", type=int, default=0, choices=[0, 1], help="condition bit (default 0)")
    po.set_defaults(func=cmd_poll)

    g = sub.add_parser("gen-svf", help="offline .sbit -> CRAM .svf via cdt_cfg (no cable)")
    g.add_argument("--sbit", required=True, help="input bitstream (.sbit)")
    g.add_argument("--svf", help="output .svf path (default: <sbit>_cram.svf alongside)")
    g.add_argument("--pds-bin", help="dir with cdt_cfg_shell.exe (else env PANGO_MCP_PDS_BIN/_2025/_2022)")
    g.add_argument("--license", help="PANGO_LICENSE_FILE (else inherit from env)")
    g.add_argument("--property", default="0x40C4E",
                   help="-svf_property (default 0x40C4E = CRAM/SRAM + check-done + 1MHz)")
    g.add_argument("--timeout", type=int, default=180, help="cdt_cfg_shell timeout in seconds")
    g.set_defaults(func=cmd_gen_svf)

    fl = sub.add_parser("flash", help="bare-metal configure SRAM by replaying a CRAM SVF "
                                       "(--sbit auto-runs gen-svf if cache stale)")
    src = fl.add_mutually_exclusive_group(required=True)
    src.add_argument("--svf", help="CRAM .svf (skip gen-svf)")
    src.add_argument("--sbit", help=".sbit; flashes via cached/auto-generated CRAM .svf")
    fl.add_argument("--pds-bin", help="for --sbit: dir with cdt_cfg_shell.exe")
    fl.add_argument("--license", help="for --sbit: PANGO_LICENSE_FILE")
    fl.add_argument("--property", default="0x40C4E", help="for --sbit: -svf_property")
    fl.add_argument("--timeout", type=int, default=180, help="for --sbit: cdt_cfg_shell timeout (s)")
    fl.add_argument("--tck-hz", type=int, default=6_000_000, help="JTAG TCK in Hz (default 6e6; proven safe up to ~10e6)")
    fl.add_argument("--verbose", action="store_true")
    fl.set_defaults(func=cmd_flash)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    # let subparser --channel override the global default when given
    if getattr(args, "channel", None) is None and args.cmd != "scan":
        args.channel = 0
    if args.cmd in {"scan", "capture", "poll", "flash"}:
        # One compact machine record plus the existing human-readable CLI lines.
        # Inventory only enumerates the driver; it does not open/reset a channel.
        print(D2XX_INVENTORY_MARKER + json.dumps(d2xx_inventory(), separators=(",", ":")))
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
