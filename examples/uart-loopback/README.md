# UART loopback — the bring-up design

The design used to bring up the hardware path on a PG2L200H (FBB676, -6): a
8N1 UART that echoes every received byte and emits an idle heartbeat, with an
ILA core tapping the receive path.

It is here because it exercises the whole chain in one build — simulate, place
and route, instrument, configure the device, capture on-chip — which is exactly
the sequence a new user wants to see working before trusting it on their own
design.

| File | What it is |
|---|---|
| `rtl/top_uart.v` | The DUT. RX=V14, TX=U14, 27 MHz clock on D18. |
| `sim/tb_uart.v` | Self-checking testbench — drives frames and asserts the echo. |
| `constraints/top_uart.fdc` | Pin LOC / IO standard / clock for the board above. |
| `debug/uart_ila.fic` | Hand-written debug core: 14 channels over `rx_data`, control and the line signals. |
| `../verify-uart.ps1` | Closed-loop host check over a real serial port. |

**The pins and the part are board-specific.** They are the ones on the
maintainer's board, not a default — replace `family/device/package/speedgrade`
and every pin with your own before building. The tools ship no default part and
will not guess one; a wrong package fails the build late, in place and route.

Simulate first (no board, no PDS licence needed):

```
fpga_sim   sources: [rtl/top_uart.v, sim/tb_uart.v], top: tb_uart, wave: true
fpga_assert  log_contains: PASS
```

Then build, instrument and capture with `fpga_pds_compile` → `fpga_ila_build` →
`fpga_jtag_scan` → `fpga_jtag_flash` → `fpga_jtag_capture`. Every device write
needs `confirm:true` and a matching `expectIdcode`.
