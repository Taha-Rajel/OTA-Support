# OTA Support — Voice & Chat Agent

AI-powered telecom customer support. Customers can **chat** or **talk** to the agent in a web interface, or use the terminal. Built with **Groq** (LLM + Whisper speech-to-text), **Gemini** embeddings, **Pinecone** (knowledge base search) and **PostgreSQL** (call reports).

---

## Quick start

```bash
pip install -r requirements.txt
cp .env.example .env            # then fill in your keys
psql -U postgres -c "CREATE DATABASE ota_support_db;"
python agent/kb_chain.py        # upload the knowledge base (first time only)
python main.py --api            # starts the API AND the web interface
```

Open **http://localhost:8000** — that's the full app (chat + voice call).
API documentation is at **http://localhost:8000/docs**.

> Use **Chrome or Edge**. The voice call needs microphone permission, which browsers only allow on `http://localhost` or HTTPS (opening `ui/index.html` directly will not work).

---

## Web interface

| Feature | What it does |
|---|---|
| **Chat** | Type a message or tap a quick button; the agent answers from the knowledge base. |
| **Voice call** | Click the call button and just talk. Your microphone is recorded until you stop speaking, transcribed (Whisper), answered by the agent and read aloud. Say "goodbye" to end the call. |
| **Mute / Speaker** | Mute your microphone, or turn the agent's voice off (replies still appear as text). |
| **Settings (⚙)** | Your name, voice language (English / Français / العربية / auto-detect), read chat replies aloud. Saved in your browser. |
| **History & stats** | Each chat message and call is listed as *resolved* or *escalated*; session stats update live. |
| **Feedback** | Star rating and comment, stored in the database. |
| **Reports** | Export the chat, or download the call report and recording. |
| **Status indicator** | Shows *Agent online / offline* by checking `/health`. |

---

## Configuration (`.env`)

Copy `.env.example` to `.env`. Required values:

| Variable | Where to get it |
|---|---|
| `GROQ_API_KEY` | console.groq.com → API Keys |
| `GEMINI_API_KEY` | aistudio.google.com |
| `PINECONE_API_KEY` | Pinecone dashboard (the index is created automatically) |
| `DATABASE_URL` | `postgresql://user:password@host:5432/ota_support_db` |

Everything else has a default. SMTP and Slack are optional; leave them empty to disable alerts.

---

## Project structure

```
voice-agent/
├── agent/
│   ├── brain.py          # Conversation engine
│   ├── kb_chain.py       # RAG pipeline (Pinecone + Gemini + Groq)
│   ├── router.py         # Intent & category classifier
│   └── resolution.py     # Resolution notes & escalation
├── analytics/
│   └── monitor.py        # Recurring-issue detection & email/Slack alerts
├── api/
│   └── app.py            # FastAPI: REST endpoints + serves the web UI
├── db/
│   ├── models.py         # SQLAlchemy models (CallReport, RecurringAlert, Feedback)
│   └── reports.py        # DB read/write helpers
├── knowledge_base/
│   └── documents/        # .txt files ingested into Pinecone
├── ui/                   # Web interface (index.html, app.js, style.css)
├── stt.py                # Speech-to-text (Groq Whisper)
├── tts.py                # Text-to-speech for terminal voice mode (gTTS)
├── main.py               # Entry point
├── .env.example          # Configuration template
└── requirements.txt
```

---

## Other ways to run

```bash
python main.py --text                 # chat in the terminal (no microphone)
python main.py                        # voice mode in the terminal (needs: pip install pyaudio)
python main.py --file path/audio.wav  # transcribe a file, then answer it
python main.py --api                  # web interface + REST API (recommended)
```

---

## API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/call` | Process a customer message and return the agent reply |
| POST | `/transcribe?language=en` | Speech-to-text: raw audio bytes in the body → `{"text": "..."}` (empty `language` = auto-detect) |
| POST | `/feedback` | Save a rating (0–5) and comment |
| GET | `/calls?minutes=120` | List recent calls |
| GET | `/calls/{id}` | Full record of one call |
| GET | `/health` | Liveness check |

```bash
curl -X POST http://localhost:8000/call \
  -H "Content-Type: application/json" \
  -d '{"customer_input": "My internet has been down for 2 days", "customer_name": "Ahmed"}'
```

---

## How it works

```
Customer speaks (browser microphone)
    ↓ /transcribe  → Groq Whisper
Customer text
    ↓ /call
    ↓ Router   → intent + issue category
    ↓ KB       → Pinecone similarity search → Groq LLM answer
    ↓ Brain    → natural reply
Agent reply  →  shown in the UI and read aloud (browser voice)
    ↓ DB       → CallReport saved (PostgreSQL)
    ↓ Monitor  → recurring-issue check → email / Slack alert
```

---

## Troubleshooting

- **"Agent offline" in the interface** — the API is not running, or you opened `index.html` directly. Run `python main.py --api` and use http://localhost:8000.
- **Every answer is an apology / "escalated"** — the knowledge base is empty or Pinecone is not reachable. Check the Pinecone key and run `python agent/kb_chain.py`.
- **Microphone does not work** — allow microphone access in the browser, and use `localhost` or HTTPS.
- **`DATABASE_URL` error at startup** — make sure PostgreSQL is running, the database exists, and special characters in the password are URL-encoded.
- **Agent answers in English when you speak French** — the voice language setting only affects speech recognition and the browser voice; the agent's prompts are in English.
