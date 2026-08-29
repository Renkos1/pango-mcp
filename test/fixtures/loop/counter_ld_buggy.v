// counter_ld_buggy — the BUGGY version handed to the agent (brief 009).
// Bug: the synchronous-load branch (ld) is missing, so `ld`/`din` never take
// effect. Everything else matches the good version. Module name is kept as
// `counter_ld` so the same tb_counter_ld.v drives it. tb stage 5 (load check)
// is where this version must $fatal.
module counter_ld (
  input  wire        clk,
  input  wire        rst,        // synchronous, active-high
  input  wire        en,         // count enable
  input  wire        ld,         // synchronous load (unused here — the bug)
  input  wire [3:0]  din,        // load value (unused here — the bug)
  output reg  [3:0]  q
);
  always @(posedge clk) begin
    if (rst)
      q <= 4'd0;
    // BUG: missing `else if (ld) q <= din;`
    else if (en)
      q <= q + 4'd1;
    // else hold
  end
endmodule
