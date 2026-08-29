"""Shared setup for the FLA bench scripts in this directory.

These are NOT tests. Each one opens FTDI device index 0 and shifts real JTAG
IR/DR, so running one with any unrelated FT2232/FT232 attached (another probe,
a USB-serial adapter) pushes JTAG traffic into that device. They live outside
`test/` for exactly that reason, and they refuse to touch a cable unless
FPGA_JTAG_LAB_CONFIRM=1 is set — the same fail-closed shape the MCP device-write
tools use (`confirm:true` + `expectIdcode`).
"""

import os
import sys
from pathlib import Path

JTAG_DIR = Path(__file__).resolve().parents[2] / "src" / "toolchains" / "pango-pds" / "jtag"
sys.path.insert(0, str(JTAG_DIR))


def require_confirm():
    """Fail closed before any cable access."""
    if os.environ.get("FPGA_JTAG_LAB_CONFIRM") != "1":
        script = Path(sys.argv[0]).name
        sys.exit(
            f"{script}: refusing to open a JTAG cable without confirmation.\n"
            f"This opens FTDI device index 0 and shifts JTAG IR/DR — any FT2232/FT232\n"
            f"on this machine may receive it. Re-run with FPGA_JTAG_LAB_CONFIRM=1 once\n"
            f"you have verified which device index 0 actually is."
        )
