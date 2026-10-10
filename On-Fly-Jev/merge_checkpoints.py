"""Plain average of two decision checkpoints from ONE lineage (README: unrelated runs collapse).

./venv/bin/python merge_checkpoints.py NEW.pt ORIGINAL.pt OUT.pt [alpha=0.5]   # alpha = weight of NEW
"""
import os
import sys

import torch


def merge(a, b, out, alpha=0.5):
    if not 0.0 <= alpha <= 1.0:
        raise ValueError("alpha must be in [0, 1], got %r" % (alpha,))
    ca = torch.load(a, map_location="cpu", weights_only=False)
    sa, sb = ca["model_state"], torch.load(b, map_location="cpu", weights_only=False)["model_state"]
    if sa.keys() != sb.keys():
        raise ValueError("checkpoints have different parameters")
    bad = [k for k in sa if sa[k].shape != sb[k].shape]
    if bad:
        raise ValueError("checkpoints differ in parameter shape: %s" % ", ".join(bad[:5]))
    ca["model_state"] = {k: (alpha * sa[k].float() + (1 - alpha) * sb[k].float()).to(sa[k].dtype)
                         if sa[k].is_floating_point() else sa[k] for k in sa}
    tmp = out + ".tmp"
    try:
        torch.save(ca, tmp)
        os.replace(tmp, out)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


if __name__ == "__main__":
    merge(sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]) if len(sys.argv) > 4 else 0.5)
