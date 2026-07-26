"""
Simple MCP stdio <-> WebSocket pipe with optional unified config.
Adapted from https://github.com/78/mcp-calculator for Xiaozhi MCP endpoint.

Usage:
  set MCP_ENDPOINT=<ws_endpoint>
  python mcp_pipe.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import subprocess
import sys
from pathlib import Path

import websockets
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("MCP_PIPE")

INITIAL_BACKOFF = 1
MAX_BACKOFF = 600


async def connect_with_retry(uri: str, target: str) -> None:
    reconnect_attempt = 0
    backoff = INITIAL_BACKOFF
    while True:
        try:
            if reconnect_attempt > 0:
                logger.info(
                    "[%s] Waiting %ss before reconnection attempt %s...",
                    target,
                    backoff,
                    reconnect_attempt,
                )
                await asyncio.sleep(backoff)
            await connect_to_server(uri, target)
        except Exception as exc:  # noqa: BLE001
            reconnect_attempt += 1
            logger.warning(
                "[%s] Connection closed (attempt %s): %s",
                target,
                reconnect_attempt,
                exc,
            )
            backoff = min(backoff * 2, MAX_BACKOFF)


async def connect_to_server(uri: str, target: str) -> None:
    process = None
    try:
        logger.info("[%s] Connecting to WebSocket server...", target)
        async with websockets.connect(uri) as websocket:
            logger.info("[%s] Successfully connected to WebSocket server", target)
            cmd, env = build_server_command(target)
            process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                encoding="utf-8",
                text=True,
                env=env,
                cwd=str(ROOT),
            )
            logger.info("[%s] Started server process: %s", target, " ".join(cmd))
            await asyncio.gather(
                pipe_websocket_to_process(websocket, process, target),
                pipe_process_to_websocket(process, websocket, target),
                pipe_process_stderr_to_terminal(process, target),
            )
    except websockets.exceptions.ConnectionClosed as exc:
        logger.error("[%s] WebSocket connection closed: %s", target, exc)
        raise
    except Exception as exc:  # noqa: BLE001
        logger.error("[%s] Connection error: %s", target, exc)
        raise
    finally:
        if process is not None:
            logger.info("[%s] Terminating server process", target)
            try:
                process.terminate()
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
            logger.info("[%s] Server process terminated", target)


async def pipe_websocket_to_process(websocket, process, target: str) -> None:
    try:
        while True:
            message = await websocket.recv()
            if isinstance(message, bytes):
                message = message.decode("utf-8")
            process.stdin.write(message + "\n")
            process.stdin.flush()
    except Exception as exc:  # noqa: BLE001
        logger.error("[%s] Error in WebSocket to process pipe: %s", target, exc)
        raise
    finally:
        if process.stdin and not process.stdin.closed:
            process.stdin.close()


async def pipe_process_to_websocket(process, websocket, target: str) -> None:
    try:
        while True:
            data = await asyncio.to_thread(process.stdout.readline)
            if not data:
                logger.info("[%s] Process has ended output", target)
                break
            await websocket.send(data)
    except Exception as exc:  # noqa: BLE001
        logger.error("[%s] Error in process to WebSocket pipe: %s", target, exc)
        raise


async def pipe_process_stderr_to_terminal(process, target: str) -> None:
    try:
        while True:
            data = await asyncio.to_thread(process.stderr.readline)
            if not data:
                logger.info("[%s] Process has ended stderr output", target)
                break
            sys.stderr.write(data)
            sys.stderr.flush()
    except Exception as exc:  # noqa: BLE001
        logger.error("[%s] Error in process stderr pipe: %s", target, exc)
        raise


def load_config() -> dict:
    path = os.environ.get("MCP_CONFIG") or str(ROOT / "mcp_config.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to load config %s: %s", path, exc)
        return {}


def build_server_command(target: str | None = None):
    if target is None:
        assert len(sys.argv) >= 2, "missing server name or script path"
        target = sys.argv[1]

    cfg = load_config()
    servers = cfg.get("mcpServers", {}) if isinstance(cfg, dict) else {}

    if target in servers:
        entry = servers[target] or {}
        if entry.get("disabled"):
            raise RuntimeError(f"Server '{target}' is disabled in config")
        typ = (entry.get("type") or entry.get("transportType") or "stdio").lower()
        child_env = os.environ.copy()
        for key, value in (entry.get("env") or {}).items():
            child_env[str(key)] = str(value)

        if typ == "stdio":
            command = entry.get("command")
            args = entry.get("args") or []
            if not command:
                raise RuntimeError(f"Server '{target}' is missing 'command'")
            return [command, *args], child_env

        if typ in ("sse", "http", "streamablehttp"):
            url = entry.get("url")
            if not url:
                raise RuntimeError(f"Server '{target}' (type {typ}) is missing 'url'")
            cmd = [sys.executable, "-m", "mcp_proxy"]
            if typ in ("http", "streamablehttp"):
                cmd += ["--transport", "streamablehttp"]
            headers = entry.get("headers") or {}
            for header_key, header_value in headers.items():
                cmd += ["-H", header_key, str(header_value)]
            cmd.append(url)
            return cmd, child_env

        raise RuntimeError(f"Unsupported server type: {typ}")

    script_path = target
    if not os.path.exists(script_path):
        raise RuntimeError(
            f"'{target}' is neither a configured server nor an existing script"
        )
    return [sys.executable, script_path], os.environ.copy()


def signal_handler(sig, frame):  # noqa: ARG001
    logger.info("Received interrupt signal, shutting down...")
    sys.exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal_handler)
    if sys.platform == "win32":
        signal.signal(signal.SIGTERM, signal_handler)

    endpoint_url = os.environ.get("MCP_ENDPOINT")
    if not endpoint_url or "请替换" in endpoint_url:
        logger.error(
            "请先在 .env 中配置有效的 MCP_ENDPOINT（从小智控制台复制接入点地址）"
        )
        sys.exit(1)

    target_arg = sys.argv[1] if len(sys.argv) >= 2 else None

    async def _main() -> None:
        if not target_arg:
            cfg = load_config()
            servers_cfg = cfg.get("mcpServers") or {}
            enabled = [
                name
                for name, entry in servers_cfg.items()
                if not (entry or {}).get("disabled")
            ]
            skipped = [name for name in servers_cfg if name not in enabled]
            if skipped:
                logger.info("Skipping disabled servers: %s", ", ".join(skipped))
            if not enabled:
                raise RuntimeError("No enabled mcpServers found in config")
            logger.info("Starting servers: %s", ", ".join(enabled))
            tasks = [
                asyncio.create_task(connect_with_retry(endpoint_url, name))
                for name in enabled
            ]
            await asyncio.gather(*tasks)
        else:
            if os.path.exists(target_arg):
                await connect_with_retry(endpoint_url, target_arg)
            else:
                logger.error(
                    "Argument must be a local Python script path. "
                    "To run configured servers, run without arguments."
                )
                sys.exit(1)

    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        logger.info("Program interrupted by user")
    except Exception as exc:  # noqa: BLE001
        logger.error("Program execution error: %s", exc)
        sys.exit(1)
