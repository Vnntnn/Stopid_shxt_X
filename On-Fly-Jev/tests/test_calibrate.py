import numpy as np
import pytest

from calibrate_evidence import choose_dcfg, fit_temperatures, require_examples


def onehot(k, i):
    t = [0.0] * k
    t[i] = 1.0
    return t


def overconfident(rng, n, k, acc=0.6, scale=6.0):
    logits, targets = [], []
    for _ in range(n):
        truth = int(rng.integers(k))
        pred = truth if rng.random() < acc else int((truth + 1 + rng.integers(k - 1)) % k)
        z = np.zeros(k)
        z[pred] = scale
        logits.append(z)
        targets.append(onehot(k, truth))
    return logits, targets


def calibrated(rng, n, k):
    logits, targets = [], []
    for _ in range(n):
        z = rng.normal(0, 1.5, k)
        p = np.exp(z) / np.exp(z).sum()
        logits.append(z)
        targets.append(onehot(k, int(rng.choice(k, p=p))))
    return logits, targets


def test_overconfident_logits_get_t_above_one_and_lower_ece():
    rng = np.random.default_rng(0)
    lg, tg = overconfident(rng, 300, 4)
    temps, before, after = fit_temperatures(lg, tg)
    assert temps["choice:3-5"] > 1.5
    assert after["ece"] < before["ece"]


def test_calibrated_logits_keep_t_near_one():
    rng = np.random.default_rng(1)
    lg, tg = calibrated(rng, 3000, 4)
    temps, _, _ = fit_temperatures(lg, tg)
    assert abs(temps["choice:3-5"] - 1.0) < 0.15      # tolerance 0.15 at n=3000


def test_buckets_are_keyed_by_option_count():
    rng = np.random.default_rng(2)
    a, ta = overconfident(rng, 40, 4)
    b, tb = overconfident(rng, 40, 7)
    temps, _, _ = fit_temperatures(a + b, ta + tb)
    assert set(temps) == {"choice:3-5", "choice:6-10"}


def test_temperature_is_clamped():
    rng = np.random.default_rng(3)
    lg, tg = overconfident(rng, 200, 4, acc=0.25, scale=500.0)     # wants a huge T
    temps, _, _ = fit_temperatures(lg, tg)
    from decision_core import TEMP_MAX, TEMP_MIN
    assert temps["choice:3-5"] == TEMP_MAX and TEMP_MIN < TEMP_MAX


STALE = {"choice:3-5": 9.0}
TEMPS = {"choice:3-5": 1.7}


def test_choose_dcfg_stores_new_temps_when_ece_improves_and_keeps_other_keys():
    dcfg = {"max_len": 7, "data_license": "local only", "temperature_by_options": STALE}
    out = choose_dcfg(dcfg, TEMPS, {"ece": 0.2}, {"ece": 0.1})
    assert out["temperature_by_options"] == TEMPS and out["data_license"] == "local only" and out["max_len"] == 7
    assert dcfg["temperature_by_options"] == STALE                   # input untouched


def test_choose_dcfg_drops_stale_temps_when_ece_does_not_improve():
    dcfg = {"max_len": 7, "data_license": "local only", "temperature_by_options": STALE}
    for after in ({"ece": 0.2}, {"ece": 0.3}):
        out = choose_dcfg(dcfg, TEMPS, {"ece": 0.2}, after)
        assert "temperature_by_options" not in out
        assert out["data_license"] == "local only" and out["max_len"] == 7
    assert dcfg["temperature_by_options"] == STALE
    assert choose_dcfg({"a": 1}, TEMPS, {"ece": 0.2}, {"ece": 0.3}) == {"a": 1}


def test_require_examples_raises_on_empty_dev_set():
    with pytest.raises(ValueError, match="no dev examples after prep"):
        require_examples([])
    assert require_examples([{"x": 1}]) is None
