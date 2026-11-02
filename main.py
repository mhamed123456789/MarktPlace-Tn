import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles


ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
APP_URL = os.getenv(
    "APP_URL",
    os.getenv("RENDER_EXTERNAL_URL", "http://127.0.0.1:8000"),
).rstrip("/")
REST_RESOURCES = {
    "posts", "public_profiles", "comments", "messages", "point_requests",
    "post_likes", "post_saves", "profiles", "app_settings",
}
RPC_FUNCTIONS = {
    "create_post", "create_photo_post", "toggle_like", "toggle_save", "create_comment",
    "create_point_request", "admin_review_point_request", "admin_update_user",
    "send_private_message", "admin_update_payment_settings", "update_post",
}
PUBLIC_READ_RESOURCES = {"posts", "public_profiles", "comments"}
MAX_REQUEST_BYTES = 100 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.storage_http = httpx.AsyncClient(
        timeout=httpx.Timeout(120),
        limits=httpx.Limits(
            max_connections=12,
            max_keepalive_connections=8,
            keepalive_expiry=30,
        ),
    )
    try:
        yield
    finally:
        await app.state.storage_http.aclose()


app = FastAPI(title="Marketplace TN API", version="1.0.0", lifespan=lifespan)
app.mount("/assets", StaticFiles(directory=ROOT / "static"), name="assets")


@app.get("/")
async def home():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/setup.sql")
async def setup_sql():
    return FileResponse(
        ROOT / "supabase" / "schema.sql",
        media_type="application/sql",
        filename="souqna-supabase-schema.sql",
    )


@app.get("/api/config")
async def config():
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise HTTPException(
            status_code=503,
            detail="Configure SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY in .env.",
        )
    return {"supabaseUrl": SUPABASE_URL, "supabaseKey": SUPABASE_KEY}


@app.get("/api/setup-status")
async def setup_status():
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise HTTPException(status_code=503, detail="Supabase is not configured.")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                f"{SUPABASE_URL}/rest/v1/posts",
                params={"select": "id", "limit": "0"},
                headers={"apikey": SUPABASE_KEY},
            )
            if response.is_success:
                version_response = await client.get(
                    f"{SUPABASE_URL}/rest/v1/app_settings",
                    params={"select": "schema_version", "id": "eq.1", "limit": "1"},
                    headers={"apikey": SUPABASE_KEY},
                )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail="Supabase could not be reached.") from exc
    if response.is_success:
        if not version_response.is_success:
            try:
                version_error = version_response.json()
            except ValueError:
                version_error = {}
            message = version_error.get("message", "")
            if "schema_version" in message or "schema cache" in message.lower():
                return {"ready": True, "upgradeRequired": True}
            raise HTTPException(
                status_code=502,
                detail=message or "Could not verify the Marketplace TN schema version.",
            )
        try:
            settings = version_response.json()
        except ValueError as exc:
            raise HTTPException(
                status_code=502,
                detail="Supabase returned an invalid Marketplace TN schema version.",
            ) from exc
        if not isinstance(settings, list) or (settings and not isinstance(settings[0], dict)):
            raise HTTPException(
                status_code=502,
                detail="Supabase returned an unexpected Marketplace TN schema version.",
            )
        current_version = settings[0].get("schema_version", 0) if settings else 0
        if not isinstance(current_version, int):
            raise HTTPException(
                status_code=502,
                detail="Supabase returned an invalid Marketplace TN schema version.",
            )
        return {"ready": True, "upgradeRequired": current_version < 3}
    try:
        error = response.json()
    except ValueError:
        error = {}
    message = error.get("message", "")
    if response.status_code == 404 and (
        "schema cache" in message.lower() or "could not find the table" in message.lower()
    ):
        return {"ready": False}
    raise HTTPException(
        status_code=502,
        detail=message or "Could not verify the Supabase database setup.",
    )


@app.get("/api/health")
async def health():
    return {"ok": True, "service": "souqna"}


@app.get("/api/auth/google")
async def google_auth(code_challenge: str):
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise HTTPException(status_code=503, detail="Supabase is not configured.")
    if not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", code_challenge):
        raise HTTPException(status_code=400, detail="Invalid OAuth code challenge.")
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            upstream = await client.get(
                f"{SUPABASE_URL}/auth/v1/authorize",
                params={
                    "provider": "google",
                    "redirect_to": APP_URL,
                    "code_challenge": code_challenge,
                    "code_challenge_method": "s256",
                },
                headers={"apikey": SUPABASE_KEY},
            )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail="Supabase Auth could not be reached.") from exc

    location = upstream.headers.get("location")
    if upstream.is_redirect and location:
        return RedirectResponse(location, status_code=302)
    try:
        detail = upstream.json().get("msg") or upstream.json().get("message")
    except ValueError:
        detail = None
    raise HTTPException(
        status_code=upstream.status_code if upstream.status_code >= 400 else 502,
        detail=detail or "Google sign-in is unavailable. Enable the Google provider in Supabase Auth.",
    )


def validate_resource(path: str) -> str:
    parts = path.split("/")
    if len(parts) == 1 and parts[0] in REST_RESOURCES:
        return path
    if len(parts) == 2 and parts[0] == "rpc" and parts[1] in RPC_FUNCTIONS:
        return path
    raise HTTPException(status_code=404, detail="Unknown API resource.")


def check_content_length(request: Request, label: str) -> None:
    content_length = request.headers.get("content-length")
    if not content_length:
        return
    try:
        size = int(content_length)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid content length.") from exc
    if size < 0:
        raise HTTPException(status_code=400, detail="Invalid content length.")
    if size > MAX_REQUEST_BYTES:
        raise HTTPException(status_code=413, detail=f"{label} is too large.")


@app.api_route("/api/rest/{path:path}", methods=["GET", "POST", "PATCH", "DELETE"])
async def rest_proxy(path: str, request: Request):
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise HTTPException(status_code=503, detail="Supabase is not configured.")
    resource = validate_resource(path)
    auth = request.headers.get("authorization", "")
    public_read = request.method == "GET" and resource in PUBLIC_READ_RESOURCES
    if not auth.startswith("Bearer ") and not public_read:
        raise HTTPException(status_code=401, detail="Sign in to continue.")
    check_content_length(request, "Request")

    url = f"{SUPABASE_URL}/rest/v1/{quote(resource, safe='/')}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Accept": request.headers.get("accept", "application/json"),
    }
    if auth.startswith("Bearer "):
        headers["Authorization"] = auth
    for name in ("content-type", "prefer", "accept-profile", "content-profile", "range", "range-unit"):
        if value := request.headers.get(name):
            headers[name] = value
    body = await request.body() if request.method in {"POST", "PATCH"} else None
    if body and len(body) > MAX_REQUEST_BYTES:
        raise HTTPException(status_code=413, detail="Request is too large.")

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            upstream = await client.request(
                request.method,
                url,
                params=request.query_params,
                headers=headers,
                content=body,
            )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail="Supabase could not be reached.") from exc

    response_headers = {}
    if "content-range" in upstream.headers:
        response_headers["content-range"] = upstream.headers["content-range"]
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=response_headers,
        media_type=upstream.headers.get("content-type"),
    )


@app.api_route("/api/storage/upload/{path:path}", methods=["POST", "DELETE"])
async def storage_proxy(path: str, request: Request):
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise HTTPException(status_code=503, detail="Supabase is not configured.")
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Sign in to continue.")
    allowed_buckets = (
        "object/marketplace-media/",
        "object/marketplace-receipts/",
        "object/marketplace-message-media/",
    )
    if not path.startswith(allowed_buckets) or ".." in path:
        raise HTTPException(status_code=404, detail="Unknown storage resource.")
    check_content_length(request, "File")
    if path.startswith("object/marketplace-media/") and request.headers.get("content-type", "").startswith("image/"):
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="Chaque image ne peut pas dépasser 20 Mo.")

    headers = {"apikey": SUPABASE_KEY, "Authorization": auth}
    for name in ("content-type", "x-upsert", "cache-control", "content-length"):
        if value := request.headers.get(name):
            headers[name] = value

    async def bounded_body():
        total = 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_REQUEST_BYTES:
                raise HTTPException(status_code=413, detail="File is too large.")
            if (
                path.startswith("object/marketplace-media/")
                and request.headers.get("content-type", "").startswith("image/")
                and total > MAX_IMAGE_BYTES
            ):
                raise HTTPException(status_code=413, detail="Chaque image ne peut pas dépasser 20 Mo.")
            yield chunk

    try:
        client = request.app.state.storage_http
        outbound = client.build_request(
            request.method,
            f"{SUPABASE_URL}/storage/v1/{quote(path, safe='/')}",
            headers=headers,
            content=bounded_body() if request.method == "POST" else None,
        )
        upstream = await client.send(outbound)
        try:
            content = await upstream.aread()
        finally:
            await upstream.aclose()
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail="Supabase storage could not be reached.") from exc
    return Response(
        content=content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
    )


@app.post("/api/storage/sign/{bucket}/{object_path:path}")
async def sign_private_object(bucket: str, object_path: str, request: Request):
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise HTTPException(status_code=503, detail="Supabase is not configured.")
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Sign in to continue.")
    if bucket not in {"marketplace-receipts", "marketplace-message-media"}:
        raise HTTPException(status_code=404, detail="Unknown storage resource.")
    if ".." in object_path or not object_path:
        raise HTTPException(status_code=404, detail="Unknown storage resource.")
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            upstream = await client.post(
                f"{SUPABASE_URL}/storage/v1/object/sign/{bucket}/{quote(object_path, safe='/')}",
                headers={"apikey": SUPABASE_KEY, "Authorization": auth, "Content-Type": "application/json"},
                json={"expiresIn": 300},
            )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail="Supabase storage could not be reached.") from exc
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
    )
