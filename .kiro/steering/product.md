# WingTradeBot Product Overview

WingTradeBot is an automated trading system that bridges TradingView webhook signals with SimpleFX API execution. The system receives trading signals from TradingView indicators and automatically places trades with configurable risk management parameters.

## Core Features

- **Webhook Processing**: Receives and processes TradingView webhook signals via REST endpoints
- **SimpleFX Integration**: Executes trades through SimpleFX API with dual API key support for multiple accounts
- **Web Dashboard**: Real-time monitoring interface for account status, trade history, and settings management
- **Risk Management**: Configurable position sizing, stop loss, take profit levels, and trading session controls
- **Session Trading**: Supports Asia, London, New York, and Limbo trading sessions with individual enable/disable controls
- **Database Logging**: SQLite database for comprehensive trade history and account settings persistence
- **WebSocket Market Data**: Real-time price feeds for accurate trade execution timing

## Trading Modes

- `NORMAL`: Allow both buy and sell orders
- `BUY_ONLY`: Only execute buy orders
- `SELL_ONLY`: Only execute sell orders
- `EXCLUSIVE_MODE`: Prevents multiple orders in the same direction for the same symbol

## Security Features

- GPG signed commits required (Yubikey-based)
- Basic authentication for dashboard access
- IP whitelist for webhook endpoints
- SSL/TLS encryption for production deployment
- Environment variable configuration for sensitive data