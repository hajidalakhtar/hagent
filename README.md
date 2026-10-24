# Pi Durable Execution Worker (hagent)

Sistem autonomous **Tactical Execution Worker** berbasis **Pi Durable** dengan interface **A2A (Agent-to-Agent) Protocol** dan integrasi native **GitHub CLI (`gh`)**, dirancang untuk armada **MicroVM di Tailscale mesh**.

---

## 🌟 Fitur Utama Terbaru

1. **Injeksi System Prompt**:
   - **Saat Start Server**: Berikan instruksi global via flag `--system-prompt "..."` atau `--system-prompt-file prompt.txt` (atau set di `.env`).
   - **Per-Task Override**: Master Agent dapat menyuntikkan instruksi khusus per-task melalui field `system_prompt` saat memanggil `POST /tasks`.
2. **GitHub Issue & Pull Request Workflow (Native `gh` CLI)**:
   - `gh_issue_view`: Membaca deskripsi issue, label, dan riwayat komentar.
   - `gh_issue_comment`: Memberikan komentar progres atau status di issue.
   - `gh_pr_create`: Otomatis melakukan `git push` dan membuka Pull Request baru (lengkap dengan title, deskripsi, dan link `Closes #<issue>`).
   - `gh_pr_view`: Menginspeksi metadata PR dan melihat full `git diff`.
   - `gh_pr_review`: Melakukan code review terhadap Pull Request (approve, comment, atau request changes).
3. **Multi-Agent & Multi-Worktree di 1 VM**:
   - Menjalankan beberapa task/subtask secara paralel di worktree terisolasi (`./worktrees/<task-id>`) pada branch terpisah (`agent/<task-id>`).

---

## 🚀 Panduan Menjalankan

### 1. Menjalankan Worker di MicroVM

```bash
# 1. Pastikan GITHUB_TOKEN ada di .env agar gh CLI terautentikasi
cp .env.example .env

# 2. Jalankan worker (bisa dengan injeksi system prompt)
bun run server.ts \
  --port 3000 \
  --concurrency 4 \
  --system-prompt "Selalu gunakan TypeScript strict mode dan pastikan semua unit test lewat sebelum membuka PR."
```
Atau jika prompt panjang ada di file:
```bash
bun run server.ts --system-prompt-file ./my_custom_rules.md
```

---

### 2. Mengoperasikan Worker dari Master Agent (CLI)

#### Selesaikan GitHub Issue Secara Otomatis
```bash
bun run master.ts submit \
  --worker http://worker-vm-1:3000 \
  --repo https://github.com/my-org/backend.git \
  --issue 42
```
*Worker otomatis membaca Issue #42, membuat branch `agent/issue-42`, mengedit kode, menjalankan test, dan membuka Pull Request `Closes #42` via `gh pr create`!*

#### Review Pull Request Secara Otomatis
```bash
bun run master.ts submit \
  --worker http://worker-vm-1:3000 \
  --repo https://github.com/my-org/backend.git \
  --pr 15 \
  --prompt "Periksa apakah ada celah SQL injection atau performa lambat di query baru."
```

#### Dispatch Lewat Fleet Orchestrator (Auto Load-Balancing)
```bash
bun run skills/a2a-worker-fleet/scripts/fleet.ts dispatch \
  --repo https://github.com/my-org/backend.git \
  --issue 42 \
  --watch
```

---

## 🧪 Testing

```bash
bun test
```
*(Seluruh 6 unit & integration test lulus dalam ~120ms).*
