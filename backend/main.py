import os
from fastapi import FastAPI, HTTPException, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from graph import dataset_pipeline
from state import GraphState
from config import config

app = FastAPI(title="Bengali Dataset Creation Pipeline")

# ── CORS ─────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs(config.UPLOADS_DIR, exist_ok=True)
os.makedirs(config.OUTPUTS_DIR, exist_ok=True)


# ── Helpers ───────────────────────────────────────────────────────────────────

class UrlRequest(BaseModel):
    url: str

def _initial_state(input_type: str, input_source: str) -> GraphState:
    return {
        "input_type":   input_type,
        "input_source": input_source,
        "raw_documents": [],
        "cleaned_texts": [],
        "qa_pairs":      [],
        "errors":        [],
        "output_file":   "",
        "hf_file":       "",
        "unsloth_file":  "",
        "excel_file":    "",
    }

def _file_basenames(state: dict) -> dict:
    return {
        "jsonl":   os.path.basename(state.get("output_file", "")),
        "hf":      os.path.basename(state.get("hf_file", "")),
        "unsloth": os.path.basename(state.get("unsloth_file", "")),
        "excel":   os.path.basename(state.get("excel_file", "")),
    }


# ── Upload endpoint (called BEFORE opening WebSocket for file inputs) ─────────

@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """
    Upload a PDF or image and return the server-side path + detected input_type.
    The frontend should then open a WebSocket and send this file_path as input_source.
    """
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext == ".pdf":
        input_type = "pdf"
    elif ext in (".png", ".jpg", ".jpeg"):
        input_type = "image"
    else:
        raise HTTPException(
            status_code=400,
            detail="Unsupported format. Upload a PDF or image (PNG/JPG)."
        )
    file_path = os.path.join(config.UPLOADS_DIR, file.filename)
    with open(file_path, "wb") as f:
        f.write(await file.read())
    return {"file_path": file_path, "input_type": input_type}


# ── WebSocket streaming endpoint ─────────────────────────────────────────────

@app.websocket("/ws/process")
async def ws_process(websocket: WebSocket):
    """
    Real-time pipeline execution over WebSocket.

    Client sends one JSON message to kick off the pipeline:
        { "input_type": "url"|"pdf"|"image",  "input_source": "<url or file_path>" }

    Server streams JSON messages for every LangGraph node:
        { "type": "node_start", "node": "<name>", "label": "<human label>" }
        { "type": "node_done",  "node": "<name>" }
        { "type": "node_error", "node": "<name>", "message": "<error>" }
        { "type": "error",      "message": "<error>" }          ← fatal, stream ends
        { "type": "completed",  "pairs": <int>, "files": { jsonl, hf, unsloth, excel } }
    """
    await websocket.accept()
    try:
        # 1. Receive kick-off message
        data = await websocket.receive_json()
        input_type   = data.get("input_type")
        input_source = data.get("input_source")

        if not input_type or not input_source:
            await websocket.send_json({"type": "error", "message": "Missing input_type or input_source."})
            return

        # 2. Guard: check required API keys
        if input_type == "url" and not config.APIFY_API_TOKEN:
            await websocket.send_json({"type": "error", "message": "APIFY_API_TOKEN is not configured in .env"})
            return
        if not config.OPENAI_API_KEY:
            await websocket.send_json({"type": "error", "message": "OPENAI_API_KEY is not configured in .env"})
            return

        state = _initial_state(input_type, input_source)
        accumulated: dict = {}
        fatal_error = False

        # 3. Stream LangGraph events node-by-node
        async for event in dataset_pipeline.astream_events(state, version="v2"):
            kind = event["event"]
            name = event.get("name", "")

            # Only care about our own registered nodes
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
                        # A node returned errors — report and stop
                        err_msg = output["errors"][-1]
                        await websocket.send_json({"type": "node_error", "node": name, "message": err_msg})
                        await websocket.send_json({"type": "error", "message": err_msg})
                        fatal_error = True
                        break

                await websocket.send_json({
                    "type":  "node_done",
                    "node":  name,
                    "label": config.NODE_LABELS.get(name, name),
                })

        if fatal_error:
            return

        # 4. All nodes done — send completion summary
        errors = accumulated.get("errors", [])
        if errors:
            await websocket.send_json({"type": "error", "message": errors[-1]})
            return

        await websocket.send_json({
            "type":  "completed",
            "pairs": len(accumulated.get("qa_pairs", [])),
            "files": _file_basenames(accumulated),
        })
        
        # Explicitly close so the client UI unlocks immediately
        await websocket.close()

    except WebSocketDisconnect:
        pass  # client closed the connection cleanly
    except Exception as e:
        try:
            await websocket.send_json({"type": "error", "message": str(e)})
            await websocket.close()
        except Exception:
            pass


# ── Download endpoint ─────────────────────────────────────────────────────────

@app.get("/download/{filename}")
async def download_file(filename: str):
    """
    Serve any generated dataset file from the outputs directory.
    Supports .jsonl and .xlsx.
    """
    # Security: prevent directory traversal
    safe_name = os.path.basename(filename)
    file_path = os.path.join(config.OUTPUTS_DIR, safe_name)

    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found.")

    if safe_name.endswith(".xlsx"):
        media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    else:
        media_type = "application/jsonl"

    return FileResponse(file_path, media_type=media_type, filename=safe_name)


# ── Legacy HTTP endpoints (kept for Swagger /docs testing) ───────────────────

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
    if ext == ".pdf":
        input_type = "pdf"
    elif ext in (".png", ".jpg", ".jpeg"):
        input_type = "image"
    else:
        raise HTTPException(status_code=400, detail="Unsupported format.")

    file_path = os.path.join(config.UPLOADS_DIR, file.filename)
    with open(file_path, "wb") as f:
        f.write(await file.read())

    final = dataset_pipeline.invoke(_initial_state(input_type, file_path))
    if final.get("errors"):
        return {"status": "error", "errors": final["errors"]}
    return {"status": "success", "pairs": len(final.get("qa_pairs", [])), "files": _file_basenames(final)}


from fastapi.staticfiles import StaticFiles

# ── Frontend Static Files ────────────────────────────────────────────────────
frontend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")
if os.path.exists(frontend_dir):
    app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
