import os
import re
import json
import uuid
import gc
import fitz  # PyMuPDF

try:
    import pytesseract
    from PIL import Image
    OCR_AVAILABLE = True
except ImportError:
    OCR_AVAILABLE = False

try:
    import docx as python_docx   # python-docx
    DOCX_AVAILABLE = True
except ImportError:
    DOCX_AVAILABLE = False

try:
    import openpyxl
    EXCEL_AVAILABLE = True
except ImportError:
    EXCEL_AVAILABLE = False

try:
    import html2text as _h2t
    H2T_AVAILABLE = True
except ImportError:
    H2T_AVAILABLE = False

from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, Field
from typing import List

from state import GraphState
from config import config

# Max total context chars sent to LLM in one call
_MAX_CONTEXT_CHARS = 50000


# ══════════════════════════════════════════════════════════════════════════════
# Pydantic schemas for structured LLM output
# ══════════════════════════════════════════════════════════════════════════════

class QAPair(BaseModel):
    """SFT instruction–input–output pair."""
    instruction: str = Field(description="The core task or question — primarily in Bengali, but can be in English for cross-lingual items.")
    input:       str = Field(description="Additional context for the task (can be empty/blank if the instruction is self-sufficient).")
    output:      str = Field(description="The detailed, accurate Bengali response with step-by-step Chain-of-Thought reasoning.")

class QAPairsList(BaseModel):
    pairs: List[QAPair] = Field(description="List of instruction-response pairs.")


class CPTChunk(BaseModel):
    """CPT raw Bengali text chunk."""
    text: str = Field(description="A natural, fluent Bengali educational text passage.")

class CPTChunksList(BaseModel):
    chunks: List[CPTChunk] = Field(description="List of Bengali text chunks for pre-training.")


class DPOTriple(BaseModel):
    """DPO preference triple."""
    prompt:   str = Field(description="A student question or prompt — primarily in Bengali, but can be in English for cross-lingual items.")
    chosen:   str = Field(description="The preferred, pedagogically excellent Bengali response with clear step-by-step reasoning.")
    rejected: str = Field(description="The inferior, flawed Bengali response with specific pedagogical, factual, or linguistic problems.")

class DPOTriplesList(BaseModel):
    triples: List[DPOTriple] = Field(description="List of DPO preference triples.")


# ══════════════════════════════════════════════════════════════════════════════
# EXTRACTION NODES
# ══════════════════════════════════════════════════════════════════════════════

def scrape_node(state: GraphState) -> GraphState:
    """Scrape the given URL using Apify."""
    url = state["input_source"]
    try:
        from langchain_core.documents import Document
        from langchain_apify import ApifyWrapper
        apify = ApifyWrapper()
        loader = apify.call_actor(
            actor_id=config.APIFY_ACTOR_ID,
            run_input={
                "startUrls":     [{"url": url}],
                "maxCrawlPages": config.APIFY_CRAWL_PAGES,
                "maxCrawlDepth": config.APIFY_CRAWL_DEPTH,
            },
            dataset_mapping_function=lambda item: Document(
                page_content=item.get("text") or "",
                metadata={"source": item.get("url", url)},
            ),
        )
        docs = loader.load()
        raw_text = [doc.page_content for doc in docs if doc.page_content.strip()]
        del docs, loader, apify
        gc.collect()
        if not raw_text:
            return {"errors": ["Scraping returned no content from the URL."]}
        return {"raw_documents": raw_text}
    except Exception as e:
        return {"errors": [f"Scraping failed: {str(e)}"]}


def _safe_ocr(image, lang: str) -> str:
    """Run Tesseract OCR with graceful fallback to 'eng' if lang pack is missing."""
    try:
        return pytesseract.image_to_string(image, lang=lang)
    except pytesseract.TesseractError:
        return pytesseract.image_to_string(image, lang='eng')


def pdf_node(state: GraphState) -> GraphState:
    """Extract text from a PDF (text layer first, OCR fallback at low DPI)."""
    file_path = state["input_source"]
    try:
        doc = fitz.open(file_path)
        raw_text = []
        for i in range(len(doc)):
            page = doc.load_page(i)
            text = page.get_text().strip()
            if text:
                raw_text.append(text)
            elif OCR_AVAILABLE:
                # Low DPI (120) to save memory — A4 page ≈ 8MB vs 40MB at 200 DPI
                pix = page.get_pixmap(dpi=120)
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                ocr_text = _safe_ocr(img, config.TESSERACT_LANG).strip()
                if ocr_text:
                    raw_text.append(ocr_text)
                del img, pix
            del page
            # Force cleanup after every page
            if i % 3 == 0:
                gc.collect()
        doc.close()
        del doc
        gc.collect()

        # Delete the uploaded file to free disk/memory
        try:
            os.remove(file_path)
        except OSError:
            pass

        if not raw_text:
            return {"errors": ["PDF had no extractable text and OCR returned nothing."]}
        return {"raw_documents": raw_text}
    except Exception as e:
        return {"errors": [f"PDF extraction failed: {str(e)}"]}


def docx_node(state: GraphState) -> GraphState:
    """Extract text from a .docx / .doc file using python-docx."""
    file_path = state["input_source"]
    if not DOCX_AVAILABLE:
        return {"errors": ["python-docx is not installed. Run: pip install python-docx"]}
    try:
        document = python_docx.Document(file_path)
        paragraphs = [p.text.strip() for p in document.paragraphs if p.text.strip()]
        for table in document.tables:
            for row in table.rows:
                for cell in row.cells:
                    if cell.text.strip():
                        paragraphs.append(cell.text.strip())
        del document
        gc.collect()

        # Delete uploaded file
        try:
            os.remove(file_path)
        except OSError:
            pass

        if not paragraphs:
            return {"errors": ["DOCX file is empty or has no readable text."]}
        chunk_size = 10
        chunks = [
            "\n".join(paragraphs[i:i + chunk_size])
            for i in range(0, len(paragraphs), chunk_size)
        ]
        return {"raw_documents": chunks}
    except Exception as e:
        return {"errors": [f"DOCX extraction failed: {str(e)}"]}


def text_node(state: GraphState) -> GraphState:
    """Read a plain .txt file directly."""
    file_path = state["input_source"]
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read().strip()
        if not content:
            return {"errors": ["Text file is empty."]}
        return {"raw_documents": [content]}
    except Exception as e:
        return {"errors": [f"Text file reading failed: {str(e)}"]}


def ocr_node(state: GraphState) -> GraphState:
    """Extract text from a scanned image using Tesseract OCR."""
    file_path = state["input_source"]
    try:
        image = Image.open(file_path)
        text = _safe_ocr(image, config.TESSERACT_LANG).strip()
        image.close()
        if not text:
            return {"errors": ["OCR returned no text from this image."]}
        return {"raw_documents": [text]}
    except Exception as e:
        return {"errors": [f"OCR failed: {str(e)}"]}


def domain_node(state: GraphState) -> GraphState:
    """
    Build a rich structured context prompt from the selected domain + subdomains.
    This node generates no external content — it constructs a detailed Bengali
    educational brief that becomes the 'context' for the LLM generation node.
    """
    domain     = state.get("domain", "")
    subdomains = state.get("subdomains") or []
    mode       = state.get("pipeline_mode", "sft")

    domain_label = config.DOMAIN_LABELS.get(domain, domain.title())
    subdomain_labels = [
        config.SUBDOMAIN_LABELS.get(s, s) for s in subdomains
    ]

    mode_descriptions = {
        "cpt": "raw Bengali educational text for language model pre-training",
        "sft": "instruction-response pairs for an AI Bengali tutor",
        "dpo": "DPO preference triples (chosen vs rejected Bengali tutor responses)",
    }
    mode_desc = mode_descriptions.get(mode, "Bengali educational content")

    # Build a rich structured brief as the "source document"
    context_parts = [
        f"Domain: {domain_label}",
        f"Target output: {mode_desc}",
        "",
        "Sub-topics to cover:",
    ]
    for label in subdomain_labels:
        context_parts.append(f"  • {label}")

    context_parts += [
        "",
        "Guidelines:",
        "  • Use authentic Bengali language throughout.",
        "  • Content must be appropriate for Class 6–12 Bengali students.",
        "  • Use local Bengali context (West Bengal / Bangladesh): prices in Tk/₹, local names, local examples.",
        "  • Cover each sub-topic with sufficient depth.",
        "  • Vary difficulty from basic to advanced within each sub-topic.",
    ]

    if domain == "math":
        context_parts += [
            "  • For mathematics: show step-by-step working in Bengali.",
            "  • Include word problems with Bengali-context numbers (e.g., মূল্য ৳৫০, দূরত্ব ১২ কিমি).",
            "  • Cover both WBBSE and NCTB syllabus topics where applicable.",
            "  • Include competitive exam level problems (Olympiad, JEE, WBCS) for advanced topics.",
        ]
    elif domain == "science":
        context_parts += [
            "  • For science: explain concepts clearly with real-world Bengali examples.",
            "  • Reference NCTB (জাতীয় শিক্ষাক্রম ও পাঠ্যপুস্তক বোর্ড) curriculum level.",
            "  • Include diagrams described in text (e.g., 'একটি চিত্রে দেখানো হলো...').",
            "  • Relate science to everyday life in Bengal (e.g., Ganga delta for geography, agriculture for biology).",
        ]
    elif domain == "bengali_lang":
        context_parts += [
            "  • For Bengali language: use authentic literary sources (Tagore, Nazrul, Sukumar Ray, Bankim, Sarat).",
            "  • Grammar examples must use correct বাংলা terminology.",
            "  • Include letter/application writing formats as per WBBSE/NCTB standards.",
            "  • For translation tasks: provide accurate English ↔ Bengali equivalents with context.",
        ]
    elif domain == "social":
        context_parts += [
            "  • For social studies: include specific facts about West Bengal, Bangladesh, and Indian history.",
            "  • Reference key historical events, geographical features, and government structures.",
            "  • For economics: use examples with Indian Rupee (₹) and Bangladeshi Taka (৳).",
            "  • Include current events and SDG-related topics where relevant.",
        ]
    elif domain == "ict":
        context_parts += [
            "  • For ICT: explain technical concepts in simple Bengali with English technical terms.",
            "  • Programming examples should use Bengali variable names and comments where possible.",
            "  • Cover digital literacy for rural Bengali students — basic internet, email, safety.",
            "  • Include practical scenarios: online forms, banking apps, educational websites.",
        ]
    elif domain == "reasoning":
        context_parts += [
            "  • For reasoning: provide clear worked examples in Bengali before each problem type.",
            "  • Include problems similar to competitive exams: WBCS, SSC, Railway, Banking.",
            "  • Pattern and series questions should use Bengali numerals (১, ২, ৩) alongside Arabic.",
            "  • Verbal reasoning questions should use Bengali language-based coding/decoding.",
        ]

    context = "\n".join(context_parts)
    return {"raw_documents": [context]}


# ══════════════════════════════════════════════════════════════════════════════
# CLEANING NODE
# ══════════════════════════════════════════════════════════════════════════════

def clean_node(state: GraphState) -> GraphState:
    """
    Make extracted text LLM-ready.
    - For web-scraped content: use html2text to strip HTML artefacts.
    - For PDF/DOCX/domain content: light whitespace normalization only.
    """
    raw_docs = state.get("raw_documents", [])
    if not raw_docs:
        return {"errors": ["No content extracted from the source."]}

    input_type = state.get("input_type", "")
    cleaned = []

    if input_type == "url" and H2T_AVAILABLE:
        # Web content — strip HTML/markdown artefacts using lightweight html2text
        converter = _h2t.HTML2Text()
        converter.ignore_links = True
        converter.ignore_images = True
        converter.body_width = 0  # no line wrapping
        for raw in raw_docs:
            if not raw.strip():
                continue
            text = converter.handle(raw)
            text = re.sub(r'[ \t]+', ' ', text)
            text = re.sub(r'\n{3,}', '\n\n', text).strip()
            if len(text) > 80:
                cleaned.append(text)
    else:
        # PDF / DOCX / text / domain — light normalization only
        for raw in raw_docs:
            text = re.sub(r'[ \t]+', ' ', raw)
            text = re.sub(r'\n{3,}', '\n\n', text).strip()
            if len(text) > 30:
                cleaned.append(text)

    # Free raw documents from memory
    del raw_docs
    gc.collect()

    if not cleaned:
        return {"errors": ["After cleaning, no usable text remained."]}

    return {"cleaned_texts": cleaned}


# ══════════════════════════════════════════════════════════════════════════════
# LLM GENERATION NODE  (branches on pipeline_mode: cpt | sft | dpo)
# ══════════════════════════════════════════════════════════════════════════════

def openai_node(state: GraphState) -> GraphState:
    """
    Send cleaned text to the LLM and get structured output.
    Branches on pipeline_mode:
      - 'cpt' → CPTChunksList  (raw Bengali text chunks)
      - 'sft' → QAPairsList    (instruction–response pairs)
      - 'dpo' → DPOTriplesList (prompt, chosen, rejected triples)
    """
    texts = state.get("cleaned_texts", [])
    if not texts:
        return {"errors": ["No cleaned text available for the LLM."]}

    mode      = state.get("pipeline_mode") or "sft"
    llm_model = state.get("model") or config.LLM_MODEL

    # ── Pick prompts based on mode ────────────────────────────────────────────
    if mode == "cpt":
        default_sys = config.CPT_SYSTEM_PROMPT
        default_hum = config.CPT_HUMAN_PROMPT
    elif mode == "dpo":
        default_sys = config.DPO_SYSTEM_PROMPT
        default_hum = config.DPO_HUMAN_PROMPT
    else:  # sft (default)
        default_sys = config.SFT_SYSTEM_PROMPT
        default_hum = config.SFT_HUMAN_PROMPT

    sys_prompt = state.get("system_prompt") or default_sys
    hum_prompt = state.get("human_prompt")  or default_hum

    # Ensure {context} placeholder exists in human prompt
    if "{context}" not in hum_prompt:
        hum_prompt = hum_prompt.strip() + "\n\nContext:\n{context}"

    target_pairs = state.get("target_pairs") or 50
    sys_prompt += f"\n\nIMPORTANT INSTRUCTION: You must generate EXACTLY {target_pairs} items."

    # ── Pick output schema based on mode ──────────────────────────────────────
    if mode == "cpt":
        output_schema = CPTChunksList
    elif mode == "dpo":
        output_schema = DPOTriplesList
    else:
        output_schema = QAPairsList

    llm_kwargs = {"model": llm_model}
    reasoning = state.get("reasoning_effort") or "low"
    if reasoning != "none":
        llm_kwargs["reasoning_effort"] = reasoning

    llm    = ChatOpenAI(**llm_kwargs)
    prompt = ChatPromptTemplate.from_messages([
        ("system", sys_prompt),
        ("human",  hum_prompt),
    ])
    chain = prompt | llm.with_structured_output(output_schema)

    full_text = "\n\n---\n\n".join(texts)
    # Truncate context to prevent OOM on huge documents
    if len(full_text) > _MAX_CONTEXT_CHARS:
        full_text = full_text[:_MAX_CONTEXT_CHARS]

    try:
        result = chain.invoke({"context": full_text})
    except Exception as e:
        return {"errors": [f"LLM generation failed: {str(e)}"]}
    finally:
        # Aggressively free LLM objects
        del chain, prompt, llm
        gc.collect()
    # ── Map result to state fields ─────────────────────────────────────────────
    if mode == "cpt":
        pairs = [{"instruction": c.text, "input": "", "output": ""} for c in result.chunks]
        return {"qa_pairs": pairs}
    elif mode == "dpo":
        triples = [
            {"prompt": t.prompt, "chosen": t.chosen, "rejected": t.rejected}
            for t in result.triples
        ]
        return {"dpo_triples": triples}
    else:
        pairs = [{"instruction": p.instruction, "input": p.input, "output": p.output} for p in result.pairs]
        return {"qa_pairs": pairs}


# ══════════════════════════════════════════════════════════════════════════════
# EXPORT NODE  (handles CPT / SFT / DPO output formats)
# ══════════════════════════════════════════════════════════════════════════════

def output_node(state: GraphState) -> GraphState:
    """
    Write the generated data in four export formats.
    Format varies by pipeline_mode:

    CPT mode  → stores raw text chunks
      - JSONL:    { "text": "..." }
      - HF:       { "messages": [{"role": "assistant", "content": "..."}] }
      - Unsloth:  { "instruction": "Generate Bengali text about:", "input": "", "output": "..." }
      - Excel:    Single 'text' column

    SFT mode  → instruction–response pairs (default / existing behaviour)
      - JSONL:    { "instruction": "...", "response": "..." }
      - HF:       { "messages": [user + assistant turns] }
      - Unsloth:  { "instruction": "...", "input": "", "output": "..." }
      - Excel:    instruction | response

    DPO mode  → preference triples
      - JSONL:    { "prompt": "...", "chosen": "...", "rejected": "..." }
      - HF:       { "prompt": "...", "chosen": [...], "rejected": [...] }
      - Unsloth:  { "prompt": "...", "chosen": "...", "rejected": "..." }
      - Excel:    prompt | chosen | rejected
    """
    mode    = state.get("pipeline_mode") or "sft"
    pairs   = state.get("qa_pairs",    [])
    triples = state.get("dpo_triples", [])

    if mode == "dpo":
        if not triples:
            return {"errors": ["No DPO triples were generated."]}
    else:
        if not pairs:
            return {"errors": ["No dataset pairs were generated."]}

    os.makedirs(config.OUTPUTS_DIR, exist_ok=True)
    uid = uuid.uuid4().hex[:8]

    try:
        base_path    = f"{config.OUTPUTS_DIR}/dataset_{mode}_{uid}.jsonl"
        hf_path      = f"{config.OUTPUTS_DIR}/dataset_{mode}_{uid}_hf.jsonl"
        unsloth_path = f"{config.OUTPUTS_DIR}/dataset_{mode}_{uid}_unsloth.jsonl"
        excel_path   = ""

        # ── CPT ──────────────────────────────────────────────────────────────
        if mode == "cpt":
            # Base JSONL: {text}
            with open(base_path, "w", encoding="utf-8") as f:
                for p in pairs:
                    f.write(json.dumps({"text": p["instruction"]}, ensure_ascii=False) + "\n")

            # HF format: assistant monologue
            with open(hf_path, "w", encoding="utf-8") as f:
                for p in pairs:
                    entry = {"messages": [{"role": "assistant", "content": p["instruction"]}]}
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")

            # Unsloth: instruction="" output=text
            with open(unsloth_path, "w", encoding="utf-8") as f:
                for p in pairs:
                    entry = {"instruction": "নিচের বিষয়ে বাংলায় বিস্তারিত লিখুন:", "input": "", "output": p["instruction"]}
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")

            # Excel
            if EXCEL_AVAILABLE:
                excel_path = f"{config.OUTPUTS_DIR}/dataset_{mode}_{uid}.xlsx"
                wb = openpyxl.Workbook()
                ws = wb.active
                ws.title = "CPT Dataset"
                ws.append(["text"])
                for p in pairs:
                    ws.append([p["instruction"]])
                wb.save(excel_path)

        # ── DPO ──────────────────────────────────────────────────────────────
        elif mode == "dpo":
            # Base JSONL: {prompt, chosen, rejected}
            with open(base_path, "w", encoding="utf-8") as f:
                for t in triples:
                    f.write(json.dumps(t, ensure_ascii=False) + "\n")

            # HF TRL DPO format
            with open(hf_path, "w", encoding="utf-8") as f:
                for t in triples:
                    entry = {
                        "prompt":   t["prompt"],
                        "chosen":   [{"role": "assistant", "content": t["chosen"]}],
                        "rejected": [{"role": "assistant", "content": t["rejected"]}],
                    }
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")

            # Unsloth DPO format (same as base)
            with open(unsloth_path, "w", encoding="utf-8") as f:
                for t in triples:
                    f.write(json.dumps(t, ensure_ascii=False) + "\n")

            # Excel
            if EXCEL_AVAILABLE:
                excel_path = f"{config.OUTPUTS_DIR}/dataset_{mode}_{uid}.xlsx"
                wb = openpyxl.Workbook()
                ws = wb.active
                ws.title = "DPO Dataset"
                ws.append(["prompt", "chosen", "rejected"])
                for t in triples:
                    ws.append([t["prompt"], t["chosen"], t["rejected"]])
                wb.save(excel_path)

        # ── SFT (default) ─────────────────────────────────────────────────────
        else:
            # Base JSONL: {instruction, input, output}
            with open(base_path, "w", encoding="utf-8") as f:
                for p in pairs:
                    f.write(json.dumps(p, ensure_ascii=False) + "\n")

            # HF messages format
            with open(hf_path, "w", encoding="utf-8") as f:
                for p in pairs:
                    user_content = p["instruction"]
                    if p.get("input"):
                        user_content += "\n\n" + p["input"]
                    entry = {
                        "messages": [
                            {"role": "user",      "content": user_content},
                            {"role": "assistant", "content": p.get("output", "")},
                        ]
                    }
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")

            # Unsloth / Alpaca format
            with open(unsloth_path, "w", encoding="utf-8") as f:
                for p in pairs:
                    entry = {"instruction": p["instruction"], "input": p.get("input", ""), "output": p.get("output", "")}
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")

            # Excel
            if EXCEL_AVAILABLE:
                excel_path = f"{config.OUTPUTS_DIR}/dataset_{mode}_{uid}.xlsx"
                wb = openpyxl.Workbook()
                ws = wb.active
                ws.title = "SFT Dataset"
                ws.append(["instruction", "input", "output"])
                for p in pairs:
                    ws.append([p["instruction"], p.get("input", ""), p.get("output", "")])
                wb.save(excel_path)

        return {
            "output_file":  base_path,
            "hf_file":      hf_path,
            "unsloth_file": unsloth_path,
            "excel_file":   excel_path,
        }

    except Exception as e:
        return {"errors": [f"Export failed: {str(e)}"]}
