"""Download a pinned On-Fly-Jev snapshot; verify tensor-file SHA-256."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "vendor" / "onfly"
REPO = "Quazim0t0/On-Fly-Jev"
REVISION = "e11d5a2a328b34aab7956ae4891b6b34b98425b5"
FILES = ["README.md", "agent.py", "decision_core.py", "decision_config.json",
         "fly_trunk.py", "model.py", "config.py", "biolif.py", "fly100.py",
         "spikeattn.py", "engram.py", "dopamine.py", "upstream_lif.py",
         "normuon.py", "spike_tokenizer.py", "tokenizer.json", "fly100.json",
         "fly100.pt", "On-Fly-Jev.pt"]
HASHES = {
    "On-Fly-Jev.pt": "9e83bb449d9d4e98b8e035c8d518b0a9d6302413532bebcb5ce10982a1a43e2b",
    "fly100.pt": "1eece50950655756c94a1266f47d41b3ef9099b8ba039329aa86e562c295a432",
}

def sha256(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def download(name):
    path = DEST / name
    if path.exists() and name in HASHES and sha256(path) == HASHES[name]:
        print(f"Verified existing {name}", flush=True)
        return
    url = f"https://huggingface.co/{REPO}/resolve/{REVISION}/{name}"
    partial = path.with_suffix(path.suffix + ".part")
    with urllib.request.urlopen(url, timeout=60) as src, partial.open("wb") as dst:
        n, last = 0, 0
        while chunk := src.read(4 * 1024 * 1024):
            dst.write(chunk)
            n += len(chunk)
            if n - last >= 100 * 1024 * 1024:
                print(f"{name}: {n // 1024 // 1024} MB", flush=True)
                last = n
    if name in HASHES and sha256(partial) != HASHES[name]:
        raise RuntimeError(f"Checksum mismatch: {name}")
    partial.replace(path)
    print(f"Downloaded {name}", flush=True)

def main():
    DEST.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(download, FILES))
    # The upstream files use pickle loading; these checkpoints contain plain tensors
    # and dictionaries. Restrict their loaders to PyTorch's weights-only mode.
    for name in ("decision_core.py", "fly100.py"):
        p = DEST / name
        p.write_text(p.read_text().replace("weights_only=False", "weights_only=True"))
    (DEST / "snapshot.json").write_text(json.dumps({
        "repo": REPO, "revision": REVISION, "sha256": HASHES,
        "local_patch": "torch.load weights_only=True",
    }, indent=2) + "\n")

if __name__ == "__main__":
    main()
