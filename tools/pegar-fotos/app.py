import os
import sys
import ctypes
import string
import time
import shutil
import json
import socket
import subprocess
import threading
import winsound
import mimetypes
from datetime import datetime
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import unquote, quote
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

from shared import (
    UDP_PORT, HTTP_PORT, BROADCAST_INTERVAL, APP_IDENTIFIER,
    PHOTO_EXTENSIONS, VIDEO_EXTENSIONS, get_local_ip, get_lan_ips,
    get_subnet_broadcasts, build_broadcast_message,
    make_batch_name, new_machine_id, BASE_DIR, CONFIG_FILE,
    DONE_MARKER, REGISTRY_FILE, TMP_PREFIX, OLD_HTTP_PORT,
    parse_seq_name, make_seq_name, max_seq_in_folder, lot_hash_from_dir, lot_hash_from_items,
    make_lot_hash, quick_hash_file, quick_hash_parts
)
from peer import PeerListener, PeerSync
import notify
import camera

_single_instance_handle = None


def marker_files(batch_path):
    """Hash de cada arquivo do lote (gravado no marcador)."""
    marker = os.path.join(batch_path, DONE_MARKER)
    if not os.path.isfile(marker):
        return {}
    try:
        with open(marker, "r", encoding="utf-8") as f:
            data = json.load(f)
        files = data.get("files", {})
        return files if isinstance(files, dict) else {}
    except Exception:
        return {}


def acquire_single_instance(allow_multiple=False):
    """Garante que so uma instancia do app rode por maquina."""
    global _single_instance_handle
    if allow_multiple:
        return True
    try:
        kernel32 = ctypes.windll.kernel32
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        for name in ("Global\\NatalFotoImport", "Local\\NatalFotoImport"):
            handle = kernel32.CreateMutexW(None, False, name)
            if handle:
                if kernel32.GetLastError() == 183:
                    kernel32.CloseHandle(handle)
                    return False
                _single_instance_handle = handle
                return True
    except Exception:
        pass
    return True


def parse_args():
    import argparse
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--port", type=int)
    parser.add_argument("--root")
    parser.add_argument("--machine-id")
    parser.add_argument("--peer")
    parser.add_argument("--config")
    parser.add_argument("--import", dest="import_path")
    parser.add_argument("--allow-multiple", action="store_true")
    # Modo quiosque: sem janela, sem elevacao de firewall (regras vem do
    # instalador) e com log em arquivo. O PDV sobe este processo sozinho.
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--no-firewall", action="store_true")
    parser.add_argument("--no-notify", action="store_true")
    parser.add_argument("--log")
    try:
        args, _ = parser.parse_known_args()
    except Exception:
        args = argparse.Namespace()
    return args


def list_batch_dirs(root):
    """Subpastas de lotes no diretorio raiz (ignora ocultas/registro)."""
    names = []
    if os.path.isdir(root):
        for item in sorted(os.listdir(root)):
            if item.startswith(".") or item.startswith("_"):
                continue
            full = os.path.join(root, item)
            if os.path.isdir(full):
                names.append((item, full))
    return names


def batch_info(name, full):
    """Resumo de um lote (nome, qtd, tamanho, data, origem e hash)."""
    files = [f for f in os.listdir(full) if not f.startswith(".")]
    count = 0
    size = 0
    for f in files:
        fp = os.path.join(full, f)
        if os.path.isfile(fp):
            count += 1
            try:
                size += os.path.getsize(fp)
            except OSError:
                pass
    source = ""
    lot_hash = ""
    marker = os.path.join(full, DONE_MARKER)
    if os.path.isfile(marker):
        try:
            with open(marker, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            source = data.get("source", "")
            lot_hash = data.get("hash", "")
        except Exception:
            pass
    return {
        "name": name,
        "count": count,
        "size": size,
        "date": datetime.fromtimestamp(os.path.getmtime(full)).strftime("%d/%m/%Y %H:%M"),
        "source": source,
        "hash": lot_hash,
        "seq": parse_seq_name(name) or 0,
        "done": os.path.isfile(os.path.join(full, DONE_MARKER)),
    }


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = False


class PhotoHTTPHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def get_root(self):
        return getattr(self.server, "server_root", "")

    def _safe_path(self, *parts):
        root = os.path.realpath(self.get_root())
        target = os.path.realpath(os.path.join(root, *parts))
        try:
            if os.path.commonpath([root, target]) != root:
                return None
        except ValueError:
            return None
        return target

    def translate_path(self, path):
        path = unquote(path.split("?")[0].split("#")[0])
        path = path.lstrip("/")
        return self._safe_path(path) or self.get_root()

    def _json(self, payload, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0:
                return {}
            raw = self.rfile.read(length)
            data = json.loads(raw.decode("utf-8") or "{}")
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _list_dirs(self):
        return list_batch_dirs(self.get_root())

    def _batch_info(self, name, full):
        return batch_info(name, full)

    def do_POST(self):
        # O PDV chama isto quando o operador pede "Sincronizar agora".
        if self.path == "/api/sync-now":
            app = getattr(self.server, "app", None)
            if app is not None and getattr(app, "peer_sync", None):
                app.peer_sync.wake.set()
            self._json({"ok": True})
            return
        if self.path == "/api/camera/scan":
            app = getattr(self.server, "app", None)
            try:
                payload = app.camera_scan() if app is not None else {"ok": False}
            except Exception as e:
                payload = {"ok": False, "connected": False, "newCount": 0, "error": str(e)}
            self._json(payload)
            return
        if self.path == "/api/camera/capture":
            app = getattr(self.server, "app", None)
            try:
                payload = app.start_camera_capture() if app is not None else {"ok": False}
            except Exception as e:
                payload = {"ok": False, "error": str(e)}
            self._json(payload, 200 if payload.get("ok") else 409)
            return
        if self.path == "/api/camera/settings":
            app = getattr(self.server, "app", None)
            try:
                payload = app.set_camera_settings(self._read_json()) if app is not None else {"ok": False}
            except Exception as e:
                payload = {"ok": False, "error": str(e)}
            self._json(payload, 200 if payload.get("ok") else 400)
            return
        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        path = self.translate_path(self.path)

        if self.path == "/api/camera":
            app = getattr(self.server, "app", None)
            try:
                payload = {"ok": True, "camera": app.camera_payload() if app is not None else {}}
            except Exception as e:
                payload = {"ok": False, "error": str(e)}
            self._json(payload)
            return

        if self.path == "/api/camera/settings":
            app = getattr(self.server, "app", None)
            try:
                payload = {"ok": True, "settings": app.camera_settings_payload() if app is not None else {}}
            except Exception as e:
                payload = {"ok": False, "error": str(e)}
            self._json(payload)
            return

        if self.path == "/api/status":
            app = getattr(self.server, "app", None)
            try:
                payload = app.status_payload() if app is not None else {"ok": False}
            except Exception as e:
                payload = {"ok": False, "error": str(e)}
            self._json(payload)
            return

        if self.path == "/api/ping":
            self._json({"status": "ok", "app": APP_IDENTIFIER})
            return

        if self.path == "/api/seq":
            self._json({"seq": max_seq_in_folder(self.get_root())})
            return

        if self.path == "/api/server-info":
            batches = [self._batch_info(n, f) for n, f in self._list_dirs()]
            self._json({"app": APP_IDENTIFIER, "batches": batches})
            return

        if self.path == "/api/batches" or self.path == "/api/batches/":
            batches = [self._batch_info(n, f) for n, f in self._list_dirs()]
            self._json(batches)
            return

        if self.path.startswith("/api/batches/") and self.path.endswith("/files"):
            batch_name = unquote(self.path.split("/")[3])
            batch_path = self._safe_path(batch_name)
            if not batch_path:
                self.send_response(404)
                self.end_headers()
                return
            known = marker_files(batch_path)
            files = []
            if os.path.isdir(batch_path):
                for f in sorted(os.listdir(batch_path)):
                    if f.startswith("."):
                        continue
                    fp = os.path.join(batch_path, f)
                    if os.path.isfile(fp):
                        try:
                            size = os.path.getsize(fp)
                        except OSError:
                            size = 0
                        files.append({"name": f, "size": size, "hash": known.get(f, "")})
            self._json(files)
            return

        if self.path.startswith("/files/"):
            parts = self.path.split("/")
            if len(parts) >= 4:
                batch_name = unquote(parts[2])
                file_name = unquote("/".join(parts[3:]))
                file_path = self._safe_path(batch_name, file_name)
                if file_path and os.path.isfile(file_path):
                    self.send_response(200)
                    mime, _ = mimetypes.guess_type(file_path)
                    self.send_header("Content-Type", mime or "application/octet-stream")
                    self.send_header("Content-Length", str(os.path.getsize(file_path)))
                    self.send_header("Content-Disposition", f'attachment; filename="{os.path.basename(file_path)}"')
                    self.end_headers()
                    with open(file_path, "rb") as f:
                        shutil.copyfileobj(f, self.wfile)
                    return
            self.send_response(404)
            self.end_headers()
            return

        if self.path == "/" or self.path == "":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            rows = ""
            for name, full in self._list_dirs():
                info = self._batch_info(name, full)
                size_str = (f"{info['size'] / (1024*1024):.1f} MB"
                            if info["size"] < 1024*1024*1024
                            else f"{info['size'] / (1024*1024*1024):.2f} GB")
                rows += (f'<tr><td><a href="/files/{quote(name)}/">{name}</a></td>'
                         f'<td>{info["count"]}</td><td>{size_str}</td></tr>')
            html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Natal Foto Import - Servidor</title>
<style>
body {{ font-family: Segoe UI, sans-serif; background: #1e1e2e; color: #cdd6f4; padding: 40px; }}
h1 {{ color: #89b4fa; }}
table {{ border-collapse: collapse; width: 100%; margin-top: 20px; }}
th {{ background: #313244; padding: 12px; text-align: left; }}
td {{ padding: 10px 12px; border-bottom: 1px solid #313244; }}
a {{ color: #a6e3a1; text-decoration: none; }}
a:hover {{ text-decoration: underline; }}
</style></head>
<body>
<h1>Natal Foto Import - Servidor de Rede</h1>
<p>Pastas disponiveis para download:</p>
<table><tr><th>Lote</th><th>Fotos</th><th>Tamanho</th></tr>{rows}</table>
</body></html>"""
            self.wfile.write(html.encode())
            return

        self.send_response(404)
        self.end_headers()


class UDPBeacon:
    def __init__(self, name, port, machine_id=""):
        self.name = name
        self.port = port
        self.machine_id = machine_id
        self.running = False
        self.thread = None

    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False

    def _loop(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        while self.running:
            try:
                # Recalcula sempre: o Wi-Fi/cabo pode conectar depois do boot e
                # um broadcast antigo (/24 errado ou vazio) nunca acharia o outro PC.
                broadcast_addrs = get_subnet_broadcasts()
                msg = build_broadcast_message(self.name, self.port, self.machine_id)
                for addr in broadcast_addrs:
                    try:
                        sock.sendto(msg.encode(), (addr, UDP_PORT))
                    except Exception:
                        pass
            except Exception:
                pass
            for _ in range(BROADCAST_INTERVAL * 10):
                if not self.running:
                    break
                time.sleep(0.1)
        sock.close()


class PhotoImportApp:
    def __init__(self, root, args=None):
        self.args = args
        self.root = root
        self.config_file = (args.config if args and args.config else CONFIG_FILE)
        self.root.title("Natal Foto Import")
        self.root.geometry("960x820")
        self.root.minsize(820, 640)
        self.root.configure(bg="#1e1e2e")

        default_dest = os.path.join(os.path.expanduser("~"), "Desktop", "natal", "Fotos_Importadas")
        self.config = {
            "destination_path": default_dest,
            "prefix": "NATAL",
            "auto_import": True,
            "include_videos": True,
            "server_enabled": True,
            "server_port": HTTP_PORT,
            "server_name": socket.gethostname(),
            "always_on_top": True,
            "history": [],
            "machine_id": "",
            "sync_interval": 8,
            "auto_download": True,
            "camera_auto_capture": False,
        }
        self.load_config()

        if self.args and self.args.port:
            self.config["server_port"] = self.args.port
        if self.args and self.args.root:
            self.config["destination_path"] = self.args.root
        if self.args and self.args.machine_id:
            self.config["machine_id"] = self.args.machine_id
        if not self.config.get("machine_id"):
            self.config["machine_id"] = new_machine_id()
            self.save_config()

        self.headless = bool(getattr(self.args, "headless", False))
        self.no_firewall = bool(getattr(self.args, "no_firewall", False))
        self.log_file = getattr(self.args, "log", None) or ""
        self._started_at = time.time()
        # Retrato do estado para GET /api/status (lido por outra thread, sem Tk).
        self._status = {
            "card": {"state": "waiting", "badge": "AGUARDANDO CARTAO...", "message": "", "drive": "", "batch": ""},
            "progress": {"count": 0, "total": 0, "speed": 0, "file": ""},
            "download": None,
            "peer": {"found": False, "name": "", "ip": "", "port": 0, "status": "", "error": "", "batches": []},
            "server": {"active": False, "ips": [], "url": "", "port": 0},
            "camera": {
                "connected": False, "devices": [], "name": "", "capturing": False,
                "message": "", "lastBatch": "", "lastCount": 0, "lastAt": 0, "lastError": "",
            },
            "ignored": [],
        }

        os.makedirs(self.config["destination_path"], exist_ok=True)

        self._registry_names = {}
        self._registry_hashes = set()
        self._load_import_registry()

        self._camera_lock = threading.Lock()
        self._camera_index_file = os.path.join(
            self.config["destination_path"], ".natal_camera_index.json")
        self._camera_index = self._load_camera_index()
        self._last_process_reason = ""

        self.root.attributes("-topmost", self.config.get("always_on_top", True) and not self.headless)
        if self.headless:
            try:
                self.root.withdraw()
            except Exception:
                pass

        self.is_copying = False
        self.last_processed_drive = None
        self.monitor_running = True
        self.cancel_download = False

        self.http_server = None
        self.http_thread = None
        self.udp_beacon = None
        self.server_start_time = None

        self.peer_info = None
        self.peer_batches = []
        self.peer_downloading = False
        self.peer_ignored = set()

        notify.register_app_id()
        notify.set_enabled(not bool(getattr(self.args, "no_notify", False)))
        self.log("iniciado headless=%s root=%s" % (self.headless, self.config["destination_path"]))

        self.setup_styles()
        self.build_ui()

        self.monitor_thread = threading.Thread(target=self.monitor_drives, daemon=True)
        self.monitor_thread.start()

        self.peer_sync = PeerSync(
            self.config["destination_path"],
            sync_interval=self.config.get("sync_interval", 8),
            auto_download=self.config.get("auto_download", True),
            on_status=self._peer_status,
            on_progress=self._peer_progress,
            on_batch_done=self._peer_batch_done,
            on_error=self._peer_error,
            on_batches=self._peer_batches,
            on_duplicate=self._peer_duplicate,
            on_batch_failed=self._peer_batch_failed,
        )
        self.peer_sync.start()

        self.peer_listener = None
        if self.args and self.args.peer:
            host, _, port = self.args.peer.partition(":")
            self.peer_sync.set_peer({"ip": host, "port": int(port or HTTP_PORT),
                                     "name": host, "machine_id": ""})
            self.root.after(0, self._peer_found,
                            {"ip": host, "port": int(port or HTTP_PORT), "name": host})
        else:
            self.peer_listener = PeerListener(
                self.config["machine_id"],
                on_found=self._peer_found,
                on_lost=self._peer_lost,
                on_keepalive=self._peer_keepalive,
                local_ips=get_lan_ips(),
            )
            if not self.peer_listener.start():
                self.root.after(0, self._peer_error,
                                "Descoberta UDP indisponivel (porta 50000 ocupada)")

        self.root.after(500, self.start_network_server)
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

        # importa o cartao indicado na linha de comando (depois de tudo pronto)
        if self.args and getattr(self.args, "import_path", None):
            folder = self.args.import_path
            photos = self.find_photos_in_drive(folder)
            if photos:
                self.last_processed_drive = folder
                threading.Thread(target=self.process_import, args=(folder, photos), daemon=True).start()

    # ---------------------------------------------------------------- config
    def load_config(self):
        if os.path.exists(self.config_file):
            try:
                with open(self.config_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    self.config.update(data)
            except Exception:
                pass
        if self.config.get("server_port") == OLD_HTTP_PORT:
            self.config["server_port"] = HTTP_PORT

    def save_config(self):
        try:
            with open(self.config_file, "w", encoding="utf-8") as f:
                json.dump(self.config, f, ensure_ascii=False, indent=4)
        except Exception:
            pass

    # ----------------------------------------------------------- status/log
    def log(self, message):
        line = "[%s] %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), message)
        try:
            print(line, flush=True)
        except Exception:
            pass
        if not self.log_file:
            return
        try:
            pasta = os.path.dirname(self.log_file)
            if pasta:
                os.makedirs(pasta, exist_ok=True)
            with open(self.log_file, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass

    def _set_card(self, state, badge, message="", drive="", batch=""):
        self._status["card"] = {
            "state": state, "badge": badge, "message": message,
            "drive": drive, "batch": batch,
        }

    # --------------------------------------------------------------- camera
    def _set_camera(self, **values):
        cam = self._status["camera"]
        for key, value in values.items():
            cam[key] = value

    def _load_camera_index(self):
        try:
            with open(self._camera_index_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            keys = data.get("keys") or []
            return set(str(k) for k in keys)
        except Exception:
            return set()

    def _camera_index_add(self, keys):
        keys = [str(k) for k in (keys or []) if k]
        if not keys:
            return
        with self._camera_lock:
            self._camera_index.update(keys)
            try:
                tmp = self._camera_index_file + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump({"keys": sorted(self._camera_index)}, f)
                os.replace(tmp, self._camera_index_file)
            except Exception as e:
                self.log("camera: falha ao salvar indice: %s" % e)

    def _update_camera_presence(self, devices):
        names = []
        for dev in devices or []:
            if isinstance(dev, dict):
                name = (dev.get("name") or dev.get("description") or "").strip()
            else:
                name = str(dev or "").strip()
            if name and name not in names:
                names.append(name)
        cam = self._status["camera"]
        cam["connected"] = bool(names)
        cam["devices"] = names
        cam["name"] = names[0] if names else ""
        if not names and not cam.get("capturing"):
            cam["message"] = ""

    def camera_payload(self):
        cam = self._status["camera"]
        return {
            "connected": bool(cam.get("connected")),
            "devices": list(cam.get("devices") or []),
            "name": cam.get("name") or "",
            "capturing": bool(cam.get("capturing")),
            "message": cam.get("message") or "",
            "lastBatch": cam.get("lastBatch") or "",
            "lastCount": int(cam.get("lastCount") or 0),
            "lastAt": cam.get("lastAt") or 0,
            "lastError": cam.get("lastError") or "",
            "autoCapture": bool(self.config.get("camera_auto_capture", False)),
        }

    def camera_settings_payload(self):
        return {"autoCapture": bool(self.config.get("camera_auto_capture", False))}

    def set_camera_settings(self, data):
        if not isinstance(data, dict):
            return {"ok": False, "error": "invalid"}
        if "autoCapture" in data:
            self.config["camera_auto_capture"] = bool(data.get("autoCapture"))
            self.save_config()
            self.log("camera: captura automatica %s" % (
                "ativada" if self.config["camera_auto_capture"] else "desativada"))
        return {"ok": True, "settings": self.camera_settings_payload()}

    def camera_scan(self):
        self._update_camera_presence(camera.list_wpd_devices())
        with self._camera_lock:
            skip = set(self._camera_index)
        result = camera.scan(skip)
        cams = [str(c) for c in (result.get("cameras") or []) if c]
        if cams:
            self._update_camera_presence([{"name": c} for c in cams])
        else:
            self._update_camera_presence([])
        return {
            "ok": bool(result.get("ok")),
            "connected": bool(cams),
            "cameras": cams,
            "name": cams[0] if cams else "",
            "newCount": int(result.get("newCount") or 0),
            "total": int(result.get("total") or 0),
            "files": result.get("files") or [],
            "error": result.get("error") or "",
            "autoCapture": bool(self.config.get("camera_auto_capture", False)),
        }

    def start_camera_capture(self):
        with self._camera_lock:
            cam = self._status["camera"]
            if cam.get("capturing") or self.is_copying:
                return {"ok": False, "error": "busy", "message": "Ja existe uma importacao em andamento."}
            if not cam.get("connected"):
                self._update_camera_presence(camera.list_wpd_devices())
            if not cam.get("connected"):
                return {"ok": False, "error": "no_camera", "message": "Nenhuma camera conectada."}
            cam.update({
                "capturing": True,
                "message": "Lendo a camera...",
                "lastBatch": "",
                "lastCount": 0,
                "lastAt": 0,
                "lastError": "",
            })
        threading.Thread(target=self._camera_capture_worker, daemon=True).start()
        return {"ok": True, "started": True}

    def _camera_capture_worker(self):
        root = self.config["destination_path"]
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        staging = os.path.join(root, TMP_PREFIX + "camera_" + stamp)
        cam_name = self._status["camera"].get("name") or "Camera"
        try:
            with self._camera_lock:
                skip = set(self._camera_index)
            self.log("camera: procurando fotos novas (%s, %d ignoradas)" % (cam_name, len(skip)))
            result = camera.capture(staging, skip)
            files = result.get("files") or []
            errors = result.get("errors") or []
            if not files:
                if result.get("error"):
                    raise RuntimeError(result.get("error"))
                if errors:
                    raise RuntimeError("%d foto(s) nao puderam ser copiadas" % len(errors))
                self._set_camera(
                    capturing=False, message="Nenhuma foto nova na camera.",
                    lastBatch="", lastCount=0, lastAt=time.time(), lastError="",
                )
                self._set_card("camera_empty", "CAMERA SEM NOVIDADES",
                               "Nenhuma foto nova na camera.")
                return
            paths = [f.get("path") for f in files if f.get("path") and os.path.isfile(f.get("path"))]
            if not paths:
                raise RuntimeError("As fotos nao chegaram ao computador")
            self._set_camera(message="Copiando %d foto(s)..." % len(paths))
            batch_name = self.process_import(staging, paths, source_label=cam_name)
            reason = self._last_process_reason
            if batch_name:
                self._camera_index_add([f.get("key") for f in files])
                aviso = (" (%d foto(s) nao copiada(s))" % len(errors)) if errors else ""
                self._set_camera(
                    capturing=False,
                    message="Sessao criada: %s (%d fotos).%s" % (batch_name, len(paths), aviso),
                    lastBatch=batch_name, lastCount=len(paths),
                    lastAt=time.time(), lastError="",
                )
            elif reason in ("duplicate", "no_new"):
                self._camera_index_add([f.get("key") for f in files])
                msg = ("Essas fotos ja estavam importadas." if reason == "duplicate"
                       else "Nenhuma foto nova na camera.")
                self._set_camera(
                    capturing=False, message=msg, lastBatch="",
                    lastCount=len(paths) if reason == "duplicate" else 0,
                    lastAt=time.time(), lastError="",
                )
            else:
                self._set_camera(
                    capturing=False, message="Falha ao importar as fotos da camera.",
                    lastBatch="", lastCount=len(paths), lastAt=time.time(),
                    lastError="Nao foi possivel publicar a sessao.",
                )
                self._set_card("camera_error", "ERRO NA CAMERA",
                               "Nao foi possivel publicar a sessao.")
        except Exception as e:
            self.log("camera: erro: %s" % e)
            self._set_camera(
                capturing=False, message="Falha ao ler a camera.",
                lastAt=time.time(), lastError=str(e)[:300],
            )
            self._set_card("camera_error", "ERRO NA CAMERA", str(e)[:200])
        finally:
            self.is_copying = False
            shutil.rmtree(staging, ignore_errors=True)

    def status_payload(self):
        """Estado completo para o PDV (GET /api/status). Roda fora da thread Tk:
        le apenas atributos simples e o diretorio de lotes."""
        root = self.config.get("destination_path", "")
        batches = []
        try:
            for name, full in list_batch_dirs(root):
                try:
                    batches.append(batch_info(name, full))
                except Exception:
                    pass
        except Exception:
            pass
        prefix = self.config.get("prefix", "NATAL")
        try:
            next_batch = make_seq_name(max_seq_in_folder(root) + 1, prefix)
        except Exception:
            next_batch = ""
        ips = get_lan_ips()
        port = self.config.get("server_port", HTTP_PORT)
        return {
            "ok": True,
            "app": APP_IDENTIFIER,
            "pid": os.getpid(),
            "root": root,
            "headless": self.headless,
            "uptime": int(time.time() - self._started_at),
            "machineId": self.config.get("machine_id", ""),
            "serverName": self.config.get("server_name", socket.gethostname()),
            "prefix": prefix,
            "nextBatch": next_batch,
            "copying": bool(self.is_copying),
            "card": self._status["card"],
            "progress": self._status["progress"] if self.is_copying else None,
            "download": self._status["download"],
            "server": {
                "active": bool(self.http_server),
                "ips": ips,
                "port": port,
                "url": ("http://%s:%s" % (ips[0], port)) if ips else "",
                "serving": os.path.basename(root),
            },
            "peer": self._status["peer"],
            "camera": self.camera_payload(),
            "batches": batches,
            "history": self.config.get("history", [])[-50:],
            "ignored": sorted(self.peer_ignored),
            "noFirewall": self.no_firewall,
        }

    # ------------------------------------------------------------------- UI
    def setup_styles(self):
        style = ttk.Style()
        style.theme_use("clam")

        BG_CARD = "#2a2a3d"
        TEXT_COLOR = "#cdd6f4"

        style.configure(".", background="#1e1e2e", foreground=TEXT_COLOR, font=("Segoe UI", 10))
        style.configure("Card.TFrame", background=BG_CARD, relief="flat")
        style.configure("Header.TLabel", font=("Segoe UI", 16, "bold"), background="#1e1e2e", foreground="#ffffff")
        style.configure("SubHeader.TLabel", font=("Segoe UI", 11, "bold"), background=BG_CARD, foreground="#89b4fa")
        style.configure("CardText.TLabel", font=("Segoe UI", 10), background=BG_CARD, foreground=TEXT_COLOR)
        style.configure("Accent.TButton", font=("Segoe UI", 10, "bold"), background="#3b82f6", foreground="#ffffff", borderwidth=0, padding=8)
        style.map("Accent.TButton", background=[("active", "#2563eb"), ("disabled", "#4b5563")])
        style.configure("Secondary.TButton", font=("Segoe UI", 9), background="#45475a", foreground="#ffffff", borderwidth=0, padding=6)
        style.map("Secondary.TButton", background=[("active", "#585b70")])
        style.configure("Green.TButton", font=("Segoe UI", 10, "bold"), background="#22c55e", foreground="#11111b", borderwidth=0, padding=8)
        style.map("Green.TButton", background=[("active", "#16a34a"), ("disabled", "#4b5563")])
        style.configure("Red.TButton", font=("Segoe UI", 10, "bold"), background="#ef4444", foreground="#ffffff", borderwidth=0, padding=8)
        style.map("Red.TButton", background=[("active", "#dc2626"), ("disabled", "#4b5563")])
        style.configure("TProgressbar", thickness=18, troughcolor="#11111b", background="#22c55e", bordercolor="#1e1e2e")
        style.configure("Treeview", background="#181825", foreground="#cdd6f4", fieldbackground="#181825", font=("Segoe UI", 9), rowheight=26)
        style.configure("Treeview.Heading", background="#313244", foreground="#ffffff", font=("Segoe UI", 9, "bold"))
        style.map("Treeview", background=[("selected", "#45475a")])
        style.configure("TNotebook", background="#1e1e2e", borderwidth=0)
        style.configure("TNotebook.Tab", background="#313244", foreground="#cdd6f4", padding=(18, 8), font=("Segoe UI", 10, "bold"))
        style.map("TNotebook.Tab", background=[("selected", "#3b82f6")], foreground=[("selected", "#ffffff")])

    def _make_scrollable(self, parent):
        container = ttk.Frame(parent)
        container.pack(fill=tk.BOTH, expand=True)
        canvas = tk.Canvas(container, bg="#1e1e2e", highlightthickness=0)
        scrollbar = ttk.Scrollbar(container, orient=tk.VERTICAL, command=canvas.yview)
        frame = ttk.Frame(canvas)
        frame.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0, 0), window=frame, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)
        canvas.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)
        scrollbar.pack(side=tk.RIGHT, fill=tk.Y)
        canvas.bind("<Enter>", lambda e: setattr(self, "_active_canvas", canvas))
        canvas.bind("<Leave>", lambda e: setattr(self, "_active_canvas", None))
        return frame

    def build_ui(self):
        main_container = ttk.Frame(self.root, padding=(12, 12, 12, 8))
        main_container.pack(fill=tk.BOTH, expand=True)

        header_frame = ttk.Frame(main_container)
        header_frame.pack(fill=tk.X, pady=(0, 10))
        ttk.Label(header_frame, text="Natal Foto Import", style="Header.TLabel").pack(side=tk.LEFT)
        ttk.Label(header_frame, text="Servidor + Cliente automatico", font=("Segoe UI", 9),
                  background="#1e1e2e", foreground="#a6adc8").pack(side=tk.LEFT, padx=15, pady=(5, 0))
        self.btn_topmost = ttk.Button(header_frame, text="Sempre Frente: ON",
                                      style="Secondary.TButton", command=self.toggle_topmost)
        self.btn_topmost.pack(side=tk.RIGHT)
        self.update_topmost_button()

        self.notebook = ttk.Notebook(main_container)
        self.notebook.pack(fill=tk.BOTH, expand=True)
        self.tab_card = ttk.Frame(self.notebook, padding=4)
        self.tab_peer = ttk.Frame(self.notebook, padding=4)
        self.notebook.add(self.tab_card, text="  Cartao  ")
        self.notebook.add(self.tab_peer, text="  Outro PC  ")

        self._active_canvas = None
        self.root.bind_all("<MouseWheel>", self._on_mousewheel)

        self._build_card_tab(self.tab_card)
        self._build_peer_tab(self.tab_peer)

    def _on_mousewheel(self, event):
        canvas = getattr(self, "_active_canvas", None)
        if canvas:
            canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

    def _build_card_tab(self, parent):
        content = self._make_scrollable(parent)

        card_status = ttk.Frame(content, style="Card.TFrame", padding=15)
        card_status.pack(fill=tk.X, pady=(0, 10))
        status_header = ttk.Frame(card_status, style="Card.TFrame")
        status_header.pack(fill=tk.X)
        ttk.Label(status_header, text="Status do Cartao", style="SubHeader.TLabel").pack(side=tk.LEFT)
        self.status_badge = tk.Label(status_header, text="AGUARDANDO CARTAO...", font=("Segoe UI", 10, "bold"),
                                     bg="#f59e0b", fg="#11111b", padx=10, pady=3)
        self.status_badge.pack(side=tk.RIGHT)
        self.drive_info_lbl = ttk.Label(card_status,
                                        text="Insira um cartao de memoria ou pen drive no computador...",
                                        style="CardText.TLabel", font=("Segoe UI", 11))
        self.drive_info_lbl.pack(anchor=tk.W, pady=(10, 0))

        card_dest = ttk.Frame(content, style="Card.TFrame", padding=15)
        card_dest.pack(fill=tk.X, pady=(0, 10))
        ttk.Label(card_dest, text="Pasta das Fotos", style="SubHeader.TLabel").pack(anchor=tk.W, pady=(0, 8))
        dest_row = ttk.Frame(card_dest, style="Card.TFrame")
        dest_row.pack(fill=tk.X)
        self.dest_path_lbl = ttk.Label(dest_row, text=self.config["destination_path"],
                                       style="CardText.TLabel", font=("Segoe UI", 9, "italic"))
        self.dest_path_lbl.pack(side=tk.LEFT, fill=tk.X, expand=True)
        ttk.Button(dest_row, text="Alterar Pasta", style="Secondary.TButton",
                   command=self.choose_destination).pack(side=tk.RIGHT, padx=(5, 0))
        ttk.Button(dest_row, text="Abrir Pasta", style="Secondary.TButton",
                   command=self.open_destination_folder).pack(side=tk.RIGHT, padx=(5, 0))
        next_row = ttk.Frame(card_dest, style="Card.TFrame")
        next_row.pack(fill=tk.X, pady=(10, 0))
        ttk.Label(next_row, text="Proximo Lote: ", style="CardText.TLabel").pack(side=tk.LEFT)
        self.next_batch_val_lbl = tk.Label(next_row, text="NATAL-S0001",
                                           font=("Segoe UI", 13, "bold"), bg="#181825", fg="#a6e3a1",
                                           padx=10, pady=2)
        self.next_batch_val_lbl.pack(side=tk.LEFT, padx=5)
        ttk.Label(next_row, text="(a ordem em que os lotes sao criados)",
                  style="CardText.TLabel", font=("Segoe UI", 8, "italic"), foreground="#a6adc8").pack(side=tk.LEFT)
        self.update_next_batch_label()

        card_network = ttk.Frame(content, style="Card.TFrame", padding=15)
        card_network.pack(fill=tk.X, pady=(0, 10))
        net_header = ttk.Frame(card_network, style="Card.TFrame")
        net_header.pack(fill=tk.X)
        ttk.Label(net_header, text="Servidor de Rede", style="SubHeader.TLabel").pack(side=tk.LEFT)
        self.net_badge = tk.Label(net_header, text="PARADO", font=("Segoe UI", 10, "bold"),
                                  bg="#6c7086", fg="#ffffff", padx=10, pady=3)
        self.net_badge.pack(side=tk.RIGHT)

        net_info_row = ttk.Frame(card_network, style="Card.TFrame")
        net_info_row.pack(fill=tk.X, pady=(8, 0))
        self.net_ip_lbl = ttk.Label(net_info_row, text="IP: --", style="CardText.TLabel", font=("Segoe UI", 10))
        self.net_ip_lbl.pack(side=tk.LEFT)
        self.net_clients_lbl = ttk.Label(net_info_row, text="", style="CardText.TLabel", font=("Segoe UI", 9),
                                         foreground="#a6adc8")
        self.net_clients_lbl.pack(side=tk.RIGHT)

        net_actions = ttk.Frame(card_network, style="Card.TFrame")
        net_actions.pack(fill=tk.X, pady=(8, 0))
        self.btn_toggle_server = ttk.Button(net_actions, text="Iniciar Servidor", style="Green.TButton",
                                            command=self.toggle_server)
        self.btn_toggle_server.pack(side=tk.LEFT, padx=(0, 5))
        ttk.Button(net_actions, text="Copiar Link", style="Secondary.TButton",
                   command=self.copy_server_link).pack(side=tk.LEFT, padx=(0, 5))

        self.net_url_lbl = ttk.Label(card_network, text="", style="CardText.TLabel", font=("Segoe UI", 9, "italic"),
                                     foreground="#89b4fa")
        self.net_url_lbl.pack(anchor=tk.W, pady=(8, 0))

        card_progress = ttk.Frame(content, style="Card.TFrame", padding=15)
        card_progress.pack(fill=tk.X, pady=(0, 10))
        ttk.Label(card_progress, text="Progresso do Descarregamento", style="SubHeader.TLabel").pack(anchor=tk.W, pady=(0, 8))
        self.progress_bar = ttk.Progressbar(card_progress, style="TProgressbar", mode="determinate")
        self.progress_bar.pack(fill=tk.X, pady=(0, 8))
        prog_row = ttk.Frame(card_progress, style="Card.TFrame")
        prog_row.pack(fill=tk.X)
        self.prog_count_lbl = ttk.Label(prog_row, text="0 / 0 arquivos", style="CardText.TLabel")
        self.prog_count_lbl.pack(side=tk.LEFT)
        self.prog_speed_lbl = ttk.Label(prog_row, text="-- MB/s", style="CardText.TLabel")
        self.prog_speed_lbl.pack(side=tk.RIGHT)
        self.current_file_lbl = ttk.Label(card_progress, text="", style="CardText.TLabel", font=("Segoe UI", 8),
                                          foreground="#a6adc8")
        self.current_file_lbl.pack(anchor=tk.W, pady=(4, 0))

        actions_frame = ttk.Frame(content)
        actions_frame.pack(fill=tk.X, pady=(0, 10))
        self.btn_manual_copy = ttk.Button(actions_frame, text="Selecionar Pasta/Cartao Manualmente",
                                          style="Accent.TButton", command=self.manual_import)
        self.btn_manual_copy.pack(side=tk.LEFT, fill=tk.X, expand=True)

        card_history = ttk.Frame(content, style="Card.TFrame", padding=15)
        card_history.pack(fill=tk.X, pady=(0, 10))
        ttk.Label(card_history, text="Historico de Lotes", style="SubHeader.TLabel").pack(anchor=tk.W, pady=(0, 8))
        columns = ("lote", "data", "fotos", "tamanho", "origem")
        self.tree = ttk.Treeview(card_history, columns=columns, show="headings", height=6)
        self.tree.heading("lote", text="Lote")
        self.tree.heading("data", text="Data / Hora")
        self.tree.heading("fotos", text="Qtd Fotos")
        self.tree.heading("tamanho", text="Tamanho")
        self.tree.heading("origem", text="Origem")
        self.tree.column("lote", width=150, anchor="center")
        self.tree.column("data", width=140, anchor="center")
        self.tree.column("fotos", width=80, anchor="center")
        self.tree.column("tamanho", width=100, anchor="center")
        self.tree.column("origem", width=250, anchor="w")
        self.tree.pack(fill=tk.X)
        self.tree.bind("<Double-1>", self.on_history_double_click)
        self.update_history_table()

        self.update_server_ui()

    def _build_peer_tab(self, parent):
        content = self._make_scrollable(parent)

        card_peer = ttk.Frame(content, style="Card.TFrame", padding=15)
        card_peer.pack(fill=tk.X, pady=(0, 10))
        peer_header = ttk.Frame(card_peer, style="Card.TFrame")
        peer_header.pack(fill=tk.X)
        ttk.Label(peer_header, text="Outro PC", style="SubHeader.TLabel").pack(side=tk.LEFT)
        self.peer_badge = tk.Label(peer_header, text="AGUARDANDO", font=("Segoe UI", 10, "bold"),
                                   bg="#f59e0b", fg="#11111b", padx=10, pady=3)
        self.peer_badge.pack(side=tk.RIGHT)

        peer_info_row = ttk.Frame(card_peer, style="Card.TFrame")
        peer_info_row.pack(fill=tk.X, pady=(8, 0))
        self.peer_name_lbl = ttk.Label(peer_info_row, text="Procurando outro computador na rede...",
                                        style="CardText.TLabel", font=("Segoe UI", 10))
        self.peer_name_lbl.pack(side=tk.LEFT)
        self.peer_sync_lbl = ttk.Label(peer_info_row, text="", style="CardText.TLabel", font=("Segoe UI", 9),
                                       foreground="#a6adc8")
        self.peer_sync_lbl.pack(side=tk.RIGHT)
        self.peer_error_lbl = ttk.Label(card_peer, text="", style="CardText.TLabel", font=("Segoe UI", 9),
                                        foreground="#ef4444")
        self.peer_error_lbl.pack(anchor=tk.W, pady=(6, 0))

        card_dl = ttk.Frame(content, style="Card.TFrame", padding=15)
        card_dl.pack(fill=tk.X, pady=(0, 10))
        ttk.Label(card_dl, text="Download de Fotos", style="SubHeader.TLabel").pack(anchor=tk.W, pady=(0, 8))
        self.dl_progress = ttk.Progressbar(card_dl, style="TProgressbar", mode="determinate")
        self.dl_progress.pack(fill=tk.X, pady=(0, 8))
        dl_row = ttk.Frame(card_dl, style="Card.TFrame")
        dl_row.pack(fill=tk.X)
        self.dl_count_lbl = ttk.Label(dl_row, text="0 / 0 arquivos", style="CardText.TLabel")
        self.dl_count_lbl.pack(side=tk.LEFT)
        self.dl_speed_lbl = ttk.Label(dl_row, text="-- MB/s", style="CardText.TLabel")
        self.dl_speed_lbl.pack(side=tk.RIGHT)
        self.dl_file_lbl = ttk.Label(card_dl, text="", style="CardText.TLabel", font=("Segoe UI", 8),
                                     foreground="#a6adc8")
        self.dl_file_lbl.pack(anchor=tk.W, pady=(4, 0))

        card_remote = ttk.Frame(content, style="Card.TFrame", padding=15)
        card_remote.pack(fill=tk.X, pady=(0, 10))
        ttk.Label(card_remote, text="Lotes no Outro PC", style="SubHeader.TLabel").pack(anchor=tk.W, pady=(0, 8))
        columns = ("status", "lote", "fotos", "tamanho", "data")
        self.tree_remote = ttk.Treeview(card_remote, columns=columns, show="headings", height=6)
        for col, title, width in (("status", "Status", 80), ("lote", "Lote", 170),
                                  ("fotos", "Fotos", 70), ("tamanho", "Tamanho", 100), ("data", "Data", 130)):
            self.tree_remote.heading(col, text=title)
            self.tree_remote.column(col, width=width, anchor="center")
        self.tree_remote.pack(fill=tk.X)

        card_local = ttk.Frame(content, style="Card.TFrame", padding=15)
        card_local.pack(fill=tk.X, pady=(0, 10))
        ttk.Label(card_local, text="Meus Lotes (neste PC)", style="SubHeader.TLabel").pack(anchor=tk.W, pady=(0, 8))
        columns = ("lote", "fotos", "tamanho", "data")
        self.tree_local = ttk.Treeview(card_local, columns=columns, show="headings", height=6)
        for col, title, width in (("lote", "Lote", 170), ("fotos", "Fotos", 70),
                                  ("tamanho", "Tamanho", 110), ("data", "Data", 140)):
            self.tree_local.heading(col, text=title)
            self.tree_local.column(col, width=width, anchor="center")
        self.tree_local.pack(fill=tk.X)
        self.tree_local.bind("<Double-1>", self.on_local_double_click)
        self.update_local_table()

    # ---------------------------------------------------------------- server
    def update_server_ui(self):
        if self.http_server:
            ips = get_lan_ips()
            ip = get_local_ip()
            port = self.config.get("server_port", HTTP_PORT)
            if not ips:
                ips = [ip]
            urls = " | ".join(f"http://{x}:{port}" for x in ips)
            self.net_badge.config(text="ATIVO", bg="#22c55e", fg="#11111b")
            self.net_ip_lbl.config(text=f"IPs: {' '.join(ips)}")
            self.net_url_lbl.config(text=f"Outros notebooks acessem: {urls}")
            self.btn_toggle_server.config(text="Parar Servidor", style="Red.TButton")
            elapsed = ""
            if self.server_start_time:
                secs = int(time.time() - self.server_start_time)
                m, s = divmod(secs, 60)
                h, m = divmod(m, 60)
                elapsed = f" | Ativo: {h}h{m:02d}m{s:02d}s" if h else f" | Ativo: {m}m{s:02d}s"
            self.net_clients_lbl.config(text=f"Servindo: {os.path.basename(self.config['destination_path'])}{elapsed}")
        else:
            self.net_badge.config(text="PARADO", bg="#6c7086", fg="#ffffff")
            self.net_ip_lbl.config(text="IP: --")
            self.net_url_lbl.config(text="O servidor esta parado - os outros PCs nao conseguem baixar fotos")
            self.btn_toggle_server.config(text="Iniciar Servidor", style="Green.TButton")
            self.net_clients_lbl.config(text="")

    def toggle_server(self):
        if self.http_server:
            self.stop_network_server()
        else:
            self.start_network_server()

    def start_network_server(self):
        if self.http_server:
            return
        try:
            port = self.config.get("server_port", HTTP_PORT)
            server = ThreadedHTTPServer(("0.0.0.0", port), PhotoHTTPHandler)
            server.server_root = self.config["destination_path"]
            server.app = self
            self.http_server = server
            self.http_thread = threading.Thread(target=server.serve_forever, daemon=True)
            self.http_thread.start()
            self.udp_beacon = UDPBeacon(self.config.get("server_name", socket.gethostname()),
                                        port, self.config.get("machine_id", ""))
            self.udp_beacon.start()
            self.server_start_time = time.time()
            self.config["server_enabled"] = True
            if not self.no_firewall:
                self.add_firewall_rule(port)
            self.save_config()
            self.log("servidor de rede ativo na porta %s (root=%s)" % (port, self.config["destination_path"]))
            self.root.after(0, self.update_server_ui)
            self.root.after(0, self.start_uptime_updater)
        except Exception as e:
            self.log("ERRO ao iniciar servidor na porta %s: %s" % (self.config.get("server_port", HTTP_PORT), e))
            if not self.headless:
                self.root.after(0, messagebox.showerror,
                                "Erro", f"Nao foi possivel iniciar o servidor na porta "
                                        f"{self.config.get('server_port', HTTP_PORT)}:\n\n{e}\n\n"
                                        f"Provavelmente outro programa esta usando essa porta.")

    def add_firewall_rule(self, port):
        try:
            self._set_private_profile()
            self._remove_blocking_rules(port)
            rule_name = f"Natal Foto Import - Porta {port}"
            if not self._check_firewall_rule(rule_name):
                result = subprocess.run(
                    ["netsh", "advfirewall", "firewall", "add", "rule",
                     f"name={rule_name}", "dir=in", "action=allow",
                     "protocol=TCP", f"localport={port}", "profile=any"],
                    capture_output=True, timeout=10
                )
                if result.returncode != 0:
                    self._request_firewall_elevation(rule_name, port, protocol="TCP")
        except Exception:
            pass

    def _set_private_profile(self):
        try:
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private"],
                capture_output=True, timeout=15
            )
            if result.returncode != 0:
                ps_script = (
                    "Start-Process -FilePath 'powershell' -Verb RunAs -Wait -ArgumentList "
                    "'-NoProfile','-Command','Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private'"
                )
                subprocess.run(["powershell", "-Command", ps_script], timeout=20)
        except Exception:
            pass

    def _remove_blocking_rules(self, port):
        try:
            result = subprocess.run(
                ["netsh", "advfirewall", "firewall", "show", "rule", "name=all", "dir=in",
                 "protocol=TCP", f"localport={port}", "action=block"],
                capture_output=True, timeout=10, encoding="utf-8", errors="replace"
            )
            has_block = result.returncode == 0 and ("OK" in result.stdout or "OK" in result.stderr)
            del_result = subprocess.run(
                ["netsh", "advfirewall", "firewall", "delete", "rule", "name=all", "dir=in",
                 "protocol=TCP", f"localport={port}", "action=block"],
                capture_output=True, timeout=10
            )
            if has_block and del_result.returncode != 0:
                self._request_firewall_elevation(None, port, protocol="TCP", delete_block=True)
        except Exception:
            pass

    def _check_firewall_rule(self, rule_name):
        try:
            result = subprocess.run(
                ["netsh", "advfirewall", "firewall", "show", "rule", f"name={rule_name}"],
                capture_output=True, timeout=10, encoding="utf-8", errors="replace"
            )
            return result.returncode == 0 and ("OK" in result.stdout or "OK" in result.stderr)
        except Exception:
            return False

    def _request_firewall_elevation(self, rule_name, port, protocol="TCP", delete_block=False):
        try:
            if delete_block:
                ps_script = (
                    f"Start-Process -FilePath 'netsh' -Verb RunAs -Wait "
                    f"-ArgumentList 'advfirewall','firewall','delete','rule','name=all','dir=in',"
                    f"'protocol={protocol}','localport={port}','action=block'"
                )
            else:
                ps_script = (
                    f"Start-Process -FilePath 'netsh' -Verb RunAs -Wait "
                    f"-ArgumentList 'advfirewall','firewall','add','rule',"
                    f"'name={rule_name}','dir=in','action=allow','protocol={protocol}',"
                    f"'localport={port}','profile=any'"
                )
            subprocess.run(["powershell", "-Command", ps_script], timeout=15)
        except Exception:
            pass

    def stop_network_server(self):
        if self.udp_beacon:
            self.udp_beacon.stop()
            self.udp_beacon = None
        if self.http_server:
            try:
                self.http_server.shutdown()
                self.http_server.server_close()
            except Exception:
                pass
            self.http_server = None
        self.http_thread = None
        self.server_start_time = None
        self.root.after(0, self.update_server_ui)

    def start_uptime_updater(self):
        def _update():
            if self.http_server:
                self.update_server_ui()
                self.root.after(10000, _update)
        _update()

    def copy_server_link(self):
        if self.http_server:
            ip = get_local_ip()
            port = self.config.get("server_port", HTTP_PORT)
            link = f"http://{ip}:{port}"
            self.root.clipboard_clear()
            self.root.clipboard_append(link)
            messagebox.showinfo("Copiado", f"Link copiado:\n{link}")
        else:
            messagebox.showwarning("Aviso", "O servidor nao esta rodando!")

    def toggle_topmost(self):
        current = self.config.get("always_on_top", True)
        self.config["always_on_top"] = not current
        self.root.attributes("-topmost", not current)
        self.save_config()
        self.update_topmost_button()

    def update_topmost_button(self):
        is_top = self.config.get("always_on_top", True)
        self.btn_topmost.config(text="Sempre Frente: ON" if is_top else "Sempre Frente: OFF")

    # ----------------------------------------------------------------- peer
    def _peer_found(self, info):
        self.peer_info = info
        self.peer_sync.set_peer(info)
        self._status["peer"].update({
            "found": True,
            "name": info.get("name", ""),
            "ip": info.get("ip", ""),
            "port": info.get("port", 0),
            "error": "",
        })
        self.root.after(0, self._update_peer_ui)

    def _peer_lost(self, old):
        self.peer_info = None
        self.peer_sync.clear_peer()
        self._status["peer"].update({
            "found": False, "name": "", "ip": "", "port": 0,
            "status": "Outro PC desconectado", "batches": [],
        })
        self._status["download"] = None
        self.root.after(0, self._update_peer_ui)

    def _peer_keepalive(self):
        pass

    def _update_peer_ui(self):
        if self.peer_info:
            url = f"http://{self.peer_info['ip']}:{self.peer_info['port']}"
            self.peer_badge.config(text="ENCONTRADO", bg="#22c55e", fg="#11111b")
            self.peer_name_lbl.config(text=f"Nome: {self.peer_info['name']}  |  {url}")
        else:
            self.peer_badge.config(text="AGUARDANDO", bg="#f59e0b", fg="#11111b")
            self.peer_name_lbl.config(text="Procurando outro computador na rede...")
        self.update_remote_table()
        self.update_local_table()

    def _peer_status(self, message):
        self._status["peer"]["status"] = message
        self.root.after(0, lambda: self.peer_sync_lbl.config(text=message))

    def _peer_error(self, message):
        self._status["peer"]["error"] = message
        self.root.after(0, lambda: self.peer_error_lbl.config(text=f"ERRO: {message}"))

    def _peer_batches(self, batches):
        self.peer_batches = batches
        self._status["peer"]["batches"] = batches
        self.root.after(0, self.update_remote_table)

    def _peer_duplicate(self, batch):
        name = batch.get("name", "")
        self.peer_ignored.add(name)
        self.root.after(0, lambda: self.peer_sync_lbl.config(
            text=f"{name}: mesmas fotos que ja tenho - nao baixou de novo"))
        self.root.after(0, self.update_remote_table)

    def _peer_progress(self, batch_name, count, total, done_bytes, elapsed):
        speed = (done_bytes / (1024 * 1024)) / elapsed if elapsed else 0
        if total > 0 and count > total:
            count = total
        self._status["download"] = (
            {
                "batch": batch_name, "count": count, "total": total,
                "speed": round(speed, 2),
            }
            if total > 0
            else None
        )

        def _apply():
            self.dl_progress["maximum"] = max(total, 1)
            self.dl_progress["value"] = count
            self.dl_count_lbl.config(text=f"{count} / {total} arquivos")
            self.dl_speed_lbl.config(text=f"{speed:.1f} MB/s")
            self.dl_file_lbl.config(text=f"[{batch_name}] baixando...")

        self.root.after(0, _apply)

    def _peer_batch_failed(self, batch_name, restantes, total):
        self._status["download"] = None
        mensagem = f"{batch_name}: faltaram {restantes} de {total} arquivo(s)"
        self._status["peer"]["error"] = mensagem
        self.log("lote %s incompleto: %s" % (batch_name, mensagem))

        def _apply():
            self.dl_file_lbl.config(text=f"Incompleto: {mensagem}")
            self.peer_error_lbl.config(text=f"ERRO: {mensagem} - tentando de novo")
            self.update_remote_table()

        self.root.after(0, _apply)

    def _peer_batch_done(self, batch_name, count, size, downloaded=None):
        peer_name = self.peer_info["name"] if self.peer_info else "outro PC"
        now = datetime.now().strftime("%H:%M:%S")
        self._status["download"] = None
        self.log("lote %s baixado de %s (%s arquivos)" % (batch_name, peer_name, count))

        # registra os arquivos baixados para nao importar de novo o mesmo cartao
        for fname, fsize, fhash, fqhash in (downloaded or []):
            self._registry_names.setdefault(fname, {})[fsize] = {"h": fhash, "q": fqhash}
            if fhash:
                self._registry_hashes.add(fhash)
        if downloaded:
            self._save_import_registry()

        self.config.setdefault("history", []).append({
            "batch": batch_name,
            "date": now,
            "count": count,
            "size": self.format_size(size),
            "source": f"PC {peer_name}",
        })
        self.save_config()

        def _apply():
            self.dl_file_lbl.config(text=f"Sincronizado! {count} arquivo(s) em {batch_name}")
            self.peer_sync_lbl.config(text=f"Tudo sincronizado ({now})")
            self.peer_error_lbl.config(text="")
            self.update_history_table()
            self.update_remote_table()
            self.update_local_table()

        self.root.after(0, _apply)

        notify.toast(
            f"{count} foto(s) baixada(s)",
            f"{batch_name}\nDe {peer_name}",
            folder=os.path.join(self.config["destination_path"], batch_name),
            on_fallback=lambda t, m: self.root.after(0, self._fallback_banner, t, m),
        )

    def _fallback_banner(self, title, message):
        self.dl_file_lbl.config(text=f"{title} - {message.splitlines()[0]}")

    def update_remote_table(self):
        for row in self.tree_remote.get_children():
            self.tree_remote.delete(row)
        root = self.config["destination_path"]
        for batch in self.peer_batches:
            name = batch["name"]
            done = os.path.isfile(os.path.join(root, name, DONE_MARKER))
            if done:
                status = "OK"
            elif name in self.peer_ignored:
                status = "IGUAL"
            else:
                status = "NOVO"
            self.tree_remote.insert("", tk.END, values=(
                status, name, batch.get("count", 0), self.format_size(batch.get("size", 0)),
                batch.get("date", "")
            ))

    def update_local_table(self):
        for row in self.tree_local.get_children():
            self.tree_local.delete(row)
        root = self.config["destination_path"]
        if not os.path.isdir(root):
            return
        for name in sorted(os.listdir(root), reverse=True):
            path = os.path.join(root, name)
            if not os.path.isdir(path) or name.startswith("."):
                continue
            count = 0
            size = 0
            for r, _, fs in os.walk(path):
                for f in fs:
                    if f.startswith("."):
                        continue
                    count += 1
                    try:
                        size += os.path.getsize(os.path.join(r, f))
                    except OSError:
                        pass
            mtime = datetime.fromtimestamp(os.path.getmtime(path)).strftime("%d/%m/%Y %H:%M")
            self.tree_local.insert("", tk.END, values=(name, count, self.format_size(size), mtime))

    def on_local_double_click(self, event):
        selected = self.tree_local.selection()
        if selected:
            name = self.tree_local.item(selected[0], "values")[0]
            path = os.path.join(self.config["destination_path"], name)
            if os.path.exists(path):
                os.startfile(path)

    # ---------------------------------------------------------------- cartao
    def choose_destination(self):
        folder = filedialog.askdirectory(initialdir=self.config["destination_path"], title="Selecione a Pasta")
        if folder:
            self.config["destination_path"] = folder
            self.dest_path_lbl.config(text=folder)
            self._load_import_registry()
            self.save_config()
            if self.http_server:
                self.http_server.server_root = folder
            if self.peer_sync:
                self.peer_sync.root = folder
            self.update_local_table()

    def open_destination_folder(self):
        dest = self.config["destination_path"]
        os.makedirs(dest, exist_ok=True)
        os.startfile(dest)

    def get_next_sequence(self, consult_peer=True):
        """Proximo numero de sequencia do lote.

        Usa o maior numero ja existente localmente E o maior numero que o
        outro PC conhece, para os 2 notebooks nunca criarem numeros
        diferentes para o mesmo cartao.
        """
        local_max = max_seq_in_folder(self.config["destination_path"])
        biggest = local_max
        peer_sync = getattr(self, "peer_sync", None)
        if consult_peer and peer_sync:
            data, _error = peer_sync.get_json("/api/seq", retries=1)
            if isinstance(data, dict):
                try:
                    biggest = max(biggest, int(data.get("seq", 0)))
                except (TypeError, ValueError):
                    pass
        return biggest + 1

    def update_next_batch_label(self):
        prefix = self.config.get("prefix", "NATAL")
        try:
            seq = max_seq_in_folder(self.config["destination_path"]) + 1
        except Exception:
            seq = 1
        self.next_batch_val_lbl.config(text=make_seq_name(seq, prefix))

    def update_history_table(self):
        for row in self.tree.get_children():
            self.tree.delete(row)
        for item in reversed(self.config.get("history", [])):
            self.tree.insert("", tk.END, values=(
                item.get("batch", ""), item.get("date", ""),
                item.get("count", 0), item.get("size", "0 MB"), item.get("source", "")
            ))

    def on_history_double_click(self, event):
        selected = self.tree.selection()
        if selected:
            values = self.tree.item(selected[0], "values")
            batch_folder = os.path.join(self.config["destination_path"], values[0])
            if os.path.exists(batch_folder):
                os.startfile(batch_folder)
            else:
                messagebox.showwarning("Nao Encontrado", f"Pasta '{values[0]}' nao encontrada.")

    def get_removable_drives(self):
        drives = []
        bitmask = ctypes.windll.kernel32.GetLogicalDrives()
        for letter in string.ascii_uppercase:
            if bitmask & 1:
                drive_path = f"{letter}:\\"
                drive_type = ctypes.windll.kernel32.GetDriveTypeW(drive_path)
                if letter != "C":
                    if drive_type == 2:
                        drives.append(drive_path)
                    elif drive_type == 3:
                        dcim_path = os.path.join(drive_path, "DCIM")
                        if os.path.exists(dcim_path):
                            drives.append(drive_path)
            bitmask >>= 1
        return drives

    def find_photos_in_drive(self, drive_path):
        photos = []
        try:
            for root_dir, dirs, files in os.walk(drive_path):
                dirs[:] = [d for d in dirs if not d.startswith('$') and d != 'System Volume Information']
                for file in files:
                    ext = os.path.splitext(file)[1].lower()
                    if ext in PHOTO_EXTENSIONS or (self.config.get("include_videos", True) and ext in VIDEO_EXTENSIONS):
                        photos.append(os.path.join(root_dir, file))
        except Exception:
            pass
        return photos

    def monitor_drives(self):
        while self.monitor_running:
            time.sleep(2)
            if self.is_copying:
                continue
            try:
                removable_drives = self.get_removable_drives()
                was_camera_connected = bool(self._status["camera"].get("connected"))
                try:
                    cam_devices = camera.list_wpd_devices()
                except Exception:
                    cam_devices = []
                self._update_camera_presence(cam_devices)
                now_camera_connected = bool(self._status["camera"].get("connected"))

                if not removable_drives:
                    self.last_processed_drive = None
                started_import = False
                has_card_photos = False
                for drive in removable_drives:
                    photos = self.find_photos_in_drive(drive)
                    if photos:
                        has_card_photos = True
                        if drive != self.last_processed_drive:
                            self.root.after(0, self.set_status_detected, drive, len(photos))
                            if self.config.get("auto_import", True):
                                self.last_processed_drive = drive
                                threading.Thread(target=self.process_import, args=(drive, photos), daemon=True).start()
                                started_import = True
                                break
                        else:
                            self.root.after(0, self.set_status_ready_existing, drive, len(photos))
                    else:
                        if drive != self.last_processed_drive:
                            self.root.after(0, self.set_status_empty, drive)

                if started_import or self.is_copying:
                    continue
                cam = self._status["camera"]
                if (now_camera_connected and not was_camera_connected
                        and not has_card_photos
                        and self.config.get("camera_auto_capture", False)
                        and not cam.get("capturing")):
                    self.log("camera: conectada; iniciando captura automatica")
                    self.root.after(0, self.set_status_camera_ready, cam.get("name") or "")
                    self.start_camera_capture()
                    continue
                if not removable_drives and cam.get("connected") and not cam.get("capturing"):
                    self.root.after(0, self.set_status_camera_ready, cam.get("name") or "")
                elif not removable_drives and not cam.get("connected"):
                    self.root.after(0, self.set_status_waiting)
            except Exception:
                pass

    def set_status_waiting(self):
        self.status_badge.config(text="AGUARDANDO CARTAO OU CAMERA...", bg="#f59e0b", fg="#11111b")
        self.drive_info_lbl.config(text="Insira um cartao/pen drive ou conecte a camera no computador...")
        self._set_card("waiting", "AGUARDANDO CARTAO OU CAMERA...",
                       "Insira um cartao/pen drive ou conecte a camera no computador...")

    def set_status_camera_ready(self, name):
        nome = name or "Camera"
        badge = f"CAMERA CONECTADA ({nome})"
        msg = f"{nome} conectada. Tire as fotos e use 'Sessao da camera' no PDV."
        self.status_badge.config(text=badge, bg="#8b5cf6", fg="#ffffff")
        self.drive_info_lbl.config(text=msg)
        self._set_card("camera_ready", badge, msg, drive=nome)

    def set_status_detected(self, drive, count):
        self.status_badge.config(text=f"CARTAO DETECTADO ({drive})", bg="#3b82f6", fg="#ffffff")
        self.drive_info_lbl.config(text=f"Drive {drive} detectado com {count} fotos/videos. Iniciando copia...")
        self._set_card("detected", f"CARTAO DETECTADO ({drive})",
                       f"Drive {drive} detectado com {count} fotos/videos. Iniciando copia...", drive=drive)

    def set_status_ready_existing(self, drive, count):
        self.status_badge.config(text=f"CARTAO JA PROCESSADO ({drive})", bg="#45475a", fg="#ffffff")
        self.drive_info_lbl.config(text=f"Drive {drive} ja foi descarregado ({count} fotos). Remova o cartao.")
        self._set_card("ready_existing", f"CARTAO JA PROCESSADO ({drive})",
                       f"Drive {drive} ja foi descarregado ({count} fotos). Remova o cartao.", drive=drive)

    def set_status_empty(self, drive):
        self.status_badge.config(text=f"CARTAO VAZIO ({drive})", bg="#6c7086", fg="#ffffff")
        self.drive_info_lbl.config(text=f"Drive {drive} conectado, mas nenhuma foto suportada encontrada.")
        self._set_card("empty", f"CARTAO VAZIO ({drive})",
                       f"Drive {drive} conectado, mas nenhuma foto suportada encontrada.", drive=drive)

    def set_status_copying(self, batch_name, count):
        self.status_badge.config(text=f"COPIANDO PARA {batch_name}...", bg="#22c55e", fg="#11111b")
        self.drive_info_lbl.config(text=f"Descarregando {count} fotos para {batch_name}...")
        self._set_card("copying", f"COPIANDO PARA {batch_name}...",
                       f"Descarregando {count} fotos para {batch_name}...", batch=batch_name)

    def set_status_finished(self, batch_name, count):
        self.status_badge.config(text=f"CONCLUIDO ({batch_name})", bg="#a6e3a1", fg="#11111b")
        self.drive_info_lbl.config(text=f"Sucesso! {count} fotos salvas em {batch_name}. Pode remover o cartao!")
        self._set_card("finished", f"CONCLUIDO ({batch_name})",
                       f"Sucesso! {count} fotos salvas em {batch_name}. Pode remover o cartao!", batch=batch_name)

    def set_status_all_imported(self):
        self.status_badge.config(text="CARTAO SEM NOVIDADES", bg="#f59e0b", fg="#11111b")
        self.drive_info_lbl.config(text="Todas as fotos deste cartao ja foram importadas antes. Pode remover.")
        self._set_card("all_imported", "CARTAO SEM NOVIDADES",
                       "Todas as fotos deste cartao ja foram importadas antes. Pode remover.")

    def manual_import(self):
        if self.is_copying:
            messagebox.showinfo("Aviso", "Ja existe uma copia em andamento!")
            return
        folder = filedialog.askdirectory(title="Selecione o Cartao ou Pasta de Origem")
        if folder:
            photos = self.find_photos_in_drive(folder)
            if not photos:
                messagebox.showwarning("Nenhuma Foto", "Nenhuma foto ou video suportado encontrado.")
                return
            self.last_processed_drive = folder
            threading.Thread(target=self.process_import, args=(folder, photos), daemon=True).start()

    def _dest_entries_for(self, new_files):
        """(nome no lote, hash do arquivo) que os arquivos terao."""
        entries = []
        used = set()
        for src_file, fhash, file_size, _qhash in new_files:
            filename = os.path.basename(src_file)
            name, ext = os.path.splitext(filename)
            candidate = filename
            counter = 1
            while candidate.lower() in used:
                candidate = f"{name}_{counter}{ext}"
                counter += 1
            used.add(candidate.lower())
            entries.append((candidate, fhash))
        return entries

    def _lot_with_hash(self, content_hash):
        """Nome do lote local que ja tem esse conteudo (ou None)."""
        if not content_hash:
            return None
        root = self.config["destination_path"]
        try:
            for name in os.listdir(root):
                if name.startswith("."):
                    continue
                marker = os.path.join(root, name, DONE_MARKER)
                if not os.path.isfile(marker):
                    continue
                try:
                    with open(marker, "r", encoding="utf-8") as f:
                        if json.load(f).get("hash") == content_hash:
                            return name
                except Exception:
                    continue
        except OSError:
            pass
        return None

    def process_import(self, source_path, photo_files, source_label=None):
        source = source_label or source_path
        self._last_process_reason = ""
        self.is_copying = True
        self.root.after(0, lambda: self.btn_manual_copy.config(state=tk.DISABLED))
        self.root.after(0, lambda: self.drive_info_lbl.config(text="Verificando quais fotos sao novas..."))

        known = {}
        for n, sizes in self._registry_names.items():
            for s, info in sizes.items():
                if isinstance(info, dict):
                    known[(n, s)] = (info.get("q", ""), info.get("h", ""))
                else:
                    known[(n, s)] = ("", info)

        new_files = []
        for f in photo_files:
            if not self.monitor_running:
                break
            try:
                size = os.path.getsize(f)
            except Exception:
                continue
            name = os.path.basename(f)
            entry = known.get((name, size))
            if entry:
                q, h = entry
                if q:
                    if quick_hash_file(f) == q:
                        continue
                elif h and self._file_hash(f) == h:
                    continue
            try:
                fhash = self._file_hash(f)
            except Exception:
                continue
            if fhash in self._registry_hashes:
                continue
            try:
                qhash = quick_hash_file(f)
            except Exception:
                qhash = ""
            new_files.append((f, fhash, size, qhash))

        if not new_files:
            self._last_process_reason = "no_new"
            self.is_copying = False
            self.root.after(0, lambda: self.btn_manual_copy.config(state=tk.NORMAL))
            try:
                winsound.MessageBeep(winsound.MB_ICONASTERISK)
            except Exception:
                pass
            self.root.after(0, self.set_status_all_imported)
            return None

        # se o MESMO conteudo ja existe em outro lote (ex: baixado do outro PC
        # com outro nome) nao cria uma pasta duplicada
        prospective = make_lot_hash(self._dest_entries_for(new_files))
        same_lot = self._lot_with_hash(prospective)
        if same_lot:
            self._last_process_reason = "duplicate"
            self.is_copying = False
            self.root.after(0, lambda: self.btn_manual_copy.config(state=tk.NORMAL))
            self.root.after(0, self.set_status_all_imported)
            self.root.after(0, lambda: self.drive_info_lbl.config(
                text=f"Essas fotos ja estao no lote {same_lot}. Pode remover o cartao."))
            return None

        prefix = self.config.get("prefix", "NATAL")
        seq = self.get_next_sequence()
        root = self.config["destination_path"]
        batch_name = make_seq_name(seq, prefix)
        while os.path.exists(os.path.join(root, batch_name)):
            seq += 1
            batch_name = make_seq_name(seq, prefix)
        tmp_dir = os.path.join(root, TMP_PREFIX + batch_name)
        final_dir = os.path.join(root, batch_name)

        if os.path.exists(tmp_dir):
            shutil.rmtree(tmp_dir, ignore_errors=True)
        os.makedirs(tmp_dir, exist_ok=True)

        total_files = len(new_files)
        self.root.after(0, self.set_status_copying, batch_name, total_files)
        self.root.after(0, lambda: self.progress_bar.config(maximum=total_files, value=0))

        copied_bytes = 0
        copied_count = 0
        copy_errors = 0
        start_time = time.time()

        lot_entries = []
        for idx, (src_file, fhash, file_size, qhash) in enumerate(new_files, 1):
            if not self.monitor_running:
                break
            filename = os.path.basename(src_file)
            dest_file = os.path.join(tmp_dir, filename)
            counter = 1
            name, ext = os.path.splitext(filename)
            while os.path.exists(dest_file):
                dest_file = os.path.join(tmp_dir, f"{name}_{counter}{ext}")
                counter += 1
            try:
                shutil.copy2(src_file, dest_file)
                lot_entries.append((os.path.basename(dest_file), fhash))
                self._registry_names.setdefault(os.path.basename(dest_file), {})[file_size] = {
                    "h": fhash, "q": qhash
                }
                self._registry_hashes.add(fhash)
                copied_bytes += file_size
                copied_count += 1
                elapsed = time.time() - start_time
                speed_mb = (copied_bytes / (1024 * 1024)) / elapsed if elapsed > 0 else 0
                self.root.after(0, self.update_progress_ui, idx, total_files, speed_mb, filename)
            except Exception:
                copy_errors += 1

        if copied_count != total_files or copy_errors:
            # Nunca publica lote incompleto: o sidecar criaria uma sessao
            # faltando fotos e o cartao poderia ser apagado pelo operador.
            self._last_process_reason = "copy_error"
            shutil.rmtree(tmp_dir, ignore_errors=True)
            self.is_copying = False
            self._status["progress"] = None
            faltaram = total_files - copied_count
            self.root.after(0, lambda: self.btn_manual_copy.config(state=tk.NORMAL))
            self.root.after(0, self.set_status_empty, source)
            self.root.after(0, lambda: self.drive_info_lbl.config(
                text=f"Falha ao copiar {faltaram} foto(s). Nada foi publicado; tente de novo."))
            self.log("lote %s NAO publicado: %s de %s copiados" % (
                batch_name, copied_count, total_files))
            return None

        published = self._publish_batch(tmp_dir, final_dir)
        if not published:
            self._last_process_reason = "publish_error"
            shutil.rmtree(tmp_dir, ignore_errors=True)
            self.is_copying = False
            self._status["progress"] = None
            self.root.after(0, lambda: self.btn_manual_copy.config(state=tk.NORMAL))
            self.root.after(0, self.set_status_empty, source)
            return None

        self._save_import_registry()
        self._write_marker(final_dir, copied_count, copied_bytes, source,
                           make_lot_hash(lot_entries), dict(lot_entries))

        formatted_size = self.format_size(copied_bytes)
        date_str = datetime.now().strftime("%d/%m/%Y %H:%M")
        self.config.setdefault("history", []).append({
            "batch": batch_name, "date": date_str,
            "count": copied_count, "size": formatted_size, "source": source
        })
        self.save_config()

        try:
            winsound.MessageBeep(winsound.MB_ICONASTERISK)
        except Exception:
            pass

        self.root.after(0, self.finish_import, batch_name, copied_count)
        self._last_process_reason = "ok"
        return batch_name

    def _publish_batch(self, tmp_dir, final_dir):
        """Publica o lote de forma atomica: so aparece pronto para o outro PC."""
        try:
            if not os.path.exists(final_dir):
                os.makedirs(os.path.dirname(final_dir), exist_ok=True)
                os.rename(tmp_dir, final_dir)
                return True
            for name in os.listdir(tmp_dir):
                src = os.path.join(tmp_dir, name)
                dst = os.path.join(final_dir, name)
                if os.path.isfile(src) and not os.path.exists(dst):
                    shutil.move(src, dst)
            shutil.rmtree(tmp_dir, ignore_errors=True)
            return True
        except Exception:
            return False

    def _write_marker(self, batch_dir, count, size, source, lot_hash=None, files=None):
        marker_path = os.path.join(batch_dir, DONE_MARKER)
        tmp_path = marker_path + ".tmp"
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump({
                    "count": count,
                    "size": size,
                    "source": source,
                    "hash": lot_hash or lot_hash_from_dir(batch_dir),
                    "seq": parse_seq_name(os.path.basename(batch_dir)) or 0,
                    "files": files or {},
                }, f)
            os.replace(tmp_path, marker_path)
        except Exception:
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except OSError:
                pass

    def _file_hash(self, path):
        import hashlib
        h = hashlib.sha1()
        with open(path, "rb") as fi:
            while True:
                chunk = fi.read(1024 * 1024)
                if not chunk:
                    break
                h.update(chunk)
        return h.hexdigest()[:16]

    def _load_import_registry(self):
        self._registry_names = {}
        self._registry_hashes = set()
        dest = self.config["destination_path"]

        existing = set()
        if os.path.isdir(dest):
            for root_dir, _, files in os.walk(dest):
                for fn in files:
                    if fn == REGISTRY_FILE or fn.startswith("."):
                        continue
                    fp = os.path.join(root_dir, fn)
                    try:
                        existing.add((fn, os.path.getsize(fp)))
                    except Exception:
                        pass

        known_hashes = {}
        fpath = os.path.join(dest, REGISTRY_FILE)
        if os.path.exists(fpath):
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    for e in json.load(f).get("files", []):
                        n = e.get("n")
                        s = e.get("s")
                        h = e.get("h")
                        q = e.get("q", "")
                        if n and s is not None:
                            known_hashes[(n, s)] = (h or "", q or "")
            except Exception:
                pass

        for (n, s) in existing:
            h, q = known_hashes.get((n, s), ("", ""))
            self._registry_names.setdefault(n, {})[s] = {"h": h, "q": q}
            if h:
                self._registry_hashes.add(h)

    def _save_import_registry(self):
        dest = self.config["destination_path"]
        files = []
        for n, sizes in self._registry_names.items():
            for s, info in sizes.items():
                if isinstance(info, dict):
                    files.append({"n": n, "s": s, "h": info.get("h", ""), "q": info.get("q", "")})
                else:
                    files.append({"n": n, "s": s, "h": info})
        try:
            os.makedirs(dest, exist_ok=True)
            with open(os.path.join(dest, REGISTRY_FILE), "w", encoding="utf-8") as f:
                json.dump({"files": files}, f)
        except Exception:
            pass

    def update_progress_ui(self, count, total, speed, filename):
        self.progress_bar["value"] = count
        self.prog_count_lbl.config(text=f"{count} / {total} arquivos")
        self.prog_speed_lbl.config(text=f"{speed:.1f} MB/s")
        self.current_file_lbl.config(text=f"Copiando: {filename}")
        self._status["progress"] = {"count": count, "total": total, "speed": round(speed, 2), "file": filename}

    def finish_import(self, batch_name, count):
        self.is_copying = False
        self.btn_manual_copy.config(state=tk.NORMAL)
        self.current_file_lbl.config(text="")
        self.set_status_finished(batch_name, count)
        # Copia concluida: limpa o progresso para o chip do PDV nao ficar
        # eternamente em "Copiando 6/6".
        self._status["progress"] = None
        self.update_history_table()
        self.update_local_table()
        self.update_next_batch_label()
        self.log("lote %s importado do cartao (%s arquivos)" % (batch_name, count))

        notify.toast(
            f"{count} foto(s) importada(s)",
            f"{batch_name}\nSalvo em {os.path.basename(self.config['destination_path'])}",
            folder=os.path.join(self.config["destination_path"], batch_name),
            on_fallback=lambda t, m: None,
        )

    def format_size(self, size_bytes):
        if size_bytes < 1024 * 1024:
            return f"{size_bytes / 1024:.1f} KB"
        elif size_bytes < 1024 * 1024 * 1024:
            return f"{size_bytes / (1024 * 1024):.1f} MB"
        else:
            return f"{size_bytes / (1024 * 1024 * 1024):.2f} GB"

    def on_close(self):
        self.monitor_running = False
        self.cancel_download = True
        if self.peer_sync:
            self.peer_sync.stop()
        if self.peer_listener:
            self.peer_listener.stop()
        self.stop_network_server()
        self.root.destroy()


def main():
    args = parse_args()
    headless = bool(getattr(args, "headless", False))
    if not acquire_single_instance(getattr(args, "allow_multiple", False)):
        if headless:
            # O PDV ja tem outra instancia (talvez orfa). Sai sem janela.
            try:
                with open(getattr(args, "log", None) or os.devnull, "a", encoding="utf-8") as f:
                    f.write("[%s] outra instancia ja esta rodando; saindo\n"
                            % datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
            except Exception:
                pass
            return
        root = tk.Tk()
        root.withdraw()
        messagebox.showinfo(
            "Natal Foto Import",
            "O app ja esta aberto neste computador.\n\n"
            "Feche a janela que ja esta aberta antes de abrir de novo\n"
            "(a porta de rede so pode ser usada por uma instancia).")
        root.destroy()
        return
    root = tk.Tk()
    PhotoImportApp(root, args)
    root.mainloop()


if __name__ == "__main__":
    main()
