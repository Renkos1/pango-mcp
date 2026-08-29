// counter_ld — reference (GOOD) version (brief 009).
// posedge clk: rst? q<=0 : ld? q<=din : en? q<=q+1 : hold.
// ld has priority over en (synchronous load). Synthesizable to PG2L200H;
// q is a plain register output so an ILA can capture q[3:0] directly.
module counter_ld (
  input  wire        clk,
  input  wire        rst,        // synchronous, active-high
  input  wire        en,         // count enable
  input  wire        ld,         // synchronous load (priority over en)
  input  wire [3:0]  din,        // load value
  output reg  [3:0]  q
);
  always @(posedge clk) begin
    if (rst)
      q <= 4'd0;
    else if (ld)
      q <= din;
    else if (en)
      q <= q + 4'd1;
    // else hold
  end
endmodule
