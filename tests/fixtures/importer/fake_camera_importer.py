import json
import os
import runpy
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
APP_DIR = ROOT / "tools" / "pegar-fotos"
sys.path.insert(0, str(APP_DIR))

import camera

DEVICES = json.loads(os.environ.get("NATAL_FAKE_CAMERA_DEVICES", "[]") or "[]")
SOURCE = Path(os.environ.get("NATAL_FAKE_CAMERA_SOURCE", "") or "")
ERROR = os.environ.get("NATAL_FAKE_CAMERA_ERROR", "")
DATE = os.environ.get("NATAL_FAKE_CAMERA_DATE", "2026-01-01 00:00:00")
DEVICE_NAME = os.environ.get("NATAL_FAKE_CAMERA_NAME", "Canon EOS REBEL T5")


def _device_name():
    if DEVICES and isinstance(DEVICES[0], dict):
        return str(DEVICES[0].get("name") or DEVICE_NAME)
    return DEVICE_NAME


def _source_files():
    if not SOURCE.is_dir():
        return []
    return sorted(p for p in SOURCE.iterdir() if p.is_file())


def _key(path):
    return "%s|%s|%s|%s" % (_device_name(), path.name, path.stat().st_size, DATE)


def _info(path):
    return {
        "key": _key(path),
        "name": path.name,
        "size": path.stat().st_size,
        "date": DATE,
        "device": _device_name(),
    }


def list_wpd_devices():
    if ERROR == "list" or not DEVICES:
        return []
    return [{"name": _device_name(), "description": "Fake WPD camera"}]


def scan(skip_keys=None):
    if ERROR == "scan":
        raise RuntimeError("fake camera scan failure")
    skip = set(str(k) for k in (skip_keys or []))
    files = [p for p in _source_files() if _key(p) not in skip]
    devices = [d.get("name") or DEVICE_NAME for d in DEVICES if isinstance(d, dict)]
    return {
        "ok": True,
        "mode": "list",
        "cameras": devices,
        "total": len(_source_files()),
        "newCount": len(files),
        "files": [_info(p) for p in files],
    }


def capture(dest, skip_keys=None):
    if ERROR == "capture":
        return {
            "ok": False,
            "mode": "copy",
            "error": "fake camera capture failure",
            "cameras": [_device_name()],
            "copied": 0,
            "files": [],
            "errors": [],
        }
    skip = set(str(k) for k in (skip_keys or []))
    files = [p for p in _source_files() if _key(p) not in skip]
    copied = []
    errors = []
    root = Path(dest)
    root.mkdir(parents=True, exist_ok=True)
    for index, path in enumerate(files, 1):
        slot = root / ("f%04d" % index)
        slot.mkdir(parents=True, exist_ok=True)
        target = slot / path.name
        try:
            shutil.copy2(path, target)
            copied.append({
                "key": _key(path),
                "name": path.name,
                "path": str(target),
                "size": target.stat().st_size,
                "device": _device_name(),
            })
        except OSError:
            errors.append(path.name)
    return {
        "ok": not errors,
        "mode": "copy",
        "cameras": [_device_name()],
        "copied": len(copied),
        "files": copied,
        "errors": errors,
    }


camera.list_wpd_devices = list_wpd_devices
camera.scan = scan
camera.capture = capture

runpy.run_path(str(APP_DIR / "app.py"), run_name="__main__")
