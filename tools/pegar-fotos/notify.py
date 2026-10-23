import os
import winsound

try:
    from winotify import Notification
    HAS_WINOTIFY = True
except Exception:
    HAS_WINOTIFY = False

APP_ID = "NatalFotoImport"
APP_NAME = "Natal Foto Import"
_ENABLED = True


def set_enabled(value):
    """Liga/desliga os toasts (modo quiosque sem aviso do Windows)."""
    global _ENABLED
    _ENABLED = bool(value)


def _icon_path():
    try:
        from shared import RESOURCE_DIR
        path = os.path.join(RESOURCE_DIR, "natal_icon.png")
        if os.path.isfile(path):
            return os.path.abspath(path)
    except Exception:
        pass
    return ""


def register_app_id():
    """Registra o AppUserModelID no HKCU (sem admin) para o toast sair com
    o nome e o icone do app, em vez de aparecer como PowerShell."""
    try:
        import winreg
        icon = _icon_path()
        key = winreg.CreateKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Classes\AppUserModelId\%s" % APP_ID
        )
        winreg.SetValueEx(key, "DisplayName", 0, winreg.REG_SZ, APP_NAME)
        if icon:
            winreg.SetValueEx(key, "IconUri", 0, winreg.REG_SZ, icon)
        winreg.CloseKey(key)
        return True
    except Exception:
        return False


def toast(title, message, folder=None, on_fallback=None):
    """Notificacao nativa do Windows (tipo pop de pendrive).

    Retorna True se o toast foi exibido, False se caiu no fallback.
    """
    icon = _icon_path()
    if not _ENABLED:
        return False
    if HAS_WINOTIFY:
        try:
            note = Notification(app_id=APP_ID, title=title, msg=message, icon=icon or None)
            if folder:
                try:
                    target = "file:///" + os.path.abspath(folder).replace("\\", "/").replace(" ", "%20")
                    note.add_actions(label="Abrir pasta", launch=target)
                except Exception:
                    pass
            note.show()
            return True
        except Exception:
            pass

    try:
        winsound.MessageBeep(winsound.MB_ICONASTERISK)
    except Exception:
        pass
    if on_fallback:
        try:
            on_fallback(title, message)
        except Exception:
            pass
    return False
