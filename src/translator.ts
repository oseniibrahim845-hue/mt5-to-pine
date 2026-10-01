import type { EnumDecl, Expr, FuncDecl, Program, Stmt, VarDecl } from "./ast.js";
import { parse, parseExpression, ParseError } from "./parser.js";
import { LexError } from "./lexer.js";
import {
  APPLIED_PRICE,
  BUILTIN_RETURN_TYPES,
  COLORS,
  MATH_FUNCTIONS,
  MA_METHOD,
  MA_METHOD_VALUES,
  NUMERIC_CONSTANTS,
  PINE_RESERVED,
  TIMEFRAMES,
  defaultValue,
  pineType,
} from "./mappings.js";

// ---------------------------------------------------------------------------
// Public types

export type Severity = "error" | "warning" | "info";

export interface Issue {
  line: number;
  severity: Severity;
  message: string;
}

export interface ConvertOptions {
  /** Script title. Defaults to #property description or "Converted EA". */
  title?: string;
  /**
   * Shift series indexes by one bar when the EA only acts on a new bar and reads closed bars
   * (index >= 1). This makes Pine's bar-close execution line up with MT5's new-bar execution.
   */
  alignNewBar?: boolean;
}

export interface ConvertResult {
  /** "full": no errors; "partial": Pine produced but some parts need manual work; "failed": no output. */
  status: "full" | "partial" | "failed";
  pine: string;
  issues: Issue[];
  stats: {
    inputs: number;
    indicators: number;
    functions: number;
    linesIn: number;
    linesOut: number;
    barShift: number;
  };
}

// ---------------------------------------------------------------------------
// Internal types

type PType = "int" | "float" | "bool" | "string" | "color" | "unknown";

interface Code {
  code: string;
  prec: number; // Pine precedence of the outermost operator
  type: PType;
}

const PREC = { ternary: 1, or: 2, and: 3, eq: 4, cmp: 5, add: 6, mul: 7, unary: 8, postfix: 9, atom: 10 };

const C_TO_PINE_OP: Record<string, { op: string; prec: number }> = {
  "||": { op: "or", prec: PREC.or },
  "&&": { op: "and", prec: PREC.and },
  "==": { op: "==", prec: PREC.eq },
  "!=": { op: "!=", prec: PREC.eq },
  "<": { op: "<", prec: PREC.cmp },
  ">": { op: ">", prec: PREC.cmp },
  "<=": { op: "<=", prec: PREC.cmp },
  ">=": { op: ">=", prec: PREC.cmp },
  "+": { op: "+", prec: PREC.add },
  "-": { op: "-", prec: PREC.add },
  "*": { op: "*", prec: PREC.mul },
  "/": { op: "/", prec: PREC.mul },
  "%": { op: "%", prec: PREC.mul },
};

interface VarInfo {
  pine: string;
  type: PType;
  mqlType: string;
  isGlobal: boolean;
  isInput: boolean;
  isArray: boolean;
}

interface HandleSpec {
  fn: string;
  args: Expr[];
  line: number;
  /** Pine names for each buffer once generated. */
  buffers?: string[];
}

interface Binding {
  kind: "buffer" | "price" | "rates";
  handle?: string; // for buffer
  buffer?: number;
  price?: string; // close/open/high/low/time/volume for "price"
  timeframe?: string | null; // Pine tf expression (null = chart) for price/rates
  start: Expr;
  count: Expr;
  line: number;
}

interface FlagState {
  done: string;
  ret: string | null;
}

interface FnCtx {
  name: string; // MQL function name ("OnTick", "OnInit", user fn, "#global")
  scopes: Map<string, VarInfo>[];
  valueFn: boolean; // returns a value
  returnType: PType;
  flag: FlagState | null;
  loopDepth: number;
  pre: string[] | null; // hoisted statements (trade calls)
  hoistOk: boolean;
  timeStructs: Map<string, string>;
  topLevel: boolean; // emitting at Pine global scope
  switchFlags: { name: string; depth: number }[]; // `break` out of a switch case
}

class Out {
  lines: string[] = [];
  constructor(public indent = 0) {}
  emit(line: string) {
    this.lines.push("    ".repeat(this.indent) + line);
  }
  push(fn: () => void) {
    this.indent++;
    try {
      fn();
    } finally {
      this.indent--;
    }
  }
}

const INDICATOR_FNS = new Set([
  "iMA", "iRSI", "iATR", "iMACD", "iBands", "iStochastic", "iCCI", "iADX", "iMomentum", "iStdDev",
  "iSAR", "iWPR", "iMFI", "iOBV", "iAO", "iCustom", "iEnvelopes", "iIchimoku", "iDEMA", "iTEMA",
  "iFrAMA", "iAMA", "iVIDyA", "iTriX", "iForce", "iDeMarker", "iRVI", "iOsMA", "iBearsPower",
  "iBullsPower", "iChaikin", "iAD", "iAlligator", "iFractals", "iGator", "iADXWilder", "iBWMFI",
  "iAC", "iMFI", "iVolumes",
]);

const PRICE_ARRAY_FNS: Record<string, string> = {
  CopyClose: "close",
  CopyOpen: "open",
  CopyHigh: "high",
  CopyLow: "low",
  CopyTime: "time",
  CopyTickVolume: "volume",
  CopyRealVolume: "volume",
};

const SERIES_FNS: Record<string, string> = {
  iClose: "close",
  iOpen: "open",
  iHigh: "high",
  iLow: "low",
  iTime: "time",
  iVolume: "volume",
  iTickVolume: "volume",
  iRealVolume: "volume",
};

const MQL4_SERIES: Record<string, string> = {
  Close: "close",
  Open: "open",
  High: "high",
  Low: "low",
  Time: "time",
  Volume: "volume",
};

const RATES_FIELDS: Record<string, string> = {
  open: "open",
  high: "high",
  low: "low",
  close: "close",
  time: "time",
  tick_volume: "volume",
  real_volume: "volume",
  spread: "0",
};

const TRADE_METHODS_IGNORED = new Set([
  "SetExpertMagicNumber", "SetDeviationInPoints", "SetTypeFilling", "SetTypeFillingBySymbol",
  "SetAsyncMode", "SetMarginMode", "LogLevel", "SetTypeFilling",
]);

// ---------------------------------------------------------------------------

export function convert(source: string, options: ConvertOptions = {}): ConvertResult {
  let program: Program;
  try {
    program = parse(source);
  } catch (e) {
    const line = e instanceof ParseError || e instanceof LexError ? e.line : 0;
    return {
      status: "failed",
      pine: "",
      issues: [{ line, severity: "error", message: `Could not read the MQL5 code: ${(e as Error).message}` }],
      stats: { inputs: 0, indicators: 0, functions: 0, linesIn: source.split("\n").length, linesOut: 0, barShift: 0 },
    };
  }

  const first = new Translator(source, program, options, 0);
  let result = first.run();
  const align = options.alignNewBar !== false;
  if (align && result.status !== "failed" && first.shouldShiftBars()) {
    const shifted = new Translator(source, program, options, 1).run();
    shifted.issues.push({
      line: 0,
      severity: "info",
      message:
        "The EA only acts on a new bar and reads closed bars, so bar indexes were shifted by 1 " +
        "(MT5 index 1 at the new bar = Pine index 0 at bar close). Orders still fill at the next bar's open.",
    });
    result = shifted;
  } else if (align && first.usesNewBarLogic() && result.status !== "failed") {
    result.issues.push({
      line: 0,
      severity: "warning",
      message:
        "Pine runs once per bar close. This EA reads the forming bar (index 0) or uses non-constant indexes, " +
        "so its signals may be one bar later than in MT5.",
    });
  }
  return result;
}

class Translator {
  private issues: Issue[] = [];
  private srcLines: string[];
  private defines = new Map<string, Expr>();
  private enumValues = new Map<string, number>();
  private enumTypes = new Map<string, EnumDecl>();
  private globals = new Map<string, VarInfo>();
  private globalDecls: VarDecl[] = [];
  private inputDecls: VarDecl[] = [];
  private functions = new Map<string, FuncDecl>();
  private inlineFns = new Set<string>();
  private handles = new Map<string, HandleSpec>();
  private bindings = new Map<string, Binding>();
  private seriesArrays = new Set<string>();
  private usedNames = new Set<string>();
  private helpers = new Set<string>();
  private indicatorLines: string[] = [];
  private constLines: string[] = [];
  private title = "Converted EA";
  private warnedOnce = new Set<string>();
  // Bar alignment stats (filled in during translation)
  private minSeriesIndex = Infinity;
  private nonConstSeriesIndex = false;
  private seriesAccessCount = 0;
  private inputNames = new Map<string, { kind: "maMethod" | "price" | "timeframe" | "enum" | "plain" }>();

  constructor(
    private source: string,
    private program: Program,
    private options: ConvertOptions,
    private barShift: number,
  ) {
    this.srcLines = source.split(/\r?\n/);
  }

  usesNewBarLogic(): boolean {
    return /iTime\s*\(|SERIES_LASTBAR_DATE|new_?bar|lastbar|last_bar|prevtime|prev_time|lastTime/i.test(this.source);
  }

  shouldShiftBars(): boolean {
    return (
      this.usesNewBarLogic() && !this.nonConstSeriesIndex && this.seriesAccessCount > 0 && this.minSeriesIndex >= 1
    );
  }

  private issue(line: number, severity: Severity, message: string) {
    if (this.issues.some((i) => i.line === line && i.message === message)) return;
    this.issues.push({ line, severity, message });
  }
  private warnOnce(key: string, line: number, message: string, severity: Severity = "warning") {
    if (this.warnedOnce.has(key)) return;
    this.warnedOnce.add(key);
    this.issue(line, severity, message);
  }

  // -------------------------------------------------------------------------
  // Driver

  run(): ConvertResult {
    this.collect();
    this.scanBindings();
    this.reserveNames();
    this.computeInlineFunctions();

    const body = new Out();
    // Inputs
    const inputOut = new Out();
    for (const d of this.inputDecls) this.emitInput(d, inputOut);

    // Global variables
    const globalsOut = new Out();
    const gctx = this.newCtx("#global", false, "unknown", true);
    for (const d of this.globalDecls) this.emitGlobalVar(d, globalsOut, gctx);

    // User functions (in dependency order)
    const fnOut = new Out();
    for (const fn of this.orderFunctions()) {
      if (this.inlineFns.has(fn.name)) continue;
      this.emitFunction(fn, fnOut);
    }

    // OnInit (first bar) and OnTick (every bar)
    const mainOut = new Out();
    const onInit = this.functions.get("OnInit");
    if (onInit) this.emitOnInit(onInit, mainOut);
    const onTick = this.functions.get("OnTick");
    if (onTick) {
      const ctx = this.newCtx("OnTick", false, "unknown", true);
      ctx.scopes.push(new Map());
      if (this.needsFlag(onTick.body.body)) {
        ctx.flag = { done: this.uniqueName("tick_done"), ret: null };
        mainOut.emit(`bool ${ctx.flag.done} = false`);
      }
      this.emitStmtList(onTick.body.body, mainOut, ctx);
    } else if (this.functions.has("OnCalculate")) {
      this.issue(
        this.functions.get("OnCalculate")!.line,
        "error",
        "This is an indicator (OnCalculate). Only Expert Advisors (OnTick) are supported in this version.",
      );
    } else {
      this.issue(0, "error", "No OnTick() function found. Only Expert Advisors are supported in this version.");
    }

    for (const name of ["OnTimer", "OnTrade", "OnTradeTransaction", "OnBookEvent", "OnTester"]) {
      const fn = this.functions.get(name);
      if (fn && fn.body.body.length > 0) {
        this.issue(fn.line, "error", `${name}() has no Pine equivalent and was not converted.`);
      }
    }
    const deinit = this.functions.get("OnDeinit");
    if (deinit && deinit.body.body.some((s) => !this.isIgnorableDeinitStmt(s))) {
      this.issue(deinit.line, "info", "OnDeinit() was skipped (Pine has no shutdown event).");
    }

    // Assemble
    const lines: string[] = [];
    lines.push("// This Pine Script was generated from MQL5 by mt5-to-pine.");
    lines.push("// Review the notes the converter returned before trading with it.");
    lines.push("//@version=6");
    lines.push(`strategy(${JSON.stringify(this.options.title ?? this.title)}, overlay = true, pyramiding = 1, calc_on_every_tick = false)`);
    const section = (title: string, src: string[]) => {
      if (src.length === 0) return;
      lines.push("");
      lines.push(`// ---- ${title} ----`);
      lines.push(...src);
    };
    const usesPos = [fnOut, mainOut, globalsOut].some((o) => o.lines.some((l) => l.includes("f_pos()") || l.includes("posState")));
    const helperLines = this.helperLines();
    if (usesPos) {
      helperLines.push(
        "// Position seen by the EA logic on this bar (MT5 updates it right after each order).",
        "var posState = array.new_float(1, 0.0)",
        "f_pos() => array.get(posState, 0)",
      );
      mainOut.lines.unshift("array.set(posState, 0, strategy.position_size)");
    }
    section("Constants", this.constLines);
    section("Inputs", inputOut.lines);
    section("Helpers", helperLines);
    section("Indicators", this.indicatorLines);
    section("Variables", globalsOut.lines);
    section("Functions", fnOut.lines);
    section("Logic (runs once per bar, like OnTick on a new bar)", mainOut.lines);
    void body;

    const pine = lines.join("\n") + "\n";
    const hasError = this.issues.some((i) => i.severity === "error");
    this.issues.sort((a, b) => a.line - b.line);
    return {
      status: hasError ? "partial" : "full",
      pine,
      issues: this.issues,
      stats: {
        inputs: this.inputDecls.reduce((n, d) => n + d.declarators.length, 0),
        indicators: [...this.handles.values()].filter((h) => h.buffers).length,
        functions: [...this.functions.keys()].filter((n) => !n.startsWith("On")).length,
        linesIn: this.srcLines.length,
        linesOut: lines.length,
        barShift: this.barShift,
      },
    };
  }

  private isIgnorableDeinitStmt(s: Stmt): boolean {
    if (s.type === "ExprStmt" && s.expr.type === "Call" && s.expr.callee.type === "Ident") {
      return ["IndicatorRelease", "Comment", "Print", "EventKillTimer", "ObjectsDeleteAll"].includes(s.expr.callee.name);
    }
    return s.type === "Empty";
  }

  // -------------------------------------------------------------------------
  // Pass 1: collect declarations

  private collect() {
    for (const d of this.program.directives) {
      const m = d.text.match(/^#\s*(\w+)\s*(.*)$/);
      if (!m) continue;
      const [, kind, rest] = m;
      if (kind === "property") {
        const pm = rest.match(/^(\w+)\s*(.*)$/);
        if (pm && pm[1] === "description") {
          const s = pm[2].trim().replace(/^"|"$/g, "");
          if (s) this.title = s.slice(0, 60);
        }
        if (pm && /^indicator_/.test(pm[1])) {
          this.warnOnce("indicator-prop", d.line, "Indicator properties (#property indicator_*) are ignored.", "info");
        }
      } else if (kind === "define") {
        const dm = rest.match(/^(\w+)(\([^)]*\))?\s*(.*)$/);
        if (!dm) continue;
        if (dm[2]) {
          this.issue(d.line, "error", `Macro with parameters #define ${dm[1]}${dm[2]} is not supported.`);
          continue;
        }
        const value = dm[3].trim();
        if (!value) continue;
        try {
          this.defines.set(dm[1], parseExpression(value));
        } catch {
          this.issue(d.line, "error", `Could not understand #define ${dm[1]} ${value}`);
        }
      } else if (kind === "include") {
        if (!/Trade[\\/]+(Trade|PositionInfo|SymbolInfo|OrderInfo|AccountInfo)\.mqh/i.test(rest)) {
          this.issue(d.line, "warning", `Included file ${rest} was not converted. Paste its code into the EA if it is needed.`);
        }
      }
    }

    for (const item of this.program.items) {
      switch (item.type) {
        case "EnumDecl": {
          this.enumTypes.set(item.name, item);
          let next = 0;
          for (const m of item.members) {
            if (m.value) {
              const v = this.constNumber(m.value);
              if (v === null) this.issue(item.line, "error", `Enum value ${m.name} must be a number.`);
              else next = v;
            }
            this.enumValues.set(m.name, next);
            next++;
          }
          break;
        }
        case "VarDecl":
          if (item.modifiers.includes("input") || item.modifiers.includes("sinput") || item.modifiers.includes("extern")) {
            this.inputDecls.push(item);
          } else {
            this.globalDecls.push(item);
          }
          break;
        case "FuncDecl":
          if (this.functions.has(item.name)) {
            this.issue(item.line, "error", `Function ${item.name} is defined more than once (overloads are not supported).`);
          } else {
            this.functions.set(item.name, item);
          }
          break;
        case "Unsupported":
          this.issue(item.line, "error", `${item.what} is not supported (Pine has no classes or templates).`);
          break;
      }
    }

  }

  /** Names that will exist in the Pine script (bound arrays and handles disappear). */
  private reserveNames() {
    for (const d of [...this.inputDecls, ...this.globalDecls]) {
      for (const dec of d.declarators) {
        if (this.handles.has(dec.name) || this.bindings.has(dec.name)) continue;
        this.usedNames.add(this.pineName(dec.name));
      }
    }
    for (const n of this.functions.keys()) this.usedNames.add(this.pineName(n));
  }

  private constNumber(e: Expr): number | null {
    if (e.type === "Number") return Number(e.value.replace(/[fFlLuU]+$/, ""));
    if (e.type === "Unary" && e.op === "-" && e.prefix) {
      const v = this.constNumber(e.arg);
      return v === null ? null : -v;
    }
    if (e.type === "Ident") {
      if (this.enumValues.has(e.name)) return this.enumValues.get(e.name)!;
      const d = this.defines.get(e.name);
      if (d) return this.constNumber(d);
      if (e.name in NUMERIC_CONSTANTS && /^-?[\d.]+(e-?\d+)?$/.test(NUMERIC_CONSTANTS[e.name])) {
        return Number(NUMERIC_CONSTANTS[e.name]);
      }
    }
    if (e.type === "Binary") {
      const a = this.constNumber(e.left);
      const b = this.constNumber(e.right);
      if (a === null || b === null) return null;
      switch (e.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return b === 0 ? null : a / b;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Pass 2: indicator handles and array bindings

  private scanBindings() {
    const visitExpr = (e: Expr, fnName: string) => {
      walkExpr(e, (x) => {
        if (x.type === "Assign" && x.op === "=" && x.target.type === "Ident" && isIndicatorCall(x.value)) {
          this.registerHandle(x.target.name, x.value as Expr & { type: "Call" });
        }
        if (x.type === "Call" && x.callee.type === "Ident") {
          const name = x.callee.name;
          if (name === "CopyBuffer") this.registerBufferBinding(x, fnName);
          else if (name in PRICE_ARRAY_FNS) this.registerPriceBinding(x, PRICE_ARRAY_FNS[name]);
          else if (name === "CopyRates") this.registerPriceBinding(x, "rates");
          else if (name === "ArraySetAsSeries" && x.args[0]?.type === "Ident") {
            const flag = x.args[1];
            const on = !flag || !(flag.type === "Ident" && flag.name === "false");
            if (on) this.seriesArrays.add(x.args[0].name);
          }
        }
      });
    };
    const visitStmt = (s: Stmt, fnName: string) => {
      walkStmt(s, (st) => {
        if (st.type === "VarDecl") {
          for (const d of st.declarators) {
            if (d.init && isIndicatorCall(d.init)) this.registerHandle(d.name, d.init as Expr & { type: "Call" });
            if (d.init) visitExpr(d.init, fnName);
          }
        }
      }, (e) => visitExpr(e, fnName));
    };
    for (const d of this.globalDecls) {
      for (const dec of d.declarators) {
        if (dec.init && isIndicatorCall(dec.init)) this.registerHandle(dec.name, dec.init as Expr & { type: "Call" });
      }
    }
    for (const fn of this.functions.values()) visitStmt(fn.body, fn.name);
  }

  private registerHandle(name: string, call: Expr & { type: "Call" }) {
    const fn = (call.callee as Expr & { type: "Ident" }).name;
    if (this.handles.has(name)) {
      const prev = this.handles.get(name)!;
      if (JSON.stringify(stripLines(prev.args)) !== JSON.stringify(stripLines(call.args)) || prev.fn !== fn) {
        this.issue(call.line, "error", `Handle ${name} is assigned two different indicators. Use one handle per indicator.`);
      }
      return;
    }
    this.handles.set(name, { fn, args: call.args, line: call.line });
  }

  private registerBufferBinding(call: Expr & { type: "Call" }, fnName: string) {
    const [h, buf, start, count, arr] = call.args;
    if (!h || !buf || !start || !count || !arr) {
      this.issue(call.line, "error", "CopyBuffer needs 5 arguments (handle, buffer, start, count, array).");
      return;
    }
    if (h.type !== "Ident") {
      this.issue(call.line, "error", "CopyBuffer handle must be a variable.");
      return;
    }
    if (arr.type !== "Ident") {
      this.issue(call.line, "error", "CopyBuffer target must be an array variable.");
      return;
    }
    if (start.type === "Ident" && this.isDatetimeish(start.name)) {
      this.issue(call.line, "error", "CopyBuffer by start time is not supported; use a start position.");
      return;
    }
    const bufferIndex = this.constNumber(buf);
    if (bufferIndex === null) {
      this.issue(call.line, "error", "CopyBuffer buffer number must be a constant.");
      return;
    }
    this.setBinding(arr.name, { kind: "buffer", handle: h.name, buffer: bufferIndex, start, count, line: call.line }, fnName);
  }

  private registerPriceBinding(call: Expr & { type: "Call" }, price: string) {
    const [, tf, start, count, arr] = call.args;
    if (!arr || arr.type !== "Ident" || !start || !count) {
      this.issue(call.line, "error", "Copy* function needs (symbol, timeframe, start, count, array).");
      return;
    }
    this.setBinding(
      arr.name,
      price === "rates"
        ? { kind: "rates", start, count, line: call.line, timeframe: null }
        : { kind: "price", price, start, count, line: call.line, timeframe: null },
      "",
    );
    // Timeframe is resolved during translation (needs input info).
    (this.bindings.get(arr.name) as Binding & { tfExpr?: Expr }).tfExpr = tf;
  }

  private setBinding(arr: string, b: Binding, _fn: string) {
    const prev = this.bindings.get(arr);
    if (prev) {
      const same =
        prev.kind === b.kind &&
        prev.handle === b.handle &&
        prev.buffer === b.buffer &&
        prev.price === b.price &&
        JSON.stringify(stripLines([prev.start, prev.count])) === JSON.stringify(stripLines([b.start, b.count]));
      if (!same) {
        this.issue(b.line, "error", `Array ${arr} is filled from two different sources. Use a separate array for each.`);
      }
      return;
    }
    this.bindings.set(arr, b);
  }

  private isDatetimeish(name: string): boolean {
    const g = this.globals.get(name);
    return g?.mqlType === "datetime";
  }

  // -------------------------------------------------------------------------
  // Functions that change globals must be inlined (Pine functions cannot assign globals).

  private computeInlineFunctions() {
    const globalNames = new Set<string>();
    for (const d of this.globalDecls) for (const dec of d.declarators) globalNames.add(dec.name);

    const direct = new Map<string, boolean>();
    const calls = new Map<string, Set<string>>();
    for (const fn of this.functions.values()) {
      if (fn.name.startsWith("On")) continue;
      const locals = new Set(fn.params.map((p) => p.name));
      walkStmt(fn.body, (s) => {
        if (s.type === "VarDecl") for (const d of s.declarators) locals.add(d.name);
      }, () => {});
      let modifies = false;
      const called = new Set<string>();
      walkStmt(fn.body, () => {}, (e) =>
        walkExpr(e, (x) => {
          const target = x.type === "Assign" ? x.target : x.type === "Unary" && (x.op === "++" || x.op === "--") ? x.arg : null;
          if (target?.type === "Ident" && globalNames.has(target.name) && !locals.has(target.name)) modifies = true;
          if (x.type === "Call" && x.callee.type === "Ident" && this.functions.has(x.callee.name)) called.add(x.callee.name);
        }),
      );
      direct.set(fn.name, modifies);
      calls.set(fn.name, called);
    }
    let changed = true;
    for (const [n, m] of direct) if (m) this.inlineFns.add(n);
    while (changed) {
      changed = false;
      for (const [n, c] of calls) {
        if (this.inlineFns.has(n)) continue;
        if ([...c].some((x) => this.inlineFns.has(x))) {
          this.inlineFns.add(n);
          changed = true;
        }
      }
    }
    for (const n of this.inlineFns) {
      const fn = this.functions.get(n)!;
      if (fn.returnType !== "void") {
        this.issue(
          fn.line,
          "error",
          `Function ${n}() changes global variables and returns a value. Pine functions cannot change globals; ` +
            "split it into a void function that sets the globals and a separate check.",
        );
      }
      if (this.isRecursive(n)) this.issue(fn.line, "error", `Recursive function ${n}() is not supported.`);
    }
  }

  private isRecursive(name: string, seen = new Set<string>()): boolean {
    if (seen.has(name)) return true;
    const fn = this.functions.get(name);
    if (!fn) return false;
    seen.add(name);
    let rec = false;
    walkStmt(fn.body, () => {}, (e) =>
      walkExpr(e, (x) => {
        if (x.type === "Call" && x.callee.type === "Ident" && this.functions.has(x.callee.name)) {
          if (x.callee.name === name || this.isRecursive(x.callee.name, new Set(seen))) rec = true;
        }
      }),
    );
    return rec;
  }

  private orderFunctions(): FuncDecl[] {
    const order: FuncDecl[] = [];
    const state = new Map<string, number>();
    const visit = (fn: FuncDecl) => {
      if (state.get(fn.name) === 2) return;
      if (state.get(fn.name) === 1) return; // cycle; reported by isRecursive when inlined
      state.set(fn.name, 1);
      walkStmt(fn.body, () => {}, (e) =>
        walkExpr(e, (x) => {
          if (x.type === "Call" && x.callee.type === "Ident") {
            const callee = this.functions.get(x.callee.name);
            if (callee && !callee.name.startsWith("On")) visit(callee);
          }
        }),
      );
      state.set(fn.name, 2);
      order.push(fn);
    };
    for (const fn of this.functions.values()) if (!fn.name.startsWith("On")) visit(fn);
    return order;
  }

  // -------------------------------------------------------------------------
  // Names

  private pineName(name: string): string {
    let n = name;
    if (PINE_RESERVED.has(n)) n = n + "_";
    return n;
  }

  private uniqueName(base: string): string {
    let n = base;
    let i = 2;
    while (this.usedNames.has(n) || PINE_RESERVED.has(n)) n = `${base}${i++}`;
    this.usedNames.add(n);
    return n;
  }

  private newCtx(name: string, valueFn: boolean, returnType: PType, topLevel: boolean): FnCtx {
    return {
      name,
      scopes: [this.globals],
      valueFn,
      returnType,
      flag: null,
      loopDepth: 0,
      pre: null,
      hoistOk: false,
      timeStructs: new Map(),
      topLevel,
      switchFlags: [],
    };
  }

  private lookup(ctx: FnCtx, name: string): VarInfo | undefined {
    for (let i = ctx.scopes.length - 1; i >= 0; i--) {
      const v = ctx.scopes[i].get(name);
      if (v) return v;
    }
    return undefined;
  }

  private declareLocal(ctx: FnCtx, name: string, mqlType: string, isArray = false): VarInfo {
    const scope = ctx.scopes[ctx.scopes.length - 1];
    let pine = this.pineName(name);
    // At Pine global scope, OnTick locals must not clash with globals or other names.
    if (ctx.topLevel && (this.globals.has(name) || this.functions.has(name) || this.lookup(ctx, name))) {
      pine = this.uniqueName(pine + "_");
    } else if (ctx.topLevel) {
      // Locals of OnTick become Pine globals; keep a registry so later helpers do not clash.
      if (this.usedNames.has(pine) && !this.lookup(ctx, name)) pine = this.uniqueName(pine);
      else this.usedNames.add(pine);
    }
    const info: VarInfo = {
      pine,
      type: toPType(pineType(mqlType) ?? (this.enumTypes.has(mqlType) ? "int" : "unknown")),
      mqlType,
      isGlobal: false,
      isInput: false,
      isArray,
    };
    scope.set(name, info);
    return info;
  }

  // -------------------------------------------------------------------------
  // Inputs

  private emitInput(d: VarDecl, out: Out) {
    for (const dec of d.declarators) {
      const name = this.pineName(dec.name);
      const label = this.inputLabel(d.line, dec.name);
      const t = d.varType;
      const init = dec.init;
      const ctx = this.newCtx("#input", false, "unknown", true);
      const info: VarInfo = { pine: name, type: "unknown", mqlType: t, isGlobal: true, isInput: true, isArray: false };

      if (t === "ENUM_TIMEFRAMES") {
        const v = init?.type === "Ident" ? init.name : "PERIOD_CURRENT";
        const tf = TIMEFRAMES[v] ?? "";
        out.emit(`${name} = input.timeframe(${JSON.stringify(tf)}, ${JSON.stringify(label)})`);
        info.type = "string";
        this.inputNames.set(dec.name, { kind: "timeframe" });
      } else if (t === "ENUM_APPLIED_PRICE") {
        const v = init?.type === "Ident" ? init.name : "PRICE_CLOSE";
        out.emit(`${name} = input.source(${APPLIED_PRICE[v] ?? "close"}, ${JSON.stringify(label)})`);
        info.type = "float";
        this.inputNames.set(dec.name, { kind: "price" });
      } else if (t === "ENUM_MA_METHOD") {
        const v = init?.type === "Ident" && init.name in MA_METHOD ? init.name : "MODE_SMA";
        const options = Object.keys(MA_METHOD);
        out.emit(`${name}_str = input.string(${JSON.stringify(v)}, ${JSON.stringify(label)}, options = ${JSON.stringify(options).replace(/,/g, ", ")})`);
        out.emit(`${name} = ${this.enumSwitch(`${name}_str`, options.map((o) => [o, MA_METHOD_VALUES[o]]))}`);
        info.type = "int";
        this.inputNames.set(dec.name, { kind: "maMethod" });
      } else if (this.enumTypes.has(t)) {
        const en = this.enumTypes.get(t)!;
        const options = en.members.map((m) => m.name);
        const v = init?.type === "Ident" ? init.name : options[0];
        out.emit(`${name}_str = input.string(${JSON.stringify(v)}, ${JSON.stringify(label)}, options = ${JSON.stringify(options).replace(/,/g, ", ")})`);
        out.emit(`${name} = ${this.enumSwitch(`${name}_str`, options.map((o) => [o, this.enumValues.get(o)!]))}`);
        info.type = "int";
        this.inputNames.set(dec.name, { kind: "enum" });
      } else if (t.startsWith("ENUM_")) {
        const v = init ? this.expr(init, ctx).code : "0";
        out.emit(`${name} = input.int(${v}, ${JSON.stringify(label)})`);
        info.type = "int";
        this.issue(d.line, "warning", `Input ${dec.name} uses ${t}; it became a number input. Check its values.`);
        this.inputNames.set(dec.name, { kind: "plain" });
      } else {
        const pt = pineType(t);
        const v = init ? this.expr(init, ctx) : null;
        switch (pt) {
          case "int":
            if (t === "datetime") {
              out.emit(`${name} = input.time(${v ? v.code : "0"}, ${JSON.stringify(label)})`);
            } else {
              out.emit(`${name} = input.int(${v ? v.code : "0"}, ${JSON.stringify(label)})`);
            }
            info.type = "int";
            break;
          case "float":
            out.emit(`${name} = input.float(${v ? asFloatLiteral(v.code) : "0.0"}, ${JSON.stringify(label)})`);
            info.type = "float";
            break;
          case "bool":
            out.emit(`${name} = input.bool(${v ? v.code : "false"}, ${JSON.stringify(label)})`);
            info.type = "bool";
            break;
          case "string":
            out.emit(`${name} = input.string(${v ? v.code : '""'}, ${JSON.stringify(label)})`);
            info.type = "string";
            break;
          case "color":
            out.emit(`${name} = input.color(${v ? v.code : "color.blue"}, ${JSON.stringify(label)})`);
            info.type = "color";
            break;
          default:
            this.issue(d.line, "error", `Input ${dec.name} has unsupported type ${t}.`);
        }
        this.inputNames.set(dec.name, { kind: "plain" });
      }
      this.globals.set(dec.name, info);
    }
  }

  private enumSwitch(strVar: string, pairs: [string, number][]): string {
    // a == "X" ? 0 : a == "Y" ? 1 : ...
    let code = String(pairs[pairs.length - 1][1]);
    for (let i = pairs.length - 2; i >= 0; i--) {
      code = `${strVar} == ${JSON.stringify(pairs[i][0])} ? ${pairs[i][1]} : ${code}`;
    }
    return code;
  }

  private inputLabel(line: number, name: string): string {
    const text = this.srcLines[line - 1] ?? "";
    const m = text.match(/\/\/\s*(.+?)\s*$/);
    if (m && text.includes(name)) return m[1].slice(0, 80);
    return name;
  }

  // -------------------------------------------------------------------------
  // Globals

  private emitGlobalVar(d: VarDecl, out: Out, ctx: FnCtx) {
    const t = d.varType;
    for (const dec of d.declarators) {
      // Indicator handles and trade objects do not exist in Pine.
      if (this.handles.has(dec.name)) continue;
      if (["CTrade", "CPositionInfo", "CSymbolInfo", "COrderInfo", "CAccountInfo", "MqlTick", "MqlTradeRequest", "MqlTradeResult"].includes(t)) {
        this.globals.set(dec.name, { pine: dec.name, type: "unknown", mqlType: t, isGlobal: true, isInput: false, isArray: false });
        continue;
      }
      if (t === "MqlDateTime") {
        this.globals.set(dec.name, { pine: dec.name, type: "unknown", mqlType: t, isGlobal: true, isInput: false, isArray: false });
        continue;
      }
      if (dec.isArray) {
        if (this.bindings.has(dec.name)) {
          this.globals.set(dec.name, { pine: dec.name, type: "float", mqlType: t, isGlobal: true, isInput: false, isArray: true });
          continue;
        }
        this.issue(d.line, "error", `Global array ${dec.name} is not supported yet (only arrays filled by CopyBuffer/CopyClose/... are).`);
        this.globals.set(dec.name, { pine: dec.name, type: "unknown", mqlType: t, isGlobal: true, isInput: false, isArray: true });
        continue;
      }
      if (t === "MqlRates") {
        this.issue(d.line, "error", `Global MqlRates ${dec.name} is not supported.`);
        continue;
      }
      const pt = pineType(t) ?? (this.enumTypes.has(t) ? "int" : null);
      if (!pt) {
        this.issue(d.line, "error", `Global ${dec.name} has unsupported type ${t}.`);
        continue;
      }
      const pine = this.pineName(dec.name);
      const info: VarInfo = { pine, type: toPType(pt), mqlType: t, isGlobal: true, isInput: false, isArray: false };
      let init = defaultValue(pt);
      if (dec.init) init = this.coerce(this.expr(dec.init, ctx), toPType(pt)).code;
      const isConst = d.modifiers.includes("const");
      this.globals.set(dec.name, info);
      out.emit(isConst ? `${pt} ${pine} = ${init}` : `var ${pt} ${pine} = ${init}`);
    }
  }

  // -------------------------------------------------------------------------
  // OnInit: runs on the first bar

  private emitOnInit(fn: FuncDecl, out: Out) {
    const ctx = this.newCtx("OnInit", false, "unknown", true);
    ctx.scopes.push(new Map());
    const kept: Stmt[] = [];
    for (const s of fn.body.body) {
      if (this.isInitNoise(s)) continue;
      kept.push(s);
    }
    if (kept.length === 0) return;
    const inner = new Out(out.indent + 1);
    ctx.topLevel = false;
    this.initMode = true;
    try {
      if (this.needsFlag(kept)) {
        ctx.flag = { done: "init_done", ret: null };
        inner.emit("bool init_done = false");
      }
      this.emitStmtList(kept, inner, ctx);
    } finally {
      this.initMode = false;
    }
    if (inner.lines.length === 0) return;
    out.emit("// OnInit()");
    out.emit("if barstate.isfirst");
    out.lines.push(...inner.lines);
  }
  private initMode = false;

  private isInitNoise(s: Stmt): boolean {
    if (s.type === "Empty") return true;
    if (s.type === "Return") return true;
    if (s.type === "ExprStmt") {
      const e = s.expr;
      if (e.type === "Assign" && e.target.type === "Ident" && this.handles.has(e.target.name)) return true;
      if (e.type === "Call") {
        if (e.callee.type === "Member" && TRADE_METHODS_IGNORED.has(e.callee.property)) return true;
        if (e.callee.type === "Ident" && ["ArraySetAsSeries", "EventSetTimer", "ChartIndicatorAdd", "Print", "Comment"].includes(e.callee.name)) {
          return e.callee.name !== "Print";
        }
      }
    }
    // if(handle == INVALID_HANDLE) { ...; return INIT_FAILED; }
    if (s.type === "If") {
      let mentionsHandle = false;
      walkExpr(s.test, (x) => {
        if (x.type === "Ident" && (this.handles.has(x.name) || x.name === "INVALID_HANDLE")) mentionsHandle = true;
      });
      if (mentionsHandle) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // User functions

  private emitFunction(fn: FuncDecl, out: Out) {
    const rt = fn.returnType === "void" ? "unknown" : toPType(pineType(fn.returnType) ?? "unknown");
    const ctx = this.newCtx(fn.name, fn.returnType !== "void", rt, false);
    const scope = new Map<string, VarInfo>();
    ctx.scopes.push(scope);
    const params: string[] = [];
    for (const p of fn.params) {
      if (p.isRef || p.isArray) {
        this.issue(fn.line, "error", `Parameter ${p.name} of ${fn.name}() is passed by reference or is an array; Pine does not support that.`);
      }
      const pt = pineType(p.varType) ?? (this.enumTypes.has(p.varType) ? "int" : null);
      const pine = this.pineName(p.name);
      scope.set(p.name, { pine, type: toPType(pt ?? "unknown"), mqlType: p.varType, isGlobal: false, isInput: false, isArray: false });
      let decl = pt ? `${pt} ${pine}` : pine;
      if (p.defaultValue) decl += ` = ${this.expr(p.defaultValue, ctx).code}`;
      params.push(decl);
    }
    const inner = new Out(out.indent + 1);
    if (this.needsFlag(fn.body.body)) {
      ctx.flag = { done: "done_", ret: ctx.valueFn ? "result_" : null };
      if (ctx.flag.ret) inner.emit(`${pineType(fn.returnType) ?? "float"} ${ctx.flag.ret} = ${defaultValue(pineType(fn.returnType) ?? "float")}`);
      inner.emit(`bool ${ctx.flag.done} = false`);
      this.emitStmtList(fn.body.body, inner, ctx);
      if (ctx.flag.ret) inner.emit(ctx.flag.ret);
    } else {
      this.emitStmtList(fn.body.body, inner, ctx);
    }
    if (inner.lines.length === 0) inner.emit(ctx.valueFn ? defaultValue(pineType(fn.returnType) ?? "float") : "na");
    if (!ctx.valueFn) {
      // Make sure void functions do not accidentally return a value of mixed type.
      const last = inner.lines[inner.lines.length - 1];
      if (!/^\s+(if|for|while|else)\b/.test(last)) {
        // fine as is
      }
    }
    if (out.lines.length > 0) out.emit("");
    out.emit(`${this.pineName(fn.name)}(${params.join(", ")}) =>`);
    out.lines.push(...inner.lines);
  }

  // -------------------------------------------------------------------------
  // Statements

  /** True when returns are not just at the end of lists / if-branches. */
  private needsFlag(stmts: Stmt[]): boolean {
    const ok = (list: Stmt[]): boolean => {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (s.type === "Return") {
          if (i !== list.length - 1) return false;
        } else if (s.type === "If") {
          if (!ok(asList(s.then)) || (s.else && !ok(asList(s.else)))) return false;
        } else if (s.type === "Block") {
          if (!ok(s.body)) return false;
          if (containsReturn(s) && i !== list.length - 1 && !endsWithReturn(s.body)) return false;
        } else if (containsReturn(s)) {
          return false; // return inside loop or switch
        }
      }
      return true;
    };
    return !ok(stmts);
  }

  private emitStmtList(stmts: Stmt[], out: Out, ctx: FnCtx) {
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      const rest = stmts.slice(i + 1);

      if (ctx.flag) {
        if (this.emitAndWrap(s, rest, out, ctx)) return;
        continue;
      }

      // Simple mode: returns only at the end of lists or if-branches.
      if (s.type === "Return") {
        if (ctx.valueFn && s.value) {
          const v = this.withHoist(ctx, out, () => this.coerce(this.expr(s.value!, ctx), ctx.returnType));
          out.emit(v.code);
        } else if (s.value && !ctx.valueFn && this.initMode) {
          const failed = this.constNumber(s.value);
          if (failed !== null && failed !== 0) out.emit(`runtime.error("OnInit failed")`);
        }
        return;
      }
      if (s.type === "If" && (containsReturn(s.then) || (s.else && containsReturn(s.else)))) {
        const thenList = asList(s.then);
        const elseList = s.else ? asList(s.else) : [];
        const thenRet = endsWithReturn(thenList);
        const elseRet = endsWithReturn(elseList);
        const newThen = thenRet ? thenList : thenList.concat(rest);
        const newElse = elseRet ? elseList : elseList.concat(rest);
        const test = this.withHoist(ctx, out, () => this.cond(s.test, ctx));
        if (test.code === "true" || test.code === "false") {
          this.emitStmtList(test.code === "true" ? newThen : newElse, out, ctx);
          return;
        }
        const thenBody = this.subList(newThen, out, ctx);
        const elseBody = this.subList(newElse, out, ctx);
        if (thenBody.length === 0 && elseBody.length === 0) return;
        if (thenBody.length === 0 && !ctx.valueFn) {
          out.emit(`if ${negate(test)}`);
          out.lines.push(...elseBody);
          return;
        }
        out.emit(`if ${test.code}`);
        out.lines.push(...(thenBody.length ? thenBody : ["    ".repeat(out.indent + 1) + (ctx.valueFn ? defaultValue(pineTypeOf(ctx.returnType)) : "na")]));
        if (elseBody.length) {
          out.emit("else");
          out.lines.push(...elseBody);
        }
        return;
      }
      if (this.emitAndWrap(s, rest, out, ctx)) return;
    }
  }

  /**
   * Emit one statement. If it may set an exit flag (return / switch break), the remaining
   * statements are wrapped in `if not flag`. Returns true when `rest` was consumed.
   */
  private emitAndWrap(s: Stmt, rest: Stmt[], out: Out, ctx: FnCtx): boolean {
    const before = out.lines.length;
    this.emitStmt(s, out, ctx);
    if (s.type === "Return" || s.type === "Break" || s.type === "Continue") return true; // rest unreachable
    if (rest.length === 0) return false;
    const flags = [ctx.flag?.done, ...ctx.switchFlags.map((f) => f.name)].filter((f): f is string => !!f);
    const added = out.lines.slice(before);
    const set = flags.filter((f) => added.some((l) => l.trimStart().startsWith(`${f} := true`)));
    if (set.length === 0) return false;
    out.emit(set.length === 1 ? `if not ${set[0]}` : `if not (${set.join(" or ")})`);
    out.push(() => this.emitStmtList(rest, out, ctx));
    return true;
  }

  private subList(stmts: Stmt[], out: Out, ctx: FnCtx): string[] {
    const sub = new Out(out.indent + 1);
    ctx.scopes.push(new Map());
    try {
      this.emitStmtList(stmts, sub, ctx);
    } finally {
      ctx.scopes.pop();
    }
    return sub.lines;
  }

  private withHoist<T>(ctx: FnCtx, out: Out, fn: () => T): T {
    const prevPre = ctx.pre;
    const prevOk = ctx.hoistOk;
    ctx.pre = [];
    ctx.hoistOk = true;
    try {
      const v = fn();
      for (const l of ctx.pre) out.emit(l);
      return v;
    } finally {
      ctx.pre = prevPre;
      ctx.hoistOk = prevOk;
    }
  }

  private emitStmt(s: Stmt, out: Out, ctx: FnCtx) {
    switch (s.type) {
      case "Empty":
        return;
      case "Block": {
        // Pine has no bare blocks; inline the statements (scoping is kept by our renaming).
        ctx.scopes.push(new Map());
        try {
          this.emitStmtList(s.body, out, ctx);
        } finally {
          ctx.scopes.pop();
        }
        return;
      }
      case "VarDecl":
        this.emitLocalDecl(s, out, ctx);
        return;
      case "ExprStmt":
        this.emitExprStmt(s.expr, out, ctx, s.line);
        return;
      case "If": {
        const test = this.withHoist(ctx, out, () => this.cond(s.test, ctx));
        if (test.code === "true" || test.code === "false") {
          const branch = test.code === "true" ? s.then : s.else;
          if (branch) this.emitStmt(branch.type === "Block" ? branch : { type: "Block", body: [branch], line: s.line }, out, ctx);
          return;
        }
        const thenBody = this.subList(asList(s.then), out, ctx);
        const elseBody = s.else ? this.subList(asList(s.else), out, ctx) : [];
        if (thenBody.length === 0 && elseBody.length === 0) return;
        if (thenBody.length === 0) {
          out.emit(`if ${negate(test)}`);
          out.lines.push(...elseBody);
          return;
        }
        out.emit(`if ${test.code}`);
        out.lines.push(...thenBody);
        if (elseBody.length) {
          // else-if chains read better flattened
          const firstElse = elseBody[0].trimStart();
          if (elseBody.length > 0 && firstElse.startsWith("if ") && s.else?.type === "If" && isSingleIfChain(elseBody, out.indent + 1)) {
            out.emit("else " + firstElse);
            out.lines.push(...elseBody.slice(1).map((l) => l.slice(4)));
          } else {
            out.emit("else");
            out.lines.push(...elseBody);
          }
        }
        return;
      }
      case "Return": {
        if (!ctx.flag) return; // handled by emitStmtList in simple mode
        if (s.value && ctx.flag.ret) {
          const v = this.withHoist(ctx, out, () => this.coerce(this.expr(s.value!, ctx), ctx.returnType));
          out.emit(`${ctx.flag.ret} := ${v.code}`);
        } else if (s.value && this.initMode) {
          const failed = this.constNumber(s.value);
          if (failed !== null && failed !== 0) out.emit(`runtime.error("OnInit failed")`);
        }
        out.emit(`${ctx.flag.done} := true`);
        if (ctx.loopDepth > 0) out.emit("break");
        return;
      }
      case "Break": {
        const sw = ctx.switchFlags[ctx.switchFlags.length - 1];
        if (sw && sw.depth === ctx.loopDepth) out.emit(`${sw.name} := true`);
        else out.emit("break");
        return;
      }
      case "Continue":
        out.emit("continue");
        return;
      case "For":
        this.emitFor(s, out, ctx);
        return;
      case "While": {
        const test = this.cond(s.test, ctx);
        out.emit(`while ${test.code}`);
        this.loopBody(s.body, out, ctx, []);
        this.afterLoop(s.body, out, ctx);
        return;
      }
      case "DoWhile": {
        out.emit("while true");
        const test = this.cond(s.test, ctx);
        this.loopBody(s.body, out, ctx, [`if ${negate(test)}`, "    break"]);
        this.afterLoop(s.body, out, ctx);
        if (containsContinue(s.body)) this.issue(s.line, "warning", "'continue' inside do-while skips the loop test in the converted code.");
        return;
      }
      case "Switch":
        this.emitSwitch(s, out, ctx);
        return;
    }
  }

  private loopBody(body: Stmt, out: Out, ctx: FnCtx, tail: string[]) {
    ctx.loopDepth++;
    const lines = this.subList(asList(body), out, ctx);
    ctx.loopDepth--;
    if (lines.length === 0 && tail.length === 0) lines.push("    ".repeat(out.indent + 1) + "na");
    out.lines.push(...lines);
    for (const t of tail) out.lines.push("    ".repeat(out.indent + 1) + t);
  }

  private afterLoop(body: Stmt, out: Out, ctx: FnCtx) {
    if (ctx.flag && containsReturn(body) && ctx.loopDepth > 0) {
      out.emit(`if ${ctx.flag.done}`);
      out.emit("    break");
    }
  }

  private emitFor(s: Stmt & { type: "For" }, out: Out, ctx: FnCtx) {
    // Try to turn `for(i = a; i < b; i++)` into `for i = a to b - 1`.
    ctx.scopes.push(new Map());
    try {
      const simple = this.simpleFor(s, ctx);
      if (simple) {
        const { varName, from, to, step } = simple;
        const header = `for ${varName} = ${from.code} to ${to}${step === 1 ? "" : ` by ${step}`}`;
        const constBounds = /^-?\d+$/.test(from.code) && /^-?\d+$/.test(to);
        if (constBounds) {
          const a = Number(from.code);
          const b = Number(to);
          if ((step > 0 && a > b) || (step < 0 && a < b)) return; // loop never runs
          out.emit(header);
          this.loopBody(s.body, out, ctx, []);
          this.afterLoop(s.body, out, ctx);
        } else {
          // Pine counts down automatically when from > to; guard so empty loops stay empty.
          out.emit(`if ${from.code} ${step > 0 ? "<=" : ">="} ${to}`);
          out.push(() => {
            out.emit(header);
            this.loopBody(s.body, out, ctx, []);
            this.afterLoop(s.body, out, ctx);
          });
        }
        return;
      }
      // General form -> while loop
      if (s.init) this.emitStmt(s.init, out, ctx);
      if (containsContinue(s.body) && s.update.length > 0) {
        this.issue(s.line, "error", "This for-loop uses 'continue' with a complex header; rewrite it as a simple counting loop.");
      }
      const test = s.test ? this.cond(s.test, ctx) : { code: "true", prec: PREC.atom, type: "bool" as PType };
      out.emit(`while ${test.code}`);
      const tail: string[] = [];
      for (const u of s.update) {
        const tmp = new Out(0);
        this.emitExprStmt(u, tmp, ctx, s.line);
        tail.push(...tmp.lines);
      }
      this.loopBody(s.body, out, ctx, tail);
      this.afterLoop(s.body, out, ctx);
    } finally {
      ctx.scopes.pop();
    }
  }

  private simpleFor(
    s: Stmt & { type: "For" },
    ctx: FnCtx,
  ): { varName: string; from: Code; to: string; step: number } | null {
    let name: string | null = null;
    let fromExpr: Expr | null = null;
    if (s.init?.type === "VarDecl" && s.init.declarators.length === 1 && s.init.declarators[0].init) {
      name = s.init.declarators[0].name;
      fromExpr = s.init.declarators[0].init;
    } else if (s.init?.type === "ExprStmt" && s.init.expr.type === "Assign" && s.init.expr.op === "=" && s.init.expr.target.type === "Ident") {
      name = s.init.expr.target.name;
      fromExpr = s.init.expr.value;
    }
    if (!name || !fromExpr || !s.test || s.update.length !== 1) return null;
    const u = s.update[0];
    let step = 0;
    if (u.type === "Unary" && u.arg.type === "Ident" && u.arg.name === name) step = u.op === "++" ? 1 : u.op === "--" ? -1 : 0;
    if (u.type === "Assign" && u.target.type === "Ident" && u.target.name === name && (u.op === "+=" || u.op === "-=")) {
      const n = this.constNumber(u.value);
      if (n !== null && Number.isInteger(n) && n > 0) step = u.op === "+=" ? n : -n;
    }
    if (step === 0) return null;
    const t = s.test;
    if (t.type !== "Binary" || t.left.type !== "Ident" || t.left.name !== name) return null;
    // Loop variable must not be assigned in the body.
    let assigned = false;
    walkStmt(s.body, () => {}, (e) =>
      walkExpr(e, (x) => {
        const target = x.type === "Assign" ? x.target : x.type === "Unary" && (x.op === "++" || x.op === "--") ? x.arg : null;
        if (target?.type === "Ident" && target.name === name) assigned = true;
      }),
    );
    if (assigned) return null;
    const from = this.coerce(this.expr(fromExpr, ctx), "int");
    const bound = this.expr(t.right, ctx);
    let to: string;
    const boundNum = /^-?\d+$/.test(bound.code) ? Number(bound.code) : null;
    const adj = (delta: number) =>
      boundNum !== null ? String(boundNum + delta) : delta === 0 ? bound.code : `${paren(bound, PREC.add)} ${delta > 0 ? "+" : "-"} ${Math.abs(delta)}`;
    if (step > 0 && t.op === "<") to = adj(-1);
    else if (step > 0 && t.op === "<=") to = adj(0);
    else if (step < 0 && t.op === ">") to = adj(1);
    else if (step < 0 && t.op === ">=") to = adj(0);
    else return null;
    if (Math.abs(step) !== 1 && (t.op === "<" || t.op === ">")) {
      // with larger steps the inclusive bound still works because Pine stops before passing `to`
    }
    const info = this.declareLocal(ctx, name, "int");
    // The counter is declared by the for statement itself; keep the plain name when possible.
    return { varName: info.pine, from, to, step };
  }

  private emitSwitch(s: Stmt & { type: "Switch" }, out: Out, ctx: FnCtx) {
    const subject = this.expr(s.test, ctx);
    // Each group: the case labels that share a body (`case 1: case 2: ...`).
    const groups: { tests: (Expr | null)[]; body: Stmt[] }[] = [];
    let pending: (Expr | null)[] = [];
    for (const c of s.cases) {
      pending.push(c.test);
      if (c.body.length === 0) continue;
      groups.push({ tests: pending, body: c.body });
      pending = [];
    }
    if (pending.length) groups.push({ tests: pending, body: [] });

    // C falls through to the next case unless the body ends with break/return.
    const ends = (body: Stmt[]) => {
      const last = body[body.length - 1];
      return !!last && (last.type === "Break" || last.type === "Return" || endsWithReturn(body));
    };
    const bodies = groups.map((_, i) => {
      const full: Stmt[] = [];
      for (let j = i; j < groups.length; j++) {
        full.push(...groups[j].body);
        if (ends(groups[j].body)) break;
      }
      // A trailing break just ends the case.
      if (full[full.length - 1]?.type === "Break") full.pop();
      return full;
    });

    // A break that is not the last statement needs a flag to skip the rest of the case.
    let needsFlag = false;
    for (const b of bodies) for (const st of b) if (containsSwitchBreak(st)) needsFlag = true;
    let flag: { name: string; depth: number } | null = null;
    if (needsFlag) {
      flag = { name: this.uniqueName("case_done"), depth: ctx.loopDepth };
      out.emit(`bool ${flag.name} = false`);
      ctx.switchFlags.push(flag);
    } else {
      ctx.switchFlags.push({ name: "", depth: ctx.loopDepth }); // breaks here are terminal; never emitted
    }
    try {
      const subj = paren(subject, PREC.eq);
      let first = true;
      let defaultBody: Stmt[] | null = null;
      groups.forEach((g, i) => {
        if (g.tests.includes(null)) {
          defaultBody = bodies[i];
          return;
        }
        const cond = g.tests.map((t) => `${subj} == ${paren(this.expr(t!, ctx), PREC.eq)}`).join(" or ");
        const lines = this.subList(bodies[i], out, ctx);
        out.emit(`${first ? "if" : "else if"} ${cond}`);
        out.lines.push(...(lines.length ? lines : ["    ".repeat(out.indent + 1) + "na"]));
        first = false;
      });
      if (defaultBody) {
        if (first) {
          this.emitStmtList(defaultBody, out, ctx);
        } else {
          const lines = this.subList(defaultBody, out, ctx);
          if (lines.length) {
            out.emit("else");
            out.lines.push(...lines);
          }
        }
      }
    } finally {
      ctx.switchFlags.pop();
    }
  }

  private emitLocalDecl(s: VarDecl, out: Out, ctx: FnCtx) {
    const t = s.varType;
    const isStatic = s.modifiers.includes("static");
    for (const dec of s.declarators) {
      // Indicator handle created locally
      if (this.handles.has(dec.name) && dec.init && isIndicatorCall(dec.init)) {
        this.lookupOrDeclareHandle(ctx, dec.name);
        continue;
      }
      if (["CTrade", "CPositionInfo", "CSymbolInfo", "MqlTick", "MqlTradeRequest", "MqlTradeResult"].includes(t)) {
        const scope = ctx.scopes[ctx.scopes.length - 1];
        scope.set(dec.name, { pine: dec.name, type: "unknown", mqlType: t, isGlobal: false, isInput: false, isArray: false });
        continue;
      }
      if (t === "MqlDateTime") {
        const scope = ctx.scopes[ctx.scopes.length - 1];
        scope.set(dec.name, { pine: dec.name, type: "unknown", mqlType: t, isGlobal: false, isInput: false, isArray: false });
        continue;
      }
      if (dec.isArray || t === "MqlRates") {
        if (this.bindings.has(dec.name)) {
          const scope = ctx.scopes[ctx.scopes.length - 1];
          scope.set(dec.name, { pine: dec.name, type: "float", mqlType: t, isGlobal: false, isInput: false, isArray: true });
          continue;
        }
        if (dec.initList) {
          const info = this.declareLocal(ctx, dec.name, t, true);
          const items = dec.initList.map((e) => this.expr(e, ctx).code);
          const pt = pineType(t) ?? "float";
          out.emit(`${isStatic && !ctx.topLevel ? "var " : ""}array<${pt}> ${info.pine} = array.from(${items.join(", ")})`);
          info.type = "unknown";
          continue;
        }
        this.issue(s.line, "error", `Array ${dec.name} is not supported yet (only arrays filled by CopyBuffer/CopyClose/CopyRates are).`);
        const scope = ctx.scopes[ctx.scopes.length - 1];
        scope.set(dec.name, { pine: dec.name, type: "unknown", mqlType: t, isGlobal: false, isInput: false, isArray: true });
        continue;
      }
      const pt = pineType(t) ?? (this.enumTypes.has(t) ? "int" : null);
      if (!pt) {
        this.issue(s.line, "error", `Variable ${dec.name} has unsupported type ${t}.`);
        continue;
      }
      let init: string;
      if (dec.init) {
        init = this.withHoist(ctx, out, () => this.coerce(this.expr(dec.init!, ctx), toPType(pt)).code);
      } else {
        init = defaultValue(pt);
      }
      const info = this.declareLocal(ctx, dec.name, t);
      // static locals keep their value between calls -> Pine `var`
      const prefix = isStatic ? "var " : "";
      out.emit(`${prefix}${pt} ${info.pine} = ${init}`);
    }
  }

  private lookupOrDeclareHandle(ctx: FnCtx, name: string) {
    const scope = ctx.scopes[ctx.scopes.length - 1];
    scope.set(name, { pine: name, type: "int", mqlType: "int", isGlobal: false, isInput: false, isArray: false });
  }

  private emitExprStmt(e: Expr, out: Out, ctx: FnCtx, line: number) {
    // Handle creation: h = iMA(...)
    if (e.type === "Assign" && e.target.type === "Ident" && this.handles.has(e.target.name) && isIndicatorCall(e.value)) return;

    // ++ / --
    if (e.type === "Unary" && (e.op === "++" || e.op === "--")) {
      const target = this.lvalue(e.arg, ctx, line);
      if (target) out.emit(`${target} ${e.op === "++" ? "+=" : "-="} 1`);
      return;
    }

    if (e.type === "Assign") {
      if (e.target.type === "Member" && e.target.object.type === "Ident") {
        this.issue(line, "error", `Assigning to ${e.target.object.name}.${e.target.property} is not supported.`);
        return;
      }
      const target = this.lvalue(e.target, ctx, line);
      if (!target) return;
      const tinfo = e.target.type === "Ident" ? this.lookup(ctx, e.target.name) : undefined;
      if (tinfo?.isGlobal && !ctx.topLevel && !this.inlineDepth && ctx.name !== "OnInit") {
        // computeInlineFunctions should prevent this; keep a clear message just in case
        this.issue(line, "error", `Function ${ctx.name}() changes global ${e.target.type === "Ident" ? e.target.name : ""}; Pine does not allow that.`);
      }
      const value = this.withHoist(ctx, out, () => this.expr(e.value, ctx));
      const ttype = tinfo?.type ?? "unknown";
      if (e.op === "=") {
        out.emit(`${target} := ${this.coerce(value, ttype).code}`);
      } else if (["+=", "-=", "*=", "/="].includes(e.op)) {
        if (e.op === "/=" && ttype === "int") {
          out.emit(`${target} := int(${target} / ${paren(value, PREC.mul + 1)})`);
        } else if (e.op === "+=" && ttype === "string" && value.type !== "string") {
          out.emit(`${target} += str.tostring(${value.code})`);
        } else {
          out.emit(`${target} ${e.op} ${value.code}`);
        }
      } else if (e.op === "%=") {
        out.emit(`${target} := ${target} % ${paren(value, PREC.mul + 1)}`);
      } else {
        this.issue(line, "error", `Operator ${e.op} (bit operations) is not supported in Pine.`);
      }
      return;
    }

    if (e.type === "Call") {
      const handled = this.emitCallStatement(e, out, ctx, line);
      if (handled) return;
    }

    const prevOk = ctx.hoistOk;
    const v = this.withHoist(ctx, out, () => this.expr(e, ctx));
    ctx.hoistOk = prevOk;
    if (v.code && v.code !== "true" && v.code !== "na" && !/^-?\d+(\.\d+)?$/.test(v.code)) out.emit(v.code);
  }

  private inlineDepth = 0;

  /** Statement-level calls with side effects (trading, printing, inlined user functions). */
  private emitCallStatement(e: Expr & { type: "Call" }, out: Out, ctx: FnCtx, line: number): boolean {
    if (e.callee.type === "Ident") {
      const name = e.callee.name;
      if (this.inlineFns.has(name)) {
        this.emitInlineCall(this.functions.get(name)!, e.args, out, ctx, line);
        return true;
      }
      if (["ArraySetAsSeries", "ArrayFree", "ArrayResize", "IndicatorRelease", "ChartRedraw", "ResetLastError", "EventSetTimer", "EventKillTimer", "ArrayInitialize"].includes(name)) {
        if (["ArrayResize", "ArrayInitialize"].includes(name) && e.args[0]?.type === "Ident" && !this.bindings.has(e.args[0].name)) {
          this.issue(line, "error", `${name} on a plain array is not supported yet.`);
        }
        return true;
      }
      if (["CopyBuffer", "CopyClose", "CopyOpen", "CopyHigh", "CopyLow", "CopyTime", "CopyRates", "CopyTickVolume", "CopyRealVolume", "SymbolInfoTick", "TimeToStruct", "TimeCurrent"].includes(name)) {
        // The data is already available as a series; just evaluate side effects (TimeToStruct).
        this.expr(e, ctx);
        return true;
      }
      if (name === "Comment") {
        this.warnOnce("comment", line, "Comment() (text on the chart) was skipped.", "info");
        return true;
      }
      if (["ObjectCreate", "ObjectSetInteger", "ObjectSetDouble", "ObjectSetString", "ObjectDelete", "ObjectsDeleteAll", "ObjectMove", "PlaySound", "SendNotification", "SendMail"].includes(name)) {
        this.warnOnce("objects-" + name, line, `${name}() was skipped (chart objects and notifications are not converted).`, "info");
        return true;
      }
    }
    return false;
  }

  private emitInlineCall(fn: FuncDecl, args: Expr[], out: Out, ctx: FnCtx, line: number) {
    if (this.inlineDepth > 8) {
      this.issue(line, "error", `Too many nested calls while inlining ${fn.name}().`);
      return;
    }
    // A new scope via `if true` so repeated inlining never redeclares names.
    out.emit(`// ${fn.name}()`);
    out.emit("if true");
    const inner = new Out(out.indent + 1);
    const scope = new Map<string, VarInfo>();
    const savedFlag = ctx.flag;
    const savedValue = ctx.valueFn;
    const savedLoop = ctx.loopDepth;
    const savedTop = ctx.topLevel;
    // Evaluate arguments in the caller scope first.
    const argCodes = fn.params.map((p, i) => {
      const a = args[i] ?? p.defaultValue;
      if (!a) {
        this.issue(line, "error", `Missing argument ${p.name} for ${fn.name}().`);
        return { code: "na", prec: PREC.atom, type: "unknown" as PType };
      }
      return this.withHoist(ctx, inner, () => this.expr(a, ctx));
    });
    ctx.scopes.push(scope);
    this.inlineDepth++;
    ctx.topLevel = false;
    ctx.valueFn = false;
    ctx.loopDepth = 0;
    try {
      fn.params.forEach((p, i) => {
        if (p.isRef || p.isArray) this.issue(fn.line, "error", `Parameter ${p.name} of ${fn.name}() is passed by reference or is an array; Pine does not support that.`);
        const pt = pineType(p.varType) ?? (this.enumTypes.has(p.varType) ? "int" : "float");
        const pine = this.uniqueName(`${fn.name}_${p.name}`);
        scope.set(p.name, { pine, type: toPType(pt), mqlType: p.varType, isGlobal: false, isInput: false, isArray: false });
        inner.emit(`${pt} ${pine} = ${this.coerce(argCodes[i], toPType(pt)).code}`);
      });
      if (this.needsFlag(fn.body.body)) {
        ctx.flag = { done: this.uniqueName(`${fn.name}_done`), ret: null };
        inner.emit(`bool ${ctx.flag.done} = false`);
      } else {
        ctx.flag = null;
      }
      this.emitStmtList(fn.body.body, inner, ctx);
    } finally {
      ctx.scopes.pop();
      this.inlineDepth--;
      ctx.flag = savedFlag;
      ctx.valueFn = savedValue;
      ctx.loopDepth = savedLoop;
      ctx.topLevel = savedTop;
    }
    if (inner.lines.length === 0) inner.emit("na");
    out.lines.push(...inner.lines);
  }

  private lvalue(e: Expr, ctx: FnCtx, line: number): string | null {
    if (e.type === "Ident") {
      const v = this.lookup(ctx, e.name);
      if (!v) {
        this.issue(line, "error", `Unknown variable ${e.name}.`);
        return this.pineName(e.name);
      }
      if (v.isInput) {
        this.issue(line, "error", `Input ${e.name} is changed in code; Pine inputs cannot change.`);
      }
      if (v.isArray) {
        this.issue(line, "error", `Assigning to array ${e.name} is not supported.`);
      }
      return v.pine;
    }
    if (e.type === "Index") {
      this.issue(line, "error", "Writing into arrays is not supported yet.");
      return null;
    }
    this.issue(line, "error", "This assignment target is not supported.");
    return null;
  }

  // -------------------------------------------------------------------------
  // Expressions

  private cond(e: Expr, ctx: FnCtx): Code {
    const c = this.expr(e, ctx);
    return toBool(c);
  }

  private coerce(c: Code, target: PType): Code {
    if (target === "int" && (c.type === "float" || c.type === "unknown") && !/^-?\d+$/.test(c.code) && c.code !== "na") {
      if (c.type === "unknown") return c;
      return { code: `int(${c.code})`, prec: PREC.atom, type: "int" };
    }
    if (target === "bool" && (c.type === "int" || c.type === "float")) return toBool(c);
    if (target === "string" && c.type !== "string" && c.type !== "unknown") {
      return { code: `str.tostring(${c.code})`, prec: PREC.atom, type: "string" };
    }
    return c;
  }

  expr(e: Expr, ctx: FnCtx): Code {
    switch (e.type) {
      case "Number": {
        const raw = e.value.replace(/[fFlLuU]+$/, "");
        const v = /^0[xX]/.test(raw) ? String(parseInt(raw, 16)) : raw;
        const code = v.startsWith(".") ? "0" + v : v.endsWith(".") ? v + "0" : v;
        return { code, prec: PREC.atom, type: e.isFloat ? "float" : "int" };
      }
      case "String":
        return { code: JSON.stringify(e.value), prec: PREC.atom, type: "string" };
      case "Ident":
        return this.ident(e, ctx);
      case "Cast": {
        const inner = this.expr(e.expr, ctx);
        const pt = pineType(e.to);
        if (pt === "int") return { code: `int(${inner.code})`, prec: PREC.atom, type: "int" };
        if (pt === "float") return inner.type === "float" ? inner : { code: `float(${inner.code})`, prec: PREC.atom, type: "float" };
        if (pt === "string") return { code: `str.tostring(${inner.code})`, prec: PREC.atom, type: "string" };
        if (pt === "bool") return toBool(inner);
        return inner;
      }
      case "Unary": {
        if (e.op === "++" || e.op === "--") {
          this.issue(e.line, "error", `'${e.op}' inside an expression is not supported; put it on its own line.`);
          return this.expr(e.arg, ctx);
        }
        const a = this.expr(e.arg, ctx);
        if (e.op === "!") {
          const b = toBool(a);
          if (b.code === "true") return { code: "false", prec: PREC.atom, type: "bool" };
          if (b.code === "false") return { code: "true", prec: PREC.atom, type: "bool" };
          return { code: negate(b), prec: PREC.unary, type: "bool" };
        }
        if (e.op === "-") {
          if (/^\d/.test(a.code) && a.prec === PREC.atom) return { code: "-" + a.code, prec: PREC.atom, type: a.type };
          return { code: `-${paren(a, PREC.unary)}`, prec: PREC.unary, type: a.type };
        }
        if (e.op === "+") return a;
        this.issue(e.line, "error", `Operator ${e.op} (bit operations) is not supported in Pine.`);
        return a;
      }
      case "Binary":
        return this.binary(e, ctx);
      case "Ternary": {
        const [t, a, b] = this.noHoist(ctx, () => [this.cond(e.test, ctx), this.expr(e.then, ctx), this.expr(e.else, ctx)]);
        const type = a.type === b.type ? a.type : a.type === "float" || b.type === "float" ? "float" : "unknown";
        return {
          code: `${paren(t, PREC.ternary + 1)} ? ${paren(a, PREC.ternary + 1)} : ${paren(b, PREC.ternary)}`,
          prec: PREC.ternary,
          type,
        };
      }
      case "Assign":
        this.issue(e.line, "error", "Assignment inside an expression is not supported; put it on its own line.");
        return this.expr(e.value, ctx);
      case "Call":
        return this.call(e, ctx);
      case "Index":
        return this.index(e, ctx);
      case "Member":
        return this.member(e, ctx);
    }
  }

  /** Trade calls may only be hoisted out of a whole condition (or its negation). */
  private noHoist<T>(ctx: FnCtx, fn: () => T): T {
    const prev = ctx.hoistOk;
    ctx.hoistOk = false;
    try {
      return fn();
    } finally {
      ctx.hoistOk = prev;
    }
  }

  private binary(e: Expr & { type: "Binary" }, ctx: FnCtx): Code {
    return this.noHoist(ctx, () => this.binaryInner(e, ctx));
  }

  private binaryInner(e: Expr & { type: "Binary" }, ctx: FnCtx): Code {
    // PositionGetInteger(POSITION_MAGIC) == Magic: Pine strategies have one "magic number", so always true.
    if ((e.op === "==" || e.op === "!=") && (isMagicQuery(e.left) || isMagicQuery(e.right))) {
      return { code: e.op === "==" ? "true" : "false", prec: PREC.atom, type: "bool" };
    }
    // PositionGetString(POSITION_SYMBOL) == _Symbol: always the chart symbol.
    if ((e.op === "==" || e.op === "!=") && (isSymbolQuery(e.left) || isSymbolQuery(e.right)) && (isCurrentSymbol(e.left) || isCurrentSymbol(e.right))) {
      return { code: e.op === "==" ? "true" : "false", prec: PREC.atom, type: "bool" };
    }
    // PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY -> f_pos() > 0
    if (e.op === "==" || e.op === "!=") {
      const [q, k] = isPosTypeQuery(e.left) ? [e.left, e.right] : isPosTypeQuery(e.right) ? [e.right, e.left] : [null, null];
      if (q && k) {
        const kv = this.constNumber(k);
        if (kv === 0 || kv === 1) {
          const isBuy = (kv === 0) === (e.op === "==");
          return { code: isBuy ? "f_pos() > 0" : "f_pos() < 0", prec: PREC.cmp, type: "bool" };
        }
      }
    }
    const map = C_TO_PINE_OP[e.op];
    if (!map) {
      this.issue(e.line, "error", `Operator ${e.op} (bit operations) is not supported in Pine.`);
      return this.expr(e.left, ctx);
    }
    let l = this.expr(e.left, ctx);
    let r = this.expr(e.right, ctx);
    if (e.op === "&&" || e.op === "||") {
      l = toBool(l);
      r = toBool(r);
      // simple folding
      if (e.op === "&&") {
        if (l.code === "false" || r.code === "false") return { code: "false", prec: PREC.atom, type: "bool" };
        if (l.code === "true") return r;
        if (r.code === "true") return l;
      } else {
        if (l.code === "true" || r.code === "true") return { code: "true", prec: PREC.atom, type: "bool" };
        if (l.code === "false") return r;
        if (r.code === "false") return l;
      }
    }
    let type: PType = "unknown";
    if (["==", "!=", "<", ">", "<=", ">=", "&&", "||"].includes(e.op)) type = "bool";
    else if (e.op === "+" && (l.type === "string" || r.type === "string")) {
      type = "string";
      if (l.type !== "string") l = { code: `str.tostring(${l.code})`, prec: PREC.atom, type: "string" };
      if (r.type !== "string") r = { code: `str.tostring(${r.code})`, prec: PREC.atom, type: "string" };
    } else if (l.type === "float" || r.type === "float") type = "float";
    else if (l.type === "int" && r.type === "int") type = "int";

    const ln = /^-?\d+(\.\d+)?$/.test(l.code) ? Number(l.code) : null;
    const rn = /^-?\d+(\.\d+)?$/.test(r.code) ? Number(r.code) : null;
    if (ln !== null && rn !== null && type === "bool") {
      const res =
        e.op === "==" ? ln === rn : e.op === "!=" ? ln !== rn : e.op === "<" ? ln < rn : e.op === ">" ? ln > rn : e.op === "<=" ? ln <= rn : ln >= rn;
      return { code: String(res), prec: PREC.atom, type: "bool" };
    }
    const code = `${paren(l, map.prec)} ${map.op} ${paren(r, map.prec + 1)}`;
    if (e.op === "/" && l.type === "int" && r.type === "int") {
      // MQL integer division truncates; Pine always returns a float.
      return { code: `int(${code})`, prec: PREC.atom, type: "int" };
    }
    return { code, prec: map.prec, type };
  }

  private ident(e: Expr & { type: "Ident" }, ctx: FnCtx): Code {
    const name = e.name;
    const v = this.lookup(ctx, name);
    if (v) {
      if (this.handles.has(name) && !v.isInput && v.type === "int" && v.mqlType === "int" && !this.globals.get(name)) {
        return { code: "1", prec: PREC.atom, type: "int" };
      }
      return { code: v.pine, prec: PREC.atom, type: v.type };
    }
    if (this.handles.has(name)) return { code: "1", prec: PREC.atom, type: "int" }; // valid handle
    if (this.enumValues.has(name)) return { code: String(this.enumValues.get(name)), prec: PREC.atom, type: "int" };
    const def = this.defines.get(name);
    if (def) return this.expr(def, ctx);
    if (name === "true" || name === "false") return { code: name, prec: PREC.atom, type: "bool" };
    if (name === "NULL" || name === "EMPTY_VALUE") return { code: "na", prec: PREC.atom, type: "unknown" };
    if (name === "_Symbol") return { code: "syminfo.ticker", prec: PREC.atom, type: "string" };
    if (name === "_Period") return { code: "timeframe.period", prec: PREC.atom, type: "string" };
    if (name === "_Point" || name === "Point") return { code: "syminfo.mintick", prec: PREC.atom, type: "float" };
    if (name === "_Digits" || name === "Digits") return { code: "math.round(-math.log10(syminfo.mintick))", prec: PREC.atom, type: "int" };
    if (name === "Bid" || name === "Ask") {
      this.askBidWarning(e.line);
      return { code: "close", prec: PREC.atom, type: "float" };
    }
    if (name in TIMEFRAMES) return { code: JSON.stringify(TIMEFRAMES[name]), prec: PREC.atom, type: "string" };
    if (name in APPLIED_PRICE && !(name in NUMERIC_CONSTANTS)) return { code: APPLIED_PRICE[name], prec: PREC.atom, type: "float" };
    if (name in NUMERIC_CONSTANTS) {
      const c = NUMERIC_CONSTANTS[name];
      return { code: c, prec: c.startsWith("-") ? PREC.unary : PREC.atom, type: /[.e]/.test(c) || c.startsWith("math.") ? "float" : "int" };
    }
    if (name in COLORS) return { code: COLORS[name], prec: PREC.atom, type: "color" };
    if (/^clr[A-Z]/.test(name)) return { code: "color.gray", prec: PREC.atom, type: "color" };
    if (name in MQL4_SERIES) {
      this.issue(e.line, "error", `${name}[] is MQL4 style; index it like ${name}[1].`);
      return { code: MQL4_SERIES[name], prec: PREC.atom, type: "float" };
    }
    this.issue(e.line, "error", `Unknown name ${name}.`);
    return { code: this.pineName(name), prec: PREC.atom, type: "unknown" };
  }

  private askBidWarning(line: number) {
    this.warnOnce(
      "askbid",
      line,
      "Ask/Bid prices were replaced by the bar's close price (Pine backtests have no spread). Add spread manually if your EA depends on it.",
    );
  }

  private seriesRef(base: string, index: Code | number, line: number, offset = 0): Code {
    // base[index] with bar alignment shift. Bar *time* is only used for new-bar checks,
    // so it is not counted and is clamped at 0.
    const isTime = base === "time" || base.startsWith("time_");
    if (!isTime) this.seriesAccessCount++;
    let idxCode: string;
    let n: number | null = null;
    if (typeof index === "number") n = index;
    else if (/^\d+$/.test(index.code)) n = Number(index.code);
    if (n !== null) {
      n += offset;
      if (!isTime) this.minSeriesIndex = Math.min(this.minSeriesIndex, n);
      n -= this.barShift;
      if (n < 0) {
        if (!isTime) this.issue(line, "error", "Bar index became negative after alignment.");
        n = 0;
      }
      idxCode = String(n);
    } else {
      if (!isTime) this.nonConstSeriesIndex = true;
      const ic = index as Code;
      const total = offset - this.barShift;
      idxCode = total === 0 ? ic.code : `${paren(ic, PREC.add)} ${total > 0 ? "+" : "-"} ${Math.abs(total)}`;
    }
    if (idxCode === "0") return { code: base, prec: /^[\w.]+$/.test(base) ? PREC.atom : PREC.postfix, type: base === "time" ? "int" : "float" };
    const b = /^[\w.]+$/.test(base) ? base : `(${base})`;
    return { code: `${b}[${idxCode}]`, prec: PREC.postfix, type: base === "time" ? "int" : "float" };
  }

  private index(e: Expr & { type: "Index" }, ctx: FnCtx): Code {
    // Bound arrays (CopyBuffer / CopyClose / CopyRates)
    if (e.object.type === "Ident") {
      const name = e.object.name;
      const b = this.bindings.get(name);
      const local = this.lookup(ctx, name);
      if (b && (!local || local.isArray)) {
        if (b.kind === "rates") {
          this.issue(e.line, "error", `Use ${name}[i].close (or .open/.high/.low/.time) for MqlRates arrays.`);
          return { code: "close", prec: PREC.atom, type: "float" };
        }
        const base = b.kind === "buffer" ? this.bufferSeries(b.handle!, b.buffer!, e.line) : this.priceSeries(b, ctx, e.line);
        return this.boundAccess(name, b, base, e.index, ctx, e.line);
      }
      if (name in MQL4_SERIES && !local) {
        return this.seriesRef(MQL4_SERIES[name], this.expr(e.index, ctx), e.line);
      }
      if (local && !local.isArray && local.type !== "unknown") {
        this.issue(e.line, "error", `${name} is not an array.`);
      }
      if (local?.isArray && local.type === "unknown") {
        const idx = this.expr(e.index, ctx);
        return { code: `array.get(${local.pine}, ${idx.code})`, prec: PREC.atom, type: "unknown" };
      }
    }
    this.issue(e.line, "error", "Reading from this array is not supported yet.");
    return { code: "na", prec: PREC.atom, type: "unknown" };
  }

  private boundAccess(name: string, b: Binding, base: string, indexExpr: Expr, ctx: FnCtx, line: number): Code {
    const idx = this.expr(indexExpr, ctx);
    const start = this.constNumber(b.start);
    const count = this.constNumber(b.count);
    if (this.seriesArrays.has(name)) {
      if (start === null) {
        const s = this.expr(b.start, ctx);
        const total: Code = /^\d+$/.test(idx.code) && idx.code === "0" ? s : { code: `${paren(s, PREC.add)} + ${paren(idx, PREC.add + 1)}`, prec: PREC.add, type: "int" };
        return this.seriesRef(base, total, line);
      }
      return this.seriesRef(base, idx, line, start);
    }
    // Not set as series: element 0 is the oldest bar copied.
    if (start !== null && count !== null) {
      const n = /^\d+$/.test(idx.code) ? Number(idx.code) : null;
      if (n !== null) return this.seriesRef(base, start + count - 1 - n, line);
      return this.seriesRef(base, { code: `${start + count - 1} - ${paren(idx, PREC.add + 1)}`, prec: PREC.add, type: "int" }, line);
    }
    this.issue(line, "error", `Array ${name} is not set as series and its size is not constant. Call ArraySetAsSeries(${name}, true).`);
    return this.seriesRef(base, idx, line);
  }

  private member(e: Expr & { type: "Member" }, ctx: FnCtx): Code {
    // rates[i].close
    if (e.object.type === "Index" && e.object.object.type === "Ident") {
      const arr = e.object.object.name;
      const b = this.bindings.get(arr);
      if (b?.kind === "rates") {
        const field = RATES_FIELDS[e.property];
        if (!field) {
          this.issue(e.line, "error", `MqlRates field ${e.property} is not supported.`);
          return { code: "na", prec: PREC.atom, type: "unknown" };
        }
        if (field === "0") return { code: "0", prec: PREC.atom, type: "int" };
        const base = this.priceSeries({ ...b, price: field }, ctx, e.line);
        return this.boundAccess(arr, b, base, e.object.index, ctx, e.line);
      }
    }
    if (e.object.type === "Ident") {
      const obj = e.object.name;
      // MqlDateTime fields
      const ts = this.timeStructFor(ctx, obj);
      if (ts) {
        const t = ts;
        switch (e.property) {
          case "hour": return { code: `hour(${t})`, prec: PREC.atom, type: "int" };
          case "min": return { code: `minute(${t})`, prec: PREC.atom, type: "int" };
          case "sec": return { code: `second(${t})`, prec: PREC.atom, type: "int" };
          case "day": return { code: `dayofmonth(${t})`, prec: PREC.atom, type: "int" };
          case "mon": return { code: `month(${t})`, prec: PREC.atom, type: "int" };
          case "year": return { code: `year(${t})`, prec: PREC.atom, type: "int" };
          case "day_of_week": return { code: `(dayofweek(${t}) - 1)`, prec: PREC.atom, type: "int" };
          case "day_of_year": return { code: `(math.floor((${t} - timestamp(year(${t}), 1, 1, 0, 0)) / 86400000))`, prec: PREC.atom, type: "int" };
        }
      }
      const v = this.lookup(ctx, obj);
      if (v?.mqlType === "MqlTick") {
        if (e.property === "ask" || e.property === "bid" || e.property === "last") {
          this.askBidWarning(e.line);
          return { code: "close", prec: PREC.atom, type: "float" };
        }
        if (e.property === "time") return { code: "time", prec: PREC.atom, type: "int" };
      }
    }
    this.issue(e.line, "error", `Member access .${e.property} is not supported here.`);
    return { code: "na", prec: PREC.atom, type: "unknown" };
  }

  private timeStructFor(ctx: FnCtx, name: string): string | null {
    const v = this.lookup(ctx, name);
    if (v?.mqlType !== "MqlDateTime") return null;
    const t = ctx.timeStructs.get(name);
    if (!t) {
      this.warnOnce("ts-" + name, 0, `MqlDateTime ${name} is read before TimeToStruct(); using the bar time.`);
      return "time";
    }
    return t;
  }

  private bufferSeries(handle: string, buffer: number, line: number): string {
    const spec = this.handles.get(handle);
    if (!spec) {
      this.issue(line, "error", `Indicator handle ${handle} was never created with iMA/iRSI/...`);
      return "na";
    }
    if (!spec.buffers) this.generateIndicator(handle, spec);
    const name = spec.buffers?.[buffer];
    if (!name) {
      this.issue(line, "error", `${spec.fn} has no buffer ${buffer} in this converter.`);
      return "na";
    }
    return name;
  }

  private priceSeries(b: Binding & { tfExpr?: Expr }, ctx: FnCtx, line: number): string {
    const price = b.price ?? "close";
    const tf = b.tfExpr ? this.timeframeArg(b.tfExpr, line) : null;
    if (tf === null) return price;
    const key = `${price}@${tf}`;
    const existing = this.securityCache.get(key);
    if (existing) return existing;
    const name = this.uniqueName(`${price}_${tf.replace(/[^\w]/g, "") || "tf"}`);
    this.indicatorLines.push(`${name} = request.security(syminfo.tickerid, ${tf}, ${price})`);
    this.securityCache.set(key, name);
    this.warnOnce("security", line, "Data from another timeframe uses request.security(); values can differ slightly from MT5 on the forming bar.", "info");
    void ctx;
    return name;
  }
  private securityCache = new Map<string, string>();

  /** Returns a Pine timeframe expression, or null for the chart timeframe. */
  private timeframeArg(e: Expr, line: number): string | null {
    if (e.type === "Number" && Number(e.value) === 0) return null;
    if (e.type === "Ident") {
      if (e.name === "_Period" || e.name === "PERIOD_CURRENT") return null;
      if (e.name in TIMEFRAMES) return TIMEFRAMES[e.name] === "" ? null : JSON.stringify(TIMEFRAMES[e.name]);
      const kind = this.inputNames.get(e.name)?.kind;
      if (kind === "timeframe") return this.pineName(e.name);
    }
    if (e.type === "Call" && e.callee.type === "Ident" && e.callee.name === "Period") return null;
    this.issue(line, "error", "Timeframe must be PERIOD_* or an ENUM_TIMEFRAMES input.");
    return null;
  }

  private symbolArg(e: Expr | undefined, line: number): string | null {
    if (!e) return null;
    if (isCurrentSymbol(e)) return null;
    if (e.type === "String") return JSON.stringify(e.value);
    if (e.type === "Ident" && this.inputNames.has(e.name)) return this.pineName(e.name);
    this.issue(line, "error", "Only the chart symbol, a fixed symbol name or a symbol input is supported.");
    return null;
  }

  // -------------------------------------------------------------------------
  // Indicators

  private generateIndicator(handle: string, spec: HandleSpec) {
    const ctx = this.newCtx("#indicator", false, "unknown", true);
    const a = spec.args;
    const line = spec.line;
    const nm = this.uniqueName(seriesBaseName(handle, spec.fn));
    const num = (i: number, fallback?: string) => {
      const x = a[i];
      if (!x) {
        if (fallback !== undefined) return fallback;
        this.issue(line, "error", `${spec.fn} is missing argument ${i + 1}.`);
        return "na";
      }
      const c = this.expr(x, ctx);
      if (c.type === "unknown" && !/^[\d.]+$/.test(c.code)) {
        this.issue(line, "warning", `Check ${spec.fn} argument ${i + 1}; it should be a number or an input.`);
      }
      return c.code;
    };
    const src = (i: number) => this.priceArg(a[i], line);
    const maFn = (i: number, srcCode: string, len: string) => this.maCall(a[i], srcCode, len, line);
    const shift = (i: number) => {
      const s = a[i] ? this.constNumber(a[i]) : 0;
      if (s === null) {
        this.issue(line, "error", `${spec.fn} shift must be a constant.`);
        return "";
      }
      return s > 0 ? `[${s}]` : "";
    };

    let buffers: string[] = [];
    let decl: string | null = null;
    switch (spec.fn) {
      case "iMA":
        decl = `${nm} = ${maFn(4, src(5), num(2))}${shift(3)}`;
        buffers = [nm];
        break;
      case "iRSI":
        decl = `${nm} = ta.rsi(${src(3)}, ${num(2)})`;
        buffers = [nm];
        break;
      case "iATR":
        decl = `${nm} = ta.atr(${num(2)})`;
        buffers = [nm];
        break;
      case "iCCI":
        decl = `${nm} = ta.cci(${src(3)}, ${num(2)})`;
        buffers = [nm];
        break;
      case "iMomentum": {
        const s = src(3);
        decl = `${nm} = ${s} / ${s}[${num(2)}] * 100`;
        buffers = [nm];
        break;
      }
      case "iStdDev": {
        const m = a[4] ? this.constName(a[4]) : "MODE_SMA";
        if (m && m !== "MODE_SMA") this.issue(line, "warning", "iStdDev with a non-SMA method uses Pine's simple standard deviation.");
        decl = `${nm} = ta.stdev(${src(5)}, ${num(2)})${shift(3)}`;
        buffers = [nm];
        break;
      }
      case "iMACD": {
        // MT5: main = EMA(fast) - EMA(slow); signal = SMA(main) (ta.macd would use an EMA signal).
        const m = `${nm}_main`, s = `${nm}_signal`;
        const p = src(5);
        decl = `${m} = ta.ema(${p}, ${num(2)}) - ta.ema(${p}, ${num(3)})\n${s} = ta.sma(${m}, ${num(4)})`;
        this.usedNames.add(m).add(s);
        buffers = [m, s];
        break;
      }
      case "iBands": {
        const b0 = `${nm}_mid`, b1 = `${nm}_upper`, b2 = `${nm}_lower`;
        decl = `[${b0}, ${b1}, ${b2}] = ta.bb(${src(5)}, ${num(2)}, ${num(4)})`;
        this.usedNames.add(b0).add(b1).add(b2);
        if (a[3] && this.constNumber(a[3]) !== 0) this.issue(line, "error", "iBands shift is not supported.");
        buffers = [b0, b1, b2];
        break;
      }
      case "iStochastic": {
        const k = `${nm}_k`, d = `${nm}_d`;
        const kp = num(2), dp = num(3), slow = num(4);
        const field = a[6] ? this.constName(a[6]) : "STO_LOWHIGH";
        const raw = field === "STO_CLOSECLOSE" ? `ta.stoch(close, close, close, ${kp})` : `ta.stoch(close, high, low, ${kp})`;
        const lines = [`${k} = ta.sma(${raw}, ${slow})`, `${d} = ${this.maCall(a[5], k, dp, line)}`];
        decl = lines.join("\n");
        this.usedNames.add(k).add(d);
        buffers = [k, d];
        break;
      }
      case "iADX": {
        const adx = `${nm}_adx`, p = `${nm}_plus`, m = `${nm}_minus`;
        decl = `[${p}, ${m}, ${adx}] = ta.dmi(${num(2)}, ${num(2)})`;
        this.usedNames.add(adx).add(p).add(m);
        buffers = [adx, p, m];
        this.warnOnce("adx", line, "MT5's iADX smooths differently from Pine's ta.dmi (Wilder). Values differ slightly.", "info");
        break;
      }
      case "iSAR":
        decl = `${nm} = ta.sar(${num(2)}, ${num(2)}, ${num(3)})`;
        buffers = [nm];
        break;
      case "iWPR":
        decl = `${nm} = ta.wpr(${num(2)})`;
        buffers = [nm];
        break;
      case "iMFI":
        decl = `${nm} = ta.mfi(hlc3, ${num(2)})`;
        buffers = [nm];
        break;
      case "iOBV":
        decl = `${nm} = ta.obv`;
        buffers = [nm];
        break;
      case "iAO":
        decl = `${nm} = ta.sma(hl2, 5) - ta.sma(hl2, 34)`;
        buffers = [nm];
        break;
      case "iCustom":
        this.issue(line, "error", "iCustom (custom indicators) cannot be converted automatically. Convert that indicator first.");
        break;
      default:
        this.issue(line, "error", `Indicator ${spec.fn} is not supported yet.`);
    }
    spec.buffers = buffers;
    if (!decl) return;

    const tf = a[1] ? this.timeframeArg(a[1], line) : null;
    const sym = this.symbolArg(a[0], line);
    if (tf !== null || sym !== null) {
      // Wrap in request.security; tuples work too.
      const ticker = sym ?? "syminfo.tickerid";
      const tfc = tf ?? "timeframe.period";
      const wrapped = decl.split("\n").map((l) => {
        const eq = l.indexOf(" = ");
        return `${l.slice(0, eq)} = request.security(${ticker}, ${tfc}, ${l.slice(eq + 3)})`;
      });
      // Stochastic second line depends on first; compute both inside security instead.
      if (spec.fn === "iStochastic") {
        this.issue(line, "warning", "Stochastic on another timeframe is approximated.");
      }
      decl = wrapped.join("\n");
      this.warnOnce("security", line, "Data from another timeframe uses request.security(); values can differ slightly from MT5 on the forming bar.", "info");
    }
    this.indicatorLines.push(...decl.split("\n"));
  }

  private constName(e: Expr): string | null {
    return e.type === "Ident" ? e.name : null;
  }

  private priceArg(e: Expr | undefined, line: number): string {
    if (!e) return "close";
    if (e.type === "Ident") {
      if (e.name in APPLIED_PRICE) return APPLIED_PRICE[e.name];
      if (this.inputNames.get(e.name)?.kind === "price") return this.pineName(e.name);
    }
    const n = this.constNumber(e);
    if (n !== null) {
      const entry = Object.entries(NUMERIC_CONSTANTS).find(([k, v]) => k.startsWith("PRICE_") && Number(v) === n);
      if (entry) return APPLIED_PRICE[entry[0]];
    }
    this.issue(line, "error", "Applied price must be PRICE_* or an ENUM_APPLIED_PRICE input.");
    return "close";
  }

  private maCall(e: Expr | undefined, srcCode: string, len: string, line: number): string {
    if (!e) return `ta.sma(${srcCode}, ${len})`;
    if (e.type === "Ident" && e.name in MA_METHOD) return `${MA_METHOD[e.name]}(${srcCode}, ${len})`;
    const n = this.constNumber(e);
    if (n !== null) {
      const name = Object.entries(MA_METHOD_VALUES).find(([, v]) => v === n)?.[0];
      if (name) return `${MA_METHOD[name]}(${srcCode}, ${len})`;
    }
    if (e.type === "Ident" && this.inputNames.has(e.name)) {
      this.helpers.add("ma");
      return `f_ma(${srcCode}, ${len}, ${this.pineName(e.name)})`;
    }
    this.issue(line, "error", "Moving average method must be MODE_* or an ENUM_MA_METHOD input.");
    return `ta.sma(${srcCode}, ${len})`;
  }

  private helperLines(): string[] {
    const out: string[] = [];
    if (this.helpers.has("ma")) {
      out.push(
        "f_ma(float src, simple int len, int maType) =>",
        "    switch maType",
        "        1 => ta.ema(src, len)",
        "        2 => ta.rma(src, len)",
        "        3 => ta.wma(src, len)",
        "        => ta.sma(src, len)",
      );
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Calls

  private call(e: Expr & { type: "Call" }, ctx: FnCtx): Code {
    if (e.callee.type === "Member") return this.methodCall(e, e.callee, ctx);
    return this.noHoist(ctx, () => this.callInner(e, ctx));
  }

  private callInner(e: Expr & { type: "Call" }, ctx: FnCtx): Code {
    if (e.callee.type !== "Ident") {
      this.issue(e.line, "error", "This kind of call is not supported.");
      return { code: "na", prec: PREC.atom, type: "unknown" };
    }
    const name = e.callee.name;
    const args = e.args;
    const A = (i: number) => this.expr(args[i], ctx);
    const atom = (code: string, type: PType): Code => ({ code, prec: PREC.atom, type });

    // User functions
    const fn = this.functions.get(name);
    if (fn && !name.startsWith("On")) {
      if (this.inlineFns.has(name)) {
        this.issue(e.line, "error", `${name}() changes global variables, so it can only be called on its own line.`);
        return atom("na", "unknown");
      }
      const codes = args.map((a, i) => {
        const p = fn.params[i];
        const pt = p ? toPType(pineType(p.varType) ?? "unknown") : "unknown";
        return this.coerce(this.expr(a, ctx), pt).code;
      });
      return atom(`${this.pineName(name)}(${codes.join(", ")})`, toPType(pineType(fn.returnType) ?? "unknown"));
    }

    if (name in MATH_FUNCTIONS) {
      const pine = MATH_FUNCTIONS[name];
      if (pine === "math.random") return atom("math.random(0, 32767)", "float");
      const codes = args.map((_, i) => A(i));
      const type: PType = ["math.round", "math.floor", "math.ceil"].includes(pine)
        ? "int"
        : ["math.max", "math.min", "math.abs"].includes(pine) && codes.every((c) => c.type === "int")
          ? "int"
          : "float";
      return atom(`${pine}(${codes.map((c) => c.code).join(", ")})`, type);
    }

    switch (name) {
      case "NormalizeDouble":
        return atom(`math.round(${A(0).code}, ${args[1] ? A(1).code : "0"})`, "float");
      case "MathMod":
        return { code: `${paren(A(0), PREC.mul)} % ${paren(A(1), PREC.mul + 1)}`, prec: PREC.mul, type: "float" };
      case "MathIsValidNumber":
        return atom(`not na(${A(0).code})`, "bool");
      case "DoubleToString": {
        const d = args[1] ? this.constNumber(args[1]) : 8;
        if (d === null) return atom(`str.tostring(${A(0).code})`, "string");
        return atom(`str.tostring(${A(0).code}, ${JSON.stringify(d > 0 ? "0." + "0".repeat(d) : "0")})`, "string");
      }
      case "IntegerToString":
        return atom(`str.tostring(${A(0).code})`, "string");
      case "StringToDouble":
        return atom(`str.tonumber(${A(0).code})`, "float");
      case "StringToInteger":
        return atom(`int(str.tonumber(${A(0).code}))`, "int");
      case "TimeToString":
        return atom(`str.format_time(${A(0).code}, "yyyy.MM.dd HH:mm")`, "string");
      case "StringLen":
        return atom(`str.length(${A(0).code})`, "int");
      case "StringFind":
        return atom(`str.pos(${A(0).code}, ${A(1).code})`, "int");
      case "StringSubstr":
        return atom(
          args[2] ? `str.substring(${A(0).code}, ${A(1).code}, ${A(1).code} + ${paren(A(2), PREC.add + 1)})` : `str.substring(${A(0).code}, ${A(1).code})`,
          "string",
        );
      case "StringFormat":
        return this.formatCall(args, ctx, e.line);
      case "Print":
      case "PrintFormat":
      case "Alert": {
        const msg = name === "PrintFormat" ? this.formatCall(args, ctx, e.line) : this.concatArgs(args, ctx);
        return atom(name === "Alert" ? `alert(${msg.code})` : `log.info(${msg.code})`, "unknown");
      }
      case "Symbol":
        return atom("syminfo.ticker", "string");
      case "Period":
        return atom("timeframe.period", "string");
      case "Point":
        return atom("syminfo.mintick", "float");
      case "Digits":
        return atom("math.round(-math.log10(syminfo.mintick))", "int");
      case "TimeCurrent":
      case "TimeTradeServer":
      case "TimeLocal":
      case "TimeGMT":
        if (args[0]?.type === "Ident") ctx.timeStructs.set(args[0].name, "time");
        if (name !== "TimeCurrent") this.warnOnce("tz", e.line, `${name}() uses the exchange time zone in Pine.`, "info");
        return atom("time", "int");
      case "TimeToStruct":
        if (args[1]?.type === "Ident") {
          const t = A(0);
          ctx.timeStructs.set(args[1].name, t.code);
          this.warnOnce("tz", e.line, "Time-of-day checks use the exchange time zone in Pine, not the MT5 server time zone. Adjust hours if they differ.");
        }
        return atom("true", "bool");
      case "Bars":
      case "iBars":
        return atom("(bar_index + 1)", "int");
      case "GetLastError":
        return atom("0", "int");
      case "IsStopped":
        return atom("false", "bool");
      case "MQLInfoInteger":
      case "TerminalInfoInteger":
        return atom("1", "int");
      case "SymbolInfoTick":
        return atom("true", "bool");
      case "SymbolInfoDouble":
        return this.symbolInfoDouble(args, e.line);
      case "SymbolInfoInteger":
        return this.symbolInfoInteger(args, e.line);
      case "AccountInfoDouble":
        return this.accountInfo(args, e.line);
      case "AccountInfoInteger":
        this.issue(e.line, "warning", "AccountInfoInteger() is not available in Pine; returned 0.");
        return atom("0", "int");
      case "PositionsTotal":
        return { code: "(f_pos() != 0 ? 1 : 0)", prec: PREC.atom, type: "int" };
      case "PositionSelect":
        if (args[0] && !isCurrentSymbol(args[0])) this.issue(e.line, "warning", "Positions on other symbols are not visible in Pine.");
        return { code: "f_pos() != 0", prec: PREC.eq, type: "bool" };
      case "PositionSelectByTicket":
        return { code: "f_pos() != 0", prec: PREC.eq, type: "bool" };
      case "PositionGetTicket":
        return { code: "(f_pos() != 0 ? 1 : 0)", prec: PREC.atom, type: "int" };
      case "PositionGetSymbol":
        return atom("syminfo.ticker", "string");
      case "PositionGetString":
        return atom("syminfo.ticker", "string");
      case "PositionGetInteger":
        return this.positionInteger(args, e.line);
      case "PositionGetDouble":
        return this.positionDouble(args, e.line);
      case "OrdersTotal":
        this.warnOnce("orders", e.line, "OrdersTotal() (pending orders) is always 0 in the converted code.");
        return atom("0", "int");
      case "HistorySelect":
        this.issue(e.line, "error", "Trade history (HistorySelect/HistoryDeal*) is not supported yet.");
        return atom("false", "bool");
      case "CopyBuffer":
      case "CopyClose":
      case "CopyOpen":
      case "CopyHigh":
      case "CopyLow":
      case "CopyTime":
      case "CopyRates":
      case "CopyTickVolume":
      case "CopyRealVolume": {
        // Data is always available in Pine; return the requested count so "< count" checks pass.
        const idx = name === "CopyBuffer" ? 3 : 3;
        const c = args[idx] ? this.constNumber(args[idx]) : null;
        if (c === null) return { code: "bar_index + 1", prec: PREC.add, type: "int" };
        return atom(String(c), "int");
      }
      case "BarsCalculated":
        return { code: "bar_index + 1", prec: PREC.add, type: "int" };
      case "iClose":
      case "iOpen":
      case "iHigh":
      case "iLow":
      case "iTime":
      case "iVolume":
      case "iTickVolume":
      case "iRealVolume": {
        const price = SERIES_FNS[name];
        const tf = args[1] ? this.timeframeArg(args[1], e.line) : null;
        const sym = this.symbolArg(args[0], e.line);
        let base = price;
        if (tf !== null || sym !== null) {
          base = this.priceSeries({ kind: "price", price, start: args[2], count: args[2], line: e.line, tfExpr: args[1] } as Binding & { tfExpr?: Expr }, ctx, e.line);
          if (sym !== null) this.issue(e.line, "error", "Prices of another symbol are not supported in iClose/iOpen/... yet.");
        }
        const c = this.seriesRef(base, args[2] ? A(2) : 0, e.line);
        return { ...c, type: price === "time" ? "int" : "float" };
      }
      case "ArraySize":
        if (args[0]?.type === "Ident") {
          const b = this.bindings.get(args[0].name);
          if (b) {
            const c = this.constNumber(b.count);
            if (c !== null) return atom(String(c), "int");
          }
          const v = this.lookup(ctx, args[0].name);
          if (v?.isArray && v.type === "unknown") return atom(`array.size(${v.pine})`, "int");
        }
        this.issue(e.line, "error", "ArraySize on this array is not supported.");
        return atom("0", "int");
      case "ArrayMaximum":
      case "ArrayMinimum":
        return this.arrayExtreme(name, args, ctx, e.line);
      case "Sleep":
      case "RefreshRates":
      case "ChartRedraw":
        return atom("na", "unknown");
      case "OrderSend":
        this.issue(e.line, "error", "OrderSend() with MqlTradeRequest is not supported yet. Use CTrade (trade.Buy/Sell) in the EA.");
        return atom("false", "bool");
      case "OrderCalcMargin":
      case "OrderCalcProfit":
        this.issue(e.line, "error", `${name}() is not available in Pine.`);
        return atom("false", "bool");
    }

    if (isIndicatorCall(e)) {
      this.issue(e.line, "error", `${name}() must be assigned to a handle variable and read with CopyBuffer.`);
      return atom("na", "unknown");
    }
    if (name.startsWith("Object") || name.startsWith("Chart")) {
      this.warnOnce("obj-" + name, e.line, `${name}() was skipped (chart objects are not converted).`, "info");
      return atom("na", "unknown");
    }
    if (name.startsWith("Global") || name.startsWith("File")) {
      this.issue(e.line, "error", `${name}() (global variables of the terminal / files) has no Pine equivalent.`);
      return atom("na", "unknown");
    }
    const ret = BUILTIN_RETURN_TYPES[name];
    this.issue(e.line, "error", `Function ${name}() is not supported yet.`);
    return atom("na", toPType(ret ?? "unknown"));
  }

  private arrayExtreme(name: string, args: Expr[], ctx: FnCtx, line: number): Code {
    // ArrayMaximum(arr, start, count) on a bound series array -> bars back of the highest value.
    const arr = args[0];
    if (arr?.type === "Ident" && this.bindings.has(arr.name) && this.seriesArrays.has(arr.name)) {
      const b = this.bindings.get(arr.name)!;
      const base = b.kind === "buffer" ? this.bufferSeries(b.handle!, b.buffer!, line) : this.priceSeries(b, ctx, line);
      const start = args[1] ? this.constNumber(args[1]) : 0;
      const count = args[2] ? this.constNumber(args[2]) : this.constNumber(b.count);
      const bstart = this.constNumber(b.start);
      if (start !== null && count !== null && bstart !== null) {
        const fn = name === "ArrayMaximum" ? "ta.highestbars" : "ta.lowestbars";
        const off = bstart + start - this.barShift;
        this.seriesAccessCount++;
        this.minSeriesIndex = Math.min(this.minSeriesIndex, bstart + start);
        const src = off > 0 ? `${base}[${off}]` : base;
        return { code: `(${start} - ${fn}(${src}, ${count}))`, prec: PREC.atom, type: "int" };
      }
    }
    this.issue(line, "error", `${name}() is only supported on series arrays with constant ranges.`);
    return { code: "0", prec: PREC.atom, type: "int" };
  }

  private concatArgs(args: Expr[], ctx: FnCtx): Code {
    if (args.length === 0) return { code: '""', prec: PREC.atom, type: "string" };
    const parts = args.map((a) => {
      const c = this.expr(a, ctx);
      return c.type === "string" ? paren(c, PREC.add + 1) : `str.tostring(${c.code})`;
    });
    return { code: parts.join(" + "), prec: parts.length > 1 ? PREC.add : PREC.atom, type: "string" };
  }

  /** printf-style format -> str.format with {n} placeholders. */
  private formatCall(args: Expr[], ctx: FnCtx, line: number): Code {
    const fmt = args[0];
    if (!fmt || fmt.type !== "String") {
      this.issue(line, "warning", "Format string is not a literal; values are joined instead.");
      return this.concatArgs(args, ctx);
    }
    let n = 0;
    const pattern = fmt.value
      .replace(/'/g, "''")
      .replace(/[{}]/g, (m) => `'${m}'`)
      .replace(/%([-+ #0]*)(\d+)?(?:\.(\d+))?([dioufFeEgGsxXc%])/g, (_m, _flags, _w, prec, conv) => {
        if (conv === "%") return "%";
        const i = n++;
        if ("fFeEgG".includes(conv)) {
          const p = prec !== undefined ? Number(prec) : 6;
          return `{${i},number,${p > 0 ? "0." + "0".repeat(p) : "0"}}`;
        }
        return `{${i}}`;
      });
    const vals = args.slice(1).map((a) => this.expr(a, ctx).code);
    return { code: `str.format(${[JSON.stringify(pattern), ...vals].join(", ")})`, prec: PREC.atom, type: "string" };
  }

  private symbolInfoDouble(args: Expr[], line: number): Code {
    const prop = args[1]?.type === "Ident" ? args[1].name : "";
    const atom = (code: string): Code => ({ code, prec: PREC.atom, type: "float" });
    if (args[0] && !isCurrentSymbol(args[0])) this.issue(line, "warning", "SymbolInfoDouble for another symbol uses the chart symbol.");
    switch (prop) {
      case "SYMBOL_ASK":
      case "SYMBOL_BID":
      case "SYMBOL_LAST":
        this.askBidWarning(line);
        return atom("close");
      case "SYMBOL_POINT":
      case "SYMBOL_TRADE_TICK_SIZE":
        return atom("syminfo.mintick");
      case "SYMBOL_TRADE_TICK_VALUE":
        this.warnOnce("tickvalue", line, "Tick value uses syminfo.pointvalue * syminfo.mintick (per 1 contract). Check lot sizing.");
        return { code: "syminfo.pointvalue * syminfo.mintick", prec: PREC.mul, type: "float" };
      case "SYMBOL_TRADE_CONTRACT_SIZE":
        return atom("syminfo.pointvalue");
      case "SYMBOL_VOLUME_MIN":
      case "SYMBOL_VOLUME_STEP":
        this.warnOnce("volstep", line, "Lot min/step were set to 0.01. Pine has no broker lot limits.");
        return atom("0.01");
      case "SYMBOL_VOLUME_MAX":
        return atom("1000000.0");
    }
    this.issue(line, "error", `SymbolInfoDouble(${prop}) is not supported.`);
    return atom("na");
  }

  private symbolInfoInteger(args: Expr[], line: number): Code {
    const prop = args[1]?.type === "Ident" ? args[1].name : "";
    switch (prop) {
      case "SYMBOL_DIGITS":
        return { code: "math.round(-math.log10(syminfo.mintick))", prec: PREC.atom, type: "int" };
      case "SYMBOL_SPREAD":
        this.warnOnce("spread", line, "Spread is 0 in Pine backtests.");
        return { code: "0", prec: PREC.atom, type: "int" };
      case "SYMBOL_TRADE_STOPS_LEVEL":
      case "SYMBOL_TRADE_FREEZE_LEVEL":
        return { code: "0", prec: PREC.atom, type: "int" };
    }
    this.issue(line, "error", `SymbolInfoInteger(${prop}) is not supported.`);
    return { code: "0", prec: PREC.atom, type: "int" };
  }

  private accountInfo(args: Expr[], line: number): Code {
    const prop = args[0]?.type === "Ident" ? args[0].name : "";
    const atom = (code: string, prec = PREC.atom): Code => ({ code, prec, type: "float" });
    switch (prop) {
      case "ACCOUNT_BALANCE":
        return atom("strategy.initial_capital + strategy.netprofit", PREC.add);
      case "ACCOUNT_EQUITY":
        return atom("strategy.equity");
      case "ACCOUNT_PROFIT":
        return atom("strategy.openprofit");
      case "ACCOUNT_MARGIN_FREE":
      case "ACCOUNT_FREEMARGIN":
        this.warnOnce("margin", line, "Free margin was replaced by equity (Pine does not track margin the same way).");
        return atom("strategy.equity");
    }
    this.issue(line, "error", `AccountInfoDouble(${prop}) is not supported.`);
    return atom("na");
  }

  private positionInteger(args: Expr[], line: number): Code {
    const prop = args[0]?.type === "Ident" ? args[0].name : "";
    switch (prop) {
      case "POSITION_TYPE":
        return { code: "(f_pos() > 0 ? 0 : 1)", prec: PREC.atom, type: "int" };
      case "POSITION_MAGIC":
        this.warnOnce("magic", line, "Magic numbers are ignored: a Pine strategy only sees its own trades.", "info");
        return { code: "0", prec: PREC.atom, type: "int" };
      case "POSITION_TIME":
        return { code: "strategy.opentrades.entry_time(strategy.opentrades - 1)", prec: PREC.atom, type: "int" };
      case "POSITION_TICKET":
      case "POSITION_IDENTIFIER":
        return { code: "1", prec: PREC.atom, type: "int" };
    }
    this.issue(line, "error", `PositionGetInteger(${prop}) is not supported.`);
    return { code: "0", prec: PREC.atom, type: "int" };
  }

  private positionDouble(args: Expr[], line: number): Code {
    const prop = args[0]?.type === "Ident" ? args[0].name : "";
    const atom = (code: string): Code => ({ code, prec: PREC.atom, type: "float" });
    switch (prop) {
      case "POSITION_PRICE_OPEN":
        return atom("strategy.position_avg_price");
      case "POSITION_VOLUME":
        return atom("math.abs(f_pos())");
      case "POSITION_PROFIT":
        return atom("strategy.openprofit");
      case "POSITION_PRICE_CURRENT":
        return atom("close");
      case "POSITION_SL":
      case "POSITION_TP":
        this.issue(line, "error", `${prop} cannot be read back in Pine. Keep the stop/target in your own variable.`);
        return atom("0.0");
      case "POSITION_SWAP":
        return atom("0.0");
    }
    this.issue(line, "error", `PositionGetDouble(${prop}) is not supported.`);
    return atom("0.0");
  }

  // -------------------------------------------------------------------------
  // CTrade methods

  private methodCall(e: Expr & { type: "Call" }, callee: Expr & { type: "Member" }, ctx: FnCtx): Code {
    const objName = callee.object.type === "Ident" ? callee.object.name : "";
    const obj = objName ? this.lookup(ctx, objName) : undefined;
    const method = callee.property;
    const atom = (code: string, type: PType): Code => ({ code, prec: PREC.atom, type });

    if (obj?.mqlType === "CPositionInfo") {
      switch (method) {
        case "Select":
        case "SelectByIndex":
        case "SelectByTicket":
          return { code: "f_pos() != 0", prec: PREC.eq, type: "bool" };
        case "Symbol":
          return atom("syminfo.ticker", "string");
        case "Magic":
          return atom("0", "int");
        case "PositionType":
          return atom("(f_pos() > 0 ? 0 : 1)", "int");
        case "PriceOpen":
          return atom("strategy.position_avg_price", "float");
        case "Volume":
          return atom("math.abs(f_pos())", "float");
        case "Profit":
          return atom("strategy.openprofit", "float");
      }
    }
    if (obj?.mqlType !== "CTrade") {
      this.issue(e.line, "error", `Method ${objName}.${method}() is not supported.`);
      return atom("na", "unknown");
    }
    if (TRADE_METHODS_IGNORED.has(method)) return atom("na", "unknown");
    if (method === "ResultRetcode") return atom("10009", "int");
    if (method === "ResultOrder" || method === "ResultDeal") return atom("1", "int");
    if (method === "ResultRetcodeDescription" || method === "ResultComment") return atom('""', "string");

    const stmts = this.tradeStatements(method, e.args, ctx, e.line);
    if (stmts === null) {
      this.issue(e.line, "error", `CTrade.${method}() is not supported yet.`);
      return atom("false", "bool");
    }
    if (ctx.pre === null || !ctx.hoistOk) {
      this.issue(e.line, "error", `trade.${method}() inside a larger condition is not supported; call it on its own line.`);
      return atom("true", "bool");
    }
    ctx.pre.push(...stmts);
    return atom("true", "bool");
  }

  private tradeStatements(method: string, args: Expr[], ctx: FnCtx, line: number): string[] | null {
    const v = (i: number): Code | null => {
      const a = args[i];
      if (!a) return null;
      const c = this.expr(a, ctx);
      if (c.code === "0" || c.code === "0.0" || c.code === "na") return null;
      return c;
    };
    const comment = (i: number) => {
      const c = v(i);
      return c && c.type === "string" ? `, comment = ${c.code}` : "";
    };
    this.warnOnce(
      "lots",
      line,
      "Lot sizes are passed as Pine qty (number of contracts/units). For forex, 1 MT5 lot is usually 100000 units; adjust qty or the symbol's point value.",
    );
    const entry = (dir: "long" | "short", qty: Code | null, sl: Code | null, tp: Code | null, extra = "", cmt = "") => {
      const id = dir === "long" ? "Buy" : "Sell";
      const out = [`strategy.entry(${JSON.stringify(id)}, strategy.${dir}${qty ? `, qty = ${qty.code}` : ""}${extra}${cmt})`];
      // Market orders change the position at once in MT5; mirror that for later checks on this bar.
      if (!extra) {
        const q = qty ? paren(qty, PREC.unary + 1) : "1";
        out.push(`array.set(posState, 0, ${dir === "long" ? q : `-${q}`})`);
      }
      if (sl || tp) {
        out.push(
          `strategy.exit(${JSON.stringify(id + " SL/TP")}, from_entry = ${JSON.stringify(id)}${sl ? `, stop = ${sl.code}` : ""}${tp ? `, limit = ${tp.code}` : ""})`,
        );
      }
      return out;
    };
    switch (method) {
      case "Buy":
      case "Sell": {
        // Buy(volume, symbol, price, sl, tp, comment)
        if (args[1] && !isCurrentSymbol(args[1])) this.issue(line, "warning", "Trades on another symbol are placed on the chart symbol.");
        return entry(method === "Buy" ? "long" : "short", v(0), v(3), v(4), "", comment(5));
      }
      case "PositionOpen": {
        // PositionOpen(symbol, type, volume, price, sl, tp, comment)
        const type = args[1]?.type === "Ident" ? args[1].name : "";
        const dir = type === "ORDER_TYPE_BUY" ? "long" : type === "ORDER_TYPE_SELL" ? "short" : null;
        if (!dir) {
          const t = this.expr(args[1], ctx);
          return [
            `if ${t.code} == 0`,
            ...entry("long", v(2), v(4), v(5)).map((l) => "    " + l),
            "else",
            ...entry("short", v(2), v(4), v(5)).map((l) => "    " + l),
          ];
        }
        return entry(dir, v(2), v(4), v(5), "", comment(6));
      }
      case "BuyLimit":
      case "SellLimit":
      case "BuyStop":
      case "SellStop": {
        // BuyLimit(volume, price, symbol, sl, tp, type_time, expiration, comment)
        const dir = method.startsWith("Buy") ? "long" : "short";
        const price = v(1);
        const kind = method.endsWith("Limit") ? "limit" : "stop";
        if (args[5] || args[6]) this.issue(line, "warning", "Pending order expiration is ignored.");
        return entry(dir, v(0), v(3), v(4), price ? `, ${kind} = ${price.code}` : "", comment(7));
      }
      case "PositionClose":
      case "PositionCloseBy":
        return [`strategy.close_all(comment = "Close")`, `array.set(posState, 0, 0.0)`];
      case "PositionClosePartial": {
        const vol = v(1);
        if (!vol) return [`strategy.close_all()`, `array.set(posState, 0, 0.0)`];
        return [
          `if f_pos() > 0`,
          `    strategy.close("Buy", qty = ${vol.code})`,
          `    array.set(posState, 0, math.max(f_pos() - ${paren(vol, PREC.add + 1)}, 0.0))`,
          `else if f_pos() < 0`,
          `    strategy.close("Sell", qty = ${vol.code})`,
          `    array.set(posState, 0, math.min(f_pos() + ${paren(vol, PREC.add + 1)}, 0.0))`,
        ];
      }
      case "PositionModify": {
        // PositionModify(symbol|ticket, sl, tp)
        const sl = v(1);
        const tp = v(2);
        const params = `${sl ? `, stop = ${sl.code}` : ""}${tp ? `, limit = ${tp.code}` : ""}`;
        return [
          `if f_pos() > 0`,
          `    strategy.exit("Buy SL/TP", from_entry = "Buy"${params})`,
          `else if f_pos() < 0`,
          `    strategy.exit("Sell SL/TP", from_entry = "Sell"${params})`,
        ];
      }
      case "OrderDelete":
        return [`strategy.cancel_all()`];
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers

function toPType(t: string | null): PType {
  switch (t) {
    case "int":
    case "float":
    case "bool":
    case "string":
    case "color":
      return t;
    default:
      return "unknown";
  }
}

function pineTypeOf(t: PType): string {
  return t === "unknown" ? "float" : t;
}

function paren(c: Code, minPrec: number): string {
  return c.prec < minPrec ? `(${c.code})` : c.code;
}

function negate(c: Code): string {
  if (c.code === "true") return "false";
  if (c.code === "false") return "true";
  if (c.prec === PREC.unary && c.code.startsWith("not ")) return c.code.slice(4).replace(/^\((.*)\)$/s, (m, inner) => (balanced(inner) ? inner : m));
  if (c.prec === PREC.eq && / == /.test(c.code) && !/ (and|or) |!=|\?/.test(c.code)) return c.code.replace(" == ", " != ");
  if (c.prec === PREC.eq && / != /.test(c.code) && !/ (and|or) |==|\?/.test(c.code)) return c.code.replace(" != ", " == ");
  if (c.prec === PREC.cmp) {
    const m = c.code.match(/^(.*?) (<=|>=|<|>) (.*)$/);
    const inv: Record<string, string> = { "<": ">=", ">": "<=", "<=": ">", ">=": "<" };
    if (m && ![m[1], m[3]].some((x) => /[<>]|==|!=| and | or |\?/.test(x))) return `${m[1]} ${inv[m[2]]} ${m[3]}`;
  }
  return `not ${paren(c, PREC.unary)}`;
}

function balanced(s: string): boolean {
  let d = 0;
  for (const ch of s) {
    if (ch === "(") d++;
    else if (ch === ")" && --d < 0) return false;
  }
  return d === 0;
}

function toBool(c: Code): Code {
  if (c.type === "int" || c.type === "float") {
    return { code: `${paren(c, PREC.eq + 1)} != 0`, prec: PREC.eq, type: "bool" };
  }
  return c;
}

function asFloatLiteral(code: string): string {
  return /^-?\d+$/.test(code) ? code + ".0" : code;
}

function asList(s: Stmt): Stmt[] {
  return s.type === "Block" ? s.body : [s];
}

function containsReturn(s: Stmt): boolean {
  let found = false;
  walkStmt(s, (x) => {
    if (x.type === "Return") found = true;
  }, () => {});
  return found;
}

function containsContinue(s: Stmt): boolean {
  let found = false;
  walkStmt(s, (x) => {
    if (x.type === "Continue") found = true;
  }, () => {});
  return found;
}

/** A `break` that belongs to the enclosing switch (not to a loop inside the case). */
function containsSwitchBreak(s: Stmt): boolean {
  if (s.type === "Break") return true;
  if (s.type === "If") return containsSwitchBreak(s.then) || (s.else ? containsSwitchBreak(s.else) : false);
  if (s.type === "Block") return s.body.some(containsSwitchBreak);
  return false;
}

function endsWithReturn(list: Stmt[]): boolean {
  const last = list[list.length - 1];
  if (!last) return false;
  if (last.type === "Return") return true;
  if (last.type === "Block") return endsWithReturn(last.body);
  if (last.type === "If" && last.else) return endsWithReturn(asList(last.then)) && endsWithReturn(asList(last.else));
  return false;
}

function isSingleIfChain(lines: string[], indent: number): boolean {
  // The else body must be one if/else-if/else chain at the same indent level.
  const pad = "    ".repeat(indent);
  let first = true;
  for (const l of lines) {
    if (l.startsWith(pad) && !l.startsWith(pad + " ")) {
      const t = l.slice(pad.length);
      if (first) {
        if (!t.startsWith("if ")) return false;
        first = false;
      } else if (!(t.startsWith("else if ") || t === "else")) {
        return false;
      }
    }
  }
  return true;
}

function isIndicatorCall(e: Expr): boolean {
  return e.type === "Call" && e.callee.type === "Ident" && INDICATOR_FNS.has(e.callee.name);
}

function isCurrentSymbol(e: Expr): boolean {
  if (e.type === "Ident") return e.name === "_Symbol" || e.name === "NULL";
  if (e.type === "Call" && e.callee.type === "Ident") return e.callee.name === "Symbol" && e.args.length === 0;
  if (e.type === "Number") return Number(e.value) === 0;
  return false;
}

function isMagicQuery(e: Expr): boolean {
  if (e.type === "Call" && e.callee.type === "Ident" && e.callee.name === "PositionGetInteger") {
    const a = e.args[0];
    return a?.type === "Ident" && a.name === "POSITION_MAGIC";
  }
  if (e.type === "Call" && e.callee.type === "Member" && e.callee.property === "Magic") return true;
  return false;
}

function isPosTypeQuery(e: Expr): boolean {
  if (e.type === "Call" && e.callee.type === "Ident" && e.callee.name === "PositionGetInteger") {
    const a = e.args[0];
    return a?.type === "Ident" && a.name === "POSITION_TYPE";
  }
  if (e.type === "Call" && e.callee.type === "Member" && e.callee.property === "PositionType") return true;
  return false;
}

function isSymbolQuery(e: Expr): boolean {
  if (e.type === "Call" && e.callee.type === "Ident") {
    if (e.callee.name === "PositionGetSymbol") return true;
    if (e.callee.name === "PositionGetString") {
      const a = e.args[0];
      return a?.type === "Ident" && a.name === "POSITION_SYMBOL";
    }
  }
  if (e.type === "Call" && e.callee.type === "Member" && e.callee.property === "Symbol") return true;
  return false;
}

function seriesBaseName(handle: string, fn: string): string {
  let n = handle
    .replace(/^(h|handle|hnd|ind)(?=[A-Z_])/, "")
    .replace(/(_?handle|Handle|_h|Hnd|H)$/, "")
    .replace(/^_+/, "");
  // Short or generic handle names (h, h1, handle) read better as the indicator name.
  if (n.length < 3 || /^(h|handle|hnd)\d*$/i.test(n)) n = fn.replace(/^i/, "").toLowerCase() + (n.match(/\d+$/)?.[0] ?? "");
  n = n.charAt(0).toLowerCase() + n.slice(1);
  if (PINE_RESERVED.has(n)) n += "_val";
  return n;
}

function stripLines(x: unknown): unknown {
  return JSON.parse(JSON.stringify(x, (k, v) => (k === "line" ? undefined : v)));
}

export function walkExpr(e: Expr, fn: (e: Expr) => void): void {
  fn(e);
  switch (e.type) {
    case "Call":
      walkExpr(e.callee, fn);
      e.args.forEach((a) => walkExpr(a, fn));
      break;
    case "Member":
      walkExpr(e.object, fn);
      break;
    case "Index":
      walkExpr(e.object, fn);
      walkExpr(e.index, fn);
      break;
    case "Unary":
      walkExpr(e.arg, fn);
      break;
    case "Binary":
      walkExpr(e.left, fn);
      walkExpr(e.right, fn);
      break;
    case "Assign":
      walkExpr(e.target, fn);
      walkExpr(e.value, fn);
      break;
    case "Ternary":
      walkExpr(e.test, fn);
      walkExpr(e.then, fn);
      walkExpr(e.else, fn);
      break;
    case "Cast":
      walkExpr(e.expr, fn);
      break;
  }
}

export function walkStmt(s: Stmt, onStmt: (s: Stmt) => void, onExpr: (e: Expr) => void): void {
  onStmt(s);
  switch (s.type) {
    case "Block":
      s.body.forEach((b) => walkStmt(b, onStmt, onExpr));
      break;
    case "VarDecl":
      for (const d of s.declarators) {
        if (d.init) onExpr(d.init);
        d.initList?.forEach(onExpr);
      }
      break;
    case "ExprStmt":
      onExpr(s.expr);
      break;
    case "If":
      onExpr(s.test);
      walkStmt(s.then, onStmt, onExpr);
      if (s.else) walkStmt(s.else, onStmt, onExpr);
      break;
    case "For":
      if (s.init) walkStmt(s.init, onStmt, onExpr);
      if (s.test) onExpr(s.test);
      s.update.forEach(onExpr);
      walkStmt(s.body, onStmt, onExpr);
      break;
    case "While":
    case "DoWhile":
      onExpr(s.test);
      walkStmt(s.body, onStmt, onExpr);
      break;
    case "Return":
      if (s.value) onExpr(s.value);
      break;
    case "Switch":
      onExpr(s.test);
      for (const c of s.cases) {
        if (c.test) onExpr(c.test);
        c.body.forEach((b) => walkStmt(b, onStmt, onExpr));
      }
      break;
  }
}
