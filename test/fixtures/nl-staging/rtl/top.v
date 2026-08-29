`include "defs.vh"
module top(input wire clk, output wire q);
  core u_core(.clk(clk), .q(q));
endmodule
