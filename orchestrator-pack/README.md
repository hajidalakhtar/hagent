# 🎮 HAgent Orchestrator Pack

Paket portable (skill, CLI toolkit, dan prompt rules) yang dirancang khusus untuk dipasang pada **Agent Orchestrator Utama** (seperti **Claude Code**, **Google Cloud Code**, **Google Antigravity**, **Cursor**, atau **Pi Agent**) agar dapat mengontrol armada **Pi Durable Execution Workers** di MicroVM melalui Tailscale.

---

## 📁 Struktur Direktori

```
orchestrator-pack/
├── bin/
│   └── fleet.ts                     # Standalone CLI manager armada worker (Zero dependency, run with Bun)
├── skills/
│   ├── a2a-worker-fleet/
│   │   └── SKILL.md                 # Standar SOP delegasi tugas & monitoring worker
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

### 1. Untuk Google Cloud Code / Google Antigravity
Salin folder `skills/` dan aturan `instructions/GEMINI.md` ke root workspace proyekmu:
```bash
# Di workspace proyek Master VM:
mkdir -p .agents/skills
cp -r orchestrator-pack/skills/* .agents/skills/
cp orchestrator-pack/instructions/GEMINI.md ./GEMINI.md
cp orchestrator-pack/fleet.config.json.example ./fleet.config.json
```
*Antigravity dan Google Cloud Code akan langsung otomatis mendeteksi skill `a2a-worker-fleet` dan `9router`!*

---

### 2. Untuk Claude Code
Salin aturan delegasi dan CLI:
```bash
# Di workspace proyek Claude Code:
cp orchestrator-pack/instructions/CLAUDE.md ./CLAUDE.md
cp -r orchestrator-pack/skills ./.claude-skills
cp orchestrator-pack/fleet.config.json.example ./fleet.config.json
```
*Claude Code akan membaca `CLAUDE.md` dan secara otomatis menggunakan `bun run bin/fleet.ts` saat kamu memintanya mengerjakan tugas.*

---

## ⚙️ Konfigurasi Daftar Worker

Edit file `fleet.config.json` di root workspace Master:
```json
{
  "workers": [
    "http://worker-vm-1:3000",
    "http://worker-vm-2:3000"
  ]
}
```
*(Bisa juga menggunakan environment variable: `export FLEET_WORKERS="http://100.64.0.10:3000,http://100.64.0.11:3000"`)*.

---

## 🛠️ CLI Toolkit Reference (`bin/fleet.ts`)

Semua agen (maupun kamu sendiri dari terminal) dapat menjalankan perintah berikut:

```bash
# 1. Cek kesehatan dan slot kapasitas semua worker di armada
bun run bin/fleet.ts status

# 2. Kirim tugas berbasis GitHub Issue (Otomatis pilih worker terlengang)
bun run bin/fleet.ts dispatch \
  --repo https://github.com/org/repo.git \
  --issue 42 \
  --watch

# 3. Kirim instruksi kustom spesifik
bun run bin/fleet.ts dispatch \
  --repo https://github.com/org/repo.git \
  --target-branch agent/auth-fix \
  --prompt "Perbaiki validasi JWT di src/auth.ts dan jalankan bun test" \
  --watch

# 4. Review Pull Request otomatis
bun run bin/fleet.ts dispatch \
  --repo https://github.com/org/repo.git \
  --pr 15 \
  --prompt "Cari celah keamanan SQL injection dan memory leak" \
  --watch

# 5. Sanity Check / Ping percakapan kilat (tanpa Git)
bun run bin/fleet.ts ping "halo dari master"

# 6. List semua task di seluruh node
bun run bin/fleet.ts tasks

# 7. Batalkan task yang sedang berjalan
bun run bin/fleet.ts cancel <task_id> --worker http://worker-vm-1:3000
```
