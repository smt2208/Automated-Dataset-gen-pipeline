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
    DEFAULT_PAIRS = {"cpt": 10, "sft": 20, "dpo": 20}

    # ── SFT Default Prompts ───────────────────────────────────────────────────
    SFT_SYSTEM_PROMPT = (
        "You are an expert AI dataset creator building Supervised Fine-Tuning (SFT) data "
        "for a Bengali AI Tutor. The tutor must become pedagogically excellent, patient, "
        "and culturally aligned with Bengali students (Class 6–12, West Bengal & Bangladesh curricula).\n\n"
        "Data Quality Standards:\n"
        "• Generate instruction-input-output triples following the Alpaca schema.\n"
        "• The 'output' field MUST demonstrate expert-level Chain-of-Thought (CoT) reasoning — "
        "show step-by-step thinking, not just final answers.\n"
        "• Ensure maximum diversity in task types: conceptual explanation, problem solving, "
        "step-by-step derivation, multiple-choice with reasoning, summarization, comparison, "
        "error correction, translation, creative writing, and real-world application.\n"
        "• Use authentic Bengali throughout with culturally appropriate examples "
        "(local names, ₹/৳ prices, NCTB/WBBSE references).\n"
        "• Vary difficulty from basic (Class 6) to advanced (Class 12 / competitive exam level).\n\n"
        "INPUT FIELD REQUIREMENT: For at least 30–40% of the items, the 'input' field MUST contain "
        "meaningful supplementary context — a passage to analyze, a table of data, a code snippet, "
        "a problem statement, or reference material that the instruction refers to. Do NOT leave "
        "the 'input' field empty for every item."
    )
    SFT_HUMAN_PROMPT = (
        "Based on the provided context, generate a diverse set of instruction-input-output triples:\n"
        "- instruction: The core task or question (in Bengali).\n"
        "- input: Additional context for the task — a passage, data, or reference material. "
        "Fill this for 30–40% of items; leave blank only when the instruction is fully self-contained.\n"
        "- output: Detailed Bengali response with clear Chain-of-Thought reasoning.\n\n"
        "Task Diversity (cover as many as possible):\n"
        "• Conceptual explanation ('এটা কী?', 'ব্যাখ্যা করো')\n"
        "• Problem solving with step-by-step working\n"
        "• Multiple-choice with elimination reasoning\n"
        "• Summarization of passages or concepts\n"
        "• Compare & contrast between related concepts\n"
        "• Error identification & correction\n"
        "• Real-world application problems (Bengali context)\n\n"
        "Context:\n{context}"
    )

    # ── CPT Default Prompts ───────────────────────────────────────────────────
    CPT_SYSTEM_PROMPT = (
        "You are an expert Bengali language corpus architect. Your task is to generate "
        "high-quality, natural Bengali (বাংলা) raw text passages for Continued Pre-Training (CPT) "
        "of a language model that will serve as a Bengali AI tutor.\n\n"
        "Quality Standards:\n"
        "• Write entirely in authentic, fluent Bengali — avoid unnecessary English mixing "
        "unless it is natural in the educational context (e.g., technical terms like 'DNA', 'algorithm').\n"
        "• Content must be factually accurate, well-structured, and pedagogically sound.\n"
        "• Use diverse writing styles: expository, narrative, dialogic (teacher-student conversation), "
        "and analytical.\n"
        "• Target Class 6–12 students across West Bengal and Bangladesh curricula.\n"
        "• Include culturally grounded examples: local names, prices in ₹/৳, Bengali festivals, "
        "geography, and historical references.\n"
        "• Vary sentence length and complexity — mix simple explanations with advanced academic prose."
    )
    CPT_HUMAN_PROMPT = (
        "Generate rich, diverse Bengali raw text passages based on the provided context. "
        "Each passage should feel like it comes from an authentic Bengali educational resource — "
        "a textbook chapter, encyclopedia entry, well-written magazine article, or a teacher's "
        "detailed explanation.\n\n"
        "Requirements:\n"
        "1. Cover the topic comprehensively with depth and accuracy.\n"
        "2. Use varied registers: some passages formal/academic, others conversational/explanatory.\n"
        "3. Include specific examples, numbers, and facts grounded in Bengali/South Asian context.\n"
        "4. Naturally integrate subject-specific terminology (transliterated English terms are "
        "acceptable where standard in Bengali education).\n"
        "5. Output only Bengali text — no meta-commentary, headers, or labels.\n\n"
        "Context:\n{context}"
    )

    # ── DPO Default Prompts ───────────────────────────────────────────────────
    DPO_SYSTEM_PROMPT = (
        "You are an expert in AI alignment for Bengali education. Your task is to generate "
        "DPO (Direct Preference Optimization) training triples for a Bengali AI Tutor. "
        "Each triple trains the model to prefer high-quality responses over flawed ones.\n\n"
        "Triple Structure:\n"
        "• prompt: A student question or task (in Bengali).\n"
        "• chosen: The ideal tutor response — pedagogically excellent, accurate, fluent Bengali, "
        "encouraging tone, step-by-step reasoning, culturally appropriate examples.\n"
        "• rejected: A plausibly written but clearly inferior response with specific flaws.\n\n"
        "Rejection Flaws (vary across these categories):\n"
        "1. Pedagogical: Skips steps, gives answer without explanation, condescending tone.\n"
        "2. Factual: Contains incorrect facts, wrong formulas, misleading information.\n"
        "3. Linguistic: Poor Bengali grammar, excessive English mixing, unnatural phrasing.\n"
        "4. Structural: Disorganized, no clear reasoning flow, missing key steps, too brief.\n\n"
        "Quality Standard: The difference between chosen and rejected must be clear and "
        "educational — a human annotator should immediately see why 'chosen' is better."
    )
    DPO_HUMAN_PROMPT = (
        "Generate DPO preference triples for the specified domain:\n"
        "- prompt: A student question (in Bengali)\n"
        "- chosen: The ideal Bengali tutor response with clear reasoning and step-by-step explanation\n"
        "- rejected: A plausibly written but flawed Bengali response\n\n"
        "Ensure diversity across:\n"
        "• Question types (conceptual, computational, analytical, creative)\n"
        "• Difficulty levels (basic to advanced)\n"
        "• Rejection strategies (pedagogical flaws, factual errors, poor Bengali, structural problems)\n\n"
        "The chosen response should exemplify an ideal Bengali tutor with step-by-step reasoning. "
        "The rejected response should be noticeably inferior but not obviously garbage.\n\n"
        "Context:\n{context}"
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
        "ict":          "ICT / Computer Science",
        "reasoning":    "Reasoning & Mental Ability",
    }

    SUBDOMAIN_LABELS = {
        # Math
        "arithmetic":   "Arithmetic (Class 1–12)",
        "algebra":      "Algebra — equations, polynomials",
        "geometry":     "Geometry — proofs, mensuration",
        "trigonometry":  "Trigonometry — ratios, identities, heights & distances",
        "statistics":   "Statistics — mean, median, mode, probability",
        "calculus":     "Calculus — differentiation, integration (Class 11–12)",
        "set_theory":   "Set Theory — sets, Venn diagrams, relations",
        "number_theory": "Number Theory — primes, HCF, LCM, divisibility",
        "word_probs":   "Word Problems (Bengali context — Tk/₹, local names)",
        # Science
        "physics":      "Physics — motion, force, light, electricity",
        "chemistry":    "Chemistry — elements, reactions, periodic table",
        "biology":      "Biology — cells, human body, plants, ecosystems",
        "env_science":  "Environmental Science — pollution, conservation, climate",
        "astronomy":    "Astronomy — solar system, stars, space science",
        # Bengali Language
        "grammar":      "Bengali Grammar (ব্যাকরণ) — সন্ধি, সমাস, কারক, বিভক্তি",
        "comprehension":"Comprehension passages",
        "essay":        "Essay writing (রচনা / প্রবন্ধ)",
        "literature":   "Poem/Prose explanation (Tagore, Nazrul, Sukumar Ray)",
        "letter":       "Letter & Application writing (চিঠি / আবেদনপত্র)",
        "translation":  "Translation (অনুবাদ) — English ↔ Bengali",
        "report":       "Report & Dialogue writing (প্রতিবেদন / সংলাপ)",
        # Social Studies
        "geo_wb":       "Geography — West Bengal & World",
        "history_bn":   "Bengali History and Indian History",
        "world_hist":   "World History",
        "civics":       "Civics — Government structure",
        "economics":    "Basic Economics — demand, supply, banking, Indian economy",
        "current_affairs": "Current Affairs — Bengal & India",
        "env_studies":  "Environmental Studies — sustainability, ecology, SDGs",
        # ICT / Computer Science
        "digital_lit":  "Digital Literacy — internet, email, office tools",
        "programming":  "Programming Basics — algorithms, flowcharts, Python",
        "data_struct":  "Data Structures — arrays, lists, sorting",
        "networking":   "Networking & Cyber Safety — protocols, online safety",
        # Reasoning & Mental Ability
        "logical":      "Logical Reasoning — syllogisms, Venn diagrams, puzzles",
        "number_series":"Number & Pattern Series — sequences, analogies",
        "verbal":       "Verbal Reasoning — coding-decoding, blood relations",
        "non_verbal":   "Non-Verbal Reasoning — figure completion, mirror image",
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
