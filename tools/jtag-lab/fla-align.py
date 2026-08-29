"""Nail the FLA sample alignment: find offset+order where samples are monotonic."""
import sys
from _lab import require_confirm  # noqa: E402  (also puts jtag/ on sys.path)

require_confirm()
from mpsse_jtag import MpsseJtag
from fla_pango import PangoFla, IR_FLA

j = MpsseJtag(index=0)
j.open()
dt = j.device_type()
j.sync()
j.config_clock(dt[0])
print(f"IDCODE = 0x{j.read_idcode():08X}")

fla = PangoFla(j, width=8, depth=1024)
fla.arm()
j.shift_ir(IR_FLA, 10)
j.write_dr(0x03c, 9)
raw = fla.all_data_len
raw = j.read_dr(fla.all_data_len)
j.close()

W, STRIDE = 8, 9
N = 64  # samples to test

def bit(v, i):
    return (v >> i) & 1

def extract(offset, stride, width, msb_first, nsamp):
    out = []
    for k in range(nsamp):
        base = offset + k*stride
        val = 0
        for b in range(width):
            src = base + (width-1-b if msb_first else b)
            val |= bit(raw, src) << b
        out.append(val)
    return out

best = None
for stride in (8, 9):
    for offset in range(0, 18):
        for msb in (False, True):
            s = extract(offset, stride, W, msb, N)
            diffs = [(s[i+1]-s[i]) & 0xFF for i in range(len(s)-1)]
            # monotonic if all diffs equal and nonzero
            if len(set(diffs)) == 1 and diffs[0] != 0:
                print(f"MONOTONIC: stride={stride} offset={offset} msb_first={msb} "
                      f"step={diffs[0]}  first8={[f'{x:02x}' for x in s[:8]]}")
                if best is None:
                    best = (stride, offset, msb, diffs[0])

if not best:
    print("no perfectly-constant step found; showing closest candidates (mostly-constant):")
    for stride in (8, 9):
        for offset in range(0, 18):
            for msb in (False, True):
                s = extract(offset, stride, W, msb, N)
                diffs = [(s[i+1]-s[i]) & 0xFF for i in range(len(s)-1)]
                from collections import Counter
                c = Counter(diffs).most_common(1)[0]
                if c[1] >= len(diffs)-2 and c[0] != 0:
                    print(f"  near: stride={stride} offset={offset} msb={msb} "
                          f"step={c[0]} ({c[1]}/{len(diffs)})  first8={[f'{x:02x}' for x in s[:8]]}")
else:
    st, off, msb, step = best
    s = extract(off, st, W, msb, 1024)
    print(f"\nFULL DECODE stride={st} offset={off} msb_first={msb} step={step}")
    print("first 24:", [f'{x:02x}' for x in s[:24]])
    print("last 8:  ", [f'{x:02x}' for x in s[-8:]])
