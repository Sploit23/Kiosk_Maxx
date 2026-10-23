import os
import json
import hashlib
import socket
import shutil
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import quote

from shared import (UDP_PORT, DONE_MARKER, parse_broadcast_message, parse_seq_name,
                    lot_hash_from_dir, make_lot_hash, quick_hash_parts, QUICK_HASH_BLOCK,
                    enrich_peer_info)


def file_hash(path):
    """Hash do conteudo do arquivo (sha1 curto)."""
    h = hashlib.sha1()
    try:
        with open(path, "rb") as fi:
            while True:
                chunk = fi.read(1024 * 1024)
                if not chunk:
                    break
                h.update(chunk)
    except OSError:
        return ""
    return h.hexdigest()[:16]


class PeerListener:
    """Escuta o broadcast UDP dos outros PCs e ignora o proprio eco."""

    def __init__(self, machine_id, on_found, on_lost, on_keepalive, local_ips=None):
        self.machine_id = machine_id or ""
        self.local_ips = set(local_ips or [])
        self.on_found = on_found
        self.on_lost = on_lost
        self.on_keepalive = on_keepalive
        self.running = False
        self.sock = None
        self.thread = None
        self.last_seen = 0
        self.server_info = None
        self.lock = threading.Lock()

    def start(self):
        self.running = True
        try:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.sock.bind(("", UDP_PORT))
            self.sock.settimeout(2.0)
        except Exception:
            self.sock = None
            self.running = False
            return False
        self.thread = threading.Thread(target=self._listen, daemon=True)
        self.thread.start()
        threading.Thread(target=self._watchdog, daemon=True).start()
        return True

    def stop(self):
        self.running = False
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass

    def _is_self(self, info):
        mid = info.get("machine_id") or ""
        if mid and self.machine_id:
            return mid == self.machine_id
        return info.get("ip") in self.local_ips

    def _listen(self):
        while self.running:
            try:
                data, _addr = self.sock.recvfrom(1024)
                info = parse_broadcast_message(data)
                if not info:
                    continue
                info = enrich_peer_info(info, self.local_ips)
                if not info.get("ip") or self._is_self(info):
                    continue
                with self.lock:
                    changed = (
                        self.server_info is None
                        or self.server_info["ip"] != info["ip"]
                        or self.server_info["port"] != info["port"]
                    )
                    self.last_seen = time.time()
                    if changed:
                        self.server_info = info
                if changed:
                    self.on_found(info)
                else:
                    self.on_keepalive()
            except socket.timeout:
                continue
            except Exception:
                if self.running:
                    time.sleep(1)

    def _watchdog(self):
        while self.running:
            time.sleep(5)
            with self.lock:
                info = self.server_info
                last = self.last_seen
            if info and last > 0 and time.time() - last > 15:
                with self.lock:
                    self.server_info = None
                self.on_lost(info)


class PeerSync:
    """Consulta o outro PC e baixa os lotes que faltam localmente."""

    def __init__(self, root, sync_interval=8, auto_download=True,
                 on_status=None, on_progress=None, on_batch_done=None, on_error=None,
                 on_batches=None, on_duplicate=None):
        self.root = root
        self.sync_interval = sync_interval
        self.auto_download = auto_download
        self.on_status = on_status or (lambda *a: None)
        self.on_progress = on_progress or (lambda *a: None)
        self.on_batch_done = on_batch_done or (lambda *a: None)
        self.on_error = on_error or (lambda *a: None)
        self.on_batches = on_batches or (lambda *a: None)
        self.on_duplicate = on_duplicate or (lambda *a: None)
        self.peer = None
        self.remote_batches = []
        self.running = False
        self.thread = None
        self.wake = threading.Event()
        self.is_downloading = False
        self.cancel = False
        self.lock = threading.Lock()

    def set_peer(self, info):
        info = enrich_peer_info(info)
        with self.lock:
            changed = (
                self.peer is None
                or self.peer["ip"] != info["ip"]
                or self.peer["port"] != info["port"]
            )
            self.peer = dict(info)
        if changed:
            self.wake.set()

    def clear_peer(self):
        with self.lock:
            self.peer = None
        self.remote_batches = []

    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False
        self.cancel = True
        self.wake.set()

    def _loop(self):
        while self.running:
            self.wake.wait(timeout=self.sync_interval)
            self.wake.clear()
            if not self.running:
                break
            try:
                self._sync_once()
            except Exception as e:
                self.on_error(str(e))

    def _peer_urls(self, path):
        """URLs candidatas: o IP do mesmo subnet primeiro, os outros como reserva.

        O outro PC pode anunciar varios IPs (cabo + wifi). Se o primeiro nao
        responder, tenta o seguinte - assim a transferencia nunca trava.
        """
        with self.lock:
            if not self.peer:
                return []
            port = self.peer["port"]
            ips = self.peer.get("ips") or [self.peer["ip"]]
        return [f"http://{ip}:{port}{path}" for ip in ips if ip]

    def _peer_url(self, path):
        urls = self._peer_urls(path)
        return urls[0] if urls else None

    def _api(self, path, retries=2):
        urls = self._peer_urls(path)
        if not urls:
            return None, "sem outro PC conectado"
        last = None
        for attempt in range(retries):
            for url in urls:
                try:
                    req = urllib.request.Request(url)
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        return json.loads(resp.read().decode()), None
                except Exception as e:
                    last = str(e)
            time.sleep(1 * (attempt + 1))
        return None, last

    def get_json(self, path, retries=2):
        return self._api(path, retries=retries)

    def _sync_once(self):
        with self.lock:
            if not self.peer or self.is_downloading:
                return
            self.is_downloading = True
        try:
            data, error = self._api("/api/batches", retries=1)
            if error or data is None:
                self.on_status(f"Falha de conexao com o outro PC ({error})")
                return
            self.remote_batches = data
            self.on_batches(data)
            self.on_status(f"{len(data)} lote(s) no outro PC")
            if not self.auto_download:
                return
            for batch in data:
                if self.cancel:
                    break
                name = batch["name"]
                remote_hash = batch.get("hash", "")
                local_hash = self.local_hash(name)
                if local_hash and remote_hash and local_hash != remote_hash:
                    # conflito de nome (os PCs trabalharam offline): preserva a
                    # pasta local e baixa a do outro PC com um sufixo
                    alt = f"{name}-{remote_hash[:6]}"
                    if not self.is_complete(alt):
                        self._download_batch(batch, alt)
                    continue
                if self.is_complete(name):
                    continue
                if remote_hash and self.has_content(remote_hash):
                    self.on_duplicate(batch)
                    continue
                self._download_batch(batch)
        finally:
            with self.lock:
                self.is_downloading = False

    def is_complete(self, name):
        folder = os.path.join(self.root, name)
        return os.path.isdir(folder) and os.path.isfile(os.path.join(folder, DONE_MARKER))

    def local_hash(self, name):
        """Hash de conteudo do lote local (ou None)."""
        marker = os.path.join(self.root, name, DONE_MARKER)
        if not os.path.isfile(marker):
            return None
        try:
            with open(marker, "r", encoding="utf-8") as f:
                return json.load(f).get("hash", "")
        except Exception:
            return None

    def has_content(self, content_hash):
        """True se ja existe localmente um lote com o mesmo conteudo
        (mesmas fotos com outro nome - evita baixar de novo)."""
        try:
            for name in os.listdir(self.root):
                if name.startswith("."):
                    continue
                marker = os.path.join(self.root, name, DONE_MARKER)
                if not os.path.isfile(marker):
                    continue
                try:
                    with open(marker, "r", encoding="utf-8") as f:
                        if json.load(f).get("hash") == content_hash:
                            return True
                except Exception:
                    continue
        except OSError:
            pass
        return False

    def _have_file(self, path, size):
        try:
            return os.path.isfile(path) and os.path.getsize(path) == size
        except OSError:
            return False

    def _download_batch(self, batch, target_name=None):
        name = target_name or batch["name"]
        files, error = self._api(f"/api/batches/{quote(batch['name'])}/files")
        if not files:
            self.on_error(f"Nao consegui listar {batch['name']}: {error}")
            return

        batch_dir = os.path.join(self.root, name)
        try:
            os.makedirs(batch_dir, exist_ok=True)
        except Exception as e:
            self.on_error(f"Nao consegui criar a pasta {name}: {e}")
            return

        todo = [f for f in files if not self._have_file(os.path.join(batch_dir, f["name"]), f["size"])]
        total = len(files)
        already = total - len(todo)
        self.on_progress(name, already, total, 0, 0)

        downloaded = []
        if todo:
            self.on_status(f"Baixando {name} ({len(todo)} arquivo(s))...")
            start_time = time.time()
            state = {"bytes": 0, "count": 0}
            state_lock = threading.Lock()

            def task(file_info):
                if self.cancel:
                    return False
                ok, fhash, qhash = self._download_file(batch["name"], batch_dir, file_info)
                if ok:
                    with state_lock:
                        state["bytes"] += file_info["size"]
                        state["count"] += 1
                        count_now, bytes_now = state["count"], state["bytes"]
                        downloaded.append((file_info["name"], file_info["size"], fhash, qhash))
                    elapsed = max(time.time() - start_time, 0.001)
                    self.on_progress(name, already + count_now, total, bytes_now, elapsed)
                return ok

            with ThreadPoolExecutor(max_workers=4) as pool:
                list(pool.map(task, todo))

        hashes = {f["name"]: f.get("hash", "") for f in files}
        for fname, _fsize, fhash, _qhash in downloaded:
            hashes[fname] = fhash
        for fname, fhash in list(hashes.items()):
            if not fhash:
                hashes[fname] = file_hash(os.path.join(batch_dir, fname))

        self._write_marker(batch_dir, batch, make_lot_hash(list(hashes.items())), hashes)
        self.on_batch_done(name, len(files), sum(f["size"] for f in files), downloaded)

    def _download_file(self, batch_name, batch_dir, file_info):
        name = file_info["name"]
        dest = os.path.join(batch_dir, name)
        urls = self._peer_urls(f"/files/{quote(batch_name)}/{quote(name)}")
        if not urls:
            return False, "", ""
        tmp = dest + ".part"
        for url in urls:
            try:
                req = urllib.request.Request(url)
                digest = hashlib.sha1()
                head = b""
                tail = b""
                written = 0
                with urllib.request.urlopen(req, timeout=180) as resp:
                    with open(tmp, "wb") as out:
                        while True:
                            chunk = resp.read(1024 * 256)
                            if not chunk:
                                break
                            digest.update(chunk)
                            written += len(chunk)
                            if len(head) < QUICK_HASH_BLOCK:
                                head += chunk[:QUICK_HASH_BLOCK - len(head)]
                            tail = (tail + chunk)[-QUICK_HASH_BLOCK:] if written > QUICK_HASH_BLOCK else tail + chunk
                            out.write(chunk)
                os.replace(tmp, dest)
                return True, digest.hexdigest()[:16], quick_hash_parts(written, head, tail)
            except Exception:
                try:
                    if os.path.exists(tmp):
                        os.remove(tmp)
                except OSError:
                    pass
        return False, "", ""

    def _write_marker(self, batch_dir, batch, lot_hash="", files=None):
        try:
            marker = {
                "count": batch.get("count", 0),
                "size": batch.get("size", 0),
                "date": batch.get("date", ""),
                "source": batch.get("source", "peer"),
                "hash": lot_hash or lot_hash_from_dir(batch_dir),
                "seq": parse_seq_name(os.path.basename(batch_dir)) or 0,
                "files": files or {},
            }
            with open(os.path.join(batch_dir, DONE_MARKER), "w", encoding="utf-8") as f:
                json.dump(marker, f)
        except Exception:
            pass
