"""Run on the target operating system with requirements and PyInstaller installed."""
import platform
import subprocess
import sys
from pathlib import Path
import PyInstaller.__main__

is_mac = sys.platform == "darwin"
if not is_mac and sys.platform != "win32":
    raise SystemExit("Build on Windows or macOS")
name = "Infinaid EEG Studio" if is_mac else "Infinaid-EEG-Studio"
options = ["--clean","--noconfirm","--name", name, "--add-data","static:static",
           "--hidden-import","smoke","--hidden-import","sklearn.decomposition",
           "--recursive-copy-metadata","mne-icalabel"]
for package in ("mne","mne_icalabel","onnxruntime","eeglabio","pyxdf","lazy_loader"):
    options.extend(["--collect-all",package])
if is_mac:
    options += ["--onedir","--windowed","--osx-bundle-identifier","in.infinaid.eegstudio"]
else:
    options += ["--onefile","--console"]
PyInstaller.__main__.run(options+["launch.py"])
out = Path("release")
out.mkdir(exist_ok=True)
if is_mac:
    bundle = Path("dist",name+".app")
    subprocess.run([str(bundle/"Contents/MacOS"/name),"--smoke"],check=True)
    arch=platform.machine()
    subprocess.run(["ditto","-c","-k","--sequesterRsrc","--keepParent",str(bundle),
                    str(out/f"Infinaid-EEG-Studio-macOS-{arch}.zip")],check=True)
else:
    exe=Path("dist",name+".exe")
    subprocess.run([str(exe),"--smoke"],check=True)
    exe.replace(out/exe.name)
