# Project Structure & Organization

## Root Directory

```
├── src/                    # TypeScript source code
├── dist/                   # Compiled JavaScript output
├── public/                 # Static web assets for dashboard
├── ssl/                    # SSL certificates (cert.pem, key.pem)
├── scripts/                # Setup and utility scripts
├── docs/                   # Documentation files
├── .kiro/                  # Kiro AI assistant configuration
└── sfx_historical_orders.db # SQLite database file
```

## Source Code Organization (`src/`)

```
src/
├── server.ts               # Main Express server and webhook handlers
├── config.ts               # Configuration (excluded from git)
├── config.example.ts       # Configuration template
├── database.ts             # SQLite database operations
├── utils.ts                # General utility functions
├── services/               # External API integrations
│   ├── simplefx.ts         # SimpleFX API client
│   └── simplefxWebSocket.ts # WebSocket market data
├── utils/                  # Utility modules
│   ├── logger.ts           # Winston logging configuration
│   ├── webSocketManager.ts # WebSocket connection management
│   ├── webhookLogger.ts    # Webhook-specific logging
│   └── webhookQueue.ts     # Webhook processing queue
└── types/                  # TypeScript type definitions
    └── services.d.ts       # Service interface types
```

## Public Assets (`public/`)

- `index.html` - Main dashboard interface
- `index2.html` - Secondary dashboard interface
- `index2_novo_arrumar.html` - Development/backup dashboard

## Key Architectural Patterns

### Database Layer
- Single SQLite database with comprehensive schema
- Async/await pattern with sqlite wrapper
- Centralized database operations in `database.ts`

### API Services
- Modular service architecture in `src/services/`
- Token management and caching
- Dual API key support for account segregation

### Logging Strategy
- Winston-based structured logging
- Separate loggers for different concerns (trade, error, app, webhook)
- Daily rotating log files

### WebSocket Management
- Centralized WebSocket connection handling
- Real-time market data with fallback mechanisms
- Connection retry and health monitoring

### Security Configuration
- Environment-based configuration
- Sensitive data excluded from version control
- IP whitelisting and authentication middleware

## File Naming Conventions

- **TypeScript files**: camelCase (e.g., `webSocketManager.ts`)
- **Configuration**: lowercase with extensions (e.g., `config.ts`)
- **Documentation**: UPPERCASE (e.g., `README.md`, `API.md`)
- **Scripts**: kebab-case (e.g., `setup-git.sh`)