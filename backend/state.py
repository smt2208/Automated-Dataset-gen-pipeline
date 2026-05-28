from typing import TypedDict, List, Dict, Annotated, Optional
import operator


class GraphState(TypedDict):
    # ── Input ────────────────────────────────────────────────────────────────
    input_type:    str          # 'url' | 'pdf' | 'docx' | 'image' | 'text' | 'domain'
    input_source:  Optional[str]  # URL string or local file path (None for domain mode)
    pipeline_mode: Optional[str]  # 'cpt' | 'sft' | 'dpo'

    # ── Custom LLM settings (from UI Settings modal) ─────────────────────────
    system_prompt: Optional[str]  # Custom system prompt
    human_prompt:  Optional[str]  # Custom human/user prompt template
    model:         Optional[str]  # LLM model identifier
    target_pairs:  Optional[int]  # Target number of pairs/chunks to generate
    reasoning_effort: Optional[str] # 'none', 'low', 'medium', 'high'

    # ── Domain-specific generation ────────────────────────────────────────────
    domain:      Optional[str]        # e.g. 'math', 'science', 'bengali_lang', 'social'
    subdomains:  Optional[List[str]]  # e.g. ['arithmetic', 'algebra']

    # ── Pipeline data ─────────────────────────────────────────────────────────
    raw_documents: List[str]                                      # Raw extracted text
    cleaned_texts: List[str]                                      # Preprocessed text

    # ── Generated outputs (accumulated across chunks) ─────────────────────────
    # SFT / CPT pairs: {instruction, response} or {text}
    qa_pairs: Annotated[List[Dict[str, str]], operator.add]

    # DPO triples: {prompt, chosen, rejected}
    dpo_triples: Annotated[List[Dict[str, str]], operator.add]

    errors: Annotated[List[str], operator.add]  # Pipeline error log

    # ── Export file paths (all set by output_node) ────────────────────────────
    output_file:   str   # Base JSONL
    hf_file:       str   # HuggingFace messages format
    unsloth_file:  str   # Unsloth / Alpaca format
    excel_file:    str   # Excel .xlsx
