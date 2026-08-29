# cdt_cfg Tcl reference (Fabric Configuration)

`cdt_cfg.exe -file <script.tcl>` runs a Tcl script of `cfg_*` commands against a resident
`cdt_js.exe -port <N>` JTAG server. Below: every command used in the headless flow, plus three
complete, ready-to-run scripts. (Concrete values are PG2L100H/W25Q128Q examples — swap for your part.)

## Server
- `cdt_js.exe -port 65420` — start the JTAG download server (resident; start once). All `cdt_cfg`
  scripts then `cfg_connect` to it.

## Session
| command | purpose |
|---|---|
| `cfg_set_tcl_break -flag true` | stop the script on a command error (recommended) |
| `cfg_connect -ip 127.0.0.1 -port 65420` | connect to the `cdt_js` server |
| `cfg_scan_chain` | detect devices on the JTAG chain; prints "done bit" status |
| `cfg_disconnect` / `cfg_close` | end the session |
| `cfg_set_cable_property -index 0 -freq 5Mhz` | set cable TCK freq (lower for flash reliability) |

## Read device info
- `cfg_read_device_property -mode 0 -device_index <n>` → prints `The ID value is: 0x........`
  (the IDCODE). Use to identify each device and its index. `-mode 0` = IDCODE.

## SRAM configuration (volatile)
- `cfg_assign_file -file <design.sbit> -device_index <n>` — bind the bitstream to a device.
- `cfg_program -device_index <n>` — load it into config SRAM. Success prints `The done bit is 1`.

## SPI flash via the FPGA JTAG→SPI bridge (persistent)
- `cfg_gen_sfc -sbit <design.sbit> -sfc <design.sfc> -device_name <PART>` — generate the SPI-flash
  image (`.sfc`) from the bitstream. `<PART>` e.g. `W25Q128Q`.
- `cfg_jtag_flash_scan_device -device_index <n>` — detect the flash through the FPGA bridge.
- `cfg_jtag_flash_assign_file -file <design.sfc> -device_index <n>`
- `cfg_jtag_flash_erase  -device_index <n>`
- `cfg_jtag_flash_program -device_index <n>`
- `cfg_jtag_flash_verify -device_index <n>` — must report success.
- NOTE: the cable's **direct**-SPI path `cfg_flash_*` (scan/erase/program/verify) often returns
  `0xffffff` (flash not reachable from the cable) on boards where the flash hangs off the FPGA — use
  the `cfg_jtag_flash_*` bridge path instead.

## Ready-to-run scripts

### scan.tcl (read-only chain detect + IDCODE)
```tcl
cfg_set_tcl_break -flag true
cfg_connect -ip 127.0.0.1 -port 65420
cfg_scan_chain
catch { puts "IDCODE(dev0) = [cfg_read_device_property -mode 0 -device_index 0]" }
cfg_disconnect
cfg_close
```

### program_sram.tcl (volatile SRAM load)
```tcl
cfg_set_tcl_break -flag true
cfg_connect -ip 127.0.0.1 -port 65420
cfg_scan_chain
cfg_assign_file -file C:/path/design.sbit -device_index 0
cfg_program -device_index 0
cfg_disconnect
cfg_close
```

### program_flash.tcl (persistent SPI flash via JTAG bridge)
```tcl
cfg_connect -ip 127.0.0.1 -port 65420
cfg_scan_chain
cfg_set_cable_property -index 0 -freq 5Mhz
cfg_gen_sfc -sbit C:/path/design.sbit -sfc C:/path/design.sfc -device_name W25Q128Q
cfg_jtag_flash_scan_device -device_index 0
cfg_jtag_flash_assign_file -file C:/path/design.sfc -device_index 0
cfg_jtag_flash_erase   -device_index 0
cfg_jtag_flash_program -device_index 0
cfg_jtag_flash_verify  -device_index 0
cfg_disconnect
cfg_close
```

## Driving it from PowerShell (start server if needed, then run a script)
```powershell
$BIN = '<PDS_INSTALL>\bin'          # e.g. D:\pango\PDS_2022.2-SP4.2-ads\bin
if (-not (Get-Process -Name cdt_js -ErrorAction SilentlyContinue)) {
  Start-Process "$BIN\cdt_js.exe" -ArgumentList '-port 65420' -WindowStyle Hidden; Start-Sleep 2
}
& "$BIN\cdt_cfg.exe" -file scan.tcl
```
Use forward slashes in `-file` paths inside Tcl. Paths with backslashes work in PowerShell but
convert (`.Replace('\','/')`) before embedding in a generated `.tcl`.
