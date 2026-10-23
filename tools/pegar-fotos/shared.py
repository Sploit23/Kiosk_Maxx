import os
import re
import sys
import json
import socket
import hashlib
import uuid
from datetime import datetime

UDP_PORT = 50000
HTTP_PORT = 8099
OLD_HTTP_PORT = 8080
BROADCAST_INTERVAL = 3
APP_IDENTIFIER = "natal_foto_import"

DONE_MARKER = ".natal_done"
REGISTRY_FILE = ".natal_imported.json"
TMP_PREFIX = ".tmp_importando_"

if getattr(sys, "frozen", False):
    BASE_DIR = os.path.dirname(sys.executable)
    RESOURCE_DIR = getattr(sys, "_MEIPASS", BASE_DIR)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    RESOURCE_DIR = BASE_DIR

CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

PHOTO_EXTENSIONS = {
    '.jpg', '.jpeg', '.png', '.cr2', '.cr3', '.nef', '.arw', '.dng',
    '.rw2', '.orf', '.pef', '.raf', '.tif', '.tiff', '.heic', '.webp'
}

VIDEO_EXTENSIONS = {
    '.mp4', '.mov', '.avi', '.m4v', '.mts', '.m2ts'
}


def _is_private_ip(ip):
    if ip.startswith("127.") or ip.startswith("169.254."):
        return False
    if ip.startswith("10."):
        return True
    if ip.startswith("192.168."):
        return True
    if ip.startswith("172."):
        parts = ip.split(".")
        if len(parts) >= 2:
            try:
                second = int(parts[1])
                if 16 <= second <= 31:
                    return True
            except ValueError:
                pass
    return False


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(2)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and _is_private_ip(ip):
            return ip
    except Exception:
        pass
    ips = get_lan_ips()
    if ips:
        return ips[0]
    return "127.0.0.1"


def get_lan_ips():
    ips = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if _is_private_ip(ip) and ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    return ips


def all_local_ips():
    """Todos os IPs privados da maquina, o da rota padrao primeiro.

    O PC pode ter varias placas (cabo do roteador + wifi do MikroTik).
    Anunciar todos evita que o outro PC tente um IP que ele nao alcanca.
    """
    ips = []
    principal = get_local_ip()
    if principal and _is_private_ip(principal):
        ips.append(principal)
    for ip in get_lan_ips():
        if ip not in ips:
            ips.append(ip)
    return ips


def _same_subnet(ip_a, ip_b):
    try:
        a = ip_a.split(".")
        b = ip_b.split(".")
        return len(a) == 4 and len(b) == 4 and a[:3] == b[:3]
    except Exception:
        return False


def order_candidate_ips(ips, local_ips=None):
    """Coloca na frente os IPs do mesmo subnet local (os que funcionam)."""
    if not ips:
        return []
    locais = [ip for ip in (local_ips or []) if ip]
    if not locais:
        locais = [ip for ip in get_lan_ips() if ip]
    if not locais:
        principal = get_local_ip()
        locais = [principal] if principal else []
    mesmos = [ip for ip in ips if any(_same_subnet(ip, l) for l in locais)]
    outros = [ip for ip in ips if ip not in mesmos]
    return mesmos + outros


def probe_tcp(ip, port, timeout=1.0):
    """True se o outro PC responde nessa porta (teste rapido de alcance)."""
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except Exception:
        return False


def enrich_peer_info(info, local_ips=None):
    """Normaliza as infos do outro PC: ordena os IPs e define qual usar."""
    if not info:
        return info
    ips = info.get("ips") or ([info["ip"]] if info.get("ip") else [])
    ordered = order_candidate_ips(ips, local_ips)
    novo = dict(info)
    novo["ips"] = ordered
    novo["ip"] = ordered[0] if ordered else info.get("ip", "")
    return novo


def get_subnet_broadcasts():
    addrs = ["255.255.255.255"]
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if _is_private_ip(ip):
                parts = ip.split(".")
                bcast = ".".join(parts[:3]) + ".255"
                if bcast not in addrs:
                    addrs.append(bcast)
    except Exception:
        pass
    return addrs


def new_machine_id():
    return uuid.uuid4().hex[:12]


def build_broadcast_message(name, port, machine_id=""):
    return f"{APP_IDENTIFIER}|{','.join(all_local_ips())}|{port}|{name}|{machine_id}"


def parse_broadcast_message(data):
    try:
        parts = data.decode("utf-8").split("|")
        if len(parts) >= 4 and parts[0] == APP_IDENTIFIER:
            ips = [p.strip() for p in parts[1].split(",") if p.strip()]
            return {
                "ip": ips[0] if ips else "",
                "ips": ips,
                "port": int(parts[2]),
                "name": parts[3],
                "machine_id": parts[4] if len(parts) > 4 else "",
            }
    except Exception:
        pass
    return None


def make_batch_name(source_root, files, prefix="NATAL"):
    """Nome de pasta deterministico: os 2 PCs criam exatamente a mesma pasta.

    A data vem do proprio cartao (mtime mais novo dos arquivos) e o hash do
    conteudo, entao o mesmo cartao gera o mesmo nome em qualquer maquina.
    """
    items = []
    newest = 0
    for path in files:
        try:
            rel = os.path.relpath(path, source_root).replace("\\", "/").lower()
        except Exception:
            rel = os.path.basename(path).lower()
        try:
            size = os.path.getsize(path)
        except OSError:
            size = 0
        items.append(f"{rel}:{size}")
        try:
            newest = max(newest, os.path.getmtime(path))
        except OSError:
            pass
    digest = hashlib.sha1(
        "|".join(sorted(items)).encode("utf-8", "replace")
    ).hexdigest()[:6].upper()
    stamp = datetime.fromtimestamp(newest).strftime("%d%m") if newest else datetime.now().strftime("%d%m")
    return f"{prefix}-{stamp}-{digest}"


SEQ_PATTERN = re.compile(r"^(?P<prefix>.+)-S(?P<num>\d+)(?:-[0-9a-f]{4,8})?$", re.IGNORECASE)


def parse_seq_name(name):
    """Devolve o numero de sequencia do lote (NATAL-S0007 -> 7) ou None."""
    match = SEQ_PATTERN.match(name or "")
    if not match:
        return None
    try:
        return int(match.group("num"))
    except ValueError:
        return None


def make_seq_name(seq, prefix="NATAL"):
    """Nome sequencial do lote: NATAL-S0001, NATAL-S0002, ..."""
    return f"{prefix}-S{int(seq):04d}"


QUICK_HASH_BLOCK = 32768


def quick_hash_parts(size, head, tail):
    """Hash rapido de um arquivo: tamanho + inicio + fim (le ~64KB)."""
    h = hashlib.sha1()
    h.update(str(int(size)).encode("utf-8"))
    h.update(head or b"")
    h.update(tail or b"")
    return h.hexdigest()[:16]


def quick_hash_file(path, block=QUICK_HASH_BLOCK):
    """Hash rapido de um arquivo em disco (so le o inicio e o fim)."""
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            head = f.read(block)
            f.seek(max(0, size - block))
            tail = f.read(block)
    except OSError:
        return ""
    return quick_hash_parts(size, head, tail)


def max_seq_in_folder(folder):
    """Maior numero de sequencia encontrado nas pastas de um lote."""
    biggest = 0
    try:
        for name in os.listdir(folder):
            if name.startswith("."):
                continue
            number = parse_seq_name(name)
            if number and number > biggest:
                biggest = number
    except OSError:
        pass
    return biggest


def lot_hash_from_items(items):
    """Hash curto do conteudo de um lote a partir de (nome, tamanho)."""
    if not items:
        return ""
    joined = "|".join(sorted(f"{str(n).lower()}:{int(s)}" for n, s in items))
    return hashlib.sha1(joined.encode("utf-8", "replace")).hexdigest()[:10].lower()


def make_lot_hash(items):
    """Hash de conteudo de um lote a partir de (nome, hash_do_arquivo).

    Mesmo conteudo = mesmo hash, em qualquer PC.
    """
    if not items:
        return ""
    joined = "|".join(sorted(f"{str(n).lower()}:{h}" for n, h in items))
    return hashlib.sha1(joined.encode("utf-8", "replace")).hexdigest()[:10].lower()


def lot_hash_from_dir(folder):
    """Hash de conteudo de um lote (usa o marcador; senao cai no hash antigo)."""
    marker = os.path.join(folder, DONE_MARKER)
    if os.path.isfile(marker):
        try:
            with open(marker, "r", encoding="utf-8") as f:
                value = json.load(f).get("hash", "")
            if value:
                return value
        except Exception:
            pass
    items = []
    try:
        for name in os.listdir(folder):
            if name.startswith("."):
                continue
            path = os.path.join(folder, name)
            if os.path.isfile(path):
                try:
                    items.append((name, os.path.getsize(path)))
                except OSError:
                    pass
    except OSError:
        pass
    return lot_hash_from_items(items)
