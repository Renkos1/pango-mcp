"""Exporters for captured FLA samples — pure Python, no dependencies.

A "capture" is a list of `depth` integer samples, each `width` bits wide. For an
always-true capture samples[0] is the oldest; for a value/edge trigger the window
is rotated to trigger@0 (samples[0] = the trigger sample), so it is NOT plain
oldest-first — the acquisition seam sits mid-array. Carry meta["trigger_index"]/
["circular"] (see cli.py) to mark the trigger and avoid splicing across the seam.
Signal names are optional; when given (len==width, LSB first) the waveform is
emitted per-bit, otherwise as a single width-bit vector. Used by cli.py and
reusable as a library.
"""

import json
import os


def _ensure_parent(path):
    """Create the destination's parent without requiring callers to pre-stage it."""
    parent = os.path.dirname(os.path.abspath(os.fspath(path)))
    if parent:
        os.makedirs(parent, exist_ok=True)


def _id_chars(n):
    """VCD identifier codes: printable ASCII from '!' (0x21) upward."""
    return [chr(0x21 + i) for i in range(n)]


def write_vcd(path, samples, width, signal_names=None, bus_name="data",
              timescale="1ns"):
    """Write a standard VCD. Time axis = sample index (1 tick/sample). Emits
    only value changes. If signal_names is given it must have `width` entries
    (LSB first) and each bit becomes its own scalar wire; otherwise one vector."""
    per_bit = signal_names is not None
    if per_bit and len(signal_names) != width:
        raise ValueError(f"signal_names has {len(signal_names)}, need width={width}")

    lines = ["$date pango-jtag fla capture $end",
             "$version pango_jtag.export $end",
             f"$timescale {timescale} $end",
             "$scope module fla $end"]
    if per_bit:
        ids = _id_chars(width)
        for i, name in enumerate(signal_names):
            lines.append(f"$var wire 1 {ids[i]} {name} $end")
    else:
        ids = _id_chars(1)
        lines.append(f"$var wire {width} {ids[0]} {bus_name} [{width-1}:0] $end")
    lines += ["$upscope $end", "$enddefinitions $end"]

    out = "\n".join(lines) + "\n"
    prev = None
    for t, val in enumerate(samples):
        if val == prev:
            continue
        chunk = [f"#{t}"]
        if per_bit:
            for i in range(width):
                bit = (val >> i) & 1
                if prev is None or ((prev >> i) & 1) != bit:
                    chunk.append(f"{bit}{ids[i]}")
        else:
            bits = format(val & ((1 << width) - 1), f"0{width}b")
            chunk.append(f"b{bits} {ids[0]}")
        out += "\n".join(chunk) + "\n"
        prev = val
    _ensure_parent(path)
    with open(path, "w", encoding="ascii") as f:
        f.write(out)
    return path


def write_json(path, samples, width, meta=None):
    doc = {"width": width, "depth": len(samples),
           "samples": list(samples)}
    if meta:
        doc["meta"] = meta
    _ensure_parent(path)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2)
    return path


def write_csv(path, samples, width, signal_names=None):
    """One row per sample. If signal_names given, one column per bit (LSB
    first); otherwise a single hex `value` column plus decimal."""
    rows = []
    if signal_names is not None:
        rows.append("sample," + ",".join(signal_names))
        for k, val in enumerate(samples):
            bits = [str((val >> i) & 1) for i in range(len(signal_names))]
            rows.append(f"{k}," + ",".join(bits))
    else:
        rows.append("sample,value_hex,value_dec")
        hexw = (width + 3) // 4
        for k, val in enumerate(samples):
            rows.append(f"{k},0x{val:0{hexw}x},{val}")
    _ensure_parent(path)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(rows) + "\n")
    return path


def write_raw(path, raw, bit_length):
    """Persist the exact step-29 TDO stream as LSB-first packed bytes.

    Bit ``n`` is stored at byte ``n // 8``, bit ``n % 8``.  ``bit_length`` is
    carried separately in capture framing because the final byte can contain
    unused high zero bits.
    """
    if not isinstance(bit_length, int) or bit_length <= 0:
        raise ValueError(f"bit_length must be a positive integer, got {bit_length!r}")
    if not isinstance(raw, int) or raw < 0:
        raise ValueError("raw must be a non-negative integer")
    _ensure_parent(path)
    with open(path, "wb") as f:
        f.write(raw.to_bytes((bit_length + 7) // 8, byteorder="little"))
    return path


def summarize(samples, width):
    """Compact human/AI-readable summary string."""
    n = len(samples)
    uniq = len(set(samples))
    hexw = (width + 3) // 4
    head = " ".join(f"{s:0{hexw}x}" for s in samples[:16])
    tail = " ".join(f"{s:0{hexw}x}" for s in samples[-8:])
    steps = sorted({(samples[i + 1] - samples[i]) & ((1 << width) - 1)
                    for i in range(n - 1)}) if n > 1 else []
    mono = (len(steps) == 1 and steps[0] != 0)
    parts = [f"{n} samples x {width} bit, {uniq} distinct",
             f"first16: {head}",
             f"last8:   {tail}",
             f"inter-sample step(s): {steps}" + (" (monotonic)" if mono else "")]
    return "\n".join(parts)


# --- self-test (no hardware): synthesize a counter, round-trip the writers ---
if __name__ == "__main__":
    import os
    import tempfile
    W, D = 8, 32
    samp = [(i) & 0xFF for i in range(D)]
    d = tempfile.mkdtemp(prefix="export-selftest-")
    names = [f"counter[{i}]" for i in range(W)]
    vcd = write_vcd(os.path.join(d, "w.vcd"), samp, W, signal_names=names)
    vcdv = write_vcd(os.path.join(d, "wv.vcd"), samp, W)
    js = write_json(os.path.join(d, "w.json"), samp, W, meta={"src": "selftest"})
    cs = write_csv(os.path.join(d, "w.csv"), samp, W, signal_names=names)
    rw = write_raw(os.path.join(d, "nested", "w.raw.bin"), 0xA53, 12)
    # checks
    txt = open(vcd).read()
    assert "$var wire 1 ! counter[0] $end" in txt, "per-bit var missing"
    assert "#0" in txt and "#1" in txt, "timestamps missing"
    vv = open(vcdv).read()
    assert f"$var wire {W}" in vv and "[7:0]" in vv, "vector var missing"
    jd = json.load(open(js))
    assert jd["samples"] == samp and jd["width"] == W, "json round-trip"
    rows = open(cs).read().strip().split("\n")
    assert rows[0] == "sample," + ",".join(names) and len(rows) == D + 1, "csv shape"
    assert open(rw, "rb").read() == bytes([0x53, 0x0A]), "raw LSB-first packing"
    assert "monotonic" in summarize(samp, W)
    print("export.py self-test OK ->", d)
