# mt5-to-pine

Rules-based converter from **MQL5 Expert Advisors (MetaTrader 5)** to **Pine Script v6**
strategies, with a small HTTP API (API keys + credits).

The same input always gives the same output. Anything the converter cannot translate
safely is reported with a line number instead of being guessed.

```
MT5 EA (.mq5) --[mt5-to-pine API]--> Pine v6 strategy --[pineforge-codegen]--> C++
```

## What it converts (v0.1)

- `input` parameters → `input.int / float / bool / string / timeframe / source`, enums → option lists
- Indicator handles + `CopyBuffer`: iMA (all methods), iRSI, iATR, iMACD (MT5 SMA signal), iBands,
  iStochastic, iCCI, iADX, iMomentum, iStdDev, iSAR, iWPR, iMFI, iOBV, iAO — other timeframes via `request.security`
- Prices: `iClose/iOpen/iHigh/iLow/iTime`, `CopyClose/...`, `CopyRates` (`rates[i].close`)
- Trading with `CTrade`: `Buy/Sell` (+SL/TP), `PositionOpen`, `BuyLimit/SellLimit/BuyStop/SellStop`,
  `PositionClose`, `PositionClosePartial`, `PositionModify`; position queries (`PositionSelect`,
  `PositionsTotal`, `PositionGetInteger/Double/...`, `CPositionInfo`)
- Control flow: `if/else`, `for`, `while`, `do-while`, `switch` (with fall-through), early `return`
  (also inside loops), user functions (functions that change globals are inlined)
- New-bar logic: when the EA acts on a new bar and reads closed bars, indexes are shifted by one
  so Pine's bar-close run lines up with MT5
- `Print/PrintFormat/Alert`, `StringFormat`, `DoubleToString`, `NormalizeDouble`, math functions,
  `TimeToStruct` / `MqlDateTime`, account and symbol info (with notes where Pine differs)

Not yet: indicators (`OnCalculate`), classes, `iCustom`, general arrays, `OrderSend` with
`MqlTradeRequest`, trade history, `OnTimer`. These are reported as errors.

## Result

```json
{
  "status": "full | partial | failed",
  "pine": "//@version=6 ...",
  "issues": [{ "line": 42, "severity": "error | warning | info", "message": "..." }],
  "stats": { "inputs": 7, "indicators": 2, "functions": 1, "linesIn": 80, "linesOut": 60, "barShift": 1 },
  "credits_remaining": 49
}
```

- `full`: no errors. Warnings explain where Pine behaves differently from MT5 (spread, lot size, time zone).
- `partial`: Pine was produced, but the listed errors need manual work.
- `failed`: the MQL5 code could not be read (no credit is charged).

## Run it

```bash
npm install
npm test                      # unit, example and API tests
npm run convert examples/ma_cross.mq5

npx tsx src/admin.ts create luis 100     # prints a new API key once
npm run dev                              # API on :8080
```

```bash
curl -s localhost:8080/v1/convert \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: text/plain" \
  --data-binary @examples/ma_cross.mq5
```

Endpoints: `POST /v1/convert` (JSON `{"source": "...", "options": {"title": "...", "alignNewBar": true}}`
or `text/plain`), `GET /v1/usage`, `GET /v1/health`. Limits: 512 KB source, 60 requests/minute per key.

## Checking output with PineForge

`scripts/pineforge_check.py` runs Pine files through `pineforge-codegen` (Pine → C++).
It is a dev-only check; pineforge-codegen is PolyForm Noncommercial licensed and is not shipped here.

```bash
python3 -m venv .pf && .pf/bin/pip install pineforge-codegen
PINEFORGE_PYTHON=.pf/bin/python npm test
```
