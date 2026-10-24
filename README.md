# Pi Durable Execution Worker (hagent)

Sistem autonomous **Tactical Execution Worker** berbasis **Pi Durable** dengan interface **A2A (Agent-to-Agent) Protocol**, dirancang khusus untuk berjalan di atas armada **MicroVM (Tailscale mesh)**.

Agen ini berfokus murni sebagai **Worker Pelaksana (Execution Engine)**:
* **Master Agent** (seperti Claude Code, Google Antigravity, Pi Agent, atau custom script) bertugas melakukan *high-level thinking*, dekomposisi masalah, dan arsitektur.
* **Worker Agent ini** bertugas menerima sub-task konkret, memodifikasi kode di Git Worktree terisolasi, menjalankan unit test untuk verifikasi, melakukan git commit, dan mengembalikan structured artifact (diff, commit sha, test status) ke Master.

---

## 🌟 Multi-Agent & Multi-Worktree di 1 VM

Dalam **satu MicroVM**, sistem mendukung **beberapa agen/task berjalan paralel**:
1. **Parallel Task Slots (Concurrency Queue)**:
   - Satu proses worker bisa menjalankan multiple task bersamaan (default: 4 slot, dapat diatur via `--concurrency`).
   - Setiap task mendapatkan **direktori Git Worktree sendiri** di `./worktrees/<task-id>` pada branch terpisah (`agent/<task-id>`), sehingga tidak ada file conflict.
2. **Multiple Worker Processes per VM**:
   - Jika ingin memisahkan proses (misal untuk alokasi CPU/port berbeda):
     ```bash
     # Worker 1 di port 3001
     bun run server.ts --port 3001 --agent-id worker-alpha --concurrency 2

     # Worker 2 di port 3002
     bun run server.ts --port 3002 --agent-id worker-beta --concurrency 2
     ```

---

## 🏗️ Topologi Orkestrator & Worker

```
┌────────────────────────────────────────────────────────────────────────┐
│ MASTER AGENT (Claude Code / Antigravity / Pi / Custom Script)          │
│                                                                        │
│  1. Analisis issue besar & dekomposisi jadi sub-task terpisah          │
│  2. Temukan worker via Tailscale: GET /.well-known/agent.json          │
│  3. Kirim Subtask A -> Worker VM 1 (Branch: agent/auth-fix)            │
│  4. Kirim Subtask B -> Worker VM 1 (Branch: agent/billing-feat)        │
│  5. Tonton live stream SSE & terima artifact diff/commit               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Tailscale Mesh Network
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ WORKER MicroVM (Pi Durable Execution Engine)                           │
│                                                                        │
│  [A2A HTTP & SSE Server - Port 3000]                                   │
│  [Slots: Max 4 Concurrent Worktrees]                                   │
│                                                                        │
│   ├── Task A Loop ────────► Worktree: /worktrees/task-a (Branch A)     │
│   │   (Pi Durable SQLite)   (bash_run -> test -> git_commit)           │
│   │                                                                    │
│   └── Task B Loop ────────► Worktree: /worktrees/task-b (Branch B)     │
│       (Pi Durable SQLite)   (bash_run -> test -> git_commit)           │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 📋 A2A API Endpoints (Untuk Dipanggil Master Agent)

| Method | Endpoint | Deskripsi |
|---|---|---|
| `GET` | `/.well-known/agent.json` | Mengembalikan **Agent Card** (tools, skills, slot kapasitas `max` & `active`) |
| `POST` | `/tasks` | Submit sub-task baru (`{ prompt, repo: { url, base_branch, target_branch } }`) |
| `GET` | `/tasks` | List semua task di worker |
| `GET` | `/tasks/:id` | Status task, artifacts (commit sha, target branch), & execution summary |
| `GET` | `/tasks/:id/events` | **SSE Stream**: Live stream thoughts, tool calls, tool results |
| `POST` | `/tasks/:id/heartbeat` | Perpanjangan lease time |
| `POST` | `/tasks/:id/cancel` | Batalkan eksekusi task |

---

## 🚀 Panduan Menjalankan

### 1. Di Worker VM
```bash
# Salin konfigurasi environment
cp .env.example .env

# Jalankan worker dengan 4 concurrent worktree slots
bun run server.ts --port 3000 --concurrency 4
```

### 2. Dari Master Agent / CLI
```bash
# Cek Agent Card & ketersediaan slot di Worker
bun run master.ts card --worker http://worker-vm-1:3000

# Kirim sub-task A
bun run master.ts submit \
  --worker http://worker-vm-1:3000 \
  --repo https://github.com/my-org/backend.git \
  --target-branch agent/auth-fix \
  --prompt "Perbaiki validasi token JWT di src/auth.ts dan jalankan bun test test/auth.test.ts"

# Kirim sub-task B secara paralel (akan langsung jalan di worktree berbeda!)
bun run master.ts submit \
  --worker http://worker-vm-1:3000 \
  --repo https://github.com/my-org/backend.git \
  --target-branch agent/billing-feat \
  --prompt "Tambahkan endpoint webhook Stripe di src/billing.ts dan verifikasi dengan bun test"
```

---

## 🧪 Testing

```bash
bun test
```
*Semua 6 unit & concurrency integration tests lulus dalam ~200ms.*
