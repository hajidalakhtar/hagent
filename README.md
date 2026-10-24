# 🚀 HAgent: Distributed AI Software Factory

**HAgent** adalah platform autonomous coding agent terdistribusi yang menggabungkan **Pi Durable** (crash resilience & effect sandwich), **A2A Protocol** (standar Agent-to-Agent open specification), dan **Git Worktree Isolation**, dirancang untuk dijalankan di atas armada **MicroVM** yang saling terhubung melalui **Tailscale mesh network**.

---

## 🏛️ Arsitektur Sistem

Sistem ini memisahkan secara tegas antara **Master Orchestrator (Thinking & Planning)** dan **Worker MicroVM (Tactical Execution)**:

```
┌────────────────────────────────────────────────────────────────────────┐
│ MASTER ORCHESTRATOR (Claude Code / Cloud Code / Antigravity / Master VM)│
│                                                                        │
│  - Menggunakan: `orchestrator-pack/`                                   │
│  - Peran: Analisis arsitektur, dekomposisi task, PR review             │
│  - Perintah: `bun run bin/fleet.ts dispatch --issue 42 ...`            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Tailscale WireGuard Mesh (Private IP / MagicDNS)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ WORKER FLEET MicroVM (Pi Durable Execution Engine)                     │
│                                                                        │
│  [A2A HTTP & SSE Server - Port 3000]                                   │
│  [Pi Durable Loop + SQLite WAL Store]                                  │
│  [9Router AI Gateway: web_search & web_fetch]                          │
│                                                                        │
│   ├── Slot 1 (Task A) ────► Worktree: /worktrees/task-a (Branch A)     │
│   │                         (inspect -> edit -> test -> PR via gh)     │
│   │                                                                    │
│   └── Slot 2 (Task B) ────► Worktree: /worktrees/task-b (Branch B)     │
│                             (inspect -> edit -> test -> PR via gh)     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🌟 Fitur Utama

1. **Pi Durable & Effect Sandwich**:
   - Setiap turn percakapan, rencana tool, dan eksekusi dicatat ke SQLite WAL mode.
   - *Idempotent*: Jika MicroVM reboot atau mati mendadak saat kompilasi, saat hidup kembali agen akan melanjutkan tanpa mengeksekusi ulang aksi yang sudah sukses.
2. **Multi-Agent & Multi-Worktree di 1 VM**:
   - Satu MicroVM dapat menjalankan banyak task sekaligus secara paralel (`--concurrency 4`).
   - Setiap task mendapatkan folder Git worktree terisolasi (`./worktrees/<task-id>`) pada branch terpisah (`agent/<task-id>`). Tidak ada tabrakan file antar task.
3. **Integrasi GitHub CLI (`gh`)**:
   - Otomatis menyelesaikan GitHub Issues (`gh_issue_view`).
   - Melakukan testing otomatis dengan `bash_run` (`bun test`, `npm test`, dll).
   - Membuka Pull Request otomatis via `gh_pr_create` lengkap dengan link `Closes #<issue>`.
   - Menginspeksi diff dan mereview PR via `gh_pr_view` dan `gh_pr_review`.
4. **9Router AI Gateway (Web Search & Web Fetch)**:
   - Tool `web_search` dan `web_fetch` terpasang secara default.
   - Agen dapat melakukan pencarian dokumentasi dan scraping halaman web secara mandiri sebelum mengubah kode.
   - Model pencarian & fetch dapat disesuaikan di `.env` (`WEB_SEARCH_MODEL`, `WEB_FETCH_MODEL`).
5. **A2A Protocol & Tailscale Ready**:
   - Expose endpoint standar: `/.well-known/agent.json`, `/tasks`, `/tasks/:id/events` (SSE streaming), `/tasks/:id/heartbeat`.
   - Tidak perlu IP publik atau sertifikat SSL rumit; berjalan aman di atas Tailscale private network.
6. **Instant Conversational Testing**:
   - Endpoint kilat `POST /chat` untuk smoke test / percakapan santai ("halo", "siapa kamu?") tanpa harus membuat worktree atau git repo.
7. **Paket Terpisah untuk Orchestrator (`orchestrator-pack/`)**:
   - Folder mandiri berisi CLI `fleet.ts`, skill A2A, dan panduan untuk di-copy ke Claude Code, Google Cloud Code, atau Antigravity.

---

## 📁 Struktur Repositori

```
hagent/
├── server.ts                  # Entrypoint worker agent di MicroVM
├── master.ts                  # CLI kontroler dasar dari Master VM
├── orchestrator-pack/         # 📦 PAKET KHUSUS UNTUK AGENT ORCHESTRATOR LAIN
│   ├── bin/fleet.ts           # Standalone CLI manager armada worker
│   ├── skills/                # Folder skill (a2a-worker-fleet, 9router)
│   ├── instructions/          # Drop-in rules (CLAUDE.md, GEMINI.md)
│   └── README.md              # Panduan pemasangan ke Claude Code / Cloud Code
├── src/
│   ├── a2a/                   # A2A Server & Agent Card
│   ├── agent/                 # Pi Durable agent loop & prompt engine
│   ├── store/                 # SQLite WAL durability layer
│   ├── sandbox/               # Git worktree lifecycle manager
│   ├── tools/                 # bash, fs, git, github (gh), web (9router)
│   ├── llm/                   # Universal LLM client
│   └── config.ts              # Konfigurasi environment
├── test/                      # Automated test suite (Bun test)
├── .env.example               # Template environment variables
└── README.md                  # Dokumentasi utama ini
```

---

## ⚡ Panduan Cepat (Quickstart)

### 1. Di Worker MicroVM

```bash
# 1. Salin konfigurasi environment
cp .env.example .env

# 2. Isi API Key LLM & GitHub Token di .env
# LLM_BASE_URL=https://ai.hajid.dev/v1
# LLM_API_KEY=sk-...
# GITHUB_TOKEN=ghp_...

# 3. Jalankan server worker
bun run server.ts --port 3000 --concurrency 4
```

Worker akan standby di port 3000 pada Tailscale network.

---

### 2. Di Master Orchestrator (Laptop / Master VM)

Kamu bisa mengoperasikan worker secara manual atau memberikannya ke AI Agent (Claude Code / Cloud Code):

#### Opsi A: Smoke Test Cepat (Chat)
```bash
bun run master.ts chat "halo bro"
```

#### Opsi B: Selesaikan GitHub Issue Otomatis Sampai Jadi PR
```bash
bun run master.ts submit \
  --worker http://worker-vm-1:3000 \
  --repo https://github.com/org/repo.git \
  --issue 42
```

#### Opsi C: Pasang ke Agent Orchestrator Lain (Claude Code / Cloud Code)
Lihat panduan lengkap di [`orchestrator-pack/README.md`](orchestrator-pack/README.md).
Cukup salin isi folder `orchestrator-pack/skills` dan `instructions` ke workspace agenmu!

---

## 🧪 Testing

Jalankan test suite menggunakan Bun:
```bash
bun test
```
*Seluruh pengujian unit, effect sandwich replay, A2A endpoints, concurrency worktree, dan tool web search berjalan hijau (8 pass, 0 fail).*
