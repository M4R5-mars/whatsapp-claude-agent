# WhatsApp AI agent

A small server that connects **WhatsApp (Meta's Cloud API)** to **Claude**:

1. Someone sends a message, photo or PDF to your WhatsApp business number.
2. Meta delivers it to this server (webhook) through a public HTTPS address.
3. The server checks the sender is allowed, asks Claude, and replies on WhatsApp.

No dependencies to install: you only need **Node.js 18 or later**.

## Files

| File | Purpose |
|---|---|
| `server.js` | The server (webhook, WhatsApp, Claude) |
| `prompt.md` | The agent's instructions. Edit it to change how the agent behaves. |
| `.env` | Configuration template. Fill it. |
| `start-windows.bat` | Starts the server on Windows and restarts it if it stops |
| `install-windows-service.ps1` | Makes the server start automatically with Windows |
| `whatsapp-agent.service` | The Linux equivalent (systemd) |

## What the agent does

- Replies to text, **photos** (analyzes the image) and **PDFs**.
- Remembers the last ~12 messages per person (lost on restart).
- Only replies to numbers in `ALLOWED_NUMBERS` (or to anyone with `*`, with a daily limit per number).
- Verifies Meta's signature on every request and rejects forged ones.
- Never replies twice to the same message.
- Voice notes: asks the person to type instead (no audio support yet).

---

## 1. Prepare the machine (10 min)

1. Install **Node.js** (LTS) from [nodejs.org](https://nodejs.org). On Windows, accept the defaults.
2. Copy this folder to a fixed location, e.g. `C:\whatsapp-claude-agent` (Windows) or `/opt/whatsapp-claude-agent` (Linux).
3. If it runs 24/7, make sure the machine **never sleeps or hibernates** (Windows: Settings → System → Power → "Never").

## 2. Configure (5 min)

Open the file **`.env`** in the same folder and fill in:

| Variable | Where to find it |
|---|---|
| `WHATSAPP_VERIFY_TOKEN` | You make it up: a long secret word |
| `META_APP_SECRET` | developers.facebook.com → your app → **App settings → Basic → App secret** (Show) |
| `WHATSAPP_TOKEN` | Permanent *system user* token (business.facebook.com → Settings → Users → System users → Generate token, with `whatsapp_business_messaging` and `whatsapp_business_management`) |
| `WHATSAPP_PHONE_NUMBER_ID` | developers.facebook.com → WhatsApp → **API Setup** → *Phone number ID* of the number you'll use (not the phone number itself) |
| `ANTHROPIC_API_KEY` | platform.claude.com → **Settings → API keys** (needs prepaid credits) |
| `ALLOWED_NUMBERS` | Allowed numbers with country code, comma-separated: `351912345678,351923456789`. Or `*` for anyone. |

`.env` contains secret keys: don't share it, don't email it, and restrict access to the folder.

On Windows, check the file isn't secretly called `.env.txt`: run `dir /a` in the folder. If the server prints `.env not found`, that's usually why.

**Quick test**, in a terminal inside the folder:

```
node server.js
```

You should see `WhatsApp agent running on http://127.0.0.1:3000`, followed by the business number ID and the allowed numbers. Open `http://127.0.0.1:3000/health` in a browser on that machine: it should show `{"ok":true}`. Stop it with Ctrl+C.

**After any change to `.env` or `prompt.md`, restart the server.** Both are only read at startup.

## 3. Give it a public HTTPS address (the tunnel)

Meta must reach the server at a **public HTTPS address**. A tunnel does that **without opening ports on your router** and without certificates: a small program on the machine connects outwards and receives traffic through that channel. Pick one:

### Option A: ngrok (quickest for testing)
1. Create an account at [ngrok.com](https://ngrok.com) and claim your **free static domain** (Dashboard → Domains).
2. Install ngrok and connect your account: `ngrok config add-authtoken <your token>`
3. Run, in a second terminal (keep both open while testing):
   ```
   ngrok http --url=your-domain.ngrok-free.dev 127.0.0.1:3000
   ```
   Use `127.0.0.1:3000` rather than `3000`: on Windows, "localhost" sometimes points to an address the server isn't listening on (error `ERR_NGROK_8012`).
4. Your webhook address is `https://your-domain.ngrok-free.dev/webhook`.

`ngrok service install` (start with the machine) is only needed for permanent use, not for testing. `ERR_NGROK_3200` means the tunnel isn't running under that domain: check the **Forwarding** line in the ngrok window.

### Option B: Cloudflare Tunnel (recommended for production, if your domain is on Cloudflare)
1. In [dash.cloudflare.com](https://dash.cloudflare.com) → **Zero Trust → Networks → Tunnels → Create a tunnel** → type **Cloudflared**.
2. Choose the machine's OS and run the install command Cloudflare shows. This installs the tunnel **as a service** that starts with the machine.
3. Under **Public hostname**, create e.g. `agent.yourcompany.com` → **Service:** `HTTP` → `localhost:3000`.
4. Your webhook address is `https://agent.yourcompany.com/webhook`.

The tunnel adds nothing to `.env`: its key is stored in the `cloudflared` service.

### Option C: the server already has a public IP and a web server (IIS, nginx…)
Set up a reverse proxy from `/webhook` to `http://127.0.0.1:3000/webhook`, with a valid HTTPS certificate.

## 4. Start automatically (production only)

**Windows:** open PowerShell **as Administrator**, go to the folder and run:

```
powershell -ExecutionPolicy Bypass -File .\install-windows-service.ps1
```

This creates a scheduled task that starts the agent with Windows (even with nobody logged in) and restarts it if it stops. Logs go to `logs\agent.log`.

**Linux:** adjust the paths and user in `whatsapp-agent.service` and follow the instructions at the top of that file. Logs: `journalctl -u whatsapp-agent -f`.

## 5. Connect Meta to the server (10 min)

### 5.1 Webhook
In developers.facebook.com → your app → **WhatsApp → Configuration**:

1. Under **Webhook**, click **Edit**:
   - **Callback URL:** your address from step 3, ending in `/webhook`
   - **Verify token:** the same value as `WHATSAPP_VERIFY_TOKEN`
   - Leave **"Attach client certificate"** off: the server already verifies every request with your app secret.
   - Click **Verify and save**.
2. Under **Webhook fields**, **Subscribe** to the **`messages`** field.

### 5.2 Subscribe your app to the WhatsApp account
This step is easy to miss: without it, Meta accepts the webhook but **never delivers messages** for your business number. In PowerShell:

```powershell
$token = "YOUR_WHATSAPP_TOKEN"
$waba  = "YOUR_WHATSAPP_BUSINESS_ACCOUNT_ID"
Invoke-RestMethod "https://graph.facebook.com/v23.0/$waba/subscribed_apps" -Method Post -Headers @{Authorization="Bearer $token"}
```

It should reply `success : True`. The *WhatsApp Business Account ID* is shown in API Setup and is **not** the phone number ID. If you get `nonexisting field (subscribed_apps)`, you used the wrong ID. To list the accounts your business owns:

```powershell
Invoke-RestMethod "https://graph.facebook.com/v23.0/YOUR_BUSINESS_PORTFOLIO_ID/owned_whatsapp_business_accounts" -Headers @{Authorization="Bearer $token"} | ConvertTo-Json -Depth 5
```

If that fails with a permission error, assign the WhatsApp account to your system user (business.facebook.com → Settings → System users → Assign assets → WhatsApp accounts, full control) and generate a new token.

### 5.3 Check the token and number
```powershell
$id = "YOUR_WHATSAPP_PHONE_NUMBER_ID"
Invoke-RestMethod "https://graph.facebook.com/v23.0/$($id)?fields=display_phone_number,verified_name,status" -Headers @{Authorization="Bearer $token"}
```
You should see your number with `status : CONNECTED`.

### 5.4 Development vs. Live
While your app is in **Development** mode, Meta only lets the agent reply to numbers in the **To** list under API Setup, whatever `ALLOWED_NUMBERS` says. To reply to anyone, switch the app to **Live** (requires a Privacy Policy URL under App settings → Basic).

## 6. Test

From an allowed phone, send "Hello" to your business number, then a photo. You should see:

```
[webhook] field=messages number=... phone_number_id=... messages=1 statuses=0
[received] text from 351912345678
[ok] replied to 351912345678 (text)
```

The ngrok web interface at **http://127.0.0.1:4040** shows every request Meta sends and the server's response.

## Troubleshooting

| What you see | Meaning |
|---|---|
| `[config] ... .env not found` | The file is missing or has another name (e.g. `.env.txt`); the message lists similar files |
| `[config] Missing environment variables: ...` | A value is empty in `.env` |
| `[config] X is also set as a system variable` | Harmless: `.env` wins. Remove the system variable to avoid confusion |
| `[security] invalid signature` | `META_APP_SECRET` is wrong |
| `[ignored] message from unauthorized number +...` | Add that number to `ALLOWED_NUMBERS` and restart |
| `[ignored] message for phone_number_id X, but .env has ...` | Put the ID shown in the message into `WHATSAPP_PHONE_NUMBER_ID` and restart |
| `[meta] Meta refused to send ... development mode` | Add the number to the **To** list in API Setup, or switch the app to Live |
| `[limit] ... passed the limit` | The daily limit per number was reached (`MAX_MESSAGES_PER_DAY`) |
| `[claude] Claude 401/400 ...` | Anthropic key is wrong or has no credits |
| `WhatsApp 401 ...` / `(#190)` | `WHATSAPP_TOKEN` invalid or expired (did you use the temporary one?) |
| Message gets read ticks but nothing in the server or ngrok | Meta isn't delivering: do step 5.2 (`subscribed_apps`) and check the `messages` subscription |
| Nothing at all in ngrok | Check the tunnel is online and the Callback URL matches it |

## Policy note

Meta's WhatsApp Business policy (since January 2026) does not allow **general-purpose AI assistants** offered as the main service. An assistant that supports your own business operations or customers is allowed. Before opening the agent to the public (`ALLOWED_NUMBERS=*`), give `prompt.md` a clear business focus.

## Limitations

- Conversation history is kept in memory and lost on restart.
- Nothing is stored in a database.
- No voice note support.
- The agent can only **reply**. Starting conversations (e.g. a morning reminder) requires message templates approved by Meta.
