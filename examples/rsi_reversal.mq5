#property description "RSI Reversal with time filter"
#include <Trade\Trade.mqh>

enum ENUM_TRADE_DIR { DIR_BOTH = 0, DIR_LONG = 1, DIR_SHORT = 2 };

input group "Signal"
input int                RsiPeriod   = 14;            // RSI period
input ENUM_APPLIED_PRICE RsiPrice    = PRICE_CLOSE;   // RSI price
input double             Oversold    = 30.0;          // Oversold level
input double             Overbought  = 70.0;          // Overbought level
input group "Risk"
input double             Lots        = 0.1;           // Lots
input double             AtrMultSL   = 1.5;           // SL = ATR x
input double             AtrMultTP   = 3.0;           // TP = ATR x
input ENUM_TRADE_DIR     TradeDir    = DIR_BOTH;      // Trade direction
input int                StartHour   = 8;             // Start hour
input int                EndHour     = 20;            // End hour
input int                MaxTradesPerDay = 3;         // Max trades per day

CTrade trade;
int rsiHandle;
int atrHandle;
int tradesToday = 0;
int lastDay = -1;
datetime lastBarTime = 0;

int OnInit()
{
   rsiHandle = iRSI(_Symbol, _Period, RsiPeriod, RsiPrice);
   atrHandle = iATR(_Symbol, _Period, 14);
   if(rsiHandle == INVALID_HANDLE || atrHandle == INVALID_HANDLE)
      return INIT_FAILED;
   if(Oversold >= Overbought)
   {
      Print("Oversold must be below Overbought");
      return INIT_PARAMETERS_INCORRECT;
   }
   return INIT_SUCCEEDED;
}

bool InSession()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   if(dt.day_of_week == 0 || dt.day_of_week == 6) return false;
   return dt.hour >= StartHour && dt.hour < EndHour;
}

void CountDay()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   if(dt.day != lastDay)
   {
      lastDay = dt.day;
      tradesToday = 0;
   }
}

bool HasPosition()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket > 0 && PositionGetString(POSITION_SYMBOL) == _Symbol)
         return true;
   }
   return false;
}

void OnTick()
{
   datetime t = iTime(_Symbol, _Period, 0);
   if(t == lastBarTime) return;
   lastBarTime = t;

   CountDay();
   if(!InSession()) return;
   if(tradesToday >= MaxTradesPerDay) return;
   if(HasPosition()) return;

   double rsi[2], atr[1];
   ArraySetAsSeries(rsi, true);
   if(CopyBuffer(rsiHandle, 0, 1, 2, rsi) != 2) return;
   if(CopyBuffer(atrHandle, 0, 1, 1, atr) != 1) return;

   double price = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double a = atr[0];

   switch(TradeDir)
   {
      case DIR_LONG:
      case DIR_BOTH:
         if(rsi[1] < Oversold && rsi[0] >= Oversold)
         {
            if(trade.Buy(Lots, _Symbol, price, price - AtrMultSL * a, price + AtrMultTP * a))
               tradesToday++;
            return;
         }
         if(TradeDir == DIR_LONG) break;
      case DIR_SHORT:
         if(rsi[1] > Overbought && rsi[0] <= Overbought)
         {
            price = SymbolInfoDouble(_Symbol, SYMBOL_BID);
            if(trade.Sell(Lots, _Symbol, price, price + AtrMultSL * a, price - AtrMultTP * a))
               tradesToday++;
         }
         break;
   }
}
