---
name: 9router
description: >-
  Entry point for 9Router — local/remote AI gateway with OpenAI-compatible REST
  for chat, image generation, TTS, embeddings, web search, and web fetch.
---

# 9Router AI Gateway & Tools Skill

9Router is an open-source, local/remote AI gateway exposing unified, OpenAI-compatible REST endpoints to connect coding agents, N8N workflows, and CLI tools with 60+ AI providers, image generators, audio models, and web intelligence tools.

---

## ⚙️ Environment Variables

Configure 9Router in your `.env` or system environment:

```env
# 9Router Gateway URL & Key
NINEROUTER_URL=http://localhost:20128   # or your remote VPS / tunnel URL
NINEROUTER_KEY=sk-...                   # Bearer key from 9Router dashboard

# Web Search & Web Fetch Models
WEB_SEARCH_MODEL=tavily/search          # or brave/search, perplexity/search, exa/search
WEB_FETCH_MODEL=jina/reader             # or firecrawl/scrape, tavily/extract
```

---

## 🔍 Capability 1: Web Search (`/v1/search`)

Searches the live web for technical documentation, error troubleshooting, and real-time facts.

* **Endpoint:** `POST ${NINEROUTER_URL}/v1/search`
* **Headers:**
  ```http
  Authorization: Bearer ${NINEROUTER_KEY}
  Content-Type: application/json
  ```
* **Payload:**
  ```json
  {
    "model": "tavily/search",
    "query": "bun sqlite WAL mode concurrent transactions",
    "max_results": 5
  }
  ```
* **Upstream Providers Supported:** Tavily, Exa, Brave, Serper, SearXNG, Perplexity, Google PSE.

---

## 🌐 Capability 2: Web Fetch (`/v1/web/fetch`)

Scrapes any target URL and converts page content into clean, token-efficient Markdown or plain text.

* **Endpoint:** `POST ${NINEROUTER_URL}/v1/web/fetch`
* **Payload:**
  ```json
  {
    "model": "jina/reader",
    "url": "https://bun.sh/docs/api/sqlite"
  }
  ```
* **Upstream Engines Supported:** Jina Reader, Firecrawl, Tavily Extract, Exa Contents.

---

## 🎨 Capability 3: Image Generation (`/v1/images/generations`)

Generates images from text briefs using DALL-E, Imagen, FLUX, MiniMax, or Midjourney wrappers.

* **Endpoint:** `POST ${NINEROUTER_URL}/v1/images/generations`
* **Payload:**
  ```json
  {
    "model": "dall-e-3",
    "prompt": "Minimalist cyberpunk robot coding on a retro terminal",
    "n": 1,
    "size": "1024x1024"
  }
  ```

---

## 🎙️ Capability 4: Text-to-Speech (TTS) & Audio (`/v1/audio/...`)

* **TTS:** `POST ${NINEROUTER_URL}/v1/audio/speech`
  ```json
  {
    "model": "tts-1",
    "input": "Task completed successfully, pull request created.",
    "voice": "alloy"
  }
  ```
* **STT (Speech-to-Text):** `POST ${NINEROUTER_URL}/v1/audio/transcriptions` (OpenAI Whisper, Groq, Deepgram).

---

## 💬 Capability 5: Chat & Code Generation (`/v1/chat/completions`)

OpenAI-compatible chat completions with multi-provider auto-fallback (e.g. combo models).

* **Endpoint:** `POST ${NINEROUTER_URL}/v1/chat/completions`

---

## 🔄 Integrasi dengan N8N Workflow

In N8N, you can use the **HTTP Request Node** or the **OpenAI Model Node**:
1. Set the Base URL to: `http://localhost:20128/v1` (or your 9Router Tailscale IP).
2. Set API Key to: `{{ $env.NINEROUTER_KEY }}`.
3. Call any 9Router endpoint dynamically in your N8N pipelines.
