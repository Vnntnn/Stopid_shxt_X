"""Download pinned NeuroMechFly meshes and convert their articulated body to GLB.

Run with .venv/bin/python scripts/download_fly_model.py. Uses numpy and PyYAML
already present in the project environment; no Blender or physics engine needed.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
from pathlib import Path
import struct
import urllib.request

import numpy as np
import yaml

ROOT = Path(__file__).resolve().parents[1]
REVISION = "38c8ec61034cd59bc5ba0de20688d4a3c0000d60"
BASE = f"https://raw.githubusercontent.com/NeLy-EPFL/flygym/{REVISION}/"
MODEL = "src/flygym/assets/model/neuromechfly/"
CACHE = ROOT / ".runtime" / "fly-model-source"
OUTPUT = ROOT / "web" / "models" / "neuromechfly"
MANIFEST = Path(__file__).with_name("fly-model-sources.json")


def download(item):
    source, expected = item
    target = CACHE / source
    if target.is_file():
        data = target.read_bytes()
    else:
        with urllib.request.urlopen(BASE + source, timeout=60) as response:
            data = response.read()
    digest = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
    if digest != expected:
        raise ValueError(f"Source checksum mismatch: {source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


def multiply(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return np.array([aw*bw-ax*bx-ay*by-az*bz, aw*bx+ax*bw+ay*bz-az*by,
                     aw*by-ax*bz+ay*bw+az*bx, aw*bz+ax*by-ay*bx+az*bw])


def parent_of(name):
    if name == "c_thorax":
        return None
    if name == "c_head":
        return "c_thorax"
    if name.startswith("c_abdomen"):
        return {"c_abdomen12": "c_thorax", "c_abdomen3": "c_abdomen12"}.get(
            name, f"c_abdomen{int(name[-1])-1}")
    side, link = name.split("_")
    if len(side) == 2:
        chain = ["coxa", "trochanterfemur", "tibia", "tarsus1", "tarsus2",
                 "tarsus3", "tarsus4", "tarsus5"]
        index = chain.index(link)
        return "c_thorax" if index == 0 else f"{side}_{chain[index-1]}"
    return {"rostrum": "c_head", "haustellum": "c_rostrum", "eye": "c_head",
            "pedicel": "c_head", "funiculus": f"{side}_pedicel",
            "arista": f"{side}_funiculus", "wing": "c_thorax", "haltere": "c_thorax"}[link]


def build():
    rig = yaml.safe_load((CACHE / MODEL / "rigging.yaml").read_text())
    pose = yaml.safe_load((CACHE / MODEL / "pose/neutral/yaw_pitch_roll.yaml").read_text())
    materials = [
        {"name": "Cuticle", "pbrMetallicRoughness": {"baseColorFactor": [0.32, 0.19, 0.075, 1], "metallicFactor": 0.05, "roughnessFactor": 0.65}},
        {"name": "Compound eyes", "pbrMetallicRoughness": {"baseColorFactor": [0.67, 0.075, 0.035, 1], "metallicFactor": 0, "roughnessFactor": 0.4}},
        {"name": "Wing membrane", "pbrMetallicRoughness": {"baseColorFactor": [0.8, 0.85, 0.9, 0.38], "metallicFactor": 0, "roughnessFactor": 0.35}, "alphaMode": "BLEND", "doubleSided": True},
        {"name": "Abdomen bands", "pbrMetallicRoughness": {"baseColorFactor": [0.14, 0.075, 0.025, 1], "metallicFactor": 0, "roughnessFactor": 0.7}},
    ]
    doc = {"asset": {"version": "2.0", "generator": "Fly Ask NeuroMechFly converter",
                     "copyright": "NeLy-EPFL / NeuroMechFly contributors, Apache-2.0"},
           "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [], "meshes": [],
           "materials": materials, "buffers": [], "bufferViews": [], "accessors": []}
    binary = bytearray()

    def accessor(values, kind, component=5126):
        data = values.tobytes()
        view = len(doc["bufferViews"])
        doc["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(data)})
        binary.extend(data)
        binary.extend(b"\0" * (-len(binary) % 4))
        record = {"bufferView": view, "componentType": component, "count": len(values), "type": kind}
        if kind == "VEC3":
            record.update(min=values.min(axis=0).tolist(), max=values.max(axis=0).tolist())
        doc["accessors"].append(record)
        return len(doc["accessors"])-1

    names = list(rig)
    # Convert the source's +X forward / +Z up to Three.js +Z forward / +Y up.
    doc["nodes"].append({"name": "NeuroMechFly", "rotation": [0.5, 0.5, 0.5, -0.5], "children": [1]})
    lookup = {name: i+1 for i, name in enumerate(names)}
    total_faces = 0
    for name, params in rig.items():
        source_name = "l" + name[1:] if name.startswith("r") else name
        data = (CACHE / MODEL / "meshes/simplified_max2000faces" / f"{source_name}.stl").read_bytes()
        count = struct.unpack_from("<I", data, 80)[0]
        if len(data) != 84 + 50*count:
            raise ValueError(f"Invalid binary STL: {source_name}")
        faces = np.ndarray(count, dtype=np.dtype([("normal", "<f4", (3,)), ("vertices", "<f4", (3, 3)), ("attribute", "<u2")]), buffer=data, offset=84)["vertices"].copy() * 1000
        if name.startswith("r"):
            faces[:, :, 1] *= -1
            faces = faces[:, [0, 2, 1], :]
        vertices, indices = np.unique(faces.reshape(-1, 3), axis=0, return_inverse=True)
        normals = np.zeros_like(vertices)
        face_normals = np.cross(faces[:, 1]-faces[:, 0], faces[:, 2]-faces[:, 0])
        np.add.at(normals, indices, np.repeat(face_normals, 3, axis=0))
        normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
        mat = 1 if name.endswith("_eye") else 2 if name.endswith("_wing") else 3 if name in ("c_abdomen3", "c_abdomen5", "c_abdomen6") else 0
        mesh = len(doc["meshes"])
        doc["meshes"].append({"name": name, "primitives": [{"attributes": {
            "POSITION": accessor(vertices.astype("<f4"), "VEC3"),
            "NORMAL": accessor(normals.astype("<f4"), "VEC3")},
            "indices": accessor(indices.astype("<u2"), "SCALAR", 5123), "material": mat}]})
        parent = parent_of(name)
        quat = np.array(params["quat"], dtype=float)
        # Apply the upstream standing pose in its yaw/pitch/roll joint order.
        if len(name.split("_")[0]) == 2:
            left = "l" + name[1:]
            left_parent = parent_of(left)
            for axis, idx in (("yaw", 1), ("pitch", 2), ("roll", 3)):
                angle = math.radians(pose["joint_angles"].get(f"{left_parent}-{left}-{axis}", 0))
                if name.startswith("r") and axis != "pitch":
                    angle = -angle
                delta = np.zeros(4)
                delta[0], delta[idx] = math.cos(angle/2), math.sin(angle/2)
                quat = multiply(quat, delta)
        quat /= np.linalg.norm(quat)
        translation = params["pos"] if parent else [0, 0, 0]
        node = {"name": name, "mesh": mesh, "translation": translation,
                "rotation": quat[[1, 2, 3, 0]].tolist()}
        children = [lookup[n] for n in names if parent_of(n) == name]
        if children:
            node["children"] = children
        doc["nodes"].append(node)
        total_faces += count
    doc["buffers"] = [{"byteLength": len(binary)}]
    encoded = json.dumps(doc, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    glb = struct.pack("<III", 0x46546C67, 2, 28+len(encoded)+len(binary))
    glb += struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
    glb += struct.pack("<II", len(binary), 0x004E4942) + binary
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "fly.glb").write_bytes(glb)
    (OUTPUT / "LICENSE").write_bytes((CACHE / "LICENSE").read_bytes())
    (OUTPUT / "source.json").write_text(json.dumps({"repository": "https://github.com/NeLy-EPFL/flygym",
        "revision": REVISION, "license": "Apache-2.0", "segments": len(rig), "triangles": total_faces,
        "sha256": hashlib.sha256(glb).hexdigest(), "bytes": len(glb)}, indent=2) + "\n")
    print(f"Built {OUTPUT / 'fly.glb'}: {len(rig)} segments, {total_faces:,} triangles, {len(glb):,} bytes")


if __name__ == "__main__":
    sources = json.loads(MANIFEST.read_text())
    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(download, sources.items()))
    build()
