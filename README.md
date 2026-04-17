# DataGen Pro: Automated Instruction-Response Pipeline 🚀

DataGen Pro is a fully automated dataset generation pipeline designed specifically to create high-quality, fine-tune-ready instruction/response pairs in Bengali.

It seamlessly takes messy data from **Websites**, **PDFs**, and **Scanned Images**, extracts the raw text, cleans it for AI-readability, and uses **GPT-5.4** internally routed via **LangGraph** to generate structured conversations suitable for training Open-Source LLMs (like Qwen 2.5 3B).

## 🌟 Features
* **Multi-Modal Scraping:**
  * **Website URLs:** Extracts clean text off single web pages using `Apify`.
  * **PDF Documents:** Leverages `PyMuPDF` to rip raw text layers.
  * **Images (Scanned):** Built-in OCR using `Tesseract (Bengali pack)` to decode physical documents.
* **LangGraph Orchestration**: Uses conditional edges and a state graph to intelligently route the inputs through a processing pipeline.
* **LLM-Ready Optimization**: Utilises `Html2TextTransformer` to guarantee text chunks are optimal and free of HTML DOM noise before hitting the generative model.
* **Multi-Format Exports**: Automatically packages the generated pairs into 4 ready-to-use formats:
  * **Base JSONL** (`instruction` / `response`)
  * **HuggingFace Chat** (`messages` array with user/assistant roles)
  * **Unsloth / Alpaca** (`instruction`, `input`, `output`)
  * **Excel** (`.xlsx` spreadsheets for human review)
* **Real-time Streaming UI:** A sleek, dark-mode dashboard connected via WebSockets that actively lights up to track individual LangGraph node execution.

---

## 🛠️ Architecture
The pipeline is structured into a `FastAPI` + `LangGraph` backend and an `HTML/Vanilla JS` frontend.
* **Backend:** `/backend`
  * `main.py`: FastAPI server, WebSockets, and static file serving.
  * `graph.py`: LangGraph `StateGraph` definition and routing logic.
  * `nodes.py`: Execution nodes (Scrape, PDF, OCR, Clean, OpenAI, Output).
  * `config.py`: Centralised configurations, prompts, and settings.
* **Frontend:** `/frontend`
  * Zero-dependency dark mode Web UI served directly by FastAPI.

---

## 💻 Local Development Setup

### 1. Requirements
* [Python 3.11+](https://www.python.org/downloads/)
* [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) (Must be installed on your OS along with the `ben` Bengali language pack).

### 2. Installation
```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/Automated-Dataset-gen-pipeline.git
cd Automated-Dataset-gen-pipeline/backend

# Install the exact frozen dependencies
pip install -r requirements.txt
```

### 3. Environment Variables
Create a `.env` file inside the `backend/` folder and add your API keys:
```env
OPENAI_API_KEY=sk-your-openai-api-key-here
APIFY_API_TOKEN=apify_api_your-apify-token-here
```

### 4. Running the App
Run the FastAPI development server:
```bash
fastapi dev main.py
```
Open **[http://localhost:8000](http://localhost:8000)** in your browser to access the DataGen Pro interface!

---

## ☁️ Deployment (Render)

This project is built to be deployed seamlessly on **Render**.

1. Connect your GitHub repository to Render and create a new **Web Service**.
2. **Root Directory**: Set this to `backend`
3. **Environment**: Select `Docker` (Render will automatically detect the provided `Dockerfile`).
4. **Environment Variables**: Add your `OPENAI_API_KEY` and `APIFY_API_TOKEN`.
5. Deploy!

The Dockerfile is pre-configured to install heavy OS dependencies like the Tesseract C++ engine and the Bengali language libraries (`tesseract-ocr-ben`) automatically. Once live, the same Render URL will serve both the backend API and the frontend dashboard. 

---

*© 2026 DataGen Pro. All Rights Reserved.*
