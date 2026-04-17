import os
from dotenv import load_dotenv

load_dotenv()

class Config:
    # ── API Keys ─────────────────────────────────────────────────────────
    OPENAI_API_KEY  = os.getenv("OPENAI_API_KEY")
    APIFY_API_TOKEN = os.getenv("APIFY_API_TOKEN")

    # ── Server / directory settings ───────────────────────────────────────
    CORS_ORIGINS = ["*"]
    UPLOADS_DIR  = "uploads"
    OUTPUTS_DIR  = "outputs"

    # ── Apify crawler settings ────────────────────────────────────────────
    APIFY_ACTOR_ID   = "apify/website-content-crawler"
    APIFY_CRAWL_PAGES = 1   # Only crawl the single URL the user provides
    APIFY_CRAWL_DEPTH = 0   # Do NOT follow embedded / linked pages

    # ── OCR settings ──────────────────────────────────────────────────────
    TESSERACT_LANG = "ben"          # Bengali Tesseract language pack

    # ── LLM settings ──────────────────────────────────────────────────────
    LLM_MODEL       = "gpt-5.4-nano"
    LLM_TEMPERATURE = 0.2

    # ── Prompts ───────────────────────────────────────────────────────────
    SYSTEM_PROMPT = (
        "You are an expert curriculum designer and AI dataset creator specialising in the Bengali language. "
        "Your task is to extract high-quality, diverse instruction-response pairs STRICTLY in the Bengali language "
        "from the provided document context. "
        "Create pairs that are suitable for fine-tuning a Qwen 2.5 3B model on Bengali understanding and generation. "
        "The pairs must be fluent, culturally appropriate, factually accurate, and logically derived from the text."
    )
    HUMAN_PROMPT_TEMPLATE = (
        "Carefully analyse the following document and understand its core themes, key facts, and overall domain.\n\n"
        "Based firmly on this text, generate instruction-response pairs in Bengali that offer balanced and comprehensive "
        "coverage of the material. "
        "Your absolute priority is QUALITY over quantity — avoid trivial or repetitive pairs. "
        "Instructions must be naturally phrased and varied (questions, tasks, fill-in, explanations, etc.). "
        "Responses must be highly accurate, fluent in Bengali, and sufficiently detailed to train a premium model.\n\n"
        "Context:\n{context}"
    )

    # ── Node labels shown on the frontend pipeline ────────────────────────
    NODE_LABELS: dict = {
        "scrape_node":  "Extracting Content from Website",
        "pdf_node":     "Parsing PDF Text",
        "ocr_node":     "Optical Character Recognition (OCR)",
        "clean_node":   "Data Preprocessing & Formatting",
        "openai_node":  "Generating High-Quality Instruction Pairs",
        "output_node":  "Exporting Formatted Datasets",
    }
    KNOWN_NODES: set = set(NODE_LABELS.keys())

config = Config()
