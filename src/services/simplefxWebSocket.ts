import WebSocket from "ws"
import { logger, quoteLogger, logQuote } from "../utils/logger"
import { EventEmitter } from "events"

class SimpleFXWebSocket extends EventEmitter {
  private ws: WebSocket | null = null
  private requestId = 0
  private subscribedSymbols: Set<string> = new Set()
  public lastQuote: { bid: number; ask: number; timestamp: number } | null = null
  public lastOrderPrice: { price: number; side: string; timestamp: number } | null = null
  private quotes: Map<string, { bid: number; ask: number; timestamp: number }> = new Map()

  constructor() {
    super()
  }

  public connect() {
    this.ws = new WebSocket("wss://web-quotes-core.simplefx.com/websocket/quotes")

    this.ws.on("open", () => {
      logger.info("WebSocket connection established")
      this.subscribeToSymbol("EURUSD")
      this.subscribeToSymbol("US100")
      this.subscribeToSymbol("GBPUSD")
    })

    this.ws.on("message", (data: WebSocket.Data) => {
      const message = JSON.parse(data.toString())
      this.handleMessage(message)
    })

    this.ws.on("close", () => {
      logger.warn("WebSocket connection closed. Attempting to reconnect...")
      setTimeout(() => this.connect(), 5000)
    })

    this.ws.on("error", (error) => {
      logger.error("WebSocket error:", error)
    })
  }

  public disconnect() {
    if (this.ws) {
      this.ws.close()
      this.ws = null
      logger.info("WebSocket disconnected")
    }
  }

  private handleMessage(message: any) {
    if (message.p === "/quotes/subscribed") {
      this.updateQuote(message.d[0])
    } else if (message.p === "/lastprices/list") {
      this.updateQuote(message.d[0])
    }
  }

  private updateQuote(quote: any) {
    if (this.subscribedSymbols.has(quote.s)) {
      this.quotes.set(quote.s, { bid: quote.b, ask: quote.a, timestamp: quote.t })

      this.lastQuote = { bid: quote.b, ask: quote.a, timestamp: quote.t }

      logQuote(quote.s, quote.b, quote.a);
      this.emit("quoteUpdate", { symbol: quote.s, bid: quote.b, ask: quote.a, timestamp: quote.t })
    }
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  public updateLastOrderPrice(price: number, side: string) {
    this.lastOrderPrice = { price, side, timestamp: Date.now() }
    logger.info(`Updated last order price: Price=${price}, Side=${side}`)
  }

  private getNextRequestId(): number {
    return ++this.requestId
  }

  public subscribeToSymbol(symbol: string) {
    if (this.subscribedSymbols.has(symbol)) {
      logger.debug(`Already subscribed to ${symbol}`)
      return
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const request = {
        p: "/subscribe/addList",
        i: this.getNextRequestId(),
        d: [symbol],
      }
      this.ws.send(JSON.stringify(request))
      this.subscribedSymbols.add(symbol)
      logger.info(`Subscribed to ${symbol}`)

      // Request last known price
      const lastPriceRequest = {
        p: "/lastprices/list",
        i: this.getNextRequestId(),
        d: [symbol],
      }
      this.ws.send(JSON.stringify(lastPriceRequest))
      logger.info(`Requested last known price for ${symbol}`)
    } else {
      logger.warn(`WebSocket is not open. Unable to subscribe to ${symbol}.`)
    }
  }

  public subscribeToSymbols(symbols: string[]) {
    symbols.forEach((symbol) => this.subscribeToSymbol(symbol))
  }

  // ADD THIS METHOD - Get quote for specific symbol
  public getQuoteForSymbol(symbol: string): { bid: number; ask: number; timestamp: number } | null {
    return this.quotes.get(symbol) || null
  }
}

export const simpleFXWebSocket = new SimpleFXWebSocket()
