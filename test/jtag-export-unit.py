"""Pure exporter regression: capture artifacts create missing parent trees."""

import importlib.util
import json
import os
import tempfile


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT_PATH = os.path.join(ROOT, "src", "toolchains", "pango-pds", "jtag", "export.py")
SPEC = importlib.util.spec_from_file_location("pango_jtag_export", EXPORT_PATH)
export = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(export)


with tempfile.TemporaryDirectory(prefix="fpga-jtag-export-") as root:
    samples = [0, 1, 2, 3]
    vcd = os.path.join(root, "vcd", "nested", "capture.vcd")
    js = os.path.join(root, "json", "nested", "capture.json")
    csv = os.path.join(root, "csv", "nested", "capture.csv")
    raw = os.path.join(root, "raw", "nested", "capture.step29.bin")

    export.write_vcd(vcd, samples, 2)
    export.write_json(js, samples, 2, meta={"source": "unit"})
    export.write_csv(csv, samples, 2)
    export.write_raw(raw, 0xA53, 12)

    assert os.path.isfile(vcd) and "$enddefinitions $end" in open(vcd, encoding="ascii").read()
    assert os.path.isfile(js) and json.load(open(js, encoding="utf-8"))["samples"] == samples
    assert os.path.isfile(csv) and open(csv, encoding="utf-8").read().startswith("sample,value_hex,value_dec")
    assert os.path.isfile(raw) and open(raw, "rb").read() == bytes([0x53, 0x0A])

print("jtag-export-unit: parent creation + VCD/JSON/CSV/raw PASS")
