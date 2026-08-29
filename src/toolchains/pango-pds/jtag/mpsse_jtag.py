"""Headless JTAG master over the FTDI FT2232 (USB Cable II) via the D2XX DLL + MPSSE.

Why this exists: on this board the vendor's headless debugger (`cdt_dbg -file
open_cable`) deadlocks, so FLA capture was stuck behind the PDS GUI driven by
UIAutomation (slow / flaky). The cable is a 2-channel FT2232 that the FTDI D2XX
driver (`ftd2xx.dll`, already installed for PDS) exposes directly — so we can
bit-bang JTAG ourselves with NO zadig/WinUSB driver swap and NO conflict with
the Pango toolchain. We just take turns on the cable: stop `cdt_js`, do JTAG,
let the next `scan` restart it.

The TAP state machine here follows the standard IEEE 1149.1 state walks. This
module is the transport layer; the Pango FLA arm+readback IR/DR sequence (the
vendor's PANGO200 access sequence) layers on top once the transport is proven.

Spike goal (run as __main__): reset TAP, shift DR 32 bits, expect IDCODE
0x00603899 (PG2L200H). That single read proves the whole headless path.

JTAG pin map on the FT2232 MPSSE low byte (ADBUS): AD0=TCK out, AD1=TDI out,
AD2=TDO in, AD3=TMS out.
"""

import ctypes as C
import json
import os
import sys
import time


def _resolve_ftd2xx():
    """Locate ftd2xx.dll. The FTDI D2XX runtime lives in System32 on a machine
    with the standalone driver installed, but on a PDS-only host it ships ONLY
    inside the PDS bin (D:\\pango\\PDS_*/bin/ftd2xx.dll). Original code hardcoded
    System32 and failed ("Could not find module") on PDS-only hosts. Order:
    $PANGO_MCP_FTD2XX → System32/SysWOW64 → cdt bins from pango-mcp.config.json →
    bare name (let the loader search PATH)."""
    cands = []
    env = os.environ.get("PANGO_MCP_FTD2XX")
    if env:
        cands.append(env)
    cands += [r"C:\Windows\System32\ftd2xx.dll", r"C:\Windows\SysWOW64\ftd2xx.dll"]
    try:
        # cli.py lives at jtag/; package root (with config) is 4 dirs up.
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
        cfg = os.path.join(root, "pango-mcp.config.json")
        if os.path.exists(cfg):
            with open(cfg, encoding="utf-8") as f:
                data = json.load(f)
            for host in (data.get("hosts") or {}).values():
                for shell in (host.get("pds") or {}).values():
                    b = os.path.join(os.path.dirname(str(shell)), "ftd2xx.dll")
                    if b not in cands:
                        cands.append(b)
    except Exception:
        pass
    for c in cands:
        if c and os.path.exists(c):
            return c
    return "ftd2xx.dll"  # last resort: loader searches PATH


FTD2XX = _resolve_ftd2xx()

# FT_STATUS
FT_OK = 0
FT_STATUS_NAMES = {
    0: "FT_OK",
    1: "FT_INVALID_HANDLE",
    2: "FT_DEVICE_NOT_FOUND",
    3: "FT_DEVICE_NOT_OPENED",
    4: "FT_IO_ERROR",
    5: "FT_INSUFFICIENT_RESOURCES",
    6: "FT_INVALID_PARAMETER",
    7: "FT_INVALID_BAUD_RATE",
    8: "FT_DEVICE_NOT_OPENED_FOR_ERASE",
    9: "FT_DEVICE_NOT_OPENED_FOR_WRITE",
    10: "FT_FAILED_TO_WRITE_DEVICE",
    11: "FT_EEPROM_READ_FAILED",
    12: "FT_EEPROM_WRITE_FAILED",
    13: "FT_EEPROM_ERASE_FAILED",
    14: "FT_EEPROM_NOT_PRESENT",
    15: "FT_EEPROM_NOT_PROGRAMMED",
    16: "FT_INVALID_ARGS",
    17: "FT_NOT_SUPPORTED",
    18: "FT_OTHER_ERROR",
    19: "FT_DEVICE_LIST_NOT_READY",
}
FT_FLAGS_OPENED = 0x01
FT_FLAGS_HISPEED = 0x02
# FT_SetBitMode
BITMODE_RESET = 0x00
BITMODE_MPSSE = 0x02
# FT_Purge
FT_PURGE_RX = 1
FT_PURGE_TX = 2

# MPSSE opcodes
# 0x39 = clock data bytes IN and OUT, LSB-first, TDI updated on -ve edge, TDO
#        sampled on +ve edge  -> the JTAG-standard data shift.
CLK_BYTES_INOUT_LSB = 0x39
# 0x3B = same but in BIT mode (length = #bits-1, one byte written/returned).
CLK_BITS_INOUT_LSB = 0x3B
# 0x4B = clock TMS bits OUT (no read); data byte: bits[0..6]=TMS (LSB first),
#        bit7 = TDI value held during the TMS clocking.
CLK_TMS_OUT = 0x4B
# 0x6B = clock TMS bits out AND read TDO (1 byte back).
CLK_TMS_OUT_READ = 0x6B
SEND_IMMEDIATE = 0x87  # flush read buffer back to host
DIS_DIV5 = 0x8A
DIS_ADAPTIVE = 0x97
DIS_3PHASE = 0x8D
SET_LOW_BYTE = 0x80
BAD_CMD = 0xAA  # used for the MPSSE sync self-test


def ft_status_name(status):
    """Return a stable symbolic label without inventing meaning for new codes."""
    value = int(status)
    return FT_STATUS_NAMES.get(value, f"FT_STATUS_{value}")


def classify_d2xx_inventory(inventory):
    """Pure state classification for a normalized D2XX inventory dict."""
    if inventory.get("error"):
        return "dll_unavailable"
    create_status = inventory.get("createStatus")
    if create_status not in (None, FT_OK):
        return "channel_open_failed"
    channels = inventory.get("channels") or []
    if any(ch.get("status") not in (None, FT_OK) for ch in channels):
        return "channel_open_failed"
    if int(inventory.get("count") or 0) == 0:
        return "no_ftdi_devices"
    if channels and all(bool(ch.get("opened")) for ch in channels):
        return "channels_open_elsewhere"
    return "available"


def _decode_driver_text(value):
    return value.decode("utf-8", errors="replace") if value else ""


def _format_library_version(raw):
    return f"{(raw >> 16) & 0xFF}.{(raw >> 8) & 0xFF}.{raw & 0xFF}"


def d2xx_inventory(dll_path=None):
    """Side-effect-free D2XX inventory; never opens or configures a channel."""
    path = dll_path or FTD2XX
    result = {
        "dll": path,
        "libraryVersion": None,
        "libraryVersionStatus": None,
        "createStatus": None,
        "createStatusName": None,
        "count": 0,
        "channels": [],
    }
    try:
        dll = C.WinDLL(path)
    except Exception as exc:
        result["error"] = str(exc)
        result["state"] = classify_d2xx_inventory(result)
        return result

    try:
        raw_version = C.c_ulong(0)
        status = int(dll.FT_GetLibraryVersion(C.byref(raw_version)))
        result["libraryVersionStatus"] = status
        if status == FT_OK:
            result["libraryVersion"] = _format_library_version(raw_version.value)
    except (AttributeError, OSError):
        # Older vendor-bundled DLLs may not expose this optional audit field.
        pass

    count = C.c_ulong(0)
    try:
        create_status = int(dll.FT_CreateDeviceInfoList(C.byref(count)))
    except Exception as exc:
        result["error"] = str(exc)
        result["state"] = classify_d2xx_inventory(result)
        return result
    result["createStatus"] = create_status
    result["createStatusName"] = ft_status_name(create_status)
    result["count"] = int(count.value)

    if create_status == FT_OK:
        for index in range(count.value):
            flags = C.c_ulong(0)
            dev_type = C.c_ulong(0)
            dev_id = C.c_ulong(0)
            location = C.c_ulong(0)
            serial = C.create_string_buffer(64)
            description = C.create_string_buffer(128)
            handle = C.c_void_p()
            try:
                status = int(dll.FT_GetDeviceInfoDetail(
                    index,
                    C.byref(flags),
                    C.byref(dev_type),
                    C.byref(dev_id),
                    C.byref(location),
                    serial,
                    description,
                    C.byref(handle),
                ))
            except Exception:
                status = 18  # FT_OTHER_ERROR; the symbolic field remains honest.
            result["channels"].append({
                "index": index,
                "status": status,
                "statusName": ft_status_name(status),
                "flags": int(flags.value),
                "opened": bool(flags.value & FT_FLAGS_OPENED),
                "highSpeed": bool(flags.value & FT_FLAGS_HISPEED),
                "type": int(dev_type.value),
                "id": f"0x{dev_id.value:08X}",
                "location": f"0x{location.value:08X}",
                "serial": _decode_driver_text(serial.value),
                "description": _decode_driver_text(description.value),
            })

    result["state"] = classify_d2xx_inventory(result)
    return result


class FtError(RuntimeError):
    pass


class MpsseJtag:
    def __init__(self, index=0, tck_hz=1_000_000):
        self.d = C.WinDLL(FTD2XX)
        self.h = C.c_void_p()
        self.index = index
        self.tck_hz = tck_hz
        self._op = None  # current high-level op label, surfaced in read timeouts

    def __enter__(self):
        # Convenience: `with MpsseJtag() as j:` opens the cable and runs the
        # standard sync + clock config so the body can immediately shift JTAG.
        # Without this an uncaught exception between open() and close() leaks
        # the FT handle and the next cable-acquirer sees it busy.
        self.open()
        dt = self.device_type()
        self.sync()
        self.config_clock(dt[0])
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            self.close()
        except Exception:
            pass
        return False

    def _ck(self, name, st):
        if st != FT_OK:
            raise FtError(f"{name} -> FT_STATUS {st}")

    def open(self):
        # Minimal init proven on this cable; extra D2XX params (USB transfer size,
        # event/error chars) were found to break small MPSSE reads, so omit them.
        self._ck("FT_Open", self.d.FT_Open(self.index, C.byref(self.h)))
        self._ck("FT_ResetDevice", self.d.FT_ResetDevice(self.h))
        self._ck("FT_SetTimeouts", self.d.FT_SetTimeouts(self.h, 3000, 3000))
        self._ck("FT_SetLatencyTimer", self.d.FT_SetLatencyTimer(self.h, 1))
        self._ck("FT_SetBitMode reset", self.d.FT_SetBitMode(self.h, 0x00, BITMODE_RESET))
        self._ck("FT_SetBitMode mpsse", self.d.FT_SetBitMode(self.h, 0x00, BITMODE_MPSSE))
        time.sleep(0.1)
        return self

    def device_type(self):
        dev_type = C.c_ulong(0)
        dev_id = C.c_ulong(0)
        serial = C.create_string_buffer(16)
        desc = C.create_string_buffer(64)
        self._ck("FT_GetDeviceInfo", self.d.FT_GetDeviceInfo(self.h, C.byref(dev_type), C.byref(dev_id), serial, desc, None))
        return dev_type.value, dev_id.value, serial.value, desc.value

    def write(self, data):
        buf = (C.c_ubyte * len(data))(*data)
        wrote = C.c_ulong(0)
        self._ck("FT_Write", self.d.FT_Write(self.h, buf, len(data), C.byref(wrote)))
        if wrote.value != len(data):
            raise FtError(f"FT_Write short {wrote.value}/{len(data)}")

    def read(self, n, timeout_s=1.0):
        out = bytearray()
        end = time.time() + timeout_s
        last_flush = time.time()
        while len(out) < n:
            avail = C.c_ulong(0)
            self._ck("FT_GetQueueStatus", self.d.FT_GetQueueStatus(self.h, C.byref(avail)))
            if avail.value:
                take = min(avail.value, n - len(out))
                buf = (C.c_ubyte * take)()
                got = C.c_ulong(0)
                self._ck("FT_Read", self.d.FT_Read(self.h, buf, take, C.byref(got)))
                out += bytes(buf[: got.value])
            elif time.time() > end:
                ctx = f" during {self._op}" if self._op else ""
                raise FtError(f"FT_Read timeout: got {len(out)}/{n}{ctx}")
            else:
                # The SEND_IMMEDIATE that flushes clocked TDO to the host is
                # occasionally missed on this cable -> re-issue it while waiting.
                if time.time() - last_flush > 0.1:
                    self.write(bytes([SEND_IMMEDIATE]))
                    last_flush = time.time()
                time.sleep(0.005)
        return bytes(out)

    def sync(self):
        """Classic MPSSE self-test: a bogus opcode echoes back 0xFA <opcode>."""
        self.write([BAD_CMD, SEND_IMMEDIATE])
        r = self.read(2)
        if not (r[0] == 0xFA and r[1] == BAD_CMD):
            raise FtError(f"MPSSE sync failed, got {r.hex()}")

    def config_clock(self, dev_type):
        cmds = []
        # FT2232H/4232H/232H report types 4/6/8 -> 60 MHz base, support /5 + 3-phase.
        h_series = dev_type in (4, 6, 8)
        base = 60_000_000 if h_series else 12_000_000
        if h_series:
            cmds += [DIS_DIV5, DIS_3PHASE]
        cmds += [DIS_ADAPTIVE]
        div = max(0, round(base / (2 * self.tck_hz)) - 1)
        cmds += [0x86, div & 0xFF, (div >> 8) & 0xFF]
        # Discovered cable layout (USB Cable II / FT2232H, verified 2026-06-22):
        # JTAG is on channel A; TCK=AD0 TDI=AD1 TDO=AD2 TMS=AD3, and AD7 = buffer
        # output-enable that MUST be driven HIGH (without it TDO floats -> 0xFFFFFFFF).
        # low=0x88 (TMS idle high + OE high), dir=0x8B (AD0,1,3,7 out, AD2 in).
        cmds += [SET_LOW_BYTE, 0x88, 0x8B]
        self.write(cmds)
        time.sleep(0.05)  # let the divisor + pin state settle before clocking
        self.actual_tck = base / (2 * (div + 1))

    def set_low(self, val, direction):
        """ADBUS output values + directions (1=out). TDO(AD2) must stay input."""
        self.write([SET_LOW_BYTE, val & 0xFF, direction & 0xFF])

    def set_high(self, val, direction):
        """ACBUS output values + directions (some cables put buffer-OE here)."""
        self.write([0x82, val & 0xFF, direction & 0xFF])

    # ---- TAP navigation (IEEE 1149.1 TAP state walks) ----
    def tms(self, bits, tdi=0):
        """Clock len(bits) TMS bits (LSB-first list of 0/1), holding TDI."""
        n = len(bits)
        assert 1 <= n <= 7
        val = (tdi & 1) << 7
        for i, b in enumerate(bits):
            val |= (b & 1) << i
        self.write([CLK_TMS_OUT, n - 1, val])

    def reset_to_rti(self):
        # >=5 TMS=1 -> Test-Logic-Reset, then 0 -> Run-Test-Idle.
        self.tms([1, 1, 1, 1, 1, 0])

    def rti_to_shift_dr(self):
        # RTI -1-> Select-DR -0-> Capture-DR -0-> Shift-DR
        self.tms([1, 0, 0])

    def _clock_out(self, value, nbits):
        """Write-only shift of `nbits` (LSB-first) on TDI: first nbits-1 with
        TMS=0 (stay in Shift), last bit via the TMS command (TMS=1 -> Exit1) so
        the value lands exactly. No TDO read — used for IR and DR writes."""
        bits = [(value >> i) & 1 for i in range(nbits)]
        head, last = bits[:-1], bits[-1]
        nh = len(head)
        cmds = bytearray()
        nbytes = nh // 8
        if nbytes:
            # Byte-mode clock takes a 2-byte length (lengthL, lengthH); #bytes =
            # length+1. Omitting the high byte makes the next data byte be read as
            # lengthH -> a huge bogus length that swallows all following commands.
            n1 = nbytes - 1
            cmds += bytes([0x19, n1 & 0xFF, (n1 >> 8) & 0xFF])  # bytes OUT, LSB, -ve, no read
            for b in range(nbytes):
                cmds.append(sum(head[b * 8 + k] << k for k in range(8)))
        rem = nh % 8
        if rem:
            cmds += bytes([0x1B, rem - 1])     # clock bits OUT, LSB, -ve, no read
            cmds.append(sum(head[nbytes * 8 + k] << k for k in range(rem)))
        cmds += bytes([CLK_TMS_OUT, 0x00, (last << 7) | 0x01])  # last bit + Exit1
        self.write(cmds)

    def _clock_in_bytes(self, nbits):
        """Read ceil(nbits/8) bytes via byte-mode in+out (TDI=0), staying in
        Shift (TMS=0). Returns the low `nbits` as an int. Over-clocks to the byte
        boundary — fine for reads where we exit right after. (Byte in+out is the
        path proven to work on this cable; bit-mode TDO reads do not return.)"""
        nbytes = (nbits + 7) // 8
        # 2-byte length (lengthL, lengthH); #bytes = length+1. (Previously the
        # high byte was omitted and only worked because the all-zero TDI data
        # supplied a 0x00 that happened to serve as lengthH.)
        n1 = nbytes - 1
        self.write(bytes([CLK_BYTES_INOUT_LSB, n1 & 0xFF, (n1 >> 8) & 0xFF]) + bytes(nbytes) + bytes([SEND_IMMEDIATE]))
        # Settle: without a brief pause the clocked-out TDO never shows up in the
        # read queue on this cable (polling alone times out). Scale a little with
        # size for big buffer reads.
        time.sleep(0.15 + nbytes / 1000.0)
        data = self.read(nbytes)
        return int.from_bytes(data, "little") & ((1 << nbits) - 1)

    def shift_ir(self, value, nbits):
        self.tms([1, 1, 0, 0])          # RTI -> Shift-IR
        self._clock_out(value, nbits)   # -> Exit1-IR
        self.tms([1, 0])                # Update-IR -> RTI

    def write_dr(self, value, nbits):
        self.tms([1, 0, 0])             # RTI -> Shift-DR
        self._clock_out(value, nbits)   # -> Exit1-DR
        self.tms([1, 0])                # Update-DR -> RTI

    def read_dr(self, nbits):
        self._op = f"read_dr({nbits} bits)"
        try:
            self.tms([1, 0, 0])             # RTI -> Shift-DR
            v = self._clock_in_bytes(nbits)
            self.tms([1, 1, 0])             # Exit1-DR -> Update-DR -> RTI
            return v
        finally:
            self._op = None

    # ---- SVF-player primitives (used by svf_player.py) ----
    def tck_pulse(self, n):
        """Clock n TCK with NO data shift, to implement RUNTEST IDLE n TCK.
        The clock-only opcodes (0x8F/0x8E) hold TMS at the static low-byte level,
        so we drive TMS LOW first (keep AD7 OE high) to stay in Run-Test-Idle,
        then restore the idle-high TMS state."""
        self.set_low(0x80, 0x8B)                  # OE high, TMS/TDI/TCK low
        nb = n // 8
        while nb > 0:
            c = min(nb, 0x10000)
            self.write(bytes([0x8F, (c - 1) & 0xFF, ((c - 1) >> 8) & 0xFF]))
            nb -= c
        rem = n % 8
        if rem:
            self.write(bytes([0x8E, rem - 1]))
        self.set_low(0x88, 0x8B)                  # restore TMS idle-high

    def write_dr_long(self, value, nbits, chunk_bytes=8192):
        """Write-only DR shift of arbitrary length, streamed in chunks so the
        bitstream (tens of Mbits) never builds one giant USB transfer. Shifts
        LSB-first (SVF convention), exits via TMS on the last bit. No TDO read."""
        self.tms([1, 0, 0])                       # RTI -> Shift-DR
        data = value.to_bytes((nbits + 7) // 8, "little")
        head_bits = nbits - 1
        head_full = head_bits // 8
        rem = head_bits % 8
        idx = 0
        while idx < head_full:
            n = min(chunk_bytes, head_full - idx)
            self.write(bytes([0x19, (n - 1) & 0xFF, ((n - 1) >> 8) & 0xFF]) + data[idx:idx + n])
            idx += n
        if rem:
            self.write(bytes([0x1B, rem - 1, data[head_full] & ((1 << rem) - 1)]))
        last = (value >> (nbits - 1)) & 1
        self.write(bytes([CLK_TMS_OUT, 0x00, (last << 7) | 0x01]))  # last bit + Exit1
        self.tms([1, 0])                          # Update-DR -> RTI

    def state_reset(self):
        self.tms([1, 1, 1, 1, 1])                 # -> Test-Logic-Reset (stay)

    def state_idle(self):
        self.tms([0])                             # TLR/RTI -> Run-Test-Idle

    def read_idcode(self):
        # IDCODE is the default DR loaded at Test-Logic-Reset.
        self.reset_to_rti()
        return self.read_dr(32)

    def read_idcode_via_ir(self, ir=0x283, irlen=10):
        # Exercises shift_ir (incl. bit-mode TDI write): load the Pango IDCODE
        # instruction, then read DR. If this matches the default-DR IDCODE, the
        # IR write path is correct.
        self.reset_to_rti()
        self.shift_ir(ir, irlen)
        return self.read_dr(32)

    def close(self):
        try:
            self.d.FT_SetBitMode(self.h, 0x00, BITMODE_RESET)
        finally:
            self.d.FT_Close(self.h)


EXPECT_IDCODE = 0x00603899  # PG2L200H


def _valid(idc):
    return idc not in (0x00000000, 0xFFFFFFFF)


def _attempt(idx):
    """One full open->verify->close cycle. Returns (dt, idcode_default, idcode_via_ir)."""
    j = MpsseJtag(index=idx)
    try:
        j.open()
        dt = j.device_type()
        j.sync()
        j.config_clock(dt[0])
        a = j.read_idcode()
        b = j.read_idcode_via_ir()
        return dt, a, b
    finally:
        try:
            j.close()
        except Exception:
            pass


def main():
    idx = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    last = None
    for k in range(2):
        try:
            dt, a, b = _attempt(idx)
            print(f"channel {idx}: type={dt[0]} id=0x{dt[1]:08X} serial={dt[2]!r} desc={dt[3]!r}")
            print(f"IDCODE (default DR)   = 0x{a:08X}")
            print(f"IDCODE (via IR 0x283) = 0x{b:08X}")
            ok = _valid(a) and (a & 0x0FFFFFFF) == (EXPECT_IDCODE & 0x0FFFFFFF) and a == b
            print("RESULT:", "PASS (shift_ir + read_dr verified)" if ok else "FAIL")
            return 0 if ok else 1
        except FtError as e:
            last = e
            print(f"attempt {k + 1}/2 failed: {e}; retrying...")
            time.sleep(0.1)
    print("ALL_ATTEMPTS_FAILED:", last)
    print("hint: ensure cdt_js (and PDS) are not racing for the cable.")
    return 3


if __name__ == "__main__":
    sys.exit(main())
