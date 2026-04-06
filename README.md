# Internet Tracker

A Cloudflare Worker + D1 app that tracks when you toggle internet on/off on your iPhone, with a sleek dark dashboard to visualize your daily usage.

![Architecture: iPhone Shortcut → Cloudflare Worker → D1 → Dashboard]

---

## Setup (5 minutes)

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- [Node.js](https://nodejs.org/) 18+ installed
- Wrangler CLI: `npm install -g wrangler`

### 1. Authenticate with Cloudflare

```bash
npx wrangler login
```

### 2. Create the D1 Database

```bash
npx wrangler d1 create internet-tracker-db
```

This prints a `database_id` — copy it and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "internet-tracker-db"
database_id = "paste-your-id-here"   # ← replace this
```

### 3. Set Your Auth Token

Generate a random token (e.g., run `openssl rand -hex 32`) and set it as a secret:

```bash
npx wrangler secret put AUTH_TOKEN
# paste your token when prompted
```

> Keep this token — you'll need it for the iPhone Shortcut.

### 4. Initialize the Database

```bash
npx wrangler d1 execute internet-tracker-db --remote --file=./schema.sql
```

### 5. Deploy

```bash
npx wrangler deploy
```

You'll get a URL like `https://internet-tracker.<your-subdomain>.workers.dev`.  
Open it in a browser — that's your dashboard!

---

## iPhone Shortcuts Setup

You need **two shortcuts**: one for "Internet ON", one for "Internet OFF".

### Shortcut: Internet ON

1. Open the **Shortcuts** app on your iPhone
2. Tap **+** to create a new shortcut
3. Name it **"Internet ON"**
4. Add these actions in order:

   **a. Get Current Date**
   - Action: `Date` → `Current Date`

   **b. Format Date**
   - Action: `Format Date`
   - Format: **Custom** → `yyyy-MM-dd'T'HH:mm:ssZZZZZ`
   - This gives you a proper ISO 8601 timestamp with timezone offset

   **c. Get Contents of URL** (this is the HTTP request)
   - URL: `https://internet-tracker.<your-subdomain>.workers.dev/api/event`
   - Method: **POST**
   - Headers:
     - `Authorization`: `Bearer YOUR_TOKEN_HERE`
     - `Content-Type`: `application/json`
   - Request Body (JSON):
     ```json
     {
       "type": "on",
       "local_time": "<Formatted Date from step b>"
     }
     ```

5. (Optional) Add a **Show Notification** action: "Internet ON tracked ✅"

### Shortcut: Internet OFF

Same as above, but change `"type": "on"` to `"type": "off"` and name it **"Internet OFF"**.

### Automation Triggers

To make it fully automatic:

1. Go to **Shortcuts → Automation** tab
2. Tap **+** → **Create Personal Automation**
3. Choose a trigger:
   - **"Wi-Fi"**: When connecting to/disconnecting from Wi-Fi
   - **"App"**: When opening/closing Settings
   - Or use **NFC tags** placed near your router
4. Set the action to **Run Shortcut** → pick your ON or OFF shortcut
5. Toggle off **"Ask Before Running"** for seamless tracking

> **Note on Cellular Data:** iOS doesn't have a direct automation trigger for
> toggling cellular data. The simplest approach is to manually run the shortcut
> when you toggle, or use Focus Modes as a proxy trigger.

---

## API Reference

### `POST /api/event`

Record an on/off event.

```bash
curl -X POST https://your-worker.workers.dev/api/event \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type": "on", "local_time": "2026-04-06T14:30:00-04:00"}'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"on"` or `"off"` | Yes | Internet toggled on or off |
| `local_time` | ISO 8601 string | No | Local time with timezone offset. If omitted, UTC server time is used. |

### `GET /api/events?date=YYYY-MM-DD`

Get all events for a given date (defaults to today).

### `GET /api/stats?date=YYYY-MM-DD`

Get computed stats: on/off segments, total online time, session count.

### `GET /`

The dashboard.

---

## Local Development

```bash
# Init DB locally
npx wrangler d1 execute internet-tracker-db --local --file=./schema.sql

# Run dev server
npx wrangler dev

# Test with curl
curl -X POST http://localhost:8787/api/event \
  -H "Authorization: Bearer CHANGE_ME_TO_A_RANDOM_STRING" \
  -H "Content-Type: application/json" \
  -d '{"type": "on", "local_time": "2026-04-06T09:00:00-04:00"}'

curl -X POST http://localhost:8787/api/event \
  -H "Authorization: Bearer CHANGE_ME_TO_A_RANDOM_STRING" \
  -H "Content-Type: application/json" \
  -d '{"type": "off", "local_time": "2026-04-06T10:30:00-04:00"}'

# Check dashboard
open http://localhost:8787
```

---

## Project Structure

```
internet-tracker/
├── wrangler.toml        # Cloudflare Worker config + D1 binding
├── schema.sql           # Database schema
├── package.json         # Scripts for dev/deploy
├── README.md            # You are here
└── src/
    └── worker.js        # Worker: API endpoints + dashboard HTML
```
