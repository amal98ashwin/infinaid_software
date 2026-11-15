"""Run the editor and EEG worker exclusively on this PC."""
import os
import secrets
import sys
import webbrowser
from pathlib import Path
from urllib.request import build_opener, ProxyHandler
from werkzeug.serving import make_server

os.chdir(Path(__file__).resolve().parent)
from flask import abort, request
from app import app

port = 47391
host = f"127.0.0.1:{port}"
origin = f"http://{host}"
identity = "Infinaid-EEG-Local-v1"
app.config["TRUSTED_HOSTS"] = ["127.0.0.1"]

@app.before_request
def local_only():
    if request.host != host:
        abort(403)
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("Origin") != origin:
        abort(403)

@app.get("/local-identity")
def local_identity():
    return identity

def main():
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        user32.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR,
                                     wintypes.UINT, ctypes.c_int, ctypes.c_int, wintypes.UINT]
        user32.LoadImageW.restype = wintypes.HANDLE
        ctypes.windll.kernel32.GetConsoleWindow.restype = wintypes.HWND
        user32.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT,
                                       wintypes.WPARAM, wintypes.LPARAM]
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Infinaid.EEGStudio.Desktop")
        icon = user32.LoadImageW(None, str(Path(__file__).parent / "static" / "infinaid.ico"),
                                1, 0, 0, 0x10 | 0x40)
        window = ctypes.windll.kernel32.GetConsoleWindow()
        if icon and window:
            user32.SendMessageW(window, 0x80, 0, icon)
            user32.SendMessageW(window, 0x80, 1, icon)
        ctypes.windll.kernel32.SetConsoleTitleW("Infinaid EEG Studio")
    try:
        with build_opener(ProxyHandler({})).open(origin + "/local-identity", timeout=1) as response:
            if response.read(64).decode() == identity:
                webbrowser.open(origin)
                return
    except OSError:
        pass
    try:
        server = make_server("127.0.0.1", port, app)
    except (OSError, SystemExit):
        input(f"Port {port} is in use. Close the conflicting program and retry. Press Enter to exit.")
        return
    print("EEG Studio is running on this PC. Close this window to stop it.", flush=True)
    webbrowser.open(origin)
    server.serve_forever()

if __name__ == "__main__":
    import multiprocessing
    multiprocessing.freeze_support()
    if "--smoke" in sys.argv:
        import smoke
    else:
        main()
