"""Unit test for svf_player.parse_svf + SvfPlayer dry-run tallying. No hardware."""
import sys
from pathlib import Path
JTAG_DIR = Path(__file__).resolve().parents[1] / "src" / "toolchains" / "pango-pds" / "jtag"
sys.path.insert(0, str(JTAG_DIR))
from svf_player import parse_svf, SvfPlayer, SvfError

SAMPLE = """
// a comment
TRST OFF;
ENDIR IDLE; ENDDR IDLE;
STATE RESET; STATE IDLE;
FREQUENCY 1E6 HZ;
TIR 0; HIR 0; TDR 0; HDR 0;
! bang comment
SIR 10 TDI (283);
SDR 32 TDI (00000000)
    TDO (00603899)
    MASK (0FFFFFFF);
SIR 10 TDI (28B);
RUNTEST IDLE 500000 TCK;
SDR 40 TDI (00000000FF);
SIR 10 TDI (159);
SDR 32 TDI (00000000) TDO (00001000) MASK (00001000);
STATE RESET;
"""

def check(cond, msg):
    if not cond:
        raise AssertionError(msg)

cmds = parse_svf(SAMPLE)
kinds = [c["cmd"] for c in cmds]
check(kinds.count("SIR") == 3, f"SIR count {kinds.count('SIR')}")
check(kinds.count("SDR") == 3, f"SDR count {kinds.count('SDR')}")
check("TRST" in kinds and "FREQUENCY" in kinds, "setup cmds missing")

# comments stripped: no '//' or '!' leaked into any token
for c in cmds:
    for t in c["scalars"]:
        check("//" not in t and "!" not in t, f"comment leaked: {t}")

# SIR 283 parsed
sir0 = next(c for c in cmds if c["cmd"] == "SIR")
check(sir0["params"]["TDI"] == 0x283, "SIR TDI 0x283")

# IDCODE SDR: TDI/TDO/MASK, multi-line value joined
sdr_idcode = [c for c in cmds if c["cmd"] == "SDR"][0]
check(sdr_idcode["scalars"][0] == "32", "SDR len 32")
check(sdr_idcode["params"]["TDO"] == 0x00603899, "SDR TDO idcode")
check(sdr_idcode["params"]["MASK"] == 0x0FFFFFFF, "SDR MASK")

# 40-bit TDI value (no TDO) parsed full width
sdr_data = [c for c in cmds if c["cmd"] == "SDR"][1]
check(sdr_data["params"]["TDI"] == 0x00000000FF, "SDR 40b TDI")
check("TDO" not in sdr_data["params"], "SDR data has no TDO")

# dry-run tallies
pl = SvfPlayer(None).run(cmds, dry_run=True)
check(pl.shift_bits == 32 + 40 + 32, f"shift_bits {pl.shift_bits}")
check(pl.runtest_tck == 500000, f"runtest_tck {pl.runtest_tck}")
check(len(pl.checks) == 2, f"checks {len(pl.checks)}")
check(pl.frequency == 1e6, "frequency")

# nonzero HIR must raise (multi-device unsupported)
try:
    SvfPlayer(None).run(parse_svf("HIR 8 TDI (00);"), dry_run=True)
    raise AssertionError("nonzero HIR should raise")
except SvfError:
    pass

# unknown SVF command must raise (catches typos / accidental garbage instead of
# silently no-oping it, which would skip a real check)
try:
    SvfPlayer(None).run(parse_svf("WIBBLE 8;"), dry_run=True)
    raise AssertionError("unknown SVF command should raise")
except SvfError:
    pass

# SDR with TDO check + nonzero TDI is unsupported (we never expect this from
# cfg_one_step_create_svf; raise instead of silently miscomparing)
try:
    SvfPlayer(None).run(parse_svf(
        "SDR 32 TDI (DEADBEEF) TDO (00000000) MASK (FFFFFFFF);"
    ), dry_run=True)
    raise AssertionError("SDR with TDO+nonzero TDI should raise")
except SvfError:
    pass

# STATE accepts multiple tokens (e.g. STATE RESET IDLE;) — must not raise and
# must leave the parsed scalars intact for the player to walk
state_cmds = parse_svf("STATE RESET IDLE RUNTEST;")
check(state_cmds[0]["cmd"] == "STATE", "STATE cmd")
check([s.upper() for s in state_cmds[0]["scalars"]] == ["RESET", "IDLE", "RUNTEST"],
      f"STATE scalars {state_cmds[0]['scalars']}")
SvfPlayer(None).run(state_cmds, dry_run=True)  # smoke: doesn't raise

# RUNTEST with both TCK and SEC accumulates both correctly
rt = SvfPlayer(None).run(parse_svf("RUNTEST IDLE 100 TCK 0.5 SEC;"), dry_run=True)
check(rt.runtest_tck == 100, f"runtest_tck mixed {rt.runtest_tck}")

print("svf-parse-unit OK: 3 SIR / 3 SDR, multi-line hex, dry-run tallies, "
      "HIR / unknown / TDO+nonzero-TDI guards, STATE multi-token, RUNTEST TCK+SEC")
