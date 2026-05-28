import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    # ── API Keys ─────────────────────────────────────────────────────────────
    OPENAI_API_KEY  = os.getenv("OPENAI_API_KEY")
    APIFY_API_TOKEN = os.getenv("APIFY_API_TOKEN")

    # ── Server / directory settings ───────────────────────────────────────────
    CORS_ORIGINS = ["*"]
    UPLOADS_DIR  = "uploads"
    OUTPUTS_DIR  = "outputs"

    # ── Apify crawler settings ────────────────────────────────────────────────
    APIFY_ACTOR_ID    = "apify/website-content-crawler"
    APIFY_CRAWL_PAGES = 5
    APIFY_CRAWL_DEPTH = 1

    # ── OCR settings ──────────────────────────────────────────────────────────
    @staticmethod
    def _best_tesseract_lang() -> str:
        try:
            import pytesseract
            available = pytesseract.get_languages(config='')
            if 'ben' in available:
                return 'ben+eng'
            return 'eng'
        except Exception:
            return 'eng'

    TESSERACT_LANG: str = None   # Resolved lazily below

    # ── LLM settings ──────────────────────────────────────────────────────────
    LLM_MODEL       = "gpt-5.4-mini"
    REASONING_EFFORT = "low"

    # ── Default target pairs per mode ─────────────────────────────────────────
    DEFAULT_PAIRS = {"cpt": 500, "sft": 200, "dpo": 100}

    # ── SFT Default Prompts ───────────────────────────────────────────────────
    SFT_SYSTEM_PROMPT = (
        "You are an expert curriculum designer and AI dataset creator specialising in the Bengali language. "
        "Your task is to extract and generate high-quality instruction–response pairs STRICTLY in Bengali "
        "from the provided content. These pairs will be used to fine-tune a Qwen 2.5 3B Bengali AI Tutor "
        "via Supervised Fine-Tuning (SFT). Each response should be that of an excellent, patient Bengali "
        "tutor — clear, step-by-step, encouraging, and pedagogically sound."
    )
    SFT_HUMAN_PROMPT = (
        "Carefully analyse the following content and generate diverse instruction–response pairs in Bengali. "
        "Instructions must be varied (questions, fill-in, explain-this, solve-this, compare). "
        "Responses must be detailed, accurate, written in fluent Bengali, and demonstrate good teaching pedagogy. "
        "Prioritise QUALITY over quantity. Never include trivial or repetitive pairs.\n\nContext:\n{context}"
    )

    # ── CPT Default Prompts ───────────────────────────────────────────────────
    CPT_SYSTEM_PROMPT = (
        "You are an expert Bengali corpus builder specialising in educational content for the Qwen 2.5 3B model. "
        "Your task is to generate fluent, natural Bengali raw text chunks for Continued Pre-Training (CPT). "
        "The text must be factually accurate, culturally appropriate, and written entirely in authentic Bengali (বাংলা). "
        "Avoid mixing English unnecessarily."
    )
    CPT_HUMAN_PROMPT = (
        "Generate rich, diverse Bengali raw text passages based on the provided context or domain. "
        "The text should feel like it comes from authentic Bengali educational resources — textbooks, "
        "encyclopaedias, or well-written articles. Cover the topic comprehensively. "
        "Vary sentence structure and vocabulary. Write in a clear, educational register suitable for secondary students. "
        "Output only Bengali text, no meta-commentary.\n\nContext:\n{context}"
    )

    # ── DPO Default Prompts ───────────────────────────────────────────────────
    DPO_SYSTEM_PROMPT = (
        "You are an expert in Bengali educational AI alignment. Your task is to generate DPO "
        "(Direct Preference Optimization) training triples for a Bengali AI Tutor — Qwen 2.5 3B. "
        "Each triple must contain: (1) a Bengali student prompt, (2) a CHOSEN response that is pedagogically "
        "excellent, accurate, and fluent in Bengali, and (3) a REJECTED response that has clear flaws — "
        "bad teaching style, factual errors, or poor Bengali."
    )
    DPO_HUMAN_PROMPT = (
        "Generate DPO preference triples in Bengali for the specified domain. "
        "The chosen response should exemplify an ideal Bengali tutor: clear explanation, step-by-step reasoning, "
        "culturally appropriate examples, encouraging tone. "
        "The rejected response should be plausibly wrong but noticeably inferior. "
        "Ensure diversity across question types and difficulty levels.\n\nContext:\n{context}"
    )

    # ── Backward-compat alias ─────────────────────────────────────────────────
    SYSTEM_PROMPT        = SFT_SYSTEM_PROMPT
    HUMAN_PROMPT_TEMPLATE = SFT_HUMAN_PROMPT

    # ── Domain display names ──────────────────────────────────────────────────
    DOMAIN_LABELS = {
        "math":         "Mathematics",
        "science":      "Science",
        "bengali_lang": "Bengali Language & Literature",
        "social":       "Social Studies / Geography",
    }

    SUBDOMAIN_LABELS = {
        # Math
        "arithmetic":   "Arithmetic (Class 1–12)",
        "algebra":      "Algebra — equations, polynomials",
        "geometry":     "Geometry — proofs, mensuration",
        "statistics":   "Statistics — mean, median, mode",
        "word_probs":   "Word Problems (Bengali context — Tk/₹, local names)",
        # Science
        "physics":      "Physics — motion, force, light, electricity",
        "chemistry":    "Chemistry — elements, reactions, periodic table",
        "biology":      "Biology — cells, human body, plants, ecosystems",
        # Bengali Language
        "grammar":      "Bengali Grammar (ব্যাকরণ) — সন্ধি, সমাস, কারক, বিভক্তি",
        "comprehension":"Comprehension passages",
        "essay":        "Essay writing (রচনা)",
        "literature":   "Poem/Prose explanation (Tagore, Nazrul, Sukumar Ray)",
        # Social Studies
        "geo_wb":       "Geography — West Bengal & World",
        "history_bn":   "Bengali History and Indian History",
        "world_hist":   "World History",
        "civics":       "Civics — Government structure",
    }

    # ── Node labels shown on the frontend pipeline ────────────────────────────
    NODE_LABELS: dict = {
        "scrape_node":  "Extracting Content from Website",
        "pdf_node":     "Parsing PDF Text",
        "docx_node":    "Parsing DOCX Document",
        "ocr_node":     "Optical Character Recognition (OCR)",
        "text_node":    "Reading Text File",
        "domain_node":  "Preparing Domain Context",
        "clean_node":   "Data Preprocessing & Formatting",
        "openai_node":  "Generating Bengali Dataset",
        "output_node":  "Exporting Formatted Datasets",
    }
    KNOWN_NODES: set = set(NODE_LABELS.keys())


config = Config()
config.TESSERACT_LANG = Config._best_tesseract_lang()
