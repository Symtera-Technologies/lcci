import { describe, expect, it } from "vitest";
import { formatMoney } from "@/lib/format";

/**
 * Fees, as the Chamber writes them.
 *
 * Worth its own file because the amounts are exact: an applicant draws a pay
 * order for one of six published figures, and the bank-match control compares
 * what the instrument says against what the fee schedule says. A formatter
 * that rounds, or that routes a `DECIMAL(14,2)` string through a float on its
 * way to the screen, turns a matching instrument into a query.
 */
describe("formatMoney", () => {
  it("writes the six published fees the way the form does", () => {
    expect(formatMoney("10650.00", "PKR")).toBe("Rs 10,650");
    expect(formatMoney("15100.00", "PKR")).toBe("Rs 15,100");
    expect(formatMoney("20000.00", "PKR")).toBe("Rs 20,000");
    expect(formatMoney("4450.00", "PKR")).toBe("Rs 4,450");
    expect(formatMoney("7300.00", "PKR")).toBe("Rs 7,300");
  });

  it("leaves the surcharge in its own currency", () => {
    // Quoted on the form as a dollar equivalent. Better left looking foreign
    // than dressed in a symbol the applicant's bank will not use.
    expect(formatMoney("750.00", "USD")).toBe("USD 750");
  });

  it("keeps paisa when there are any, and drops them when there are not", () => {
    // Dropping them would understate what is owed; printing "Rs 10,650.00"
    // for a whole fee reads like a bank statement rather than a price.
    expect(formatMoney("1234.50", "PKR")).toBe("Rs 1,234.50");
    expect(formatMoney("1234.05", "PKR")).toBe("Rs 1,234.05");
    expect(formatMoney("1234.00", "PKR")).toBe("Rs 1,234");
    expect(formatMoney("1234", "PKR")).toBe("Rs 1,234");
  });

  it("groups digits without arithmetic", () => {
    // The whole point: no parseFloat anywhere, so a large exact amount cannot
    // acquire a rounding error on its way to somebody's email.
    expect(formatMoney("1000000.00", "PKR")).toBe("Rs 1,000,000");
    expect(formatMoney("999.00", "PKR")).toBe("Rs 999");
    expect(formatMoney("0.00", "PKR")).toBe("Rs 0");
    expect(formatMoney("50000000.00", "PKR")).toBe("Rs 50,000,000");
  });

  it("handles a negative amount without losing the sign", () => {
    // Nothing writes one today. A refund credit would, and a formatter that
    // silently drops the minus on the one row that matters is worse than one
    // that never saw the case.
    expect(formatMoney("-500.00", "PKR")).toBe("Rs -500");
  });
});
