"""Encoding-independent trigger oracle: does the FLA buffer FREEZE?

The status register turned out to read a constant (always-true and value triggers
give identical 0x01002000), so it can't tell triggered from waiting. The robust,
position-independent signal is whether the capture buffer is FROZEN: arm, let the
counter run, then read the raw buffer TWICE (no re-arm). A frozen (triggered) FLA
returns identical data both times; a free-running one returns different windows.

Control: always-true MUST freeze (A==B) and be monotonic. Then sweep value-trigger
encodings; any combo whose buffer freezes (A==B) AND whose window contains the
target is the working trigger. If the control freezes but NO value combo does, the
core has no working runtime comparator (P2 / fic), independent of bit-order.

  python fla-freeze.py            # width 8 depth 1024 value 0xA5
"""
import sys
import time

from _lab import require_confirm  # noqa: E402  (also puts jtag/ on sys.path)

require_confirm()
from mpsse_jtag import MpsseJtag          # noqa: E402
from fla_pango import PangoFla, IR_FLA    # noqa: E402


def raw_read(fla):
    """Step 28(triggered)+29 readout, WITHOUT teardown, so it can be repeated to
    test whether the buffer is static (frozen) or advancing (free-run)."""
    j = fla.j
    j.shift_ir(IR_FLA, 10)
    j.write_dr(0x03c, 9)
    return j.read_dr(fla.all_data_len)


def frozen_probe(j, width, depth, trigger, value, settle=0.1, blob_rev=False,
                 chan_rev=False, msb=False, cond=0):
    fla = PangoFla(j, width=width, depth=depth, trigger=trigger,
                   condition_bit=cond, chan_reversed=chan_rev, code_msb_first=msb)
    if blob_rev and trigger:
        n = fla.capture_len
        v = fla.trigger_value
        fla.trigger_value = sum(((v >> i) & 1) << (n - 1 - i) for i in range(n))
    fla.arm()
    time.sleep(settle)
    a = raw_read(fla)
    b = raw_read(fla)
    frozen = (a == b)
    sa = fla.unpack(a)
    has_target = value in sa if value is not None else None
    where = [i for i, s in enumerate(sa) if s == value][:3] if value is not None else None
    return frozen, sa, has_target, where


def run(width, depth, value):
    pattern = "".join("1" if (value >> b) & 1 else "0" for b in range(width))
    mask = (1 << width) - 1
    with MpsseJtag(index=0) as j:
        print(f"IDCODE=0x{j.read_idcode():08X}\n")

        # control: always-true must freeze + be monotonic
        frz, sa, _, _ = frozen_probe(j, width, depth, None, None)
        steps = sorted({(sa[i+1]-sa[i]) & mask for i in range(len(sa)-1)})
        print(f"[CONTROL always-true] frozen(A==B)={frz}  steps={steps}  "
              f"first8={[f'{x:02X}' for x in sa[:8]]}")
        print("  (expect frozen=True, steps=[1]; if frozen=False the freeze-oracle "
              "itself is unreliable)\n")

        print(f"[VALUE sweep] target=0x{value:02X} pattern={pattern!r} — "
              f"looking for frozen=True with target present at a stable index:")
        any_frozen = False
        for blob_rev in (False, True):
            for chan_rev in (False, True):
                for msb in (False, True):
                    for cond in (0, 1):
                        frz, sa, has, where = frozen_probe(
                            j, width, depth, pattern, value,
                            blob_rev=blob_rev, chan_rev=chan_rev, msb=msb, cond=cond)
                        any_frozen = any_frozen or frz
                        tag = ""
                        if frz:
                            tag = f"  <== FROZEN; target@{where}"
                        print(f"  blob_rev={blob_rev!s:5} chan_rev={chan_rev!s:5} "
                              f"msb={msb!s:5} cond={cond}: frozen={frz!s:5} "
                              f"target_present={has}{tag}")
        print()
        if not any_frozen:
            print("VERDICT: no value-trigger encoding freezes the buffer, though the "
                  "always-true control freezes. The arm/transport is correct; the "
                  "runtime value comparator does not engage for ANY bit-order. Points "
                  "to the FLA core/fic build (P2), not our encoding.")
        else:
            print("VERDICT: at least one encoding froze the buffer => the comparator "
                  "DOES work; lock that combo as the trigger encoding.")


if __name__ == "__main__":
    w = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    d = int(sys.argv[2]) if len(sys.argv) > 2 else 1024
    v = int(sys.argv[3], 0) if len(sys.argv) > 3 else 0xA5
    run(w, d, v)
