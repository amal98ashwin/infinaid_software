"""Exercise the web entry point and Python feature export with synthetic data."""
import io
import json
import math
from app import app

names = ["Load CSV", "Bandpass Filter", "Power Feature Extraction", "Export Table"]
graph = {
    "nodes": [{"id": f"n{i}", "name": name, "params": {}} for i, name in enumerate(names)],
    "edges": [{"from": f"n{i}", "to": f"n{i+1}"} for i in range(3)],
}
samples = "Fp1,Fp2\n" + "".join(
    f"{math.sin(2*math.pi*10*i/256)},{math.sin(2*math.pi*9*i/256)}\n" for i in range(2048)
)
with app.test_client() as client:
    assert client.get("/", headers={"Host":"127.0.0.1:47391"}).status_code == 200
    response = client.post("/api/run", headers={"Origin":"http://127.0.0.1:47391","Host":"127.0.0.1:47391"}, data={
        "graph": json.dumps(graph), "n0": (io.BytesIO(samples.encode()), "synthetic.csv"),
    })
    assert response.status_code == 200, response.get_data(as_text=True)
    result = response.get_json()
    assert len(result["results"]["n2"]["features"]) == 2 and result["downloads"]
    print("CSV → filter → Python band power → CSV export passed")
