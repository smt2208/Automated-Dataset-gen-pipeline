from typing import TypedDict, List, Dict, Annotated, Optional
import operator

class GraphState(TypedDict):
    input_type:    str                              # 'url' | 'pdf' | 'image' | 'text'
    input_source:  str                              # URL string or local file path
    system_prompt: Optional[str]                    # Custom system prompt for generation
    human_prompt:  Optional[str]                    # Custom human prompt template
    raw_documents: List[str]                        # Raw text extracted from source
    cleaned_texts: List[str]                        # After LLM-ready preprocessing
    qa_pairs:      Annotated[List[Dict[str, str]], operator.add]  # Instruction/response pairs
    errors:        Annotated[List[str], operator.add]             # Pipeline error log
    # ── Export paths (all set by output_node) ────────────────────────────
    output_file:   str   # Base JSONL  { instruction, response }
    hf_file:       str   # HuggingFace { messages: [{role, content}, ...] }
    unsloth_file:  str   # Unsloth / Alpaca  { instruction, input, output }
    excel_file:    str   # Excel .xlsx, one row per pair

