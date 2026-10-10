"""DecisionAgent: `predict(state, questions)` -> Laya/Jev-shaped answers.

Output (same schema as Laya, which is schema-identical to TypeSafe Jev):
    {"model": name,
     "answers": {qid: {"type": "choice", "choice": ..., "probabilities": {...},
                       "confidence": ..., "answer_confidence": ..., "action": {...}}, ...},
     "usage": {"input_tokens": N, "output_tokens": 0}}

All questions for all states are scored in one batched forward pass per chunk.
"""
import os
from typing import Any, Dict, List, Optional, Union

import numpy as np
import torch

from decision_core import (QTYPES, answer_confidence, assemble, check_question, clamp_temperature,
                           collate, confidence_from_probs, load_decision_model, load_tokenizer,
                           temp_bucket, to_internal, tokenize_question, tokenize_state)


class DecisionAgent:
    def __init__(self, model_path: str, code_dir: Optional[str] = None, device: str = "cpu",
                 max_rows: int = 16):
        code_dir = code_dir or os.path.dirname(os.path.abspath(__file__))
        self.device = torch.device(device)
        self.model, self.cfg, _ = load_decision_model(code_dir, model_path, self.device)
        self.tok = load_tokenizer(code_dir)
        self.name = self.cfg.get("model_name", "byrne-decisions")
        self.max_len = self.cfg.get("max_len", 1024)
        self.head_max_len = self.cfg.get("head_max_len", 256)
        self.temperature = [clamp_temperature(t) for t in self.cfg.get("temperature", [1.0, 1.0, 1.0])]
        self.temperature_by_options = {k: clamp_temperature(v)
                                       for k, v in self.cfg.get("temperature_by_options", {}).items()}
        self.max_rows = max_rows
        self.amp = self.device.type == "cuda"

    @torch.no_grad()
    def _logits(self, rows: List[Dict]):
        out_l, out_a = [], []
        for i in range(0, len(rows), self.max_rows):
            b = collate(rows[i:i + self.max_rows], self.tok.pad_token_id)
            with torch.autocast(self.device.type, dtype=torch.bfloat16, enabled=self.amp):
                logits, act = self.model(*(b[k].to(self.device) for k in
                                           ("input_ids", "attention_mask", "marker_pos", "marker_mask", "qtype")))
            out_l.extend(logits.float().cpu().numpy())
            out_a.extend(torch.softmax(act.float(), -1).cpu().numpy())
        return out_l, out_a

    def _decode(self, q: Dict, z_row, act_row, k: int) -> Dict[str, Any]:
        qt = QTYPES[q["t"]]
        t_scale = self.temperature_by_options.get(temp_bucket(qt, k), self.temperature[qt])
        z = z_row[:k] / t_scale
        p = np.exp(z - z.max())
        p = p / p.sum()
        ans_conf = round(answer_confidence(p, k), 4)
        ext = {"act_probability": round(float(act_row[0]), 4)}
        if q["t"] == "choice":
            keys = list(q["crit"].keys())
            return {"type": "choice", "choice": keys[int(p.argmax())],
                    "probabilities": {kk: round(float(v), 4) for kk, v in zip(keys, p)},
                    "confidence": round(confidence_from_probs(p, k), 4),
                    "answer_confidence": ans_conf, "action": ext}
        if q["t"] == "score":
            return {"type": "score", "score": round(float((np.arange(k) * p).sum()), 4),
                    "legend": {str(i): c for i, c in enumerate(q["crit"])},
                    "probabilities": {str(i): round(float(v), 4) for i, v in enumerate(p)},
                    "confidence": round(confidence_from_probs(p, k), 4),
                    "answer_confidence": ans_conf, "action": ext}
        return {"type": "noul", "noul": round(float(p[1]), 4),
                "confidence": round(max(float(p[1]), 1.0 - float(p[1])), 4),
                "answer_confidence": ans_conf, "action": ext}

    def predict_batch(self, states: List[Union[str, dict, list]], questions: Dict[str, Dict]) -> List[Dict]:
        if not isinstance(questions, dict):
            raise ValueError("questions must be a dict of question_id -> definition")
        for qid, qdef in questions.items():
            check_question(qid, qdef)
        ids = list(questions)
        internal = {qid: to_internal(questions[qid]) for qid in ids}
        if not ids:
            return [{"model": self.name, "answers": {}, "usage": {"input_tokens": 0, "output_tokens": 0}}
                    for _ in states]
        qtoks = {qid: tokenize_question(self.tok, internal[qid]) for qid in ids}
        rows, per_state = [], []
        for st in states:
            st_ids = tokenize_state(self.tok, st)
            n_in = 0
            for qid in ids:
                seq, markers = assemble(self.tok.bos_token_id, st_ids, qtoks[qid], self.max_len,
                                        self.head_max_len, truncate_left=isinstance(st, list))
                if len(markers) != len(qtoks[qid]["opts"]):
                    raise ValueError("question %r: options exceed head_max_len=%d" % (qid, self.head_max_len))
                rows.append({"ids": seq, "markers": markers, "qtype": QTYPES[internal[qid]["t"]]})
                n_in += len(seq)
            per_state.append(n_in)
        logits, act = self._logits(rows)
        results, r = [], 0
        for s_i in range(len(states)):
            answers = {}
            for qid in ids:
                answers[qid] = self._decode(internal[qid], logits[r], act[r], len(rows[r]["markers"]))
                r += 1
            results.append({"model": self.name, "answers": answers,
                            "usage": {"input_tokens": per_state[s_i], "output_tokens": 0},
                            # Probabilities are rounded to 4 decimals; declare it like Jev does so strict
                            # clients (e.g. jev-doom) validate sums/argmax at that precision.
                            "rounding": {"probabilityDecimals": 4}})
        return results

    def predict(self, state, questions: Dict[str, Dict]) -> Dict:
        return self.predict_batch([state], questions)[0]

    system_one = predict   # Jev's name for the call
