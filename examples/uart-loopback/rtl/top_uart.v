// UART loopback bring-up DUT. 8N1. RX=V14, TX=U14, clk=27 MHz @ D18.
// DIV/HB_DIV are parameters so the testbench can shrink them for fast sim.
module top_uart #(
    parameter integer DIV    = 234,         // 27_000_000 / 115200
    parameter integer HB_DIV = 13_500_000,  // ~0.5 s heartbeat @ 27 MHz
    parameter [7:0]   HEARTBEAT = 8'h5A
)(
    input  wire       clk,
    input  wire       uart_rx,   // V14
    output wire       uart_tx,   // U14
    output wire [4:0] led
);
    localparam integer HALF = DIV/2;

    // ---- RX: 2-FF sync ----
    reg rx_s0 = 1'b1, rx_s1 = 1'b1;
    always @(posedge clk) begin rx_s0 <= uart_rx; rx_s1 <= rx_s0; end
    wire rx_sync = rx_s1;

    reg [1:0]  rx_state = 2'd0;   // 0 idle,1 start,2 data,3 stop
    reg [15:0] rx_cnt   = 16'd0;
    reg [2:0]  rx_bit   = 3'd0;
    reg [7:0]  rx_shift = 8'd0;
    reg [7:0]  rx_data  = 8'd0;
    reg        rx_valid = 1'b0;

    always @(posedge clk) begin
        rx_valid <= 1'b0;
        case (rx_state)
          2'd0: if (!rx_sync) begin rx_state <= 2'd1; rx_cnt <= 16'd0; end
          2'd1: if (rx_cnt == HALF[15:0]) begin
                    if (!rx_sync) begin rx_state <= 2'd2; rx_cnt <= 16'd0; rx_bit <= 3'd0; end
                    else rx_state <= 2'd0;           // false start
                 end else rx_cnt <= rx_cnt + 16'd1;
          2'd2: if (rx_cnt == DIV[15:0]-16'd1) begin
                    rx_cnt   <= 16'd0;
                    rx_shift <= {rx_sync, rx_shift[7:1]};   // LSB first
                    if (rx_bit == 3'd7) rx_state <= 2'd3; else rx_bit <= rx_bit + 3'd1;
                 end else rx_cnt <= rx_cnt + 16'd1;
          2'd3: if (rx_cnt == DIV[15:0]-16'd1) begin
                    rx_data  <= rx_shift; rx_valid <= 1'b1; rx_state <= 2'd0;
                 end else rx_cnt <= rx_cnt + 16'd1;
        endcase
    end

    // ---- TX: 10-bit frame {stop, data[7:0], start}, LSB(start) out first ----
    reg [9:0]  tx_frame = 10'h3FF;
    reg [3:0]  tx_idx   = 4'd0;
    reg [15:0] tx_cnt   = 16'd0;
    reg        tx_busy  = 1'b0;
    reg        tx_out   = 1'b1;
    reg [7:0]  tx_byte  = 8'd0;
    reg        tx_start = 1'b0;
    assign uart_tx = tx_out;

    always @(posedge clk) begin
        if (!tx_busy) begin
            tx_out <= 1'b1;
            if (tx_start) begin
                tx_frame <= {1'b1, tx_byte, 1'b0};
                tx_idx   <= 4'd0;
                tx_cnt   <= 16'd0;
                tx_busy  <= 1'b1;
                tx_out   <= 1'b0;                 // start bit = frame[0]
            end
        end else begin
            if (tx_cnt == DIV[15:0]-16'd1) begin
                tx_cnt <= 16'd0;
                if (tx_idx == 4'd9) begin tx_busy <= 1'b0; tx_out <= 1'b1; end
                else begin tx_idx <= tx_idx + 4'd1; tx_out <= tx_frame[tx_idx + 4'd1]; end
            end else tx_cnt <= tx_cnt + 16'd1;
        end
    end

    // ---- echo + idle heartbeat arbiter ----
    reg [25:0] hb_cnt   = 26'd0;
    reg        hb_due   = 1'b0;
    reg        rx_pend  = 1'b0;
    reg [7:0]  rx_hold  = 8'd0;
    reg [7:0]  last_byte= 8'd0;

    always @(posedge clk) begin
        tx_start <= 1'b0;
        if (hb_cnt == HB_DIV-1) begin hb_cnt <= 26'd0; hb_due <= 1'b1; end
        else hb_cnt <= hb_cnt + 26'd1;
        if (rx_valid) begin rx_pend <= 1'b1; rx_hold <= rx_data; last_byte <= rx_data; end
        if (!tx_busy && !tx_start) begin
            if (rx_pend)      begin tx_byte <= rx_hold;    tx_start <= 1'b1; rx_pend <= 1'b0; end
            else if (hb_due)  begin tx_byte <= HEARTBEAT;  tx_start <= 1'b1; hb_due  <= 1'b0; end
        end
    end

    assign led = last_byte[4:0];
endmodule
