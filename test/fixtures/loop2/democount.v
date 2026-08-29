// democount — reference (GOOD). Free-running 4-bit counter on clk; led mirrors it.
// Top ports are clk + led[4:0] only (match the board Target Profile pins). The
// counter q is INTERNAL — observed on-chip via ILA, no pin needed.
// Device-agnostic: plain RTL, no device-specific primitives.
module democount (
  input  wire       clk,
  output reg  [4:0] led
);
  reg [3:0] q = 4'd0;
  always @(posedge clk) begin
    q   <= q + 4'd1;        // increment by 1
    led <= {^q, q};         // led[4]=parity, led[3:0]=q
  end
endmodule
