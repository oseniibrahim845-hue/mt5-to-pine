// Static tables that map MQL5 names to Pine Script v6.

export const PINE_RESERVED = new Set([
  "and", "or", "not", "if", "else", "for", "to", "by", "in", "while", "switch", "var", "varip",
  "true", "false", "na", "import", "export", "method", "type", "enum", "break", "continue",
  "int", "float", "bool", "string", "color", "line", "label", "box", "table", "array", "matrix", "map",
  "linefill", "polyline", "chart", "series", "simple", "const",
  "open", "high", "low", "close", "volume", "time", "time_close", "time_tradingday", "timenow",
  "hl2", "hlc3", "ohlc4", "hlcc4", "bar_index", "last_bar_index", "ask", "bid",
  "year", "month", "weekofyear", "dayofmonth", "dayofweek", "hour", "minute", "second",
  "strategy", "indicator", "library", "math", "ta", "str", "input", "request", "syminfo", "timeframe",
  "barstate", "session", "log", "alert", "alertcondition", "plot", "plotshape", "plotchar", "plotarrow",
  "plotcandle", "plotbar", "bgcolor", "barcolor", "fill", "hline", "runtime", "ticker", "nz", "fixnan",
  "max_bars_back", "location", "shape", "size", "text", "xloc", "yloc", "position", "display", "extend",
  "format", "scale", "currency", "dividends", "earnings", "splits", "adjustment", "backadjustment",
  "settlement_as_close", "font", "order", "dayofweek", "timestamp",
]);

/** MT5 timeframe constants -> Pine timeframe strings ("" = chart timeframe). */
export const TIMEFRAMES: Record<string, string> = {
  PERIOD_CURRENT: "",
  PERIOD_M1: "1", PERIOD_M2: "2", PERIOD_M3: "3", PERIOD_M4: "4", PERIOD_M5: "5", PERIOD_M6: "6",
  PERIOD_M10: "10", PERIOD_M12: "12", PERIOD_M15: "15", PERIOD_M20: "20", PERIOD_M30: "30",
  PERIOD_H1: "60", PERIOD_H2: "120", PERIOD_H3: "180", PERIOD_H4: "240", PERIOD_H6: "360",
  PERIOD_H8: "480", PERIOD_H12: "720", PERIOD_D1: "D", PERIOD_W1: "W", PERIOD_MN1: "M",
};

/** ENUM_APPLIED_PRICE -> Pine source series. */
export const APPLIED_PRICE: Record<string, string> = {
  PRICE_CLOSE: "close",
  PRICE_OPEN: "open",
  PRICE_HIGH: "high",
  PRICE_LOW: "low",
  PRICE_MEDIAN: "hl2",
  PRICE_TYPICAL: "hlc3",
  PRICE_WEIGHTED: "hlcc4",
};
export const APPLIED_PRICE_VALUES: Record<string, number> = {
  PRICE_CLOSE: 1, PRICE_OPEN: 2, PRICE_HIGH: 3, PRICE_LOW: 4, PRICE_MEDIAN: 5, PRICE_TYPICAL: 6, PRICE_WEIGHTED: 7,
};

/** ENUM_MA_METHOD -> Pine moving average function. */
export const MA_METHOD: Record<string, string> = {
  MODE_SMA: "ta.sma",
  MODE_EMA: "ta.ema",
  MODE_SMMA: "ta.rma",
  MODE_LWMA: "ta.wma",
};
export const MA_METHOD_VALUES: Record<string, number> = { MODE_SMA: 0, MODE_EMA: 1, MODE_SMMA: 2, MODE_LWMA: 3 };

/** Plain numeric constants used by EAs. */
export const NUMERIC_CONSTANTS: Record<string, string> = {
  POSITION_TYPE_BUY: "0",
  POSITION_TYPE_SELL: "1",
  ORDER_TYPE_BUY: "0",
  ORDER_TYPE_SELL: "1",
  ORDER_TYPE_BUY_LIMIT: "2",
  ORDER_TYPE_SELL_LIMIT: "3",
  ORDER_TYPE_BUY_STOP: "4",
  ORDER_TYPE_SELL_STOP: "5",
  INIT_SUCCEEDED: "0",
  INIT_FAILED: "1",
  INIT_PARAMETERS_INCORRECT: "32767",
  INVALID_HANDLE: "-1",
  WRONG_VALUE: "-1",
  INT_MAX: "2147483647",
  INT_MIN: "-2147483648",
  DBL_MAX: "1.7976931348623157e308",
  DBL_MIN: "2.2250738585072014e-308",
  DBL_EPSILON: "2.220446049250313e-16",
  M_PI: "math.pi",
  M_E: "math.e",
  MODE_SMA: "0",
  MODE_EMA: "1",
  MODE_SMMA: "2",
  MODE_LWMA: "3",
  MODE_MAIN: "0",
  MODE_SIGNAL: "1",
  MAIN_LINE: "0",
  SIGNAL_LINE: "1",
  BASE_LINE: "0",
  UPPER_BAND: "1",
  LOWER_BAND: "2",
  PLUSDI_LINE: "1",
  MINUSDI_LINE: "2",
  STO_LOWHIGH: "0",
  STO_CLOSECLOSE: "1",
  TRADE_RETCODE_DONE: "10009",
  TRADE_RETCODE_PLACED: "10008",
  ...APPLIED_PRICE_VALUES_AS_STRINGS(),
};

function APPLIED_PRICE_VALUES_AS_STRINGS(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(APPLIED_PRICE_VALUES)) out[k] = String(v);
  return out;
}

/** MQL5 math functions with a direct Pine equivalent. */
export const MATH_FUNCTIONS: Record<string, string> = {
  MathAbs: "math.abs", fabs: "math.abs",
  MathMax: "math.max", fmax: "math.max",
  MathMin: "math.min", fmin: "math.min",
  MathPow: "math.pow", pow: "math.pow",
  MathSqrt: "math.sqrt", sqrt: "math.sqrt",
  MathRound: "math.round", round: "math.round",
  MathFloor: "math.floor", floor: "math.floor",
  MathCeil: "math.ceil", ceil: "math.ceil",
  MathLog: "math.log", log: "math.log",
  MathLog10: "math.log10", log10: "math.log10",
  MathExp: "math.exp", exp: "math.exp",
  MathSin: "math.sin", MathCos: "math.cos", MathTan: "math.tan",
  MathArcsin: "math.asin", MathArccos: "math.acos", MathArctan: "math.atan",
  MathRand: "math.random",
};

/** Return types of MQL5 built-ins we translate (for light type inference). */
export const BUILTIN_RETURN_TYPES: Record<string, string> = {
  MathAbs: "float", MathMax: "float", MathMin: "float", MathPow: "float", MathSqrt: "float",
  MathRound: "int", MathFloor: "int", MathCeil: "int", MathLog: "float", MathLog10: "float", MathExp: "float",
  NormalizeDouble: "float", DoubleToString: "string", IntegerToString: "string", StringFormat: "string",
  TimeToString: "string", StringLen: "int", StringSubstr: "string", StringFind: "int", ToLower: "string",
  iClose: "float", iOpen: "float", iHigh: "float", iLow: "float", iTime: "int", iVolume: "float",
  iTickVolume: "float", iBars: "int", Bars: "int", TimeCurrent: "int", TimeLocal: "int",
  TimeTradeServer: "int", TimeGMT: "int", PositionsTotal: "int", OrdersTotal: "int",
  PositionSelect: "bool", PositionGetDouble: "float", PositionGetInteger: "int", PositionGetString: "string",
  PositionGetTicket: "int", PositionGetSymbol: "string", AccountInfoDouble: "float",
  AccountInfoInteger: "int", SymbolInfoDouble: "float", SymbolInfoInteger: "int", CopyBuffer: "int",
  CopyClose: "int", CopyOpen: "int", CopyHigh: "int", CopyLow: "int", CopyRates: "int", CopyTime: "int",
  Symbol: "string", Period: "string", Point: "float", Digits: "int",
};

/** MQL type -> Pine type keyword. */
export function pineType(mqlType: string): string | null {
  switch (mqlType) {
    case "double":
    case "float":
      return "float";
    case "int":
    case "uint":
    case "long":
    case "ulong":
    case "short":
    case "ushort":
    case "char":
    case "uchar":
    case "datetime":
      return "int";
    case "bool":
      return "bool";
    case "string":
      return "string";
    case "color":
      return "color";
    default:
      return null;
  }
}

export function defaultValue(pine: string): string {
  switch (pine) {
    case "float":
      return "0.0";
    case "int":
      return "0";
    case "bool":
      return "false";
    case "string":
      return '""';
    case "color":
      return "color.gray";
    default:
      return "na";
  }
}

export const COLORS: Record<string, string> = {
  clrRed: "color.red", clrGreen: "color.green", clrBlue: "color.blue", clrYellow: "color.yellow",
  clrWhite: "color.white", clrBlack: "color.black", clrGray: "color.gray", clrOrange: "color.orange",
  clrAqua: "color.aqua", clrLime: "color.lime", clrMagenta: "color.fuchsia", clrNavy: "color.navy",
  clrPurple: "color.purple", clrSilver: "color.silver", clrTeal: "color.teal", clrMaroon: "color.maroon",
  clrOlive: "color.olive", clrNONE: "na", CLR_NONE: "na",
};
