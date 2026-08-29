"""Unit test for fla_pango.encode_trigger channel/bit ordering — HARDWARE-FREE.

Guards the bug found 2026-06-24: the PDS-inserted FLA's trigger channels are
REVERSED (blob slot s drives counter bit width-1-s), so encode_trigger must
default chan_reversed=True. Every value HW-tested before (0xA5 on 06-23, 0x3C on
06-24) was a BIT-PALINDROME and matched either way, masking the wrong default
until a non-palindrome (0x50, which the FPGA mis-matched as its bit-reverse 0x0A)
exposed it. The oracle below (slot s -> counter bit width-1-s, within-channel
code_msb_first=False) is hardware-calibrated; see jtag/FINDINGS.md "Channel order".
"""
import sys
from pathlib import Path

JTAG_DIR = Path(__file__).resolve().parents[1] / "src" / "toolchains" / "pango-pds" / "jtag"
sys.path.insert(0, str(JTAG_DIR))
from fla_pango import encode_trigger  # noqa: E402


def value_to_pattern(value, width):
    """User contract: pattern[ch] = bit ch of value (channel 0 = counter[0] = LSB)."""
    return "".join("1" if (value >> ch) & 1 else "0" for ch in range(width))


def fpga_matched_value(blob, width):
    """Decode the blob to the counter value the FPGA actually matches. Mapping is
    hardware-calibrated (2026-06-24): blob slot s controls counter bit (width-1-s);
    within a channel, level-1 code = 0b011, level-0 = 0b010, don't-care = 0b000
    (code_msb_first=False)."""
    v = 0
    for s in range(width):
        base = s * 3
        code = ((blob >> base) & 1) \
            | (((blob >> (base + 1)) & 1) << 1) \
            | (((blob >> (base + 2)) & 1) << 2)
        if code == 0b011:                       # expect level 1
            v |= 1 << (width - 1 - s)
        elif code not in (0b010, 0b000):
            raise AssertionError(f"slot {s}: unexpected code 0b{code:03b}")
    return v


# Palindromes match either channel order -> they CANNOT catch the bug (they are
# why it hid for two days). Non-palindromes are the discriminating cases.
PALINDROMES = [0x00, 0xFF, 0xA5, 0x3C, 0x18, 0x81, 0xC3]
NON_PALINDROMES = [0x01, 0x80, 0x0A, 0x50, 0x1F, 0x4B, 0x07, 0xE0]


def main():
    width = 8
    fails = []
    for value in PALINDROMES + NON_PALINDROMES:
        pattern = value_to_pattern(value, width)
        blob, _ = encode_trigger(width, pattern)
        got = fpga_matched_value(blob, width)
        kind = "palindrome    " if value in PALINDROMES else "non-palindrome"
        ok = got == value
        print(f"value=0x{value:02X} pattern={pattern} -> fpga matches 0x{got:02X} "
              f"[{kind}] {'OK' if ok else 'FAIL'}")
        if not ok:
            fails.append((value, got))
    if fails:
        print(f"\n{len(fails)} FAIL(s): " +
              ", ".join(f"0x{v:02X}->0x{g:02X}" for v, g in fails))
        return 1
    print("\nall values map to themselves (channel order correct)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
