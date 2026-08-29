"""Hardware-free tests for D2XX inventory normalization."""

import sys
from pathlib import Path


JTAG_DIR = Path(__file__).resolve().parents[1] / "src" / "toolchains" / "pango-pds" / "jtag"
sys.path.insert(0, str(JTAG_DIR))

from mpsse_jtag import classify_d2xx_inventory, ft_status_name  # noqa: E402


def main():
    assert ft_status_name(0) == "FT_OK"
    assert ft_status_name(2) == "FT_DEVICE_NOT_FOUND"
    assert ft_status_name(3) == "FT_DEVICE_NOT_OPENED"
    assert ft_status_name(999) == "FT_STATUS_999"

    assert classify_d2xx_inventory({"error": "missing dll", "channels": []}) == "dll_unavailable"
    assert classify_d2xx_inventory({"createStatus": 0, "count": 0, "channels": []}) == "no_ftdi_devices"
    assert classify_d2xx_inventory({
        "createStatus": 0,
        "count": 2,
        "channels": [{"index": 0, "opened": True}, {"index": 1, "opened": True}],
    }) == "channels_open_elsewhere"
    assert classify_d2xx_inventory({
        "createStatus": 0,
        "count": 2,
        "channels": [{"index": 0, "opened": True}, {"index": 1, "opened": False}],
    }) == "available"
    assert classify_d2xx_inventory({"createStatus": 4, "count": 0, "channels": []}) == "channel_open_failed"

    print("jtag-d2xx-unit: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

