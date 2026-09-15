export function getPositionManagerPrompt(
  side: string,
  symbol: string,
  rules: string,
  entryPrice: number | string,
  currentPrice: number | string,
  leverage: number | string,
  amount: number | string,
  pnlUsdFormatted: string,
  pnlPctFormatted: string,
  mode: string,
  historyJson: string
): string {
  return `
    You are an expert crypto trading AI managing an active ${side} position on ${symbol}.
    KNOWLEDGE BASE (RULES TO FOLLOW):
    ${rules}
    
    TRADE DETAILS:
    - Entry Price: ${entryPrice}
    - Current Price: ${currentPrice}
    - Leverage: ${leverage}x
    - Margin: ${amount} USDT
    - Current PnL: ${pnlUsdFormatted} USDT (${pnlPctFormatted}%)
    - Mode: ${mode}
    HISTORY: ${historyJson}
    
    INSTRUCTIONS:
    Respond ONLY in JSON format:
    {
      "action": "HOLD" | "CLOSE" | "DCA" | "UPDATE_SL",
      "advice": "Short explanation or advice for the user (in Russian)",
      "newSl": number (optional)
    }
    `;
}
