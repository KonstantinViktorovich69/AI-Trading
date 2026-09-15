export function getSocialScraperPrompt(symbol: string, change: number | string, vol: number | string): string {
  return `You are a real-time Social Media Scraper AI focusing on Crypto Twitter (CT), Telegram groups, and Reddit.
Analyze the symbol: ${symbol}
Recent Price Change 24h: ${change}%
Trading Volume: $${vol}

Estimate the current social media hype level, viral density of mentions (e.g. key KOLs Shilling, Telegram pump channels, extreme FOMO discussions), and sentiment score.
Return a clean JSON mapping:
{
  "score": number (0 to 100, where 100 is hyperscale social mania / viral pump, 0 is total silence),
  "mentions": number (estimated hourly mentions density on CT/TG),
  "trend": "PUMP_HYPE" | "NEUTRAL" | "FADING",
  "sources": ["Twitter/X", "Telegram Channels", "Reddit/r/CryptoCurrency", "Discord KOL Groups"] 
}
Follow the JSON format exactly. No other text.`;
}
