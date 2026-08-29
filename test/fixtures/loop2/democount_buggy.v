// democount_buggy — the BUGGY version handed to the agent. Same ports/module name
// as the good one so the same testbench drives it. BUG: q increments by 2, so it
// counts 0,2,4,… instead of 0,1,2,…. The self-checking tb $fatals on this; the
// agent must fix the increment to +1. (On-chip ILA then confirms q ticks by 1.)
module democount (
  input  wire       clk,
  output reg  [4:0] led
);
  reg [3:0] q = 4'd0;
  always @(posedge clk) begin
    q   <= q + 4'd2;        // BUG: should be + 4'd1
    led <= {^q, q};
  end
endmodule
