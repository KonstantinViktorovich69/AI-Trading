import React, { useEffect, useRef, useState, memo, useCallback } from 'react';
import { createChart, ColorType, CandlestickSeries, HistogramSeries, LineSeries, createSeriesMarkers } from 'lightweight-charts';
import { Loader2, X, RefreshCw, Layers, TrendingDown, HelpCircle, Activity } from 'lucide-react';
import { cn } from '../lib/utils';

// --- Mathematical Indicators Calculators ---

function cleanSeriesData(data: any[]) {
  if (!data || data.length === 0) return [];
  const sorted = [...data].sort((a, b) => {
    const tA = typeof a.time === 'number' ? a.time : (a.time?.timestamp || 0);
    const tB = typeof b.time === 'number' ? b.time : (b.time?.timestamp || 0);
    return tA - tB;
  });
  const uniqueAndAscending: any[] = [];
  let lastTime: number | null = null;
  
  for (const item of sorted) {
    if (item) {
      const t = typeof item.time === 'number' ? item.time : (item.time?.timestamp || null);
      if (t !== null && !isNaN(t)) {
        if (lastTime === null || t > lastTime) {
          lastTime = t;
          uniqueAndAscending.push({ ...item, time: t });
        }
      }
    }
  }
  return uniqueAndAscending;
}

function getPriceFormatForCandles(candles: any[]) {
  if (!candles || candles.length === 0) return { type: 'price', precision: 2, minMove: 0.01 };
  
  const samplePrice = candles[0].close;
  
  if (samplePrice < 0.0001) {
    return { type: 'price', precision: 8, minMove: 0.00000001 };
  } else if (samplePrice < 0.01) {
    return { type: 'price', precision: 6, minMove: 0.000001 };
  } else if (samplePrice < 1.0) {
    return { type: 'price', precision: 5, minMove: 0.00001 };
  } else if (samplePrice < 10.0) {
    return { type: 'price', precision: 4, minMove: 0.0001 };
  } else if (samplePrice < 100.0) {
    return { type: 'price', precision: 3, minMove: 0.001 };
  } else {
    return { type: 'price', precision: 2, minMove: 0.01 };
  }
}

function calculateSMA(candles: any[], period: number = 20) {
  const smaData = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) continue;
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += candles[i - j].close;
    }
    smaData.push({
      time: candles[i].time,
      value: sum / period
    });
  }
  return smaData;
}

function calculateVWAP(candles: any[]) {
  const vwapData = [];
  let cumPriceVol = 0;
  let cumVol = 0;
  let lastDay = -1;
  
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const date = new Date((typeof c.time === 'number' ? c.time : c.time.timestamp) * 1000);
    const day = date.getUTCDate();
    
    // Reset daily at UTC 00:00 midnight
    if (day !== lastDay) {
      cumPriceVol = 0;
      cumVol = 0;
      lastDay = day;
    }
    
    const typicalPrice = (c.high + c.low + c.close) / 3;
    const vol = c.value || c.volume || 1; 
    
    cumPriceVol += typicalPrice * vol;
    cumVol += vol;
    
    vwapData.push({
      time: c.time,
      value: cumVol > 0 ? cumPriceVol / cumVol : typicalPrice
    });
  }
  return vwapData;
}

function calculateParabolicSAR(candles: any[]) {
  if (candles.length < 2) return [];
  const sarPoints: { time: any; value: number; isLong: boolean }[] = [];
  
  let isLong = true; // start assuming uptrend
  let sar = candles[0].low;
  let ep = candles[0].high;
  let af = 0.02;
  
  sarPoints.push({ time: candles[0].time, value: sar, isLong });
  
  for (let i = 1; i < candles.length; i++) {
    const prevCandle = candles[i - 1];
    const currCandle = candles[i];
    
    let nextSar = sar + af * (ep - sar);
    
    if (isLong) {
      const minLow = Math.min(prevCandle.low, currCandle.low);
      if (nextSar > minLow) {
        nextSar = minLow;
      }
      if (currCandle.low < nextSar) {
        isLong = false;
        nextSar = ep;
        ep = currCandle.low;
        af = 0.02;
      } else {
        if (currCandle.high > ep) {
          ep = currCandle.high;
          af = Math.min(af + 0.02, 0.2);
        }
      }
    } else {
      const maxHigh = Math.max(prevCandle.high, currCandle.high);
      if (nextSar < maxHigh) {
        nextSar = maxHigh;
      }
      if (currCandle.high > nextSar) {
        isLong = true;
        nextSar = ep;
        ep = currCandle.high;
        af = 0.02;
      } else {
        if (currCandle.low < ep) {
          ep = currCandle.low;
          af = Math.min(af + 0.02, 0.2);
        }
      }
    }
    
    sar = nextSar;
    sarPoints.push({ time: currCandle.time, value: sar, isLong });
  }
  
  return sarPoints;
}

export const TradingChart = memo(function TradingChart({ 
  symbol, 
  exchange, 
  onClose,
  trades = []
}: { 
  symbol: string; 
  exchange: string; 
  onClose?: () => void;
  trades?: any[];
}) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tf, setTf] = useState('15m');
  
  const [rawCandles, setRawCandles] = useState<any[]>([]);
  const [showVwap, setShowVwap] = useState(true); 
  const [showSma, setShowSma] = useState(true);   
  const [showSar, setShowSar] = useState(false);  
  const [showSignals, setShowSignals] = useState(true); 
  const [showTradeMarkers, setShowTradeMarkers] = useState(true);
  const [showLiquidity, setShowLiquidity] = useState(true);
  const [showImbalances, setShowImbalances] = useState(true);
  
  const priceLinesRef = useRef<any[]>([]);
  
  const [statCounts, setStatCounts] = useState({ sweeps: 0, pinbars: 0, sarReversals: 0 });

  // Initialize Lightweight Chart
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const { clientWidth, clientHeight } = chartContainerRef.current;
    
    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#09090b' },
        textColor: '#a1a1aa', // zinc-400
      },
      grid: {
        vertLines: { color: '#18181b' }, // zinc-900 (ultra stealthy and clear)
        horzLines: { color: '#18181b' },
      },
      crosshair: {
        mode: 1, 
      },
      width: clientWidth || 600,
      height: clientHeight || 400,
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
      }
    });

    // Candlesticks Series
    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981', 
      downColor: '#ef4444', 
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    });

    // Volume Series
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '', // Пустая строка для независимого оверлейного масштаба (исправляет чёрный экран)
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    // Indicators Series (Line types)
    const vwapSeries = chart.addSeries(LineSeries, {
      color: '#8b5cf6', // Indigo/violet
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const smaSeries = chart.addSeries(LineSeries, {
      color: '#f59e0b', // Amber
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const sarSeries = chart.addSeries(LineSeries, {
      color: '#ec4899', // Pink
      lineWidth: 1,
      lineStyle: 2, // Dotted
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const markersPlugin = createSeriesMarkers(candlestickSeries, []);
    candlestickSeries.attachPrimitive(markersPlugin as any);

    chartRef.current = { chart, candlestickSeries, volumeSeries, vwapSeries, smaSeries, sarSeries, markersPlugin };

    const resizeObserver = new ResizeObserver((entries) => {
      if (entries.length > 0 && chartRef.current) {
        const { width, height } = entries[0].contentRect;
        requestAnimationFrame(() => {
          if (chartRef.current) {
            chartRef.current.chart.resize(width, height);
            if (width > 0 && height > 0) {
              chartRef.current.chart.timeScale().fitContent();
            }
          }
        });
      }
    });

    resizeObserver.observe(chartContainerRef.current);

    return () => {
      if (chartContainerRef.current) {
        resizeObserver.unobserve(chartContainerRef.current);
      }
      if (chartRef.current) {
        chart.remove();
        chartRef.current = null;
      }
    };
  }, []);

  const lastCandleRef = useRef<any>(null);
  const isMountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Fetch API Candle history
  const fetchData = useCallback(async (retryCount = 0) => {
    // Abort previous in-flight chart request to prevent race conditions
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const clientTimeoutId = setTimeout(() => controller.abort(), 9000);

    setLoading(true);
    setError(null);
    try {
       const rawEx = (exchange || 'weex').toLowerCase();
       const encodedSymbol = encodeURIComponent(symbol || 'BTC/USDT');
       const apiUrl = `/api/chart/${rawEx}/${encodedSymbol}?tf=${tf || '15m'}`;
       const res = await fetch(apiUrl, { signal: controller.signal });
       clearTimeout(clientTimeoutId);
       
       const contentType = res.headers.get("content-type");
       if (!contentType || !contentType.includes("application/json")) {
          const text = await res.text();
          if (text.includes("Rate exceeded") || res.status === 429) {
             console.warn(`[CHART] Rate limit exceeded for ${symbol}, will retry...`);
             throw new Error("Rate limit exceeded");
          }
          const isServerBooting = res.status === 502 || res.status === 503 || res.status === 504 || 
                                  text.includes("Starting Server") || text.includes("Service Unavailable");
          if (isServerBooting) {
             console.warn(`[CHART] Server is starting or temporarily unavailable (${res.status}), retrying for ${symbol}...`);
             throw new Error("Server starting, will retry");
          }
          if (retryCount < 3) {
             console.warn(`[CHART] Received ${contentType} instead of JSON (${res.status}), retrying for ${symbol}...`);
             throw new Error("Temporary non-JSON response, will retry");
          }
          console.error(`[CHART] Expected JSON but got ${contentType}:`, text.substring(0, 200));
          throw new Error(`Server returned non-JSON response (${res.status}).`);
       }

       const text = await res.text();
       if (!text.trim()) {
          throw new Error("Server returned an empty response.");
       }
       const data = JSON.parse(text);
       console.log(`[CHART] API Response for ${symbol}:`, { success: data.success, count: data.data?.length });
       
       if (!isMountedRef.current) return;
       if (!res.ok || !data.success) throw new Error(data.error || "Failed to load chart data");
       
       if (data.data && data.data.length > 0 && chartRef.current) {
          data.data = cleanSeriesData(data.data);
          // Sort ascending by time and deduplicate duplicate timestamps to prevent Lightweight Charts crash
          const sortedData = [...data.data].sort((a: any, b: any) => a.time - b.time);
          const uniqueSortedData: any[] = [];
          const seenTimes = new Set<number>();
          
          for (const item of sortedData) {
             if (item && typeof item.time === 'number') {
                if (!seenTimes.has(item.time)) {
                   seenTimes.add(item.time);
                   uniqueSortedData.push(item);
                }
             }
          }

          if (uniqueSortedData.length === 0) {
             throw new Error("No unique data points available");
          }

          const mappedCandles = uniqueSortedData.map((d: any) => ({
             time: d.time,
             open: Number(d.open),
             high: Number(d.high),
             low: Number(d.low),
             close: Number(d.close),
             value: Number(d.value || 0)
          }));
          
          const cleanCandlesForChart = mappedCandles.map((c: any) => ({
             time: c.time,
             open: c.open,
             high: c.high,
             low: c.low,
             close: c.close
          }));
          
          lastCandleRef.current = { ...mappedCandles[mappedCandles.length - 1] };
          
          // Динамический формат точности цены для монет разной стоимости
          const formatOpts = getPriceFormatForCandles(mappedCandles);
          chartRef.current.candlestickSeries.applyOptions({
             priceFormat: formatOpts
          });

          chartRef.current.candlestickSeries.setData(cleanCandlesForChart);
          chartRef.current.volumeSeries.setData(uniqueSortedData.map((d: any) => ({
             time: d.time,
             value: Number(d.value || 0),
             color: Number(d.close) > Number(d.open) ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.25)'
          })));
          
          chartRef.current.chart.timeScale().fitContent();
          setRawCandles(mappedCandles);
          setLoading(false);
       } else {
          if (isMountedRef.current) {
              setError("No data available");
              setLoading(false);
          }
       }
    } catch (err: any) {
       if (!isMountedRef.current) return;
       if (err.name === 'AbortError') {
          // In-flight request was intentionally cancelled for a newer request; do not display an error
          return;
       }
       if (err.message === "Rate limit exceeded" || err.message?.includes("will retry")) {
          if (retryCount < 5) {
             setTimeout(() => fetchData(retryCount + 1), Math.min(3000, 1500 * (retryCount + 1)));
             return;
          } else {
             setError(err.message === "Rate limit exceeded" ? "Лимит запросов. Пожалуйста, подождите." : "Сервер временно недоступен. Обновите график.");
          }
       } else {
          setError(err.message?.includes("Failed to fetch") ? "Ошибка сети (таймаут соединения)" : err.message);
       }
       setLoading(false);
    }
  }, [symbol, exchange, tf]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Real-time updates handler (resilient with backoff & cleanup on poor connection)
  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let isCleanedUp = false;
    let retryCount = 0;

    const connect = () => {
      if (isCleanedUp) return;
      if (source) {
        source.close();
      }

      source = new EventSource('/api/stream/prices');

      source.onmessage = (e) => {
        try {
          if (!chartRef.current) return;
          retryCount = 0;
          const prices = JSON.parse(e.data);
          const cleanSym = symbol.replace(/[\/:]/g, '').toUpperCase();
          const p = prices[cleanSym] || 
                    prices[symbol] || 
                    prices[symbol.replace('/', '')];
          if (p !== undefined && chartRef.current) {
            const now = Math.floor(Date.now() / 1000);
            
            let duration = 60;
            if (tf === '5m') duration = 300;
            else if (tf === '15m') duration = 900;
            else if (tf === '1h') duration = 3600;
            else if (tf === '4h') duration = 14400;
            else if (tf === '1d') duration = 86400;
            
            setRawCandles(prev => {
              if (prev.length === 0) return prev;
              
              const lc = prev[prev.length - 1];
              const newCandleTime = Math.floor(now / duration) * duration;
              if (now >= lc.time + duration && newCandleTime > lc.time) {
                const newCandle = {
                  time: newCandleTime,
                  open: lc.close,
                  high: p,
                  low: p,
                  close: p,
                  value: 0
                };
                try {
                  chartRef.current.candlestickSeries.update(newCandle);
                  chartRef.current.volumeSeries.update({
                    time: newCandle.time,
                    value: 0,
                    color: 'rgba(16, 185, 129, 0.25)'
                  });
                } catch (err1) {
                  console.warn("[CHART] Realtime append error:", err1);
                }
                lastCandleRef.current = newCandle;
                return [...prev, newCandle];
              } else {
                const copy = [...prev];
                const lastIdx = copy.length - 1;
                const candle = { ...copy[lastIdx] };
                candle.close = p;
                if (p > candle.high) candle.high = p;
                if (p < candle.low) candle.low = p;
                
                try {
                  chartRef.current.candlestickSeries.update(candle);
                } catch (err2) {
                  console.warn("[CHART] Realtime update error:", err2);
                }
                lastCandleRef.current = candle;
                copy[lastIdx] = candle;
                return copy;
              }
            });
          }
        } catch(err) {}
      };

      source.onerror = () => {
        if (isCleanedUp) return;
        source?.close();
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        const delay = Math.min(5000, 500 * Math.pow(1.5, retryCount++));
        reconnectTimeout = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      isCleanedUp = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (source) source.close();
    };
  }, [symbol, tf]);

  // Indicators Rendering Effect
  useEffect(() => {
    if (!chartRef.current || rawCandles.length === 0) return;

    const { vwapSeries, smaSeries, sarSeries, candlestickSeries, markersPlugin } = chartRef.current;

    // 1. VWAP
    if (showVwap) {
      const vwapData = calculateVWAP(rawCandles);
      vwapSeries.setData(cleanSeriesData(vwapData));
    } else {
      vwapSeries.setData([]);
    }

    // 2. SMA
    if (showSma) {
      const smaData = calculateSMA(rawCandles, 20);
      smaSeries.setData(cleanSeriesData(smaData));
    } else {
      smaSeries.setData([]);
    }

    // 3. Parabolic SAR & Patters identification
    const sarData = calculateParabolicSAR(rawCandles);
    if (showSar) {
      const formattedSar = sarData.map(s => ({
        time: s.time,
        value: s.value
      }));
      sarSeries.setData(cleanSeriesData(formattedSar));
    } else {
      sarSeries.setData([]);
    }

    // 4. Signals (Markers) Generation & Counters
    let sweeps = 0;
    let pinbars = 0;
    let sarReversals = 0;

    const markers: any[] = [];

    if (showSignals) {
      for (let i = 1; i < rawCandles.length; i++) {
        const c = rawCandles[i];
        let addedMarker = false;

        // Pattern A: SAR Peak Reversal (Bearish Crossover)
        const currentSar = sarData[i];
        const prevSar = sarData[i - 1];
        if (prevSar && currentSar && prevSar.isLong && !currentSar.isLong) {
          markers.push({
            time: c.time,
            position: 'aboveBar',
            color: '#ec4899', // rose-500
            shape: 'circle',
            text: 'SAR ⬇',
            size: 1.2
          });
          addedMarker = true;
          sarReversals++;
        }

        // Pattern B: Liquidity Sweep
        if (i >= 12 && !addedMarker) {
          const slice = rawCandles.slice(i - 12, i);
          const maxPrevHigh = Math.max(...slice.map(s => s.high));
          const candleRange = c.low > 0 ? ((c.high - c.low) / c.low) * 100 : 0;
          if (candleRange >= 0.15 && c.high > maxPrevHigh && c.close < (c.high + c.low) / 2) {
            markers.push({
              time: c.time,
              position: 'aboveBar',
              color: '#fbbf24', // amber-400
              shape: 'arrowDown',
              text: 'Sweep',
              size: 1.5
            });
            addedMarker = true;
            sweeps++;
          }
        }

        // Pattern C: Pinbar Rejection (Shadow > 60% of candle range)
        if (!addedMarker) {
          const range = c.high - c.low;
          const candleRange = c.low > 0 ? (range / c.low) * 100 : 0;
          const upperShadow = c.high - Math.max(c.open, c.close);
          if (range > 0 && candleRange >= 0.15 && (upperShadow / range) > 0.6) {
            markers.push({
              time: c.time,
              position: 'aboveBar',
              color: '#f43f5e', // rose-400
              shape: 'arrowDown',
              text: 'Pinbar',
              size: 1.1
            });
            pinbars++;
          }
        }
      }
    }

    // Process trade execution events block if showTradeMarkers is true
    const tradeMarkers: any[] = [];
    if (showTradeMarkers && trades && trades.length > 0) {
      // Inline helper to find closest candle time
      const findBestCandleTime = (eventTimeStr: string | number) => {
        if (rawCandles.length === 0) return null;
        const timeVal = typeof eventTimeStr === 'number' ? eventTimeStr : new Date(eventTimeStr).getTime();
        const eventSecs = Math.floor(timeVal / 1000);
        if (isNaN(eventSecs)) return null;
        
        let bestCandle = rawCandles[0];
        let minDiff = Math.abs(rawCandles[0].time - eventSecs);
        
        for (let i = 1; i < rawCandles.length; i++) {
          const diff = Math.abs(rawCandles[i].time - eventSecs);
          if (diff < minDiff) {
            minDiff = diff;
            bestCandle = rawCandles[i];
          }
        }
        return bestCandle.time;
      };

      trades.forEach((trade) => {
        const activeSymClean = trade.symbol.replace(/[\/:]/g, '').toUpperCase();
        const chartSymClean = symbol.replace(/[\/:]/g, '').toUpperCase();
        if (activeSymClean !== chartSymClean) return;

        const isShort = trade.side === 'SHORT';

        if (trade.history && trade.history.length > 0) {
          trade.history.forEach((h: any) => {
            const candleTime = findBestCandleTime(h.time);
            if (!candleTime) return;

            const price = h.price || trade.entryPrice;
            if (h.type === 'OPEN') {
              tradeMarkers.push({
                time: candleTime,
                position: isShort ? 'aboveBar' : 'belowBar',
                color: isShort ? '#ef4444' : '#10b981',
                shape: isShort ? 'arrowDown' : 'arrowUp',
                text: `${isShort ? 'ШОРТ' : 'ЛОНГ'} Вход: $${price.toFixed(5)}`,
                size: 1.5,
              });
            } else if (h.type === 'AVERAGE' || h.type === 'ADD' || h.type === 'DCA') {
              tradeMarkers.push({
                time: candleTime,
                position: isShort ? 'aboveBar' : 'belowBar',
                color: '#fbbf24',
                shape: isShort ? 'arrowDown' : 'arrowUp',
                text: `УСР: $${price.toFixed(5)}`,
                size: 1.3,
              });
            } else if (h.type === 'CLOSE') {
              tradeMarkers.push({
                time: candleTime,
                position: isShort ? 'belowBar' : 'aboveBar',
                color: isShort ? '#10b981' : '#ef4444',
                shape: isShort ? 'arrowUp' : 'arrowDown',
                text: `Выход: $${price.toFixed(5)}`,
                size: 1.5,
              });
            }
          });
        } else {
          // Fallback to active trade basic entry/exit markers
          const entryTime = trade.entryTime || trade.createdAt || trade.openTime;
          if (entryTime) {
            const candleTime = findBestCandleTime(entryTime);
            if (candleTime) {
              tradeMarkers.push({
                time: candleTime,
                position: isShort ? 'aboveBar' : 'belowBar',
                color: isShort ? '#ef4444' : '#10b981',
                shape: isShort ? 'arrowDown' : 'arrowUp',
                text: `${isShort ? 'ШОРТ' : 'ЛОНГ'} Вход: $${trade.entryPrice.toFixed(5)}`,
                size: 1.5,
              });
            }
          }
          const closeTime = trade.closeTime || trade.updatedAt;
          if (trade.status === 'CLOSED' && trade.closePrice && closeTime) {
            const candleTime = findBestCandleTime(closeTime);
            if (candleTime) {
              tradeMarkers.push({
                time: candleTime,
                position: isShort ? 'belowBar' : 'aboveBar',
                color: isShort ? '#10b981' : '#ef4444',
                shape: isShort ? 'arrowUp' : 'arrowDown',
                text: `Выход: $${trade.closePrice.toFixed(5)}`,
                size: 1.5,
              });
            }
          }
        }
      });
    }

    const allMarkers = [...markers, ...tradeMarkers].sort((a, b) => a.time - b.time);
    if (markersPlugin) {
      markersPlugin.setMarkers(allMarkers);
    }

    setStatCounts(prev => {
      if (prev.sweeps === sweeps && prev.pinbars === pinbars && prev.sarReversals === sarReversals) {
        return prev;
      }
      return { sweeps, pinbars, sarReversals };
    });

    // --- АДДИТИВНО: Расчет и отображение ценовых уровней (TP/SL, Ликвидность, Имбаланс FVG) ---
    
    // Сброс старых линий перед перерисовкой
    priceLinesRef.current.forEach(line => {
      try {
        candlestickSeries.removePriceLine(line);
      } catch (err) {}
    });
    priceLinesRef.current = [];

    // 1. Отображение активных TP и SL уровней
    if (showTradeMarkers && trades && trades.length > 0) {
      const activeTradesForThisSymbol = trades.filter(t => {
        const tSym = t.symbol.replace(/[\/:]/g, '').toUpperCase();
        const cSym = symbol.replace(/[\/:]/g, '').toUpperCase();
        return tSym === cSym && t.status === 'OPEN';
      });

      activeTradesForThisSymbol.forEach(t => {
        if (t.takeProfit && Number(t.takeProfit) > 0) {
          try {
            const tpLine = candlestickSeries.createPriceLine({
              price: Number(t.takeProfit),
              color: '#10b981', // emerald-500
              lineWidth: 1.5,
              lineStyle: 2, // Dashed
              axisLabelVisible: true,
              title: `ТП (Выход): $${Number(t.takeProfit).toFixed(5)}`,
            });
            priceLinesRef.current.push(tpLine);
          } catch (tpErr) {}
        }
        if (t.stopLoss && Number(t.stopLoss) > 0) {
          try {
            const slLine = candlestickSeries.createPriceLine({
              price: Number(t.stopLoss),
              color: '#f43f5e', // rose-500
              lineWidth: 1.5,
              lineStyle: 2, // Dashed
              axisLabelVisible: true,
              title: `СЛ (Риск): $${Number(t.stopLoss).toFixed(5)}`,
            });
            priceLinesRef.current.push(slLine);
          } catch (slErr) {}
        }
      });
    }

    // 2. Индикаторы локальной ликвидности (пики High / лоу Low за последние 40 свечей)
    if (showLiquidity && rawCandles.length >= 15) {
      const lookback = Math.min(rawCandles.length, 40);
      const sliceCandles = rawCandles.slice(-lookback);
      
      const maxHigh = Math.max(...sliceCandles.map(c => c.high));
      const minLow = Math.min(...sliceCandles.map(c => c.low));
      
      try {
        const highLine = candlestickSeries.createPriceLine({
          price: maxHigh,
          color: '#fbbf24', // amber-400
          lineWidth: 1,
          lineStyle: 1, // Solid
          axisLabelVisible: true,
          title: `ЛИКВИДНОСТЬ (ЛОКАЛЬНЫЙ ХАЙ): $${maxHigh.toFixed(5)}`,
        });
        priceLinesRef.current.push(highLine);
      } catch (errHigh) {}

      try {
        const lowLine = candlestickSeries.createPriceLine({
          price: minLow,
          color: '#6366f1', // indigo-500
          lineWidth: 1,
          lineStyle: 1, // Solid
          axisLabelVisible: true,
          title: `ЛИКВИДНОСТЬ (ЛОКАЛЬНЫЙ ЛОУ): $${minLow.toFixed(5)}`,
        });
        priceLinesRef.current.push(lowLine);
      } catch (errLow) {}
    }

    // 3. Зоны имбаланса (Fair Value Gap - FVG)
    if (showImbalances && rawCandles.length >= 3) {
      const lookback = Math.min(rawCandles.length, 50);
      const startIdx = rawCandles.length - lookback;
      
      const bullishFVGs: { mid: number; high: number; low: number; time: number }[] = [];
      const bearishFVGs: { mid: number; high: number; low: number; time: number }[] = [];
      
      for (let i = startIdx; i < rawCandles.length - 2; i++) {
        const c1 = rawCandles[i];
        const c2 = rawCandles[i+1];
        const c3 = rawCandles[i+2];
        
        // Бычий FVG (Поддержка)
        if (c1.high < c3.low) {
          const remainingCandles = rawCandles.slice(i + 3);
          const minLow = remainingCandles.length > 0 
            ? Math.min(...remainingCandles.map(c => c.low))
            : Infinity;
          
          if (minLow > c1.high) {
            bullishFVGs.push({
              mid: (c1.high + c3.low) / 2,
              high: c3.low,
              low: c1.high,
              time: c2.time
            });
          }
        }
        
        // Медвежий FVG (Сопротивление)
        if (c1.low > c3.high) {
          const remainingCandles = rawCandles.slice(i + 3);
          const maxHigh = remainingCandles.length > 0
            ? Math.max(...remainingCandles.map(c => c.high))
            : -Infinity;
            
          if (maxHigh < c1.low) {
            bearishFVGs.push({
              mid: (c1.low + c3.high) / 2,
              high: c1.low,
              low: c3.high,
              time: c2.time
            });
          }
        }
      }
      
      // Берем по 2 самых свежих имбаланса
      const activeBullish = bullishFVGs.slice(-2);
      const activeBearish = bearishFVGs.slice(-2);
      
      activeBullish.forEach(fvg => {
        try {
          const l = candlestickSeries.createPriceLine({
            price: fvg.mid,
            color: '#10b981', // green/emerald for support
            lineWidth: 1,
            lineStyle: 3, // Dotted style
            axisLabelVisible: true,
            title: `ИМБАЛАНС FVG (ПОДДЕРЖКА): $${fvg.low.toFixed(5)} - $${fvg.high.toFixed(5)}`,
          });
          priceLinesRef.current.push(l);
        } catch (errBull) {}
      });
      
      activeBearish.forEach(fvg => {
        try {
          const l = candlestickSeries.createPriceLine({
            price: fvg.mid,
            color: '#f43f5e', // rose/red for resistance
            lineWidth: 1,
            lineStyle: 3, // Dotted style
            axisLabelVisible: true,
            title: `ИМБАЛАНС FVG (СОПРОТИВЛЕНИЕ): $${fvg.low.toFixed(5)} - $${fvg.high.toFixed(5)}`,
          });
          priceLinesRef.current.push(l);
        } catch (errBear) {}
      });
    }

  }, [rawCandles, showVwap, showSma, showSar, showSignals, showTradeMarkers, showLiquidity, showImbalances, trades, symbol]);

  return (
    <div className="w-full h-full relative z-20 flex flex-col bg-zinc-950 font-sans select-none">
      
      {/* 1. Static Responsive Control Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-zinc-900/40 border-b border-zinc-900 min-h-[50px] shrink-0">
        
        {/* Left Side: Symbol badge + Streaming status indicator */}
        <div className="flex items-center gap-2">
          <div className="bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs font-bold px-2.5 py-1 rounded font-mono">
            {symbol}
          </div>
          <span className="text-[10px] text-zinc-500 font-mono hidden md:inline">
            {exchange.toUpperCase()}
          </span>
          <div className="flex items-center gap-1.5 ml-1">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="text-[10px] text-emerald-500 font-medium tracking-wide">LIVE</span>
          </div>
        </div>

        {/* Center Side: Indicators Switches with premium glass buttons */}
        <div className="flex flex-wrap items-center gap-1.5 bg-zinc-900/50 p-1 rounded-lg border border-zinc-800">
          <button
            onClick={() => setShowVwap(!showVwap)}
            className={cn(
              "text-[10px] px-2.5 py-1 rounded transition-all font-semibold uppercase tracking-wider flex items-center gap-1.5",
              showVwap 
                ? "bg-purple-500/15 text-purple-400 border border-purple-500/30 shadow-lg shadow-purple-950/20" 
                : "text-zinc-500 hover:text-zinc-400 border border-transparent"
            )}
            title="Volume Weighted Average Price (Внутридневной VWAP с ежедневным сбросом)"
          >
            <span className={cn("w-1.5 h-1.5 rounded-full", showVwap ? "bg-purple-400 animate-pulse" : "bg-zinc-600")} />
            VWAP
          </button>

          <button
            onClick={() => setShowSma(!showSma)}
            className={cn(
              "text-[10px] px-2.5 py-1 rounded transition-all font-semibold uppercase tracking-wider flex items-center gap-1.5",
              showSma 
                ? "bg-amber-500/15 text-amber-400 border border-amber-500/30 shadow-lg shadow-amber-950/20" 
                : "text-zinc-500 hover:text-zinc-400 border border-transparent"
            )}
            title="SMA 20 - Скользящая средняя (определение локального тренда/поддержки)"
          >
            <span className={cn("w-1.5 h-1.5 rounded-full", showSma ? "bg-amber-400" : "bg-zinc-600")} />
            SMA 20
          </button>

          <button
            onClick={() => setShowSar(!showSar)}
            className={cn(
              "text-[10px] px-2.5 py-1 rounded transition-all font-semibold uppercase tracking-wider flex items-center gap-1.5",
              showSar 
                ? "bg-pink-500/15 text-pink-400 border border-pink-500/30 shadow-lg shadow-pink-950/20" 
                : "text-zinc-500 hover:text-zinc-400 border border-transparent"
            )}
            title="Parabolic Stop and Reverse (Мгновенное выявление точек слома)"
          >
            <span className={cn("w-1.5 h-1.5 rounded-full", showSar ? "bg-pink-400" : "bg-zinc-600")} />
            SAR
          </button>

          <button
            onClick={() => setShowSignals(!showSignals)}
            className={cn(
              "text-[10px] px-2.5 py-1 rounded transition-all font-semibold uppercase tracking-wider flex items-center gap-1.5",
              showSignals 
                ? "bg-sky-500/15 text-sky-400 border border-sky-500/30 shadow-lg shadow-sky-950/20" 
                : "text-zinc-500 hover:text-zinc-400 border border-transparent"
            )}
            title="ИИ-Паттерны шорт-скальпинга (Sweep, High-Pinbars, SAR Peak Reversals)"
          >
            <span className={cn("w-1.5 h-1.5 rounded-full", showSignals ? "bg-sky-400" : "bg-zinc-600")} />
            СИГНАЛЫ (ИИ)
          </button>

          <button
            onClick={() => setShowTradeMarkers(!showTradeMarkers)}
            className={cn(
              "text-[10px] px-2.5 py-1 rounded transition-all font-semibold uppercase tracking-wider flex items-center gap-1.5",
              showTradeMarkers 
                ? "bg-indigo-505/15 bg-indigo-500/15 text-indigo-400 border border-indigo-500/30 shadow-lg shadow-indigo-950/20" 
                : "text-zinc-500 hover:text-zinc-400 border border-transparent"
            )}
            title="Точки входа, усреднения и выхода из сделок на графике"
          >
            <span className={cn("w-1.5 h-1.5 rounded-full", showTradeMarkers ? "bg-indigo-400 animate-pulse" : "bg-zinc-600")} />
            СДЕЛКИ
          </button>

          <button
            onClick={() => setShowLiquidity(!showLiquidity)}
            className={cn(
              "text-[10px] px-2.5 py-1 rounded transition-all font-semibold uppercase tracking-wider flex items-center gap-1.5",
              showLiquidity 
                ? "bg-yellow-500/15 text-yellow-500 border border-yellow-500/30 shadow-lg shadow-yellow-950/25" 
                : "text-zinc-500 hover:text-zinc-400 border border-transparent"
            )}
            title="Индикаторы локальных максимумов и минимумов (пулы ликвидности)"
          >
            <span className={cn("w-1.5 h-1.5 rounded-full", showLiquidity ? "bg-yellow-500" : "bg-zinc-600")} />
            ЛИКВИДНОСТЬ
          </button>

          <button
            onClick={() => setShowImbalances(!showImbalances)}
            className={cn(
              "text-[10px] px-2.5 py-1 rounded transition-all font-semibold uppercase tracking-wider flex items-center gap-1.5",
              showImbalances 
                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-lg shadow-emerald-950/25" 
                : "text-zinc-500 hover:text-zinc-400 border border-transparent"
            )}
            title="Зоны имбаланса (Fair Value Gap - FVG), выступающие в роли магнита динамики"
          >
            <span className={cn("w-1.5 h-1.5 rounded-full", showImbalances ? "bg-emerald-400" : "bg-zinc-600")} />
            ИМБАЛАНС FVG
          </button>
        </div>

        {/* Right Side: Refresh + Timeframe Selectors + Close Button */}
        <div className="flex items-center gap-2">
          
          {/* Timeframes bar */}
          <div className="flex bg-zinc-900/60 rounded-md p-0.5 border border-zinc-800 shadow-md">
            <button 
              onClick={() => fetchData()}
              className="text-zinc-500 hover:text-indigo-400 p-1 mr-1 transition-colors rounded hover:bg-zinc-800/50"
              title="Обновить данные"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin text-indigo-500")} />
            </button>
            {['1m', '5m', '15m', '1h', '4h', '1d'].map(t => (
              <button 
                key={t}
                onClick={() => setTf(t)}
                className={cn(
                  "text-[10px] px-2 py-0.5 rounded-sm transition-all font-bold",
                  tf === t 
                    ? "bg-indigo-600 text-white shadow" 
                    : "text-zinc-400 hover:text-zinc-200"
                )}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Close Handle Overlay */}
          {onClose && (
            <button 
              onClick={onClose} 
              className="bg-zinc-900 hover:bg-zinc-800 hover:text-zinc-100 text-zinc-400 p-1.5 rounded border border-zinc-800 transition-colors shadow"
              title="Закрыть график"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 2. Main Chart View Box */}
      <div className="flex-1 relative min-h-0 bg-gradient-to-b from-zinc-950 to-zinc-900">
        
        {loading && (
          <div className="absolute inset-0 z-10 flex flex-col gap-2 items-center justify-center bg-zinc-950/60 backdrop-blur-sm">
            <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
            <span className="text-[10px] text-zinc-400 font-mono uppercase tracking-widest animate-pulse">Загрузка котировок...</span>
          </div>
        )}
        
        {error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm text-rose-500 text-xs font-mono p-4 text-center">
            <div className="max-w-xs bg-rose-950/20 border border-rose-900/30 p-4 rounded-xl">
              <p className="font-bold text-rose-400 mb-1">ОШИБКА FETCH</p>
              <p className="text-[10px] text-rose-500/90">{error}</p>
              <button 
                onClick={() => fetchData()} 
                className="mt-3 text-[10px] px-3 py-1 bg-rose-500/20 text-rose-300 border border-rose-500/30 rounded hover:bg-rose-500/30 transition-all font-bold"
              >
                Повторить попытку
              </button>
            </div>
          </div>
        )}
        
        <div ref={chartContainerRef} className="w-full h-full" />
      </div>

      {/* 3. Bottom Status Bar (Analytical Legend & Pattern Stats) */}
      {showSignals && rawCandles.length > 0 && (
        <div className="px-3 py-1.5 bg-zinc-900/40 border-t border-zinc-900 text-[10px] text-zinc-500 flex flex-wrap items-center justify-between gap-2 font-mono shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-zinc-400 font-bold uppercase tracking-wider text-[9px] flex items-center gap-1">
              <Layers className="w-3 h-3 text-indigo-400" />
              Статистика паттернов ({tf}):
            </span>
            <span className="flex items-center gap-1 hover:text-amber-400 cursor-help" title="High of candle is highest of last 12 periods, and rejection close. Perfect short trigger.">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              Ликвидити-свипы (Sweep): <strong className="text-amber-300 font-bold">{statCounts.sweeps}</strong>
            </span>
            <span className="flex items-center gap-1 hover:text-rose-400 cursor-help" title="Long upper tail (shadow is >60% of candle body + total range). Signals exhaustion of buyers active pump.">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
              Пинбары отката (Pinbar): <strong className="text-rose-300 font-bold">{statCounts.pinbars}</strong>
            </span>
            <span className="flex items-center gap-1 hover:text-pink-400 cursor-help" title="Parabolic SAR flips from below to above of candle, confirming momentum is now bearish.">
              <span className="w-1.5 h-1.5 rounded-full bg-pink-500" />
              Развороты (SAR Peak): <strong className="text-pink-400 font-bold">{statCounts.sarReversals}</strong>
            </span>
          </div>

          <div className="text-[9px] text-zinc-600 hidden lg:block">
            Для шорта: вход лимиткой в 1/3-2/3 верхней тени Sweep/Pinbar после медвежьего SAR.
          </div>
        </div>
      )}
    </div>
  );
});
