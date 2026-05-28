# AI-Powered Bengali Fine-Tuning Dataset Generator 🚀

An automated dataset generation pipeline that creates high-quality, fine-tune-ready datasets in Bengali for **Continued Pre-Training (CPT)**, **Supervised Fine-Tuning (SFT)**, and **Direct Preference Optimisation (DPO)**.

It takes raw data from **Websites**, **PDFs**, **DOCX files**, **Scanned Images**, or **Domain-Specific Topics**, extracts and cleans the text, and uses **OpenAI GPT** via **LangGraph** to generate structured datasets suitable for training language models as Bengali AI tutors.

---

## 🌟 Features

- **Three Pipeline Modes:**
  - **CPT** — Generates raw Bengali text passages for continued pre-training.
  - **SFT** — Generates instruction-input-output triples (Alpaca schema) with Chain-of-Thought reasoning.
  - **DPO** — Generates preference triples (prompt, chosen, rejected) with varied rejection strategies.

- **Multi-Source Input:**
  - **Website URLs** — Extracts clean text from web pages using `Apify`.
  - **PDF Documents** — Parses text using `PyMuPDF` with per-page memory management.
  - **DOCX Files** — Extracts content from Word documents via `python-docx`.
  - **Images (Scanned)** — OCR using `Tesseract` with Bengali language support.
  - **Domain-Specific** — Generates datasets from structured domain knowledge (no source file needed).

- **6 Subject Domains, 36 Sub-Topics:**
  - 📐 **Mathematics** — Arithmetic, Algebra, Geometry, Trigonometry, Calculus, Statistics, Set Theory, Number Theory, Word Problems
  - 🔬 **Science** — Physics, Chemistry, Biology, Environmental Science, Astronomy
  - 📖 **Bengali Language & Literature** — Grammar (ব্যাকরণ), Comprehension, Essay, Literature, Letter Writing, Translation, Report & Dialogue
  - 🌍 **Social Studies** — Geography, Bengali & Indian History, World History, Civics, Economics, Current Affairs, Environmental Studies
  - 🖥️ **ICT / Computer Science** — Digital Literacy, Programming, Data Structures, Networking & Cyber Safety
  - 🧩 **Reasoning & Mental Ability** — Logical Reasoning, Number Series, Verbal Reasoning, Non-Verbal Reasoning

- **Cross-Lingual Training:** At least 5% of SFT and DPO data uses English instructions with Bengali outputs, training models to handle real-world multilingual queries.

- **Multi-Format Exports:**
  - **Base JSONL** — Raw structured output
  - **HuggingFace Chat** — `messages` array with user/assistant roles
  - **Unsloth / Alpaca** — `instruction`, `input`, `output` format
  - **Excel** — `.xlsx` spreadsheets for human review

- **Real-Time Streaming UI:** Dark-mode SPA dashboard connected via WebSockets that tracks individual LangGraph node execution in real time.

---

## 🛠️ Architecture

```
├── backend/
│   ├── main.py          # FastAPI server, WebSocket streaming, file uploads
│   ├── graph.py         # LangGraph StateGraph definition and routing logic
│   ├── nodes.py         # Execution nodes (Scrape, PDF, DOCX, OCR, Domain, Clean, OpenAI, Output)
│   ├── state.py         # GraphState TypedDict definition
│   ├── config.py        # Centralised config, prompts, domain catalog, and settings
│   └── requirements.txt # Python dependencies
├── frontend/
│   ├── index.html       # SPA with hash routing (#home, #cpt, #sft, #dpo)
│   ├── app.js           # Router, WebSocket client, pipeline tracking, settings
│   ├── style.css        # HSL design system, glassmorphism, 3D buttons
│   └── favicon.svg
├── Dockerfile           # Production container with Tesseract + Bengali OCR
└── README.md
```

- **Backend:** FastAPI + LangGraph pipeline with structured output via Pydantic schemas.
- **Frontend:** Zero-dependency HTML/CSS/JS SPA served directly by FastAPI.
- **Communication:** WebSocket-based real-time streaming of pipeline progress.

---

## 💻 Local Development Setup

### 1. Requirements

- [Python 3.11+](https://www.python.org/downloads/)
- [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) (optional — only needed for scanned image input; install with the `ben` Bengali language pack)

### 2. Installation

```bash
# Clone the repository
git clone https://github.com/smt2208/Automated-Dataset-gen-pipeline.git
cd Automated-Dataset-gen-pipeline/backend

# Install dependencies
pip install -r requirements.txt
```

### 3. Environment Variables

Create a `.env` file inside the `backend/` folder:

```env
OPENAI_API_KEY=sk-your-openai-api-key-here
APIFY_API_TOKEN=apify_api_your-apify-token-here
```

> **Note:** `APIFY_API_TOKEN` is only required for website URL scraping. All other input modes (PDF, DOCX, Domain) work without it.

### 4. Running the App

```bash
cd backend
fastapi dev main.py
```

Open **[http://localhost:8000](http://localhost:8000)** in your browser.

---

## ⚙️ Configuration

Settings can be configured per-mode (CPT/SFT/DPO) through the UI settings panel:

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| **Model** | `gpt-5.4-mini` | Any OpenAI model | LLM used for generation |
| **Target Pairs** | 50 | 1–100 | Number of items to generate per run |
| **Reasoning Effort** | `low` | `low` / `medium` / `high` / `none` | OpenAI reasoning effort parameter |
| **System Prompt** | Mode-specific | Custom text | System instructions for the LLM |
| **Human Prompt** | Mode-specific | Custom text | Task instructions with `{context}` placeholder |

---

## ☁️ Deployment (Render)

This project is optimised for **Render's free tier** (512MB RAM):

1. Connect your GitHub repository to Render and create a new **Web Service**.
2. **Root Directory:** Set to `backend`.
3. **Environment:** Select `Docker` (Render auto-detects the `Dockerfile`).
4. **Environment Variables:** Add `OPENAI_API_KEY` and `APIFY_API_TOKEN`.
5. Deploy!

The Dockerfile installs Tesseract OCR with Bengali language support. The same Render URL serves both the API and the frontend.

### Memory Optimisation

The backend is specifically tuned for 512MB environments:
- Unused heavy dependencies removed (`unstructured[pdf]`, `sse-starlette`)
- Per-page `gc.collect()` during PDF processing
- LLM context capped at 50,000 characters
- Lazy imports for Apify/OCR modules
- Aggressive cleanup of state objects after each pipeline run

---

## 📄 License

See [LICENSE](LICENSE) for details.
