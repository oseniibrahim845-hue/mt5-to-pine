#property description "MACD + Stochastic"
#include <Trade\Trade.mqh>
#define MAGIC 777
#define SL_POINTS 400

input int FastEMA = 12;
input int SlowEMA = 26;
input int SignalSMA = 9;
input int KPeriod = 5;
input int DPeriod = 3;
input int Slowing = 3;
input double RiskPercent = 1.0; // Risk % per trade

CTrade trade;
int macdH, stochH;

int OnInit()
{
   macdH  = iMACD(NULL, 0, FastEMA, SlowEMA, SignalSMA, PRICE_CLOSE);
   stochH = iStochastic(NULL, 0, KPeriod, DPeriod, Slowing, MODE_SMA, STO_LOWHIGH);
   trade.SetExpertMagicNumber(MAGIC);
   return INIT_SUCCEEDED;
}

double CalcLots(double slPoints)
{
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double risk = balance * RiskPercent / 100.0;
   if(tickValue <= 0 || slPoints <= 0) return 0.01;
   double lots = risk / (slPoints * tickValue);
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   lots = MathFloor(lots / step) * step;
   return MathMax(lots, 0.01);
}

void OnTick()
{
   double macd[], signal[], k[], d[];
   ArraySetAsSeries(macd, true);
   ArraySetAsSeries(signal, true);
   ArraySetAsSeries(k, true);
   ArraySetAsSeries(d, true);
   if(CopyBuffer(macdH, MAIN_LINE, 0, 3, macd) <= 0) return;
   if(CopyBuffer(macdH, SIGNAL_LINE, 0, 3, signal) <= 0) return;
   if(CopyBuffer(stochH, MAIN_LINE, 0, 3, k) <= 0) return;
   if(CopyBuffer(stochH, SIGNAL_LINE, 0, 3, d) <= 0) return;

   bool macdUp = macd[1] > signal[1] && macd[2] <= signal[2];
   bool macdDn = macd[1] < signal[1] && macd[2] >= signal[2];
   bool stochOkBuy = k[1] < 50 && k[1] > d[1];
   bool stochOkSell = k[1] > 50 && k[1] < d[1];

   if(PositionSelect(_Symbol)) return;

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double lots = CalcLots(SL_POINTS);
   string msg = "Signal at " + DoubleToString(ask, _Digits) + " lots=" + lots;

   if(macdUp && stochOkBuy)
   {
      trade.Buy(lots, _Symbol, ask, ask - SL_POINTS * _Point, 0);
      Print(msg);
   }
   else if(macdDn && stochOkSell)
   {
      trade.Sell(lots, _Symbol, bid, bid + SL_POINTS * _Point, 0);
      PrintFormat("Sell %.2f lots at %.5f", lots, bid);
   }
}
