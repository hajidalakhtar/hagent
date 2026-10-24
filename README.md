# Pi Durable Coding Agent (hagent)

Sistem autonomous coding agent berbasis **Pi Durable** dengan interface **A2A (Agent-to-Agent) Protocol**, dirancang khusus untuk berjalan di atas armada **MicroVM** yang saling terhubung melalui **Tailscale mesh network**.

---

## 🌟 Fitur Utama

- **Pi Durable Loop**: Setiap langkah berpikir (*turns*), pesan, dan eksekusi tool dicatat secara persisten ke SQLite WAL mode. Mampu melanjutkan eksekusi (*auto-recovery*) pasca reboot/crash tanpa mengulang *side-effect*.
- **The Effect Sandwich (Idempotency)**:
  1. *Intent*: Catat rencana eksekusi tool (`PENDING`).
  2. *Execution*: Jalankan side effect (`bash_run`, `edit_file`, dsb).
  3. *Commit*: Simpan output ke SQLite.
  Jika VM mati mendadak saat eksekusi tool, state direkonsiliasi dan tidak terjadi duplikasi eksekusi.
- **A2A Protocol Compliance**:
  - `GET /.well-known/agent.json`: Agent Card (deskripsi skill, capability, tools, endpoint).
  - `POST /tasks`: Menerima task coding baru.
  - `GET /tasks/:id`: Cek status, pesan, dan artifacts.
  - `GET /tasks/:id/events`: Server-Sent Events (SSE) streaming live logs, thoughts, dan tool results.
  - `POST /tasks/:id/heartbeat`: Distributed lease renewal.
  - `POST /tasks/:id/cancel`: Pembatalan task aman.
- **Git Worktree Isolation**: Setiap task dijalankan di folder terisolasi (`./worktrees/<task-id>`) pada git branch khusus (`agent/<task-id>`), mencegah konflik file antar task paralel.
- **Zero-Dependency Bun Runtime**: Dibangun 100% menggunakan native primitives Bun (`bun:sqlite`, `Bun.serve`, `Bun.spawn`, native `fetch`), start time < 10ms.

---

## 🏗️ Arsitektur

```
┌────────────────────────────────────────────────────────┐
│ Master VPS / Developer Machine                         │
│                                                        │
│  bun run master.ts submit                              │
│       │                                                │
│       │ Tailscale Mesh (Encrypted WireGuard)           │
│       ▼                                                │
├────────────────────────────────────────────────────────┤
│ Worker MicroVM (IP: 100.x.y.z)                         │
│                                                        │
│  [A2A HTTP & SSE Server (Bun.serve)]                   │
│         │                                              │
│         ▼                                              │
│  [Pi Durable Loop + SQLite WAL Store]                  │
│         │                                              │
│         ├── Effect Sandwich Idempotency Layer          │
│         │                                              │
│         ▼                                              │
│  [Git Worktree Sandbox: /worktrees/<task-id>]          │
│         │                                              │
│         └── Tools: bash_run, file_edit, git_commit...  │
└────────────────────────────────────────────────────────┘
```

---

## 🚀 Panduan Menjalankan

### 1. Di Worker VPS (MicroVM)

1. Pastikan MicroVM terhubung ke Tailscale:
   ```bash
   sudo tailscale up
   ```
2. Clone repo dan buat file konfigurasi `.env`:
   ```bash
   cp .env.example .env
   ```
   Isi API key model LLM (Gemini / OpenAI / OpenRouter):
   ```env
   PORT=3000
   HOST=0.0.0.0
   GEMINI_API_KEY=AIzaSy...
   LLM_MODEL=gemini-2.5-flash
   ```
3. Jalankan server worker:
   ```bash
   bun run server.ts
   ```
   Worker akan mengekspos endpoint A2A di port 3000 pada IP Tailscale MicroVM tersebut.

---

### 2. Di Master VPS (Orkestrator)

Gunakan CLI `master.ts` untuk mengontrol worker di Tailscale:

#### Cek Agent Card (Discovery)
```bash
bun run master.ts card --worker http://worker-vm-1:3000
```

#### Kirim Task Coding & Tonton Live Stream Log
```bash
bun run master.ts submit \
  --worker http://worker-vm-1:3000 \
  --prompt "Perbaiki fungsi hitung diskon di src/discount.ts dan jalankan bun test"
```

#### Kirim Task untuk Repo Git Tertentu
```bash
bun run master.ts submit \
  --worker http://worker-vm-1:3000 \
  --repo https://github.com/org/my-project.git \
  --base-branch main \
  --prompt "Refactor user authentication endpoint to validate JWT expiry"
```

#### List & Status Task
```bash
# List semua task di worker
bun run master.ts list --worker http://worker-vm-1:3000

# Detail task
bun run master.ts status <task_id> --worker http://worker-vm-1:3000

# Cancel task
bun run master.ts cancel <task_id> --worker http://worker-vm-1:3000
```

---

## 🧪 Menjalankan Unit & Integration Test

Semua modul (SQLite persistence, Effect Sandwich, Git Worktree, A2A Server) diuji secara otomatis:

```bash
bun test
```
