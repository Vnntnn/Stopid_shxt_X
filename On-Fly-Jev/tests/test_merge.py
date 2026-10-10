import os

import pytest
import torch

import merge_checkpoints
from merge_checkpoints import merge


def test_merge_averages_floats_and_keeps_ints(tmp_path):
    a = {"kind": "spike_decision", "lm_config": {"d": 1}, "decision_cfg": {"max_len": 7, "data_license": "local only"},
         "model_state": {"w": torch.tensor([0.0, 2.0]), "n": torch.tensor([3])}}
    b = {"kind": "other", "lm_config": {"d": 2}, "decision_cfg": {"max_len": 9},
         "model_state": {"w": torch.tensor([2.0, 4.0]), "n": torch.tensor([9])}}
    torch.save(a, tmp_path / "a.pt")
    torch.save(b, tmp_path / "b.pt")
    merge(str(tmp_path / "a.pt"), str(tmp_path / "b.pt"), str(tmp_path / "o.pt"))
    out = torch.load(tmp_path / "o.pt", weights_only=False)
    o = out["model_state"]
    assert o["w"].tolist() == [1.0, 3.0] and o["n"].tolist() == [3]
    # every non-model_state key comes from the FIRST checkpoint
    assert out["kind"] == "spike_decision" and out["lm_config"] == {"d": 1} and out["decision_cfg"] == {"max_len": 7, "data_license": "local only"}


def ckpt(tmp_path, name, **state):
    torch.save({"model_state": state}, tmp_path / name)
    return str(tmp_path / name)


def test_key_mismatch_raises_value_error(tmp_path):
    a, b = ckpt(tmp_path, "a.pt", w=torch.zeros(2)), ckpt(tmp_path, "b.pt", v=torch.zeros(2))
    with pytest.raises(ValueError, match="different parameters"):
        merge(a, b, str(tmp_path / "o.pt"))
    assert not os.path.exists(tmp_path / "o.pt")


def test_broadcastable_shape_mismatch_raises(tmp_path):
    a, b = ckpt(tmp_path, "a.pt", w=torch.zeros(1, 3)), ckpt(tmp_path, "b.pt", w=torch.zeros(4, 3))
    with pytest.raises(ValueError, match="shape"):
        merge(a, b, str(tmp_path / "o.pt"))
    assert not os.path.exists(tmp_path / "o.pt")


@pytest.mark.parametrize("alpha", [-0.1, 1.5, float("nan")])
def test_alpha_out_of_range_raises(tmp_path, alpha):
    a = ckpt(tmp_path, "a.pt", w=torch.zeros(2))
    with pytest.raises(ValueError, match="alpha"):
        merge(a, a, str(tmp_path / "o.pt"), alpha=alpha)


def test_alpha_endpoints_are_allowed(tmp_path):
    a, b = ckpt(tmp_path, "a.pt", w=torch.tensor([0.0])), ckpt(tmp_path, "b.pt", w=torch.tensor([4.0]))
    merge(a, b, str(tmp_path / "o0.pt"), alpha=0.0)
    merge(a, b, str(tmp_path / "o1.pt"), alpha=1.0)
    assert torch.load(tmp_path / "o0.pt", weights_only=False)["model_state"]["w"].tolist() == [4.0]
    assert torch.load(tmp_path / "o1.pt", weights_only=False)["model_state"]["w"].tolist() == [0.0]


def test_failed_save_leaves_no_tmp_and_no_output(tmp_path, monkeypatch):
    a = ckpt(tmp_path, "a.pt", w=torch.zeros(2))

    def bad_save(obj, path):
        with open(path, "wb") as f:
            f.write(b"partial")
        raise OSError("disk full")
    monkeypatch.setattr(merge_checkpoints.torch, "save", bad_save)
    with pytest.raises(OSError):
        merge(a, a, str(tmp_path / "o.pt"))
    assert sorted(os.listdir(tmp_path)) == ["a.pt"]


def test_successful_merge_leaves_no_tmp(tmp_path):
    a = ckpt(tmp_path, "a.pt", w=torch.zeros(2))
    merge(a, a, str(tmp_path / "o.pt"))
    assert sorted(os.listdir(tmp_path)) == ["a.pt", "o.pt"]
