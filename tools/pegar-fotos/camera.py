"""Deteccao e copia de fotos de cameras USB (WPD/MTP) no Windows.

A camera nao aparece como letra de drive: o Windows expoe o dispositivo pela
classe WPD. A deteccao usa SetupAPI (rapida, sem PowerShell) e a copia usa o
Shell COM (mesmo caminho do Explorer), porque a API WPD nativa exigiria
dependencias extras.
"""

import ctypes
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

WPD_CLASS_GUID = "{EEC5AD98-8080-425F-922A-DABF3DE3F69A}"
PHONE_RE = re.compile(
    r"android|iphone|ipad|galaxy|pixel|xiaomi|redmi|motorola|moto |samsung|smartphone|celular",
    re.IGNORECASE,
)


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", ctypes.c_ulong),
        ("Data2", ctypes.c_ushort),
        ("Data3", ctypes.c_ushort),
        ("Data4", ctypes.c_ubyte * 8),
    ]


class SP_DEVINFO_DATA(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_ulong),
        ("ClassGuid", GUID),
        ("DevInst", ctypes.c_ulong),
        ("Reserved", ctypes.c_void_p),
    ]


def _resource_dir():
    return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


def _script_path():
    return os.path.join(_resource_dir(), "camera_capture.ps1")


def _powershell():
    return shutil.which("powershell.exe") or "powershell.exe"


def _guid_from_string(text):
    guid = GUID()
    res = ctypes.windll.ole32.CLSIDFromString(text, ctypes.byref(guid))
    if res != 0:
        raise OSError("CLSIDFromString falhou: %s" % res)
    return guid


def _setupapi():
    api = ctypes.windll.setupapi
    api.SetupDiGetClassDevsW.restype = ctypes.c_void_p
    api.SetupDiGetClassDevsW.argtypes = [
        ctypes.POINTER(GUID), ctypes.c_wchar_p, ctypes.c_void_p, ctypes.c_ulong,
    ]
    api.SetupDiEnumDeviceInfo.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(SP_DEVINFO_DATA),
    ]
    api.SetupDiGetDeviceRegistryPropertyW.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(SP_DEVINFO_DATA), ctypes.c_ulong,
        ctypes.POINTER(ctypes.c_ulong), ctypes.c_void_p, ctypes.c_ulong,
        ctypes.POINTER(ctypes.c_ulong),
    ]
    api.SetupDiDestroyDeviceInfoList.argtypes = [ctypes.c_void_p]
    return api


def _device_property(api, devinfo, devdata, prop):
    regtype = ctypes.c_ulong()
    needed = ctypes.c_ulong()
    api.SetupDiGetDeviceRegistryPropertyW(
        devinfo, ctypes.byref(devdata), prop, ctypes.byref(regtype),
        None, 0, ctypes.byref(needed),
    )
    if not needed.value:
        return ""
    buf = ctypes.create_unicode_buffer(needed.value // 2 + 2)
    ok = api.SetupDiGetDeviceRegistryPropertyW(
        devinfo, ctypes.byref(devdata), prop, ctypes.byref(regtype),
        buf, ctypes.sizeof(buf), ctypes.byref(needed),
    )
    return buf.value if ok else ""


def list_wpd_devices():
    """Cameras/dispositivos WPD conectados, com FriendlyName."""
    try:
        api = _setupapi()
        guid = _guid_from_string(WPD_CLASS_GUID)
        handle = api.SetupDiGetClassDevsW(
            ctypes.byref(guid), None, None, 0x02  # DIGCF_PRESENT
        )
        if not handle or handle == ctypes.c_void_p(-1).value:
            return []
        devices = []
        try:
            index = 0
            while True:
                devdata = SP_DEVINFO_DATA()
                devdata.cbSize = ctypes.sizeof(SP_DEVINFO_DATA)
                if not api.SetupDiEnumDeviceInfo(handle, index, ctypes.byref(devdata)):
                    break
                name = _device_property(api, handle, devdata, 0x0C)  # FRIENDLYNAME
                desc = _device_property(api, handle, devdata, 0x00)  # DEVICEDESC
                label = (name or desc or "").strip()
                if label and not PHONE_RE.search(label):
                    devices.append({"name": label, "description": desc.strip()})
                index += 1
        finally:
            api.SetupDiDestroyDeviceInfoList(handle)
        return devices
    except Exception:
        return []


def _json_from_stdout(text):
    for line in reversed((text or "").splitlines()):
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                data = json.loads(line)
                if isinstance(data, dict):
                    return data
            except Exception:
                continue
    return None


def _run(mode, dest="", skip_keys=None, timeout=120):
    skip_path = ""
    try:
        if skip_keys:
            fd, skip_path = tempfile.mkstemp(prefix="natal_camera_", suffix=".json")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"keys": sorted(str(k) for k in skip_keys)}, f)
        args = [
            _powershell(), "-NoProfile", "-NonInteractive",
            "-ExecutionPolicy", "Bypass", "-File", _script_path(),
            "-Mode", mode, "-CameraOnly",
        ]
        if dest:
            args += ["-Dest", dest]
        if skip_path:
            args += ["-SkipFile", skip_path]
        flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
        proc = subprocess.run(
            args, capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=timeout, creationflags=flags,
        )
        data = _json_from_stdout(proc.stdout)
        if data is None:
            err = (proc.stderr or proc.stdout or "sem resposta do PowerShell").strip()
            raise RuntimeError(err[:500])
        if not data.get("ok") and not data.get("error"):
            data["error"] = (proc.stderr or "").strip()[:500]
        return data
    finally:
        if skip_path:
            try:
                os.remove(skip_path)
            except OSError:
                pass


def scan(skip_keys=None):
    return _run("list", skip_keys=skip_keys, timeout=120)


def capture(dest, skip_keys=None):
    return _run("copy", dest=dest, skip_keys=skip_keys, timeout=900)
