import { describe, expect, it } from "vitest";
import { convert } from "../src/translator.js";

const ea = (body: string, globals = "") => `#include <Trade\\Trade.mqh>
CTrade trade;
${globals}
void OnTick()
{
${body}
}
`;
const logic = (src: string) => {
  const r = convert(src);
  const i = r.pine.indexOf("// ---- Logic");
  return { ...r, logic: r.pine.slice(i).split("\n").slice(1).join("\n").trim() };
};

describe("expressions", () => {
  it("keeps integer division as integer", () => {
    const r = logic(ea("int a = 7; int b = 2; int c = a / b;"));
    expect(r.logic).toContain("int c = int(a / b)");
  });
  it("turns string + number into str.tostring", () => {
    const r = logic(ea('double x = 1.5; string s = "x=" + x;'));
    expect(r.logic).toContain('string s = "x=" + str.tostring(x)');
  });
  it("maps logical operators", () => {
    const r = logic(ea("bool a = true; bool b = false; bool c = !a && (b || a);"));
    expect(r.logic).toContain("bool c = not a and (b or a)");
  });
  it("adds parentheses only where needed", () => {
    const r = logic(ea("double a = 1; double b = 2; double c = (a + b) * 2 - a * b;"));
    expect(r.logic).toContain("float c = (a + b) * 2 - a * b");
  });
  it("folds constant comparisons", () => {
    const r = logic(ea("if(3 < 3) return; Print(\"x\");"));
    expect(r.logic).toContain('log.info("x")');
    expect(r.logic).not.toContain("3 < 3");
  });
});

describe("control flow", () => {
  it("converts counting for-loops with a guard for empty ranges", () => {
    const r = logic(ea("int n = 5; double s = 0; for(int i = 0; i < n; i++) s += i;"));
    expect(r.logic).toContain("if 0 <= n - 1");
    expect(r.logic).toContain("for i = 0 to n - 1");
  });
  it("converts downward loops", () => {
    const r = logic(ea("double s = 0; for(int i = 10; i >= 0; i--) s += i;"));
    expect(r.logic).toContain("for i = 10 to 0 by -1");
  });
  it("turns early returns into if/else", () => {
    const r = logic(ea("double x = iClose(_Symbol, PERIOD_CURRENT, 1); if(x < 1) return; trade.Buy(1);"));
    expect(r.logic).toContain("if x >= 1");
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
  });
  it("uses a flag for returns inside loops", () => {
    const src = `#include <Trade\\Trade.mqh>
CTrade trade;
bool Has() { for(int i = PositionsTotal() - 1; i >= 0; i--) { if(PositionGetTicket(i) > 0) return true; } return false; }
void OnTick() { if(!Has()) trade.Buy(1); }`;
    const r = convert(src);
    expect(r.pine).toContain("result_ := true");
    expect(r.pine).toContain("done_ := true");
    expect(r.status).toBe("full");
  });
  it("handles switch with fall-through and conditional break", () => {
    const r = logic(
      ea("int m = 1; int x = 0; switch(m) { case 0: x = 1; break; case 1: x = 2; if(x > 1) break; case 2: x = 3; break; default: x = 9; }"),
    );
    expect(r.logic).toContain("if m == 0");
    expect(r.logic).toContain("case_done := true");
    expect(r.logic).toContain("else\n");
    expect(r.status).toBe("full");
  });
});

describe("functions", () => {
  it("inlines void functions that change globals", () => {
    const src = `int counter = 0;
void Bump(int by) { counter += by; }
void OnTick() { Bump(2); }`;
    const r = convert(src);
    expect(r.pine).toContain("// Bump()");
    expect(r.pine).toContain("counter += Bump_by");
    expect(r.status).toBe("full");
  });
  it("reports value functions that change globals", () => {
    const src = `int counter = 0;
int Bump() { counter++; return counter; }
void OnTick() { int x = Bump(); }`;
    const r = convert(src);
    expect(r.status).toBe("partial");
    expect(r.issues.some((i) => /changes global variables and returns a value/.test(i.message))).toBe(true);
  });
});

describe("indicators and trading", () => {
  it("hoists indicators and maps CopyBuffer arrays to series", () => {
    const src = ea(
      "double b[]; ArraySetAsSeries(b, true); CopyBuffer(h, 0, 0, 3, b); if(b[1] > b[2]) trade.Buy(0.1);",
      "int h; int OnInit() { h = iRSI(_Symbol, PERIOD_H1, 14, PRICE_CLOSE); return INIT_SUCCEEDED; }",
    );
    const r = convert(src);
    expect(r.pine).toContain('request.security(syminfo.tickerid, "60", ta.rsi(close, 14))');
    expect(r.pine).toMatch(/rsi\[1\] > rsi\[2\]|\bh_?\w*\[1\]/);
  });
  it("arrays not set as series are read oldest-first", () => {
    const src = ea(
      "double b[]; CopyBuffer(h, 0, 0, 3, b); if(b[2] > b[0]) trade.Buy(0.1);",
      "int h = iATR(_Symbol, PERIOD_CURRENT, 14);",
    );
    const r = convert(src, { alignNewBar: false });
    expect(r.pine).toContain("atr > atr[2]");
  });
  it("places SL/TP with strategy.exit", () => {
    const r = convert(ea("trade.Sell(0.2, _Symbol, 0, 1.2, 1.1);"));
    expect(r.pine).toContain('strategy.entry("Sell", strategy.short, qty = 0.2)');
    expect(r.pine).toContain('strategy.exit("Sell SL/TP", from_entry = "Sell", stop = 1.2, limit = 1.1)');
  });
  it("rejects trade calls hidden inside bigger conditions", () => {
    const r = convert(ea("bool ok = true; if(ok && trade.Buy(1)) Print(1);"));
    expect(r.status).toBe("partial");
  });
});

describe("errors", () => {
  it("reports syntax errors with a line number", () => {
    const r = convert("void OnTick() { int x = ; }");
    expect(r.status).toBe("failed");
    expect(r.issues[0].line).toBe(1);
  });
  it("reports classes as unsupported", () => {
    const r = convert("class A { int x; }; void OnTick() {}");
    expect(r.status).toBe("partial");
  });
  it("reports indicators (OnCalculate) as unsupported for now", () => {
    const r = convert("int OnCalculate(const int rates_total, const int prev_calculated, const int begin, const double &price[]) { return rates_total; }");
    expect(r.status).toBe("partial");
  });
});
