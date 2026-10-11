"""Prepare Schmoldt5000's downloaded Housefly glTF for the Fly Ask scene.

Usage: .venv/bin/python scripts/import_housefly.py /path/to/housefly
Preserves UVs, normals, tangents, and textures. Removes the display pedestal,
separates disconnected anatomical parts, and adds rigid animation pivots.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import shutil
import struct

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "web/models/housefly"
SOURCE = "https://sketchfab.com/3d-models/housefly-5fe7cbd25f9a446d8bae005893d010dd"


def components(positions, triangles):
    _, inverse = np.unique(np.round(positions, 4), axis=0, return_inverse=True)
    welded = inverse[triangles]
    parents = list(range(int(inverse.max()) + 1))

    def root(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    for a, b, c in welded:
        parents[root(b)] = root(a)
        parents[root(c)] = root(a)
    labels = np.array([root(a) for a in welded[:, 0]])
    return [np.flatnonzero(labels == label) for label in np.unique(labels)]


def body_part(vertices):
    x, y, z = vertices.mean(axis=0)
    side = "l" if x > 0 else "r"
    if z > 24 and abs(x) < 10 and y > 12:
        return "head"
    if y < 10 and abs(x) > 10:
        leg = "m" if abs(x) > 20 else "f" if z > 0 else "h"
        return f"{side}{leg}_lower"
    if z > 14 and y < 20:
        return f"{side}f_" + ("upper" if z < 24 else "lower")
    if abs(x) > 9 and y < 23:
        leg = "m" if z > 3 else "h"
        return f"{side}{leg}_" + ("upper" if abs(x) < 13 else "lower")
    return "body"


def build(source):
    source_doc = json.loads((source / "scene.gltf").read_text())
    if source_doc.get("asset", {}).get("extras", {}).get("source") != SOURCE:
        raise ValueError("This importer expects Schmoldt5000's Housefly download.")
    source_data = (source / source_doc["buffers"][0]["uri"]).read_bytes()

    def read(index):
        accessor = source_doc["accessors"][index]
        view = source_doc["bufferViews"][accessor["bufferView"]]
        dtype = np.dtype({5126: "<f4", 5123: "<u2", 5125: "<u4"}[accessor["componentType"]])
        width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
        offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        return np.ndarray((accessor["count"], width), dtype=dtype, buffer=source_data,
                          offset=offset, strides=(view.get("byteStride", width*dtype.itemsize), dtype.itemsize)).copy()

    # The downloaded Fly.fbx transforms cancel; its vertices are +Y up, +Z forward.
    primitives = [mesh["primitives"][0] for mesh in source_doc["meshes"][:3]]
    arrays = [{key: read(index) for key, index in p["attributes"].items()} for p in primitives]
    triangles = [read(p["indices"]).reshape(-1, 3) for p in primitives]
    positions = arrays[0]["POSITION"]
    assignments = []
    nearest_labels = np.empty(len(positions), dtype=object)
    body_groups = {}
    for ids in components(positions, triangles[0]):
        vertices = np.unique(triangles[0][ids])
        name = body_part(positions[vertices])
        nearest_labels[vertices] = name
        body_groups.setdefault(name, []).extend(ids.tolist())
    assignments.append(body_groups)

    # Hair cards follow their nearest anatomical surface, including moving legs.
    hair_groups = {}
    for ids in components(arrays[1]["POSITION"], triangles[1]):
        center = arrays[1]["POSITION"][np.unique(triangles[1][ids])].mean(axis=0)
        nearest = np.argmin(np.sum((positions - center)**2, axis=1))
        hair_groups.setdefault(nearest_labels[nearest], []).extend(ids.tolist())
    assignments.append(hair_groups)
    assignments.append({f"{side}_wing": np.flatnonzero(
        (arrays[2]["POSITION"][triangles[2]].mean(axis=1)[:, 0] > 0) == (side == "l"))
        for side in ["l", "r"]})

    center = np.array([0, 24, 4], dtype=float)
    all_positions = np.concatenate([a["POSITION"] for a in arrays])
    scale = 3 / np.ptp(all_positions[:, 2])
    pivots = {"body": center, "head": np.array([0, 20.5, 24]),
              "l_wing": np.array([6.8, 25.5, 7]), "r_wing": np.array([-6.8, 25.5, 7])}
    for side, sign in [("l", 1), ("r", -1)]:
        for leg, upper, lower in [("f", [3.8, 17.5, 16], [13.3, 12, 26]),
                                  ("m", [3, 20, 6], [16.5, 13, 8]),
                                  ("h", [3, 19, -4], [15.1, 19.5, -13.7])]:
            pivots[f"{side}{leg}_upper"] = np.array(upper) * [sign, 1, 1]
            pivots[f"{side}{leg}_lower"] = np.array(lower) * [sign, 1, 1]
    required = set(pivots)
    assigned = set().union(*(set(a) for a in assignments))
    if assigned != required:
        raise ValueError(f"Unexpected anatomical groups: {assigned ^ required}")

    doc = {"asset": copy.deepcopy(source_doc["asset"]), "scene": 0, "scenes": [{"nodes": [0]}],
           "nodes": [{"name": "Housefly", "children": []}], "meshes": [], "accessors": [],
           "bufferViews": [], "buffers": [], "materials": copy.deepcopy(source_doc["materials"][:3]),
           "textures": copy.deepcopy(source_doc["textures"][:6]), "images": copy.deepcopy(source_doc["images"][:6]),
           "samplers": copy.deepcopy(source_doc.get("samplers", [])),
           "extensionsUsed": copy.deepcopy(source_doc.get("extensionsUsed", []))}
    doc["asset"]["generator"] = "Fly Ask Housefly importer (from Sketchfab glTF)"
    binary = bytearray()

    def accessor(values, kind, component=5126):
        values = values.astype("<u2" if component == 5123 else "<f4")
        view = len(doc["bufferViews"])
        doc["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": values.nbytes})
        binary.extend(values.tobytes())
        binary.extend(b"\0" * (-len(binary) % 4))
        record = {"bufferView": view, "componentType": component, "count": len(values), "type": kind}
        if kind == "VEC3":
            record.update(min=values.min(axis=0).tolist(), max=values.max(axis=0).tolist())
        doc["accessors"].append(record)
        return len(doc["accessors"])-1

    lookup = {}
    for name, pivot in pivots.items():
        parent = name.replace("lower", "upper") if name.endswith("_lower") else None
        relative_to = pivots[parent] if parent else center
        index = len(doc["nodes"])
        lookup[name] = index
        doc["nodes"].append({"name": name, "translation": ((pivot-relative_to)*scale).tolist(), "children": []})
        doc["nodes"][lookup[parent] if parent else 0]["children"].append(index)
    for material, groups in enumerate(assignments):
        for name, ids in groups.items():
            selected = triangles[material][ids]
            vertices, indices = np.unique(selected, return_inverse=True)
            indices = indices.reshape(-1)
            attrs = {}
            for key, values in arrays[material].items():
                data = values[vertices]
                if key == "POSITION":
                    data = (data-pivots[name])*scale
                attrs[key] = accessor(data, {2: "VEC2", 3: "VEC3", 4: "VEC4"}[data.shape[1]])
            mesh = len(doc["meshes"])
            doc["meshes"].append({"name": name, "primitives": [{"attributes": attrs,
                "indices": accessor(indices, "SCALAR", 5123), "material": material}]})
            index = len(doc["nodes"])
            doc["nodes"].append({"name": f"{name}_{'hair' if material == 1 else 'surface'}", "mesh": mesh})
            doc["nodes"][lookup[name]]["children"].append(index)
    doc["buffers"] = [{"byteLength": len(binary)}]
    encoded = json.dumps(doc, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    glb = struct.pack("<III", 0x46546C67, 2, 28+len(encoded)+len(binary))
    glb += struct.pack("<II", len(encoded), 0x4E4F534A)+encoded
    glb += struct.pack("<II", len(binary), 0x004E4942)+binary
    OUTPUT.mkdir(parents=True, exist_ok=True)
    (OUTPUT / "fly.glb").write_bytes(glb)
    for image in doc["images"]:
        target = OUTPUT / image["uri"]
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / image["uri"], target)
    shutil.copyfile(source / "license.txt", OUTPUT / "LICENSE.txt")
    files = ["fly.glb", "LICENSE.txt", *(image["uri"] for image in doc["images"])]
    metadata = {"source": SOURCE, "author": source_doc["asset"]["extras"]["author"], "license": "CC-BY-4.0",
                "triangles": sum(len(t) for t in triangles), "pivots": len(pivots),
                "source_sha256": hashlib.sha256((source / "scene.gltf").read_bytes()+source_data).hexdigest(),
                "files": {name: {"bytes": (OUTPUT/name).stat().st_size,
                    "sha256": hashlib.sha256((OUTPUT/name).read_bytes()).hexdigest()} for name in files}}
    (OUTPUT / "source.json").write_text(json.dumps(metadata, indent=2)+"\n")
    print(f"Imported Housefly: {metadata['triangles']:,} triangles, {len(pivots)} animation pivots, "
          f"{sum(v['bytes'] for v in metadata['files'].values()):,} bytes including textures")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    build(parser.parse_args().source)
