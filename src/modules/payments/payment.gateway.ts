/**
 * The payment gateway (Razorpay). Creating a gateway order is a real external
 * operation, so it lives behind this port.
 *
 * NO IMPLEMENTATION IS WIRED: the Razorpay integration and its credentials
 * have not been provided. Until they are, online payment is reported as
 * unavailable (503 PAYMENT_GATEWAY_UNAVAILABLE) - an order id is never
 * invented locally. Tests inject a fake through `PaymentServiceDeps.gateway`.
 */
export interface PaymentGateway {
  createOrder(input: {
    /** Amount in rupees; the adapter converts to the gateway's unit. */
    amountINR: number;
    currencyCode: "INR";
    /** Our order reference, echoed back by the gateway. */
    receipt: string;
  }): Promise<{ gatewayOrderId: string }>;
}
