`timescale 1ns/1ps
module tb_uart;
    localparam integer DIV = 8;
    reg clk = 1'b0; always #5 clk = ~clk;       // sim clk; DIV is in clocks
    reg rx = 1'b1; wire tx; wire [4:0] led;

    top_uart #(.DIV(DIV), .HB_DIV(100000), .HEARTBEAT(8'h5A)) dut
        (.clk(clk), .uart_rx(rx), .uart_tx(tx), .led(led));

    integer i;
    task send_byte(input [7:0] b);
        begin
            rx = 1'b0; repeat (DIV) @(posedge clk);            // start
            for (i = 0; i < 8; i = i + 1) begin
                rx = b[i]; repeat (DIV) @(posedge clk);        // data LSB first
            end
            rx = 1'b1; repeat (DIV) @(posedge clk);            // stop
        end
    endtask

    reg [7:0] got; integer k;
    task recv_byte;
        begin
            @(negedge tx);                                     // start bit
            repeat (DIV + DIV/2) @(posedge clk);               // to mid of bit0
            for (k = 0; k < 8; k = k + 1) begin
                got[k] = tx; repeat (DIV) @(posedge clk);
            end
        end
    endtask

    integer errors = 0;
    task check(input [7:0] b);
        begin
            fork send_byte(b); recv_byte; join
            if (got !== b) begin $display("FAIL sent %02x got %02x", b, got); errors = errors + 1; end
            else $display("OK   sent %02x echoed %02x", b, got);
        end
    endtask

    initial begin
        repeat (20) @(posedge clk);
        check(8'h55);
        check(8'hC3);
        if (errors == 0) $display("TB PASS"); else $display("TB FAIL (%0d)", errors);
        $finish;
    end
endmodule
