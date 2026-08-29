// Self-checking testbench for democount. Checks the INTERNAL counter q increments
// by 1 each clock (hierarchical ref dut.q). $fatal on mismatch (the buggy +2
// variant fails at the first check); $finish + "ALL CHECKS PASSED" when correct.
module tb_democount;
  reg clk = 1'b0;
  wire [4:0] led;
  democount dut (.clk(clk), .led(led));
  always #5 clk = ~clk;

  integer i;
  reg [3:0] expected;
  initial begin
    expected = 4'd0;
    for (i = 0; i < 8; i = i + 1) begin
      @(posedge clk); #1;
      expected = expected + 4'd1;
      if (dut.q !== expected) begin
        $display("MISMATCH step %0d: q=%0d expected=%0d", i, dut.q, expected);
        $fatal(1, "democount q must increment by 1 each clock");
      end
      $display("PASS step %0d: q=%0d", i, dut.q);
    end
    $display("ALL CHECKS PASSED");
    $finish;
  end
endmodule
