"""
spike_tokenizer.py -- HuggingFace-compatible wrapper for the custom
byte-level "length-max" (greedy longest-match) tokenizer in tokenizer.json.

The raw tokenizer.json is NOT a HuggingFace `tokenizers` file; it is a plain
dict {vocab, vocab_size, max_token_len, algorithm:"length-max"}. This wrapper
makes it loadable by AutoTokenizer.from_pretrained / save_pretrained and
exposes encode/decode + the bos/eos/pad/unk ids the training scripts expect.

Encoding scheme (verified): byte-level. Text is UTF-8 encoded, each byte mapped
to its latin-1 character, then greedily matched against the vocab using the
longest key that matches at each position (max key length = max_token_len).
"""
import json, os
from typing import List, Optional

# We only use transformers' tokenizer base class. Stop it from probing
# TensorFlow/Flax (whose builds are often incompatible with numpy 2 / protobuf and
# would crash the import). setdefault so an explicit user override still wins.
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("USE_FLAX", "0")

from transformers import PreTrainedTokenizer


class SpikeTokenizer(PreTrainedTokenizer):
    vocab_files_names = {"vocab_file": "tokenizer.json"}
    model_input_names = ["input_ids"]

    def __init__(self, vocab_file=None, **kwargs):
        with open(vocab_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        self._vocab = data["vocab"]                       # str -> id
        self._ids_to_tokens = {i: t for t, i in self._vocab.items()}
        self.max_token_len = int(data.get("max_token_len", 24))
        # length-bucketed keys for fast greedy match (longest length first)
        self._lengths = sorted({len(k) for k in self._vocab}, reverse=True)

        # Appended special tokens (im_start / <think> / <begin_solution> / ...).
        # They already live in self._vocab at their real ids; we hand them to the
        # HF base class as `additional_special_tokens` so its AddedToken trie:
        #   (1) splits them out ATOMICALLY before our byte-level greedy match
        #       (verified: each maps back to its existing vocab id, no phantom id), and
        #   (2) drops them on decode(skip_special_tokens=True).
        # The set is stored in tokenizer.json under "special_tokens" so it
        # survives save_pretrained/from_pretrained round-trips.
        self._extra_specials = [
            t for t in data.get("special_tokens", []) if t in self._vocab
        ]
        if self._extra_specials:
            existing = list(kwargs.get("additional_special_tokens", []) or [])
            merged = existing + [t for t in self._extra_specials if t not in existing]
            kwargs["additional_special_tokens"] = merged

        kwargs.setdefault("bos_token", "<bos>")
        kwargs.setdefault("eos_token", "<eos>")
        kwargs.setdefault("unk_token", "<unk>")
        kwargs.setdefault("pad_token", "<pad>")
        super().__init__(**kwargs)

    @property
    def vocab_size(self) -> int:
        return len(self._vocab)

    def get_vocab(self):
        return dict(self._vocab)

    # --- core byte-level greedy tokenization ---
    def _tokenize(self, text: str) -> List[str]:
        s = text.encode("utf-8").decode("latin-1")  # one char per byte
        out, i, n = [], 0, len(s)
        while i < n:
            matched = None
            hi = min(self.max_token_len, n - i)
            for L in range(hi, 0, -1):
                sub = s[i:i + L]
                if sub in self._vocab:
                    matched = sub
                    break
            if matched is None:           # single byte always exists in vocab
                matched = s[i]
            out.append(matched)
            i += len(matched)
        return out

    def _convert_token_to_id(self, token: str) -> int:
        return self._vocab.get(token, self._vocab["<unk>"])

    def _convert_id_to_token(self, index: int) -> str:
        return self._ids_to_tokens.get(index, "<unk>")

    def convert_tokens_to_string(self, tokens: List[str]) -> str:
        # transformers 5.x hands the FULL token list here (special tokens
        # included; skip_special_tokens is already applied upstream via
        # convert_ids_to_tokens). So we can't just byte-decode everything: a
        # special token like "<|im_start|>" is a literal marker, not latin-1
        # bytes. Decode runs of ordinary byte-tokens together (needed so
        # multi-byte UTF-8 sequences reassemble) and emit any special token
        # inline as its literal string.
        specials = {"<pad>", "<unk>", "<bos>", "<eos>", *self._extra_specials}
        out, buf = [], []
        for tok in tokens:
            if tok in specials:
                if buf:
                    out.append("".join(buf).encode("latin-1").decode("utf-8", errors="replace"))
                    buf = []
                out.append(tok)
            else:
                buf.append(tok)
        if buf:
            out.append("".join(buf).encode("latin-1").decode("utf-8", errors="replace"))
        return "".join(out)

    def save_vocabulary(self, save_directory: str, filename_prefix: Optional[str] = None):
        os.makedirs(save_directory, exist_ok=True)
        fn = (filename_prefix + "-" if filename_prefix else "") + "tokenizer.json"
        path = os.path.join(save_directory, fn)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"vocab": self._vocab, "vocab_size": self.vocab_size,
                       "max_token_len": self.max_token_len,
                       "algorithm": "length-max",
                       "special_tokens": list(self._extra_specials)},
                      f, ensure_ascii=False)
        return (path,)
