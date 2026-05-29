import os
import gc
from fastapi import FastAPI, HTTPException, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from graph import dataset_pipeline
from state import GraphState
from config import config

app = FastAPI(title="Bengali AI Tutor — Dataset Generation Pipeline")

# ── CORS ───────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs(config.UPLOADS_DIR, exist_ok=True)
os.makedirs(config.OUTPUTS_DIR, exist_ok=True)


# ── Helpers ────────────────────────────────────────────────────────────────────

class UrlRequest(BaseModel):
    url: str


def _initial_state(
    input_type:    str,
    input_source:  str | None,
    sys:           str  | None = None,
    hum:           str  | None = None,
    model:         str  | None = None,
    target_pairs:  int  | None = None,
    reasoning:     str  | None = None,
    pipeline_mode: str  | None = "sft",
    domain:        str  | None = None,
    subdomains:    list | None = None,
    cross_lingual: bool | None = None,
) -> GraphState:
    # Cap target pairs/chunks based on mode: CPT max 50, SFT/DPO max 100
    pm = pipeline_mode or "sft"
    max_limit = 50 if pm == "cpt" else 100
    tp = target_pairs or config.DEFAULT_PAIRS.get(pm, max_limit)
    tp = min(tp, max_limit)
    return {
        "input_type":    input_type,
        "input_source":  input_source,
        "pipeline_mode": pipeline_mode or "sft",
        "system_prompt": sys,
        "human_prompt":  hum,
        "model":         model,
        "target_pairs":  tp,
        "reasoning_effort": reasoning,
        "cross_lingual": cross_lingual if cross_lingual is not None else False,
        "domain":        domain,
        "subdomains":    subdomains or [],
        "raw_documents": [],
        "cleaned_texts": [],
        "qa_pairs":      [],
        "dpo_triples":   [],
        "errors":        [],
        "output_file":   "",
        "hf_file":       "",
        "unsloth_file":  "",
        "excel_file":    "",
    }


def _file_basenames(state: dict) -> dict:
    return {
        "jsonl":   os.path.basename(state.get("output_file",  "")),
        "hf":      os.path.basename(state.get("hf_file",      "")),
        "unsloth": os.path.basename(state.get("unsloth_file", "")),
        "excel":   os.path.basename(state.get("excel_file",   "")),
    }


def _result_count(state: dict, mode: str) -> int:
    """Return the number of generated items, depending on pipeline mode."""
    if mode == "dpo":
        return len(state.get("dpo_triples", []))
    return len(state.get("qa_pairs", []))


# ── File Upload ────────────────────────────────────────────────────────────────

@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """
    Upload a file and return the server-side path + detected input_type.
    The frontend then opens a WebSocket and sends this file_path as input_source.
    """
    ext = os.path.splitext(file.filename or "")[1].lower()
    ext_map = {
        ".pdf":  "pdf",
        ".docx": "docx",
        ".doc":  "docx",
        ".txt":  "text",
        ".png":  "image",
        ".jpg":  "image",
        ".jpeg": "image",
    }
    input_type = ext_map.get(ext)
    if not input_type:
        raise HTTPException(
            status_code=400,
            detail="Unsupported format. Upload a PDF, DOCX, image (PNG/JPG), or text (.txt) file."
        )
    file_path = os.path.join(config.UPLOADS_DIR, file.filename)
    with open(file_path, "wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)  # 1MB chunks
            if not chunk:
                break
            f.write(chunk)
    return {"file_path": file_path, "input_type": input_type}


# ── WebSocket streaming endpoint ───────────────────────────────────────────────

@app.websocket("/ws/process")
async def ws_process(websocket: WebSocket):
    """
    Real-time pipeline execution over WebSocket.

    Client sends ONE JSON message to kick off the pipeline:
    {
        "input_type":    "url" | "pdf" | "docx" | "image" | "text" | "domain",
        "input_source":  "<url or server file path>",   # null for domain mode
        "pipeline_mode": "cpt" | "sft" | "dpo",
        "system_prompt": "...",
        "human_prompt":  "...",
        "model":         "gpt-5.4-mini",
        "target_pairs":  200,

        // domain mode only:
        "domain":      "math" | "science" | "bengali_lang" | "social" | "ict" | "reasoning",
        "subdomains":  ["arithmetic", "algebra", ...]
    }

    Server streams JSON events per LangGraph node:
        { "type": "node_start", "node": "<name>", "label": "<human label>" }
        { "type": "node_done",  "node": "<name>" }
        { "type": "node_error", "node": "<name>", "message": "<error>" }
        { "type": "error",      "message": "<fatal error>" }
        { "type": "completed",  "pairs": <int>, "files": { jsonl, hf, unsloth, excel } }
    """
    await websocket.accept()
    try:
        data = await websocket.receive_json()

        input_type    = data.get("input_type")
        input_source  = data.get("input_source")
        pipeline_mode = data.get("pipeline_mode") or "sft"
        sys_prompt    = data.get("system_prompt")
        hum_prompt    = data.get("human_prompt")
        custom_model  = data.get("model")
        target_pairs  = data.get("target_pairs")
        reasoning     = data.get("reasoning_effort")
        cross_lingual = data.get("cross_lingual", False)
        domain        = data.get("domain")
        subdomains    = data.get("subdomains") or []

        # ── Validation ────────────────────────────────────────────────────────
        if not input_type:
            await websocket.send_json({"type": "error", "message": "Missing input_type."})
            return

        if input_type == "domain":
            if not domain:
                await websocket.send_json({"type": "error", "message": "Domain mode requires a 'domain' field."})
                return
            if not subdomains:
                await websocket.send_json({"type": "error", "message": "Domain mode requires at least one subdomain."})
                return
        else:
            if not input_source:
                await websocket.send_json({"type": "error", "message": "Missing input_source."})
                return

        if pipeline_mode not in ("cpt", "sft", "dpo"):
            await websocket.send_json({"type": "error", "message": f"Invalid pipeline_mode: '{pipeline_mode}'. Use 'cpt', 'sft', or 'dpo'."})
            return

        # ── API key guards ────────────────────────────────────────────────────
        if input_type == "url" and not config.APIFY_API_TOKEN:
            await websocket.send_json({"type": "error", "message": "APIFY_API_TOKEN is not configured in .env"})
            return
        if not config.OPENAI_API_KEY:
            await websocket.send_json({"type": "error", "message": "OPENAI_API_KEY is not configured in .env"})
            return

        # ── Build initial state ────────────────────────────────────────────────
        state = _initial_state(
            input_type    = input_type,
            input_source  = input_source,
            sys           = sys_prompt,
            hum           = hum_prompt,
            model         = custom_model,
            target_pairs  = int(target_pairs) if target_pairs else None,
            reasoning     = reasoning,
            pipeline_mode = pipeline_mode,
            domain        = domain,
            subdomains    = subdomains,
            cross_lingual = bool(cross_lingual),
        )

        accumulated: dict = {}
        fatal_error = False

        # ── Stream LangGraph events ────────────────────────────────────────────
        async for event in dataset_pipeline.astream_events(state, version="v2"):
            kind = event["event"]
            name = event.get("name", "")

            if name not in config.KNOWN_NODES:
                continue

            if kind == "on_chain_start":
                await websocket.send_json({
                    "type":  "node_start",
                    "node":  name,
                    "label": config.NODE_LABELS.get(name, name),
                })

            elif kind == "on_chain_end":
                output = event.get("data", {}).get("output", {})
                if isinstance(output, dict):
                    accumulated.update(output)

                    if output.get("errors"):
                        err_msg = output["errors"][-1]
                        await websocket.send_json({"type": "node_error", "node": name, "message": err_msg})
                        await websocket.send_json({"type": "error",      "message": err_msg})
                        fatal_error = True
                        break

                await websocket.send_json({
                    "type":  "node_done",
                    "node":  name,
                    "label": config.NODE_LABELS.get(name, name),
                })

        if fatal_error:
            return

        # ── Send completion summary ────────────────────────────────────────────
        errors = accumulated.get("errors", [])
        if errors:
            await websocket.send_json({"type": "error", "message": errors[-1]})
            return

        await websocket.send_json({
            "type":  "completed",
            "pairs": _result_count(accumulated, pipeline_mode),
            "files": _file_basenames(accumulated),
        })

        await websocket.close()

        # Free pipeline state memory
        del accumulated, state
        gc.collect()

    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
            await websocket.close()
        except Exception:
            pass


# ── Download endpoint ──────────────────────────────────────────────────────────

@app.get("/download/{filename}")
async def download_file(filename: str):
    """Serve a generated dataset file from the outputs directory."""
    safe_name = os.path.basename(filename)
    file_path = os.path.join(config.OUTPUTS_DIR, safe_name)

    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found.")

    if safe_name.endswith(".xlsx"):
        media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    else:
        media_type = "application/jsonl"

    return FileResponse(file_path, media_type=media_type, filename=safe_name)


# ── Legacy HTTP endpoints (kept for Swagger /docs testing) ────────────────────

@app.post("/process/url", summary="[Swagger] Sync URL pipeline")
async def process_url(body: UrlRequest):
    if not config.APIFY_API_TOKEN:
        raise HTTPException(status_code=500, detail="APIFY_API_TOKEN not set.")
    if not config.OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not set.")
    final = dataset_pipeline.invoke(_initial_state("url", body.url))
    if final.get("errors"):
        return {"status": "error", "errors": final["errors"]}
    return {"status": "success", "pairs": len(final.get("qa_pairs", [])), "files": _file_basenames(final)}


@app.post("/process/file", summary="[Swagger] Sync file pipeline")
async def process_file(file: UploadFile = File(...)):
    if not config.OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not set.")
    ext = os.path.splitext(file.filename or "")[1].lower()
    ext_map = {".pdf": "pdf", ".docx": "docx", ".doc": "docx",
               ".txt": "text", ".png": "image", ".jpg": "image", ".jpeg": "image"}
    input_type = ext_map.get(ext)
    if not input_type:
        raise HTTPException(status_code=400, detail="Unsupported format.")
    file_path = os.path.join(config.UPLOADS_DIR, file.filename)
    with open(file_path, "wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)
    final = dataset_pipeline.invoke(_initial_state(input_type, file_path))
    if final.get("errors"):
        return {"status": "error", "errors": final["errors"]}
    return {"status": "success", "pairs": len(final.get("qa_pairs", [])), "files": _file_basenames(final)}


# ── Frontend Static Files ──────────────────────────────────────────────────────

from fastapi.staticfiles import StaticFiles

frontend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")
if os.path.exists(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
