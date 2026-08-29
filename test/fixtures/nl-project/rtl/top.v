// Representative design for net-name discovery tests (mirrors the alog.txt beacon):
//  tx_int : purely-internal net (submodule out -> top reg in), survives clean.
//  tx     : top reg driving an LED -> its net is renamed (tx -> nt_led[0]).
//  clk    : port -> INBUF -> clock net nt_clk.
module uart_beacon(input clk, output tx);
  reg [7:0] cnt = 8'd0;
  reg       tx_r = 1'b0;
  always @(posedge clk) begin
    cnt  <= cnt + 8'd1;
    tx_r <= ^cnt;
  end
  assign tx = tx_r;
endmodule

module top(input clk, output [4:0] led);
  wire tx_int;
  uart_beacon u_beacon(.clk(clk), .tx(tx_int));
  reg tx;
  always @(posedge clk) tx <= tx_int;
  assign led = {4'b0000, tx};
endmodule
