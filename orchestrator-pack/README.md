# 🎮 HAgent Orchestrator Pack

Paket portable (native tools, Pi extension, MCP server, dan skills) yang dirancang khusus untuk dipasang pada **Agent Orchestrator Utama** (seperti **Pi Agent**, **Claude Code**, **Google Cloud Code**, **Google Antigravity**, atau **Cursor**) agar dapat berkomunikasi secara **native A2A (Agent-to-Agent)** dengan armada **Pi Durable Workers** di MicroVM melalui Tailscale.

> [!IMPORTANT]
> **Tidak perlu lagi menulis HTTP curl di bash!**
> Orchestrator agent kini memiliki native tool calls: `a2a_discover_fleet`, `a2a_send_task`, `a2a_get_task_status`, `a2a_send_message`, dan `a2a_chat`.

---

## 📁 Struktur Direktori

```
orchestrator-pack/
├── extensions/
│   └── pi-extension.ts              # 🚀 Native Extension untuk Pi Coding Agent (@earendil-works)
├── mcp/
│   └── a2a-server.ts                # 🔌 MCP Server untuk Claude Code, Antigravity, Cursor
├── src/
│   └── a2a-client.ts                # SDK Client Protokol A2A
├── bin/
│   └── fleet.ts                     # Standalone CLI toolkit untuk terminal/script
├── skills/
│   ├── a2a-worker-fleet/
│   │   └── SKILL.md                 # Standar SOP & panduan native A2A tool calling
│   └── 9router/
│       └── SKILL.md                 # Integrasi 9Router AI gateway (Web search, fetch, image, TTS)
├── instructions/
│   ├── GEMINI.md                    # Aturan delegasi untuk Google Cloud Code / Antigravity
│   └── CLAUDE.md                    # Aturan delegasi untuk Claude Code
├── fleet.config.json.example        # Template konfigurasi IP worker di Tailscale
└── README.md                        # Dokumentasi ini
```

---

## 🔌 Cara Pasang ke Agen Pilihanmu

### 1. Untuk Pi Agent (`@earendil-works/pi-coding-agent`)
Pasang extension native agar Pi Agent memiliki tool `a2a_*`:

```bash
# Opsi A: Copy ke folder extensions Pi
mkdir -p .pi/extensions
cp orchestrator-pack/extensions/pi-extension.ts .pi/extensions/a2a.ts

# Opsi B: Jalankan Pi dengan flag extension
pi --extension ./orchestrator-pack/extensions/pi-extension.ts
```

*Ketika Pi Agent berjalan, model LLM akan langsung melihat tool native:*
* `a2a_discover_fleet()`
* `a2a_send_task({ prompt, issue_number, repo_url })`
* `a2a_get_task_status({ task_id })`
* `a2a_send_message({ task_id, message })` (Komunikasi dua arah)
* `a2a_chat({ message })`

---

### 2. Untuk Claude Code / Google Antigravity / Cursor (via MCP Server)
Daftarkan `orchestrator-pack/mcp/a2a-server.ts` ke konfigurasi MCP (`mcp.json` atau `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hagent-fleet": {
      "command": "bun",
      "args": ["run", "/path/to/hagent/orchestrator-pack/mcp/a2a-server.ts"],
      "env": {
        "FLEET_WORKERS": "http://worker-vm-1:3000,http://worker-vm-2:3000"
      }
    }
  }
}
```
*Claude Code atau Antigravity akan langsung mengekspos tool A2A tersebut di dalam obrolan.*

---

### 3. Konfigurasi Daftar Worker
Edit `fleet.config.json` di root workspace Master:
```json
{
  "workers": [
    "http://worker-vm-1:3000",
    "http://worker-vm-2:3000"
  ]
}
```

---

## 🛠️ CLI Toolkit Reference (`bin/fleet.ts`)

Jika ingin menjalankan perintah manual atau testing dari terminal:

```bash
# 1. Cek kesehatan dan slot kapasitas semua worker di armada
bun run bin/fleet.ts status

# 2. Kirim tugas berbasis GitHub Issue (Otomatis pilih worker terlengang)
bun run bin/fleet.ts dispatch \
  --repo https://github.com/org/repo.git \
  --issue 42 \
  --watch

# 3. Sanity Check / Ping percakapan kilat
bun run bin/fleet.ts ping "halo dari master"

# 4. List semua task di seluruh node
bun run bin/fleet.ts tasks
```
