/**
 * Sprite Bot — Provider-Agnostic Entry Point
 *
 * Single entry point for running Open-Dispatch with Sprite backend
 * and any chat provider (Slack, Teams, Discord).
 *
 * Supports two sandbox types:
 *   fly    — Ephemeral Fly Machines (default)
 *   github — GitHub Actions workflow runs
 *
 * Usage:
 *   CHAT_PROVIDER=slack node src/sprite-bot.js
 *   CHAT_PROVIDER=teams SPRITE_SANDBOX=github node src/sprite-bot.js
 *
 * Fly sandbox required env vars:
 *   FLY_API_TOKEN    — Fly.io API token
 *   FLY_SPRITE_APP   — Fly app name for Sprites
 *   SPRITE_IMAGE     — Default Docker image for Sprites
 *
 * GitHub sandbox required env vars:
 *   GITHUB_SPRITE_TOKEN   — GitHub PAT with 'workflow' scope
 *   GITHUB_SPRITE_OWNER   — GitHub owner/org name
 *   GITHUB_SPRITE_REPO    — GitHub repository name
 *
 * Per-provider env vars (see SLACK_SETUP.md, TEAMS_SETUP.md, DISCORD_SETUP.md):
 *   Slack:   SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET
 *   Teams:   TEAMS_APP_ID, TEAMS_APP_PASSWORD
 *   Discord: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID
 */

const { registerFatalHandlers } = require('./process-handlers');
registerFatalHandlers();

require('dotenv').config();

const { createProvider } = require('./providers');
const { createBotEngine } = require('./bot-engine');
const { createInstanceManager } = require('./sprite-core');
const { createWebhookServer } = require('./webhook-server');

// ============================================
// ENV VALIDATION
// ============================================

const SANDBOX_TYPE = (process.env.SPRITE_SANDBOX || 'fly').toLowerCase();
const CHAT_PROVIDER = process.env.CHAT_PROVIDER.toLowerCase();

const REQUIRED = ['CHAT_PROVIDER'];

if (SANDBOX_TYPE === 'fly') {
  REQUIRED.push('FLY_API_TOKEN', 'FLY_SPRITE_APP', 'SPRITE_IMAGE');
} else if (SANDBOX_TYPE === 'github') {
  REQUIRED.push('GITHUB_SPRITE_TOKEN', 'GITHUB_SPRITE_OWNER', 'GITHUB_SPRITE_REPO');
} else {
  console.error(`Unknown SPRITE_SANDBOX: ${SANDBOX_TYPE}. Use: fly, github`);
  process.exit(1);
}

const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  console.error(`See SPRITE_SETUP.md for ${SANDBOX_TYPE} sandbox configuration.`);
  process.exit(1);
}

// ============================================
// PROVIDER CONFIG
// ============================================

function getProviderConfig(name) {
  switch (name) {
    case 'slack':
      return {
        token: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        socketMode: true
      };
    case 'teams':
      return {
        appId: process.env.TEAMS_APP_ID,
        appPassword: process.env.TEAMS_APP_PASSWORD
      };
    case 'discord':
      return {
        token: process.env.DISCORD_BOT_TOKEN,
        clientId: process.env.DISCORD_CLIENT_ID,
        guildId: process.env.DISCORD_GUILD_ID
      };
    default:
      console.error(`Unknown CHAT_PROVIDER: ${name}. Use: slack, teams, discord`);
      process.exit(1);
  }
}

// ============================================
// BOOT
// ============================================

(async () => {
  // 1. Create chat provider
  const providerConfig = getProviderConfig(CHAT_PROVIDER);
  const chatProvider = createProvider(CHAT_PROVIDER, providerConfig);

  // 2. Create Sprite backend
  const aiBackend = createInstanceManager();

  // 3. Create webhook server (receives callbacks from Sprites)
  const webhookPort = parseInt(process.env.WEBHOOK_PORT || '8080', 10);
  const webhookServer = createWebhookServer({
    jobs: aiBackend.jobs,
    port: webhookPort
  });

  // 4. Create bot engine
  const bot = createBotEngine({
    chatProvider,
    aiBackend,
    aiName: 'Sprite',
    streamResponses: true
  });

  // 5. Start everything
  await webhookServer.start();
  aiBackend.startStaleReaper();
  await bot.start();

  console.log(`[sprite-bot] Running with ${CHAT_PROVIDER} provider`);
  console.log(`[sprite-bot] Sandbox: ${SANDBOX_TYPE}`);
  console.log(`[sprite-bot] Webhook server on port ${webhookPort}`);

  if (SANDBOX_TYPE === 'fly') {
    console.log(`[sprite-bot] Sprite app: ${process.env.FLY_SPRITE_APP}`);
    console.log(`[sprite-bot] Default image: ${process.env.SPRITE_IMAGE}`);
  } else {
    console.log(`[sprite-bot] GitHub repo: ${process.env.GITHUB_SPRITE_OWNER}/${process.env.GITHUB_SPRITE_REPO}`);
  }

  // 6. Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[sprite-bot] ${signal} received, shutting down...`);
    aiBackend.stopStaleReaper();
    await bot.stop();
    await webhookServer.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
})();
