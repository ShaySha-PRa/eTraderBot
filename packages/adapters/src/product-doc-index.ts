export const RAKAZO_DOCS: ReadonlyArray<readonly [topics: string, url: string]> = [
  ["Getting started, first bot, what Rakazo does", "http://localhost:5173/docs.md"],
  [
    "Creating bots, chatting, bot settings, sidebar, search",
    "http://localhost:5173/docs/bots-and-chats.md",
  ],
  [
    "Importing an OpenClaw, Hermes or ChatGPT agent",
    "http://localhost:5173/docs/import-an-agent.md",
  ],
  [
    "Connecting apps and integrations (Gmail, GitHub, MCP tools)",
    "http://localhost:5173/docs/integrations.md",
  ],
  ["Slack, Telegram, WhatsApp and other chat apps", "http://localhost:5173/docs/messaging-apps.md"],
  ["Routines, schedules and triggers", "http://localhost:5173/docs/routines.md"],
  ["The bot's computer, files, using your own computer", "http://localhost:5173/docs/computer.md"],
  ["Memory", "http://localhost:5173/docs/memory.md"],
  ["Skills", "http://localhost:5173/docs/skills.md"],
  ["Approvals, Allow and Block lists", "http://localhost:5173/docs/approvals.md"],
  ["Group chats, bots working together, subagents", "http://localhost:5173/docs/groups.md"],
  ["Voice, calls, spoken replies", "http://localhost:5173/docs/voice-and-calls.md"],
  ["Models, providers, API keys, fallbacks, usage", "http://localhost:5173/docs/models.md"],
  ["Spaces", "http://localhost:5173/docs/spaces.md"],
  ["Saved credentials and website logins", "http://localhost:5173/docs/bot-secrets.md"],
  [
    "Account, preferences, data export, credits, plans, billing",
    "http://localhost:5173/docs/account.md",
  ],
  ["Desktop app", "http://localhost:5173/docs/desktop-app.md"],
  ["Mobile app", "http://localhost:5173/docs/mobile-app.md"],
  ["Bots that create and manage bots", "http://localhost:5173/docs/fleet-management.md"],
  ["Building a plugin", "http://localhost:5173/docs/build-a-plugin.md"],
  ["Self-hosting", "http://localhost:5173/docs/self-host.md"],
  ["Self-hosted server configuration", "http://localhost:5173/docs/self-host-configuration.md"],
];

/** Fixed URLs, so fetching one can't carry anything out of a run. */
export const RAKAZO_DOCS_URLS = RAKAZO_DOCS.map(([, url]) => url);
