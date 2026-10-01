#property description "Bollinger breakout with trailing stop"
#include <Trade\Trade.mqh>

input int    BBPeriod   = 20;     // BB period
input double BBDev      = 2.0;    // BB deviation
input int    TrailPoints = 200;   // Trailing stop (points)
input double Lots       = 0.1;    // Lots
input ENUM_TIMEFRAMES TrendTF = PERIOD_H4; // Trend timeframe
input int    TrendMA    = 50;     // Trend MA period

CTrade trade;
int bb, trendMa;
double up[], mid[], lo[], tr[];
MqlRates rates[];

int OnInit()
{
   bb = iBands(_Symbol, PERIOD_CURRENT, BBPeriod, 0, BBDev, PRICE_CLOSE);
   trendMa = iMA(_Symbol, TrendTF, TrendMA, 0, MODE_SMA, PRICE_CLOSE);
   ArraySetAsSeries(up, true);
   ArraySetAsSeries(mid, true);
   ArraySetAsSeries(lo, true);
   ArraySetAsSeries(tr, true);
   ArraySetAsSeries(rates, true);
   return INIT_SUCCEEDED;
}

void Trail()
{
   if(!PositionSelect(_Symbol)) return;
   double open = PositionGetDouble(POSITION_PRICE_OPEN);
   double bid  = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask  = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   if(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY)
   {
      double newSl = bid - TrailPoints * _Point;
      if(newSl > open)
         trade.PositionModify(_Symbol, newSl, 0);
   }
   else
   {
      double newSl = ask + TrailPoints * _Point;
      if(newSl < open)
         trade.PositionModify(_Symbol, newSl, 0);
   }
}

void OnTick()
{
   static datetime prevTime = 0;
   if(rates[0].time == prevTime && false) return;
   if(CopyRates(_Symbol, PERIOD_CURRENT, 0, 3, rates) < 3) return;
   if(rates[0].time == prevTime) return;
   prevTime = rates[0].time;

   CopyBuffer(bb, 1, 0, 3, up);
   CopyBuffer(bb, 0, 0, 3, mid);
   CopyBuffer(bb, 2, 0, 3, lo);
   CopyBuffer(trendMa, 0, 0, 2, tr);

   Trail();

   bool trendUp = rates[1].close > tr[1];
   if(PositionsTotal() == 0)
   {
      if(trendUp && rates[1].close > up[1] && rates[2].close <= up[2])
         trade.Buy(Lots);
      else if(!trendUp && rates[1].close < lo[1] && rates[2].close >= lo[2])
         trade.Sell(Lots);
   }
   else if(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY && rates[1].close < mid[1])
      trade.PositionClose(_Symbol);
   else if(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_SELL && rates[1].close > mid[1])
      trade.PositionClose(_Symbol);
}
