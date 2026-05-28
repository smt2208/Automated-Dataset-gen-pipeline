from typing import Literal
from langgraph.graph import StateGraph, START, END
from state import GraphState
from nodes import (
    scrape_node,
    pdf_node,
    docx_node,
    ocr_node,
    text_node,
    domain_node,
    clean_node,
    openai_node,
    output_node,
)


# ── Input router ──────────────────────────────────────────────────────────────

def route_input(state: GraphState) -> Literal[
    "scrape_node", "pdf_node", "docx_node", "ocr_node", "text_node", "domain_node"
]:
    """Route to the correct extraction node based on input_type."""
    input_type = state.get("input_type")
    if input_type == "url":
        return "scrape_node"
    elif input_type == "pdf":
        return "pdf_node"
    elif input_type == "docx":
        return "docx_node"
    elif input_type == "text":
        return "text_node"
    elif input_type == "domain":
        return "domain_node"
    else:
        # image / ocr fallback
        return "ocr_node"


# ── Error bail-out routers ─────────────────────────────────────────────────────

def after_clean(state: GraphState) -> Literal["openai_node", "__end__"]:
    if state.get("errors"):
        return END
    return "openai_node"


def after_openai(state: GraphState) -> Literal["output_node", "__end__"]:
    if state.get("errors"):
        return END
    return "output_node"


# ── Graph construction ────────────────────────────────────────────────────────

def build_graph():
    builder = StateGraph(GraphState)

    # Register all nodes
    builder.add_node("scrape_node",  scrape_node)
    builder.add_node("pdf_node",     pdf_node)
    builder.add_node("docx_node",    docx_node)
    builder.add_node("ocr_node",     ocr_node)
    builder.add_node("text_node",    text_node)
    builder.add_node("domain_node",  domain_node)
    builder.add_node("clean_node",   clean_node)
    builder.add_node("openai_node",  openai_node)
    builder.add_node("output_node",  output_node)

    # Route from START based on input_type
    builder.add_conditional_edges(START, route_input)

    # All extraction nodes converge at clean_node
    builder.add_edge("scrape_node",  "clean_node")
    builder.add_edge("pdf_node",     "clean_node")
    builder.add_edge("docx_node",    "clean_node")
    builder.add_edge("ocr_node",     "clean_node")
    builder.add_edge("text_node",    "clean_node")
    builder.add_edge("domain_node",  "clean_node")

    # Sequential pipeline with error bail-out at each stage
    builder.add_conditional_edges("clean_node",  after_clean)
    builder.add_conditional_edges("openai_node", after_openai)
    builder.add_edge("output_node", END)

    return builder.compile()


dataset_pipeline = build_graph()
