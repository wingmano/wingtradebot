# API Documentation

Complete API reference for WingTradeBot webhook server and dashboard endpoints.

## Authentication

The API uses HTTP Basic Authentication for dashboard endpoints:
- **Primary Auth**: Used for `/status2` and primary API operations
- **Secondary Auth**: Used for `/status` and secondary API operations

## Webhook Endpoints

### POST /webhook
Primary webhook endpoint for TradingView signals.

**Request Body:**
```json
{
  "action": "B",
  "symbol": "EURUSD", 
  "volume": 0.1,
  "takeProfit": 50,
  "stopLoss": 25,
  "loginNumber": "3979960",
  "alertId": "EURUSD_BUY_001",
  "timeframe": "5m",
  "exchange": "simplefx",
  "reality": "LIVE"
}
```

**Parameters:**
- `action` (string, required): Trade direction ("B" for buy, "S" for sell)
- `symbol` (string, required): Trading instrument symbol
- `volume` (number, required): Position size
- `takeProfit` (number, required): Take profit in pips
- `stopLoss` (number, optional): Stop loss in pips
- `loginNumber` (string, required): SimpleFX account number
- `alertId` (string, required): Unique identifier for the alert
- `timeframe` (string, optional): Chart timeframe
- `exchange` (string, optional): Exchange identifier
- `reality` (string, optional): "LIVE" or "DEMO"

**Response:**
```json
{
  "success": true,
  "message": "Trade executed successfully",
  "orderId": "12345",
  "executionPrice": 1.0850
}
```

### POST /webhook2
Secondary webhook endpoint with identical functionality to `/webhook`.

## Dashboard Endpoints

### GET /
Main dashboard interface. Requires secondary authentication.

### GET /status
Account status page. Requires secondary authentication.
Optional parameter: `/:loginNumber` to specify account.

### GET /status2  
Secondary status page. Requires primary authentication.

## Account Management API

### GET /api/account-settings/:loginNumber
Get account trading settings and session preferences.

**Authentication:** Secondary Auth required

**Response:**
```json
{
  "login": "3979960",
  "trading_mode": "NORMAL",
  "exclusive_mode": false,
  "asia_session": true,
  "london_session": true,
  "new_york_session": true,
  "limbo_session": false,
  "max_size": 1.0,
  "account_type": "LIVE"
}
```

### POST /api/account-settings/:loginNumber
Update account trading settings.

**Authentication:** Secondary Auth required

**Request Body:**
```json
{
  "tradingMode": "BUY_ONLY",
  "exclusive_mode": true,
  "asia_session": false,
  "london_session": true,
  "new_york_session": true,
  "limbo_session": false
}
```

**Parameters:**
- `tradingMode` (string): "NORMAL", "BUY_ONLY", or "SELL_ONLY"
- `exclusive_mode` (boolean): Prevent multiple orders in same direction
- `asia_session` (boolean): Enable Asia session trading
- `london_session` (boolean): Enable London session trading  
- `new_york_session` (boolean): Enable New York session trading
- `limbo_session` (boolean): Enable Limbo session trading

## Statistics API

### GET /api/statistics/:accountId
Get comprehensive trading statistics for an account.

**Query Parameters:**
- `startDate` (string, optional): Start date for statistics (YYYY-MM-DD)
- `endDate` (string, optional): End date for statistics (YYYY-MM-DD)

**Response:**
```json
{
  "asia": {
    "pnl": 150.50,
    "orders": 25,
    "wins": 15,
    "losses": 10,
    "winRate": 60.0,
    "avgDuration": 45,
    "label": "Asia Session (21:00-05:00 BRT)"
  },
  "london": {
    "pnl": 200.75,
    "orders": 30,
    "wins": 20,
    "losses": 10,
    "winRate": 66.7,
    "avgDuration": 38,
    "label": "London Session (05:00-10:00 BRT)"
  },
  "total": {
    "pnl": 500.25,
    "orders": 100,
    "wins": 65,
    "losses": 35,
    "winRate": 65.0,
    "profitFactor": 1.85,
    "maxDrawdown": -50.25
  }
}
```

## System API

### GET /api/list-accounts
List all accounts accessible by each API key.

**Response:**
```json
{
  "primaryApiAccounts": [
    {
      "login": "3979960",
      "currency": "USD",
      "type": "LIVE"
    }
  ],
  "secondaryApiAccounts": [
    {
      "login": "3979937", 
      "currency": "USD",
      "type": "LIVE"
    }
  ]
}
```

### GET /api/test-keys
Test connectivity and validity of API keys.

**Response:**
```json
{
  "primary": {
    "success": true,
    "token": "eyJhbGciOi..."
  },
  "secondary": {
    "success": true,
    "token": "eyJhbGciOi..."
  }
}
```

### GET /api/test-accounts
Test access to configured trading accounts.

**Response:**
```json
{
  "3979960": {
    "success": true,
    "ordersCount": 5,
    "api": "primary"
  },
  "3979937": {
    "success": true,
    "ordersCount": 2,
    "api": "secondary"
  }
}
```

## Error Responses

All endpoints return consistent error responses:

```json
{
  "error": "Error description",
  "code": "ERROR_CODE",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

**Common HTTP Status Codes:**
- `200` - Success
- `400` - Bad Request (invalid parameters)
- `401` - Unauthorized (authentication required)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `500` - Internal Server Error

## Rate Limiting

API endpoints are rate limited to prevent abuse:
- **Webhook endpoints**: 10 requests per minute per IP
- **Dashboard endpoints**: 60 requests per minute per authenticated user
- **Statistics endpoints**: 30 requests per minute per authenticated user

## WebSocket Integration

The system uses WebSocket connections for real-time market data. WebSocket endpoints are internal and not directly accessible via the API.

## Trading Sessions

Session times are in Brazil Time (BRT):
- **Asia Session**: 21:00-05:00 BRT
- **London Session**: 05:00-10:00 BRT
- **New York Session**: 10:00-18:00 BRT  
- **Limbo Session**: 18:00-21:00 BRT

## Supported Instruments

### Forex Pairs
- EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, NZDUSD
- EURGBP, EURJPY, GBPJPY

### Indices
- US100, US30, US500, NAS100, SPX500
- GER40, UK100, JPN225, TECH100

## Risk Management

### Position Sizing
- Minimum position size: 0.01 lots
- Maximum position size: Configurable per account
- Volume validation based on account equity

### Stop Loss and Take Profit
- Minimum distance: 10 pips for forex, 20 points for indices
- Maximum distance: No limit
- Automatic price level validation

### Order Management
- Duplicate order prevention via `alertId`
- Exclusive mode prevents multiple orders in same direction
- Session-based trading controls