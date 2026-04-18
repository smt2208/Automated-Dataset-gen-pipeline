import os
import re
import json
import uuid
import pytesseract
import fitz  # PyMuPDF — already a dependency

try:
    from PIL import Image
except ImportError:
    pass

try:
    import openpyxl
    EXCEL_AVAILABLE = True
except ImportError:
    EXCEL_AVAILABLE = False

from langchain_core.documents import Document
from langchain_community.document_transformers import Html2TextTransformer
from langchain_apify import ApifyWrapper
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, Field
from typing import List

from state import GraphState
from config import config


# ── Pydantic schemas for structured LLM output ───────────────────────────────

class QAPair(BaseModel):
    instruction: str = Field(description="The instruction or question in Bengali.")
    response:    str = Field(description="The detailed, accurate response in Bengali.")

class QAPairsList(BaseModel):
    pairs: List[QAPair] = Field(description="List of instruction-response pairs.")


# ── Extraction nodes ──────────────────────────────────────────────────────────

def scrape_node(state: GraphState) -> GraphState:
    """Scrape ONLY the given URL — no embedded/linked pages."""
    url = state["input_source"]
    try:
        apify = ApifyWrapper()
        loader = apify.call_actor(
            actor_id=config.APIFY_ACTOR_ID,
            run_input={
                "startUrls":    [{"url": url}],
                "maxCrawlPages": config.APIFY_CRAWL_PAGES,   # 1 — only the given page
                "maxCrawlDepth": config.APIFY_CRAWL_DEPTH,   # 0 — no following of links
            },
            dataset_mapping_function=lambda item: Document(
                page_content=item.get("text") or "",
                metadata={"source": item.get("url", url)},
            ),
        )
        docs = loader.load()
        raw_text = [doc.page_content for doc in docs if doc.page_content.strip()]
        return {"raw_documents": raw_text}
    except Exception as e:
        return {"errors": [f"Scraping failed: {str(e)}"]}


# ── OCR helper — retries with 'eng' if the primary language pack is missing ──

def _safe_ocr(image, lang: str) -> str:
    """Run Tesseract OCR with graceful fallback to 'eng' if lang pack is missing."""
    try:
        return pytesseract.image_to_string(image, lang=lang)
    except pytesseract.TesseractError:
        # Language pack not installed — fall back to English-only OCR
        return pytesseract.image_to_string(image, lang='eng')



def pdf_node(state: GraphState) -> GraphState:
    """Extract text from a PDF.
    - If the PDF has a text layer → use PyMuPDF directly.
    - If the page is blank (scanned/image-only) → auto-fall back to Tesseract OCR.
    """
    file_path = state["input_source"]
    try:
        doc = fitz.open(file_path)
        raw_text = []
        for page in doc:
            text = page.get_text().strip()
            if text:
                raw_text.append(text)
            else:
                # Page is an image — render and OCR it
                pix = page.get_pixmap(dpi=200)
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                ocr_text = _safe_ocr(img, config.TESSERACT_LANG).strip()
                if ocr_text:
                    raw_text.append(ocr_text)
        if not raw_text:
            return {"errors": ["PDF had no extractable text and OCR returned nothing."]}
        return {"raw_documents": raw_text}
    except Exception as e:
        return {"errors": [f"PDF extraction failed: {str(e)}"]}


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
    """Extract text from a scanned image using Tesseract OCR (multilingual with auto-fallback)."""
    file_path = state["input_source"]
    try:
        image = Image.open(file_path)
        text = _safe_ocr(image, config.TESSERACT_LANG).strip()
        if not text:
            return {"errors": ["OCR returned no text from this image."]}
        return {"raw_documents": [text]}
    except Exception as e:
        return {"errors": [f"OCR failed: {str(e)}"]}

# ── LLM-ready preprocessing (LangChain document transformer) ─────────────────

def clean_node(state: GraphState) -> GraphState:
    """
    Make extracted text LLM-ready using LangChain's Html2TextTransformer:
      - Strips residual HTML tags / markdown artefacts from web-scraped content
      - Normalises whitespace and removes very short fragments
    The use of LangChain Document objects keeps this step in the LC ecosystem.
    """
    raw_docs = state.get("raw_documents", [])
    if not raw_docs:
        return {"errors": ["No content extracted from the source."]}

    # Wrap in LangChain Document objects for the transformer
    docs = [Document(page_content=t) for t in raw_docs if t.strip()]

    # Html2TextTransformer strips HTML/markdown artefacts → clean plain text
    transformer = Html2TextTransformer()
    transformed  = transformer.transform_documents(docs)

    cleaned = []
    for doc in transformed:
        text = re.sub(r'[ \t]+', ' ', doc.page_content)    # collapse horizontal ws
        text = re.sub(r'\n{3,}', '\n\n', text)             # collapse excessive newlines
        text = text.strip()
        if len(text) > 80:  # discard very short / noisy fragments
            cleaned.append(text)

    if not cleaned:
        return {"errors": ["After cleaning, no usable text remained."]}

    return {"cleaned_texts": cleaned}


# ── LLM generation node ───────────────────────────────────────────────────────

def openai_node(state: GraphState) -> GraphState:
    """Send cleaned text to GPT-5.4 and get structured Bengali instruction/response pairs."""
    texts = state.get("cleaned_texts", [])
    if not texts:
        return {"errors": ["No cleaned text available for the LLM."]}

    full_text = "\n\n".join(texts)

    sys_prompt = state.get("system_prompt") or config.SYSTEM_PROMPT
    hum_prompt = state.get("human_prompt") or config.HUMAN_PROMPT_TEMPLATE
    
    # Secretly append the context placeholder to whatever the user wrote
    hum_prompt = hum_prompt.strip() + "\n\nContext:\n{context}"

    llm    = ChatOpenAI(model=config.LLM_MODEL, reasoning_effort=config.REASONING_EFFORT)
    prompt = ChatPromptTemplate.from_messages([
        ("system", sys_prompt),
        ("human",  hum_prompt),
    ])
    chain = prompt | llm.with_structured_output(QAPairsList)

    try:
        result: QAPairsList = chain.invoke({"context": full_text})
        pairs = [{"instruction": p.instruction, "response": p.response} for p in result.pairs]
        return {"qa_pairs": pairs}
    except Exception as e:
        return {"errors": [f"LLM generation failed: {str(e)}"]}


# ── Multi-format export node ──────────────────────────────────────────────────

def output_node(state: GraphState) -> GraphState:
    """
    Write the generated pairs in four formats:
      1. Base JSONL          — { instruction, response }
      2. HuggingFace JSONL   — { messages: [{role, content}, ...] }
      3. Unsloth/Alpaca JSONL — { instruction, input, output }
      4. Excel (.xlsx)        — one row per pair, two columns
    """
    pairs = state.get("qa_pairs", [])
    if not pairs:
        return {"errors": ["No QA pairs were generated."]}

    os.makedirs(config.OUTPUTS_DIR, exist_ok=True)
    uid = uuid.uuid4().hex[:8]

    try:
        # 1 ── Base JSONL ─────────────────────────────────────────────────
        base_path = f"{config.OUTPUTS_DIR}/dataset_{uid}.jsonl"
        with open(base_path, "w", encoding="utf-8") as f:
            for p in pairs:
                f.write(json.dumps(p, ensure_ascii=False) + "\n")

        # 2 ── HuggingFace messages format ─────────────────────────────────
        hf_path = f"{config.OUTPUTS_DIR}/dataset_{uid}_hf.jsonl"
        with open(hf_path, "w", encoding="utf-8") as f:
            for p in pairs:
                entry = {
                    "messages": [
                        {"role": "user",      "content": p["instruction"]},
                        {"role": "assistant", "content": p["response"]},
                    ]
                }
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        # 3 ── Unsloth / Alpaca format ──────────────────────────────────────
        unsloth_path = f"{config.OUTPUTS_DIR}/dataset_{uid}_unsloth.jsonl"
        with open(unsloth_path, "w", encoding="utf-8") as f:
            for p in pairs:
                entry = {
                    "instruction": p["instruction"],
                    "input":       "",
                    "output":      p["response"],
                }
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        # 4 ── Excel (.xlsx) ───────────────────────────────────────────────
        excel_path = ""
        if EXCEL_AVAILABLE:
            excel_path = f"{config.OUTPUTS_DIR}/dataset_{uid}.xlsx"
            wb = openpyxl.Workbook()
            ws = wb.active
            ws.title = "Bengali Dataset"
            ws.append(["instruction", "response"])
            for p in pairs:
                ws.append([p["instruction"], p["response"]])
            wb.save(excel_path)

        return {
            "output_file":  base_path,
            "hf_file":      hf_path,
            "unsloth_file": unsloth_path,
            "excel_file":   excel_path,
        }

    except Exception as e:
        return {"errors": [f"Export failed: {str(e)}"]}
