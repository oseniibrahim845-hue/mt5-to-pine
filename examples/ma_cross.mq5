//+------------------------------------------------------------------+
//|                                                    MA_Cross.mq5  |
//+------------------------------------------------------------------+
#property copyright "Example"
#property description "MA Cross EA"
#property version   "1.00"
#include <Trade\Trade.mqh>

input int    InpFastPeriod = 10;     // Fast MA period
input int    InpSlowPeriod = 30;     // Slow MA period
input ENUM_MA_METHOD InpMethod = MODE_EMA; // MA method
input double InpLots       = 0.10;   // Lot size
input int    InpStopLoss   = 300;    // Stop loss (points)
input int    InpTakeProfit = 600;    // Take profit (points)
input ulong  InpMagic      = 12345;  // Magic number

CTrade trade;
int    hFast, hSlow;
double fast[], slow[];

int OnInit()
{
   hFast = iMA(_Symbol, PERIOD_CURRENT, InpFastPeriod, 0, InpMethod, PRICE_CLOSE);
   hSlow = iMA(_Symbol, PERIOD_CURRENT, InpSlowPeriod, 0, InpMethod, PRICE_CLOSE);
   if(hFast == INVALID_HANDLE || hSlow == INVALID_HANDLE)
   {
      Print("Failed to create MA handles");
      return(INIT_FAILED);
   }
   ArraySetAsSeries(fast, true);
   ArraySetAsSeries(slow, true);
   trade.SetExpertMagicNumber(InpMagic);
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   IndicatorRelease(hFast);
   IndicatorRelease(hSlow);
}

bool IsNewBar()
{
   static datetime lastBar = 0;
   datetime cur = iTime(_Symbol, PERIOD_CURRENT, 0);
   if(cur == lastBar) return false;
   lastBar = cur;
   return true;
}

void OnTick()
{
   if(!IsNewBar()) return;
   if(CopyBuffer(hFast, 0, 0, 3, fast) < 3) return;
   if(CopyBuffer(hSlow, 0, 0, 3, slow) < 3) return;

   bool crossUp   = fast[2] < slow[2] && fast[1] > slow[1];
   bool crossDown = fast[2] > slow[2] && fast[1] < slow[1];

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);

   if(crossUp)
   {
      if(PositionSelect(_Symbol) && PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_SELL)
         trade.PositionClose(_Symbol);
      if(!PositionSelect(_Symbol))
      {
         double sl = NormalizeDouble(ask - InpStopLoss * _Point, _Digits);
         double tp = NormalizeDouble(ask + InpTakeProfit * _Point, _Digits);
         trade.Buy(InpLots, _Symbol, ask, sl, tp, "MA cross buy");
      }
   }
   else if(crossDown)
   {
      if(PositionSelect(_Symbol) && PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY)
         trade.PositionClose(_Symbol);
      if(!PositionSelect(_Symbol))
      {
         double sl = NormalizeDouble(bid + InpStopLoss * _Point, _Digits);
         double tp = NormalizeDouble(bid - InpTakeProfit * _Point, _Digits);
         trade.Sell(InpLots, _Symbol, bid, sl, tp, "MA cross sell");
      }
   }
}
