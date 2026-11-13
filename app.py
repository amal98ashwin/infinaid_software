"""One isolated, request-scoped EEG workflow per execution."""
import base64
import csv
import io
import json
import re
import tempfile
from graphlib import TopologicalSorter
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from flask import Flask, abort, jsonify, request
from scipy.io import loadmat
from werkzeug.exceptions import HTTPException

import functions as eeg

app = Flask(__name__, static_folder="static", static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 128 * 1024**2
schema = json.loads(Path("static/defaults.json").read_text())


@app.get("/")
def home():
    return app.send_static_file("index.html")


def save_inputs(key, folder):
    recordings = []
    for upload in request.files.getlist(key):
        name = upload.filename or ""
        if not name or Path(name).name != name or re.search(r'[\\/:\x00]', name):
            raise ValueError("Invalid recording filename")
        path = folder / name
        if path.exists():
            raise ValueError("Duplicate filename")
        upload.save(path)
        recordings.append(path)
    return recordings


def load_recording(node, files):
    ext = "." + node.name.split()[-1].lower()
    primary = [f for f in files if f.suffix.lower() == ext]
    if len(primary) != 1:
        raise ValueError("Choose one " + ext + " recording for this loader")
    path = primary[0]
    if ext == ".set":
        # Check EEGLAB's external sample reference before handing it to MNE.
        mat = loadmat(path, simplify_cells=True)
        data = mat.get("EEG", mat).get("data")
        if isinstance(data, str):
            if data not in {f.name for f in files if f.suffix.lower() == ".fdt"}:
                raise ValueError("Select the matching .fdt sidecar with the .set file")
        elif not isinstance(data, np.ndarray) or data.dtype.kind not in 'fiu':
            raise ValueError("Expected continuous numeric EEGLAB data or an uploaded FDT")
    if ext == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            names = [c for c in reader.fieldnames or [] if c.lower() not in ("time","timestamp","time_s")]
            samples = np.array([[float(row[c]) for c in names] for row in reader])
        if not np.isfinite(samples).all():
            raise ValueError("CSV contains non-finite samples")
        scale = 1 if node.params["unit"] == "V" else 1e-6
        node.raw = eeg.create_eeg_raw(samples.T * scale, names, node.params["sfreq"])
    else:
        node.params["filename"] = str(path)
        eeg.process_node(node)


def describe(node):
    result = {}
    if node.raw is not None:
        raw = node.raw
        idx = np.linspace(0, raw.n_times - 1, min(raw.n_times, 1200), dtype=int)
        result["signal"] = {"channels":raw.ch_names, "times":raw.times[idx].tolist(),
                            "values":raw._data[:, idx].tolist(), "sfreq":raw.info["sfreq"],
                            "samples":raw.n_times, "bads":raw.info["bads"]}
    if node.features:
        result["features"] = {k: v.tolist() for k,v in node.features["features"].items()}
        result["times"] = node.features["times"].tolist()
    if node.ica is not None:
        result["components"] = [{"index":i,"label":str(label),"probabilities":p.tolist(),
                                 "remove":i in node.ica_exclude}
            for i,(label,p) in enumerate(zip(node.ica_labels,node.ica_probabilities))]
    if node.name == "Correlation":
        result["r"] = node.correlation
    return result


@app.post("/api/streams")
def streams():
    with tempfile.TemporaryDirectory() as tmp:
        files = save_inputs("file", Path(tmp))
        if len(files) != 1 or files[0].suffix.lower() != ".xdf":
            abort(400, "Select one XDF file")
        return jsonify(eeg.get_xdf_streams(str(files[0]))[1])


@app.post("/api/run")
def execute():
    graph = json.loads(request.form["graph"])
    items = graph["nodes"]
    if not 0 < len(items) <= 100:
        abort(400, "Choose a workflow with 1–100 nodes")
    nodes = {}
    parents = {}
    for item in items:
        key, name = item["id"], item["name"]
        if not re.fullmatch(r'n[0-9]+', key) or key in nodes or name not in schema:
            abort(400, "Invalid workflow node")
        params = {k:item.get("params",{}).get(k,v) for k,v in schema[name].items() if k != "filename"}
        if name == "ICA":
            params["exclude"] = item.get("params",{}).get("exclude")
        nodes[key] = SimpleNamespace(name=name,params=params,raw=None,features=None,ica=None)
        parents[key] = []
    for edge in graph["edges"]:
        source, target = edge["from"], edge["to"]
        if source not in nodes or target not in nodes or source in parents[target]:
            abort(400, "Invalid connection")
        parents[target].append(source)
    results = {}
    downloads = []
    with tempfile.TemporaryDirectory() as tmp:
        for key in TopologicalSorter(parents).static_order():
            node = nodes[key]
            node.in_nodes = [nodes[i] for i in parents[key]]
            node.in_node = next(iter(node.in_nodes), None)
            folder = Path(tmp, key)
            folder.mkdir()
            try:
                if node.name.startswith("Load "):
                    if node.in_nodes:
                        raise ValueError("A loader cannot accept an incoming connection")
                    load_recording(node, save_inputs(key, folder))
                else:
                    count = len(node.in_nodes)
                    if (node.name == "Correlation" and count != 2 or
                        node.name == "Export Table" and count < 1 or
                        node.name not in ("Correlation","Export Table") and count != 1):
                        raise ValueError("Check the number of incoming connections")
                    if node.name in ("Export Table","Save SET"):
                        out = folder / ("features.csv" if node.name == "Export Table" else "processed.set")
                        node.params["filename"] = str(out)
                    eeg.process_node(node)
                    if node.name == "ICA" and node.params["exclude"] is not None:
                        indices = node.params["exclude"]
                        if any(type(i) is not int or not 0 <= i < node.ica.n_components_ for i in indices):
                            raise ValueError("Invalid ICA exclusion index")
                        node.ica_exclude = indices
                    if node.name in ("Export Table","Save SET"):
                        for file in folder.iterdir():
                            downloads.append({"name":key+"-"+file.name,"data":base64.b64encode(file.read_bytes()).decode()})
                results[key] = describe(node)
            except Exception as exc:
                return jsonify(error=f"{node.name} ({key}): {exc}"), 422
    return jsonify(results=results, downloads=downloads)


@app.errorhandler(Exception)
def failure(exc):
    return jsonify(error=str(exc)), exc.code if isinstance(exc, HTTPException) else 400
