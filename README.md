# Hyperwealth Bot

Build a Professional Hyperliquid USDC Perpetual Futures Automated Trading Bot Web App

Product Vision

Create a production-quality web application that connects to the Hyperliquid decentralized exchange and provides an automated algorithmic trading system for USDC-margined perpetual futures.

The goal is to build a professional-grade trading terminal + automated strategy engine that:

 Scans all available Hyperliquid USDC perpetual markets in real time

 Identifies high-probability momentum/trend opportunities

 Automatically executes trades

 Manages risk aggressively

 Protects capital during unfavorable market conditions

 Provides full transparency into every decision the bot makes

This is not a gambling bot. It must prioritize capital preservation, risk-adjusted returns, and consistent execution.

The architecture should be similar to institutional trading systems:

 Reliable market data ingestion

 Strategy engine

 Risk engine

 Execution engine

 Portfolio management

 Monitoring dashboard

Core User Experience

User Onboarding

Create a simple onboarding wizard:

Step 1: Connect Hyperliquid Wallet

Allow users to connect their wallet using secure wallet authentication.

Display:

 Wallet address

 USDC balance

 Available margin

 Current positions

 Account equity

Step 2: Trading Authorization

Users can connect a Hyperliquid API/agent wallet for automated execution.

Security requirements:

 Never store private keys in frontend code

 Never store secrets in browser storage

 Encrypt credentials server-side

 Use secure environment variables

 Follow Hyperliquid official authentication methods

Step 3: Choose Trading Mode

Allow users to select:

Paper Trading Mode

 Uses live Hyperliquid market data

 Simulates execution

 Tracks hypothetical PnL

 Allows strategy testing before real funds

Live Trading Mode

Requires confirmation:

"Enable live trading with real funds"

Require explicit confirmation.

Trading Engine

Market Scanner

Build a real-time scanner that monitors every Hyperliquid USDC perpetual market.

Update frequency:

 Real-time WebSocket data

 Minimum 5-second strategy evaluation cycle

Monitor:

 Price action

 Volume

 Volatility

 Trend strength

 Funding rates

 Open interest

 Liquidity

 Spread

Avoid trading markets with:

 Low liquidity

 Extreme spreads

 Abnormal volatility

 Missing data

Strategy Engine

Create a modular strategy framework allowing future strategies.

Initial strategy:

Adaptive Trend Following Momentum Strategy

The system should combine multiple confirmations instead of relying on a single indicator.

Trend Detection

Use:

 EMA 20/50 crossover

 EMA 100/200 trend filter

 Market structure analysis

 Higher timeframe trend confirmation

Example:

Long trades only when:

 Short-term EMA crosses above long-term EMA

 Price is above major trend filter

 Momentum confirms upward movement

Short trades only when opposite conditions occur.

Momentum Confirmation

Use:

 RSI

 MACD

 Rate of Change

 Volume expansion

Momentum indicators should confirm trades, not independently trigger trades.

Volatility Filter

Use ATR-based volatility analysis.

Avoid entries during:

 Low volatility sideways markets

 Extreme random price spikes

 Unstable conditions

Smart Entry System

Before opening any trade:

Score the opportunity.

Example:

Trade confidence score:

0-100%

Only enter trades above configurable thresholds:

Conservative:

 80%+

Balanced:

 70%+

Aggressive:

 60%+

Display:

 Why the trade was selected

 Indicator confirmations

 Risk/reward ratio

 Expected volatility

Position Management

Every trade must automatically include:

Stop Loss

Mandatory.

Never allow a trade without protection.

Options:

 Fixed percentage

 ATR-based dynamic stop

 Structure-based stop

Take Profit

Allow:

 Fixed target

 Risk/reward target

 Dynamic trailing profit

Default:

Target minimum 2:1 reward/risk ratio.

Trailing Stop

Automatically lock profits when trades move favorably.

Time-Based Exit

Close trades when:

 Momentum disappears

 Trade stagnates too long

 Signal reverses

Risk Management System

The risk engine is the most important component.

All limits must be enforced server-side.

Users can configure:

Maximum Leverage

Default:
5x

Maximum allowed:
20x

Position Size

Default:

5% of account equity per trade

Maximum:

10%

Maximum Portfolio Exposure

Default:

25%

Example:

$10,000 account

Maximum open exposure:

$2,500

Daily Loss Protection

Circuit breaker:

Default:

5% daily drawdown

When triggered:

 Stop opening new trades

 Close existing positions

 Disable automation

 Send alert

Maximum Number Of Open Positions

Allow configuration.

Default:

3-5 positions.

Correlation Protection

Avoid opening multiple positions that are highly correlated.

Example:

Do not open 5 different altcoin longs during the same market move.

Execution Engine

Build a reliable Hyperliquid execution layer.

Requirements:

Order Handling

Support:

 Market orders

 Limit orders

 Reduce-only orders

 Stop loss orders

 Take profit orders

Execution Safety

Implement:

 Order idempotency

 Duplicate order prevention

 Retry handling

 API failure recovery

 Network reconnect handling

 Order confirmation checks

Position Reconciliation

Whenever the bot starts:

 Fetch actual Hyperliquid account state

 Compare with database state

 Correct discrepancies

 Resume safely

Never assume previous state is accurate.

Dashboard

Create a premium trading dashboard.

Design style:

Professional hedge-fund style interface.

Dark theme.

Real-time updates.

Main Dashboard

Display:

Portfolio

 Total USDC equity

 Available margin

 Used margin

 Unrealized PnL

 Realized PnL

 Daily return

 Weekly return

 Monthly return

Live Positions

Table:

 Asset

 Direction

 Entry price

 Current price

 Position size

 Leverage

 Unrealized PnL

 Stop loss

 Take profit

 Liquidation price

Actions:

 Close position

 Modify stop loss

 Modify take profit

 Reduce position

Performance Charts

Include:

 Equity curve

 Daily PnL chart

 Win rate

 Average winner

 Average loser

 Maximum drawdown

 Profit factor

 Sharpe ratio

Trade History

Create detailed trade logs.

Every trade records:

 Timestamp

 Asset

 Entry

 Exit

 Size

 Leverage

 Profit/loss

 Strategy reason

 Indicators at entry

 Exit reason

Example:

"LONG BTC-PERP opened because:
EMA bullish crossover + RSI momentum confirmation + volume expansion."

Allow:

Export CSV.

Strategy Controls

Users can select:

Conservative Mode

 Lower frequency

 Higher confirmation requirements

 Lower leverage

 Smaller positions

Balanced Mode

 Medium frequency

 Moderate risk

Aggressive Mode

 More trades

 Higher risk limits

Backtesting Engine

Add a backtesting system.

Users can:

 Select market

 Select timeframe

 Select date range

 Test strategies

Show:

 Total return

 Win rate

 Maximum drawdown

 Number of trades

 Profit factor

 Sharpe ratio

Allow optimization of:

 EMA settings

 RSI parameters

 Stop loss

 Take profit

 Risk settings

Alerts

Create:

In-App Notifications

For:

 Trade opened

 Trade closed

 Stop loss triggered

 Take profit triggered

 Daily loss limit reached

 API errors

 Connection problems

 Liquidation risk

Optional:

Email/Telegram alerts.

Emergency Controls

Always visible:

BIG RED BUTTON

"STOP BOT + CLOSE ALL POSITIONS"

Requirements:

 One click

 Immediately stops automation

 Sends reduce-only close orders

 Confirms successful closure

Never hide this button.

Database Architecture

Store:

Users

Wallet connections

Encrypted API credentials

Trading settings

Positions

Trade history

Performance metrics

Risk limits

Bot status

Strategy settings

Technical Architecture

Frontend:

 Modern React framework

 Responsive design

 Real-time dashboard updates

Backend:

 Secure API server

 Trading engine service

 Risk management service

 Database layer

 Background workers

Communication:

 REST APIs

 WebSockets

Exchange:

Hyperliquid official API integration.

Important Safety Rules

The system MUST NOT include:

❌ Martingale
❌ Unlimited averaging down
❌ Grid trading without strict risk controls
❌ Increasing size after losses
❌ Removing stop losses
❌ Ignoring liquidation risk

Final Success Criteria

The application is complete when:

 User can connect Hyperliquid wallet

 User can see live USDC balance

 User can see live positions

 User can manually close positions

 User can set/edit TP and SL

 Bot can scan all USDC perpetual markets

 Bot can execute trades automatically

 Risk limits are enforced server-side

 Paper trading works before live mode

 Dashboard shows real-time PnL

 All trades have explanations

 Kill switch closes positions safely

 System survives server restart/reconnection

 User has complete visibility into every trading decision

Build this as a serious algorithmic trading platform, not a simple trading script.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://hyper-stride-bot.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/3ce2ab0b-0b53-4d21-b7b0-33f4f1aaa86c).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
