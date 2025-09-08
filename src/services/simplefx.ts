import axios from "axios";
import { config } from "../config";
import { logError, logTrade } from "../utils/logger";
import { simpleFXWebSocket } from "./simplefxWebSocket";
import { webSocketManager } from "../utils/webSocketManager";
import { getInstrumentSpecs } from "../server";

// Token management variables
let accessToken: string | null = null;
let secondaryAccessToken: string | null = null;
let tokenExpiration: number | null = null;
let secondaryTokenExpiration: number | null = null;

/**
 * Gets an access token for the SimpleFX API
 * @param useSecondaryApi Whether to use the secondary API key
 * @returns The access token
 */
export async function getAccessToken(useSecondaryApi = false): Promise<string> {
  const now = Date.now();

  // Check if we should use the secondary token
  if (useSecondaryApi) {
    // Check if we have a valid cached token
    if (secondaryAccessToken && secondaryTokenExpiration && now < secondaryTokenExpiration) {
      return secondaryAccessToken;
    }

    try {
      const response = await axios.post(`${config.SIMPLEFX_API_URL}/auth/key`, {
        clientId: config.SIMPLEFX_API_KEY2,
        clientSecret: config.SIMPLEFX_API_SECRET2,
      });
      secondaryAccessToken = response.data.data.token;
      secondaryTokenExpiration = now + 3600000;
      return secondaryAccessToken || "";
    } catch (error: any) {
      logError.api('auth/key', error.message);
      throw error;
    }
  }

  // Use the primary token
  if (accessToken && tokenExpiration && now < tokenExpiration) {
    return accessToken;
  }

  try {
    const response = await axios.post(`${config.SIMPLEFX_API_URL}/auth/key`, {
      clientId: config.SIMPLEFX_API_KEY,
      clientSecret: config.SIMPLEFX_API_SECRET,
    });
    accessToken = response.data.data.token;
    tokenExpiration = now + 3600000;
    return accessToken || "";
  } catch (error: any) {
    logError.api('auth/key', error.message);
    throw error;
  }
}

/**
 * Clears the cached access tokens
 * @param clearSecondary Whether to clear the secondary token as well
 */
export function clearAccessTokens(clearSecondary = true): void {
  accessToken = null;
  tokenExpiration = null;

  if (clearSecondary) {
    secondaryAccessToken = null;
    secondaryTokenExpiration = null;
  }
}

/**
 * Gets active orders for a trading account
 * @param loginNumber The account login number
 * @param reality Whether the account is LIVE or DEMO
 * @param useSecondaryApi Whether to use the secondary API key
 * @param page Page number for pagination
 * @param limit Number of records per page
 * @returns The active orders
 */
export async function getActiveOrders(
  loginNumber: string,
  reality: string,
  useSecondaryApi = false,
  page = 1,
  limit = 100,
): Promise<any> {
  try {
    // Force using secondary API for account 3979937
    const shouldUseSecondaryApi = useSecondaryApi || loginNumber === "3979937";

    const response = await axios.post(
      `${config.SIMPLEFX_API_URL}/trading/orders/active`,
      {
        login: Number.parseInt(loginNumber),
        reality: reality,
        page: page,
        limit: limit,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await getAccessToken(shouldUseSecondaryApi)}`,
        },
      },
    );

    // Ensure marketOrders is always an array
    if (!response.data.data.marketOrders) {
      response.data.data.marketOrders = [];
    }

    return response.data;
  } catch (error: any) {
    // If token expired, clear it and retry once
    if (error.response?.status === 401) {
      clearAccessTokens(useSecondaryApi);

      // Retry the request
      const response = await axios.post(
        `${config.SIMPLEFX_API_URL}/trading/orders/active`,
        {
          login: Number.parseInt(loginNumber),
          reality: reality,
          page: page,
          limit: limit,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${await getAccessToken(useSecondaryApi)}`,
          },
        },
      );

      if (!response.data.data.marketOrders) {
        response.data.data.marketOrders = [];
      }

      return response.data;
    }

    logError.api('trading/orders/active', error.response?.data?.message || error.message, loginNumber);
    throw error;
  }
}

/**
 * Gets closed orders for a trading account
 * @param loginNumber The account login number
 * @param reality Whether the account is LIVE or DEMO
 * @param useSecondaryApi Whether to use the secondary API key
 * @param page Page number for pagination
 * @param limit Number of records per page
 * @returns The closed orders
 */
export async function getClosedOrders(
  loginNumber: string,
  reality: string,
  useSecondaryApi = false,
  page = 1,
  limit = 100,
): Promise<any> {
  const now = Date.now();
  // For statistics, we want to get more historical data
  const sixMonthsAgo = now - 180 * 24 * 60 * 60 * 1000; // 180 days ago

  try {
    // Force using secondary API for account 3979937
    const shouldUseSecondaryApi = useSecondaryApi || loginNumber === "3979937";

    const response = await axios.post(
      `${config.SIMPLEFX_API_URL}/trading/orders/history`,
      {
        login: Number.parseInt(loginNumber),
        reality: reality,
        timeFrom: sixMonthsAgo,
        timeTo: now,
        page: page,
        limit: limit,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await getAccessToken(shouldUseSecondaryApi)}`,
        },
      },
    );

    // Ensure marketOrders is always an array
    if (!response.data.data.marketOrders) {
      response.data.data.marketOrders = [];
    }

    return response.data;
  } catch (error: any) {
    // If token expired, clear it and retry once
    if (error.response?.status === 401) {
      clearAccessTokens(useSecondaryApi);

      // Retry the request
      const response = await axios.post(
        `${config.SIMPLEFX_API_URL}/trading/orders/history`,
        {
          login: Number.parseInt(loginNumber),
          reality: reality,
          timeFrom: sixMonthsAgo,
          timeTo: now,
          page: page,
          limit: limit,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${await getAccessToken(useSecondaryApi)}`,
          },
        },
      );

      if (!response.data.data.marketOrders) {
        response.data.data.marketOrders = [];
      }

      return response.data;
    }

    logError.api('trading/orders/history', error.response?.data?.message || error.message, loginNumber);
    throw error;
  }
}

/**
 * Gets account status for a trading account
 * @param loginNumber The account login number
 * @param reality Whether the account is LIVE or DEMO
 * @param useSecondaryApi Whether to use the secondary API key
 * @returns The account status
 */
export async function getAccountStatus(loginNumber: string, reality: string, useSecondaryApi = false): Promise<any> {
  try {
    // Force using secondary API for account 3979937
    const shouldUseSecondaryApi = useSecondaryApi || loginNumber === "3979937";

    const response = await axios.get(`${config.SIMPLEFX_API_URL}/accounts/${reality}/${loginNumber}`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await getAccessToken(shouldUseSecondaryApi)}`,
      },
    });
    return response.data;
  } catch (error: any) {
    // If token expired, clear it and retry once
    if (error.response?.status === 401) {
      clearAccessTokens(useSecondaryApi);

      // Retry the request
      const response = await axios.get(`${config.SIMPLEFX_API_URL}/accounts/${reality}/${loginNumber}`, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await getAccessToken(useSecondaryApi)}`,
        },
      });
      return response.data;
    }

    logError.api('accounts/status', error.response?.data?.message || error.message, loginNumber);
    throw error;
  }
}

/**
 * Places a trade via the SimpleFX API
 * @param side The trade side (BUY or SELL)
 * @param amount The trade amount (volume)
 * @param loginNumber The account login number
 * @param takeProfitPrice The take profit price
 * @param stopLossPrice The stop loss price
 * @param reality Whether the account is LIVE or DEMO
 * @param symbol The trading symbol
 * @param useSecondaryApi Whether to use the secondary API key
 * @returns The trade result
 */
export async function placeTrade(
  side: string,
  amount: number,
  loginNumber: string,
  takeProfitPrice: number,
  stopLossPrice: number | null,
  reality: string,
  symbol: string = "EURUSD",
  useSecondaryApi: boolean = false,
): Promise<any> {
  const shouldUseSecondaryApi = useSecondaryApi || loginNumber === "3979937";
  const instrumentSpecs = getInstrumentSpecs(symbol);

  // Validate volume
  const minLotSize = instrumentSpecs.type === "index" ? 0.1 : 0.01;
  if (amount < minLotSize) {
    throw new Error(`Volume ${amount} is below minimum ${minLotSize} for ${symbol}`);
  }

  // Format prices based on instrument type
  const formatPriceForAPI = (price: number): number => {
    if (instrumentSpecs.type === "index") {
      // Indices need exactly 1 decimal place for SimpleFX
      return Math.round(price * 10) / 10;
    } else {
      // Forex pairs use their specific decimal places
      return Number(price.toFixed(instrumentSpecs.decimals));
    }
  };

  const requestBody = {
    Reality: reality.toUpperCase(),
    Login: Number.parseInt(loginNumber),
    Symbol: symbol,
    Side: side === "B" ? "BUY" : side === "S" ? "SELL" : side.toUpperCase(),
    Volume: amount,
    TakeProfit: formatPriceForAPI(takeProfitPrice),
    StopLoss: stopLossPrice ? formatPriceForAPI(stopLossPrice) : null,
    IsFIFO: false,
    RequestId: `TV_${Date.now()}`,
    Activity: "TradingView Webhook Order",
  };

  try {
    // Capture current spread using WebSocketManager
    const lastQuote = webSocketManager.getQuoteForSymbol(symbol);
    if (!lastQuote) {
      throw new Error(`No market quote available for ${symbol}`);
    }
    const spreadAtOpen = (lastQuote.ask - lastQuote.bid) / instrumentSpecs.pipValue;

    // Log the API request payload with market context
    const apiRequestData = {
      requestBody: requestBody,
      marketContext: {
        currentBid: lastQuote.bid,
        currentAsk: lastQuote.ask,
        spread: spreadAtOpen,
        timestamp: new Date().toISOString()
      },
      priceFormatting: {
        originalTP: takeProfitPrice,
        originalSL: stopLossPrice,
        formattedTP: formatPriceForAPI(takeProfitPrice),
        formattedSL: stopLossPrice ? formatPriceForAPI(stopLossPrice) : null
      }
    };
    logTrade.apiRequest(symbol, loginNumber, 'trading/orders/market', apiRequestData);

    const response = await axios.post(`${config.SIMPLEFX_API_URL}/trading/orders/market`, requestBody, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await getAccessToken(shouldUseSecondaryApi)}`,
      },
    });

    // Validate response structure
    if (!response.data?.data?.marketOrders?.length) {
      throw new Error(`Invalid API response: No market orders returned`);
    }

    const responseWithSpread = {
      ...response.data,
      spreadAtOpen,
    };

    return responseWithSpread;
  } catch (error: any) {
    if (error.response?.status === 401) {
      clearAccessTokens(shouldUseSecondaryApi);

      const lastQuote = webSocketManager.getQuoteForSymbol(symbol);
      if (!lastQuote) {
        throw new Error(`No market quote available for ${symbol} after token retry`);
      }
      const spreadAtOpen = (lastQuote.ask - lastQuote.bid) / instrumentSpecs.pipValue;

      const response = await axios.post(`${config.SIMPLEFX_API_URL}/trading/orders/market`, requestBody, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await getAccessToken(shouldUseSecondaryApi)}`,
        },
      });

      // Validate response structure
      if (!response.data?.data?.marketOrders?.length) {
        throw new Error(`Invalid API response: No market orders returned`);
      }

      const responseWithSpread = {
        ...response.data,
        spreadAtOpen,
      };

      return responseWithSpread;
    }

    logError.trade(symbol, side, error.response?.data?.message || error.message, loginNumber);
    throw error;
  }
}

/**
 * Closes all positions for a trading account
 * @param loginNumber The account login number
 * @param reality Whether the account is LIVE or DEMO
 * @param useSecondaryApi Whether to use the secondary API key
 * @returns The close result
 */
export async function closeAllPositions(loginNumber: string, reality: string, useSecondaryApi = false): Promise<any> {
  try {
    // Force using secondary API for account 3979937
    const shouldUseSecondaryApi = useSecondaryApi || loginNumber === "3979937";

    const response = await axios.post(
      `${config.SIMPLEFX_API_URL}/trading/orders/close-all`,
      {
        login: Number.parseInt(loginNumber),
        reality: reality,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await getAccessToken(shouldUseSecondaryApi)}`,
        },
      },
    );
    return response.data;
  } catch (error: any) {
    // If token expired, clear it and retry once
    if (error.response?.status === 401) {
      clearAccessTokens(useSecondaryApi);

      // Retry the request
      const response = await axios.post(
        `${config.SIMPLEFX_API_URL}/trading/orders/close-all`,
        {
          login: Number.parseInt(loginNumber),
          reality: reality,
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${await getAccessToken(useSecondaryApi)}`,
          },
        },
      );
      return response.data;
    }

    logError.api('trading/orders/close-all', error.response?.data?.message || error.message, loginNumber);
    throw error;
  }
}

/**
 * Gets deposit history for a trading account
 * @param loginNumber The account login number
 * @param reality Whether the account is LIVE or DEMO
 * @param useSecondaryApi Whether to use the secondary API key
 * @returns The deposit history
 */
export async function getDepositHistory(loginNumber: string, reality: string, useSecondaryApi = false): Promise<any> {
  try {
    // Force using secondary API for account 3979937
    const shouldUseSecondaryApi = useSecondaryApi || loginNumber === "3979937";

    const response = await axios.get(`${config.SIMPLEFX_API_URL}/accounts/${reality}/${loginNumber}/deposits`, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await getAccessToken(shouldUseSecondaryApi)}`,
      },
    });
    return response.data;
  } catch (error: any) {
    // If token expired, clear it and retry once
    if (error.response?.status === 401) {
      clearAccessTokens(useSecondaryApi);

      // Retry the request
      const response = await axios.get(`${config.SIMPLEFX_API_URL}/accounts/${reality}/${loginNumber}/deposits`, {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${await getAccessToken(useSecondaryApi)}`,
        },
      });
      return response.data;
    }

    logError.api('accounts/deposits', error.response?.data?.message || error.message, loginNumber);
    throw error;
  }
}