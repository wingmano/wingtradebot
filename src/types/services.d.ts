declare module 'services/simplefx' {
    export function getActiveOrders(loginNumber: string): Promise<any>;
    export function getClosedOrders(loginNumber: string): Promise<any>;
    export function getAccountStatus(loginNumber: string): Promise<any>;
    export function placeTrade(side: string, amount: number, loginNumber: string, takeProfitPrice: number, stopLossPrice: number | null, marketPrice: number): Promise<any>;
    export function closeAllPositions(loginNumber: string): Promise<any>;
  }
  
  declare module 'services/simplefxWebSocket' {
    import { EventEmitter } from 'events';
    
    export class SimpleFXWebSocket extends EventEmitter {
      connect(): void;
      disconnect(): void;
      lastQuote: { bid: number; ask: number; timestamp: number } | null;
    }
    
    export const simpleFXWebSocket: SimpleFXWebSocket;
  }
  
  declare module 'utils/webSocketManager' {
    import { EventEmitter } from 'events';
    
    interface MarketData {
      symbol: string;
      bid: number;
      ask: number;
      timestamp: number;
      isStale: boolean;
    }
    
    export class WebSocketManager extends EventEmitter {
      connectForOrder(symbol: string): Promise<MarketData>;
      connectForDashboard(symbols?: string[]): Promise<void>;
      getQuoteForSymbol(symbol: string): { bid: number; ask: number; timestamp: number } | null;
      isConnected(): boolean;
      getLastPriceUpdate(): Date;
      disconnect(): void;
    }
    
    export const webSocketManager: WebSocketManager;
  }
  
  
  