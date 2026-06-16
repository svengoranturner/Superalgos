# Ask Claude — Apple Watch Shortcut

Query Claude AI directly from your wrist. Dictate a question, get an answer spoken aloud and displayed on your Apple Watch screen.

## What it does

```
[Watch] Tap shortcut → Dictate question
              ↓
[iPhone] POST https://api.anthropic.com/v1/messages
              ↓
[Watch] Speaks + shows Claude's reply
```

## Prerequisites

- iPhone with iOS 16+ (required to sync shortcuts to Watch)
- Apple Watch with watchOS 9+
- Anthropic API key — get one at [console.anthropic.com](https://console.anthropic.com/settings/api-keys)

## Quick start

### Option A — use the pre-built shortcut

1. Open this file on your iPhone: [`AskClaude.shortcut`](AskClaude.shortcut)
2. Tap **Add Shortcut**
3. Open the shortcut, tap **···** (edit) → find the **Get Contents of URL** step
4. Replace `YOUR_API_KEY_HERE` in the `x-api-key` header with your real key
5. Tap **Done**

### Option B — generate with your key baked in

```bash
python3 generate_shortcut.py --api-key sk-ant-YOUR_KEY_HERE
```

Then AirDrop `AskClaude.shortcut` to your iPhone and tap to install.

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--api-key` | `YOUR_API_KEY_HERE` | Anthropic API key |
| `--model` | `claude-sonnet-4-6` | Claude model ID |
| `--max-tokens` | `1024` | Max tokens in response |
| `--output` | `AskClaude.shortcut` | Output filename |

## Add to Apple Watch

1. On iPhone, open the **Shortcuts** app
2. Long-press **Ask Claude** → **Details**
3. Enable **"Show on Apple Watch"**
4. The shortcut appears in the Watch's Shortcuts app within seconds

Or pin it as a **complication**: Watch app → face → edit complications → choose Shortcuts → Ask Claude.

## Security note

Your API key is stored inside the shortcut file and in the Shortcuts app on your device — it never leaves Apple's secure enclave. Do not share the generated `.shortcut` file with others.

## Customising the system prompt

Open the shortcut for editing on iPhone, find the **Text** action (step 3), and change:

```
{"model":"...","messages":[{"role":"user","content":"YOUR_QUESTION"}]}
```

to include a system message:

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "system": "You are a concise assistant. Reply in 2-3 sentences max.",
  "messages": [{"role": "user", "content": "YOUR_QUESTION"}]
}
```

Or regenerate via the script — editing JSON is easier than editing Shortcuts UI.
