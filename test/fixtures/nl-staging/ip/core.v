module core(input wire clk, output reg q);
  always @(posedge clk) q <= ~q;
endmodule
