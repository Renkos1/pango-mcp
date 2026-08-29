`timescale 1ns/1ps
// Self-checking testbench for counter_ld (brief 009 — closed-loop scenario).
// no-mock: real self-check. On any mismatch it calls $fatal (log -> "fatal",
// non-zero exit) so fpga_sim reports ok:false; an all-pass run ends in $finish
// with a log free of error/fail/fatal tokens so fpga_sim reports ok:true.
// Same TB drives both counter_ld.v (good) and counter_ld_buggy.v (bad);
// stage 5 specifically tests the synchronous load and is where the buggy
// version (missing the ld branch) must $fatal.
module tb_counter_ld;
  reg        clk;
  reg        rst;
  reg        en;
  reg        ld;
  reg  [3:0] din;
  wire [3:0] q;
  integer    stage;

  counter_ld dut (.clk(clk), .rst(rst), .en(en), .ld(ld), .din(din), .q(q));

  // 10ns clock
  initial clk = 1'b0;
  always #5 clk = ~clk;

  task expect_q(input [3:0] exp);
    begin
      if (q !== exp) begin
        $display("MISMATCH stage %0d time %0t: q=%0d expected=%0d", stage, $time, q, exp);
        $fatal(1, "counter_ld behavior mismatch");
      end else begin
        $display("PASS stage %0d time %0t: q=%0d", stage, $time, q);
      end
    end
  endtask

  initial begin
    // ---- reset ----
    rst = 1'b1; en = 1'b0; ld = 1'b0; din = 4'd0; stage = 0;
    @(negedge clk);            // posedge @5 applied rst -> q=0
    stage = 1; expect_q(4'd0);

    // ---- count up ----
    rst = 1'b0; en = 1'b1; ld = 1'b0;
    @(negedge clk); stage = 2; expect_q(4'd1);   // 0 -> 1
    @(negedge clk); stage = 3; expect_q(4'd2);   // 1 -> 2
    @(negedge clk); stage = 4; expect_q(4'd3);   // 2 -> 3

    // ---- synchronous LOAD (ld has priority over en) ----
    ld = 1'b1; en = 1'b1; din = 4'd9;
    @(negedge clk);                              // good: q<=9 ; buggy: ignores ld -> q<=4
    stage = 5; expect_q(4'd9);                   // <== load check; buggy $fatal here

    // ---- count up from loaded value ----
    ld = 1'b0; en = 1'b1;
    @(negedge clk); stage = 6; expect_q(4'd10);  // 9 -> 10

    // ---- hold (en=0) ----
    en = 1'b0; ld = 1'b0;
    @(negedge clk); stage = 7; expect_q(4'd10);  // hold

    $display("ALL CHECKS PASSED");
    $finish;
  end

  // safety net so a stuck DUT never hangs the harness
  initial begin
    #1000;
    $display("TIMEOUT stage %0d", stage);
    $fatal(1, "tb_counter_ld timeout");
  end
endmodule
