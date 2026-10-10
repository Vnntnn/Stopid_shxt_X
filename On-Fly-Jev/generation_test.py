"""Generation test for On-Fly-Jev: (1) free text from its fine-tuned spiking trunk (tied LM head) next to the OPD base it
started from, (2) decisions on varied hand-written cases.   python generation_test.py [--base <opd base .pt>]"""
import argparse, json, os, sys, time
import torch
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import config as C, fly100
from model import BioWhaleLM
from spike_tokenizer import SpikeTokenizer
from agent import DecisionAgent

PROMPTS = ["The best way to learn a new language is", "Once upon a time, in a small village,",
           "Question: What is 12 + 7?\nAnswer:", "The capital of France is", "To fix a flat bicycle tire, first",
           "Dear customer, we are sorry that your order"]
CASES = [
 ("I just got promoted at work and I cannot stop smiling!", {"emotion": {"type": "choice", "instructions": "Which emotion is expressed?", "criteria": {"joy": None, "sadness": None, "anger": None, "fear": None}}}),
 ("My dog passed away this morning. The house feels empty.", {"emotion": {"type": "choice", "instructions": "Which emotion is expressed?", "criteria": {"joy": None, "sadness": None, "anger": None, "fear": None}}}),
 ({"body": "I was billed twice this month. Refund me or I cancel today."}, {
   "dept": {"type": "choice", "instructions": "Which team?", "criteria": {"billing": "refunds, charges", "tech": "bugs, outages", "sales": "new purchases"}},
   "urgency": {"type": "score", "instructions": "How urgent?", "criteria": ["low", "normal", "urgent"]},
   "churn": {"type": "noul", "instructions": "Does the user threaten to cancel?"}}),
 ({"body": "Hi! Just wanted to say the new dashboard looks great. No issues."}, {
   "churn": {"type": "noul", "instructions": "Does the user threaten to cancel?"},
   "urgency": {"type": "score", "instructions": "How urgent?", "criteria": ["low", "normal", "urgent"]}}),
 ("The movie was a complete waste of two hours; the plot made no sense.", {"sentiment": {"type": "choice", "instructions": "What is the sentiment?", "criteria": {"positive": None, "negative": None}}}),
 ("Apple shares rose 4% after the company beat quarterly earnings estimates.", {"topic": {"type": "choice", "instructions": "What is the topic?", "criteria": {"world": None, "sports": None, "business": None, "sci/tech": None}}}),
 ("wake me up at seven tomorrow", {"intent": {"type": "choice", "instructions": "What does the user want?", "criteria": {"alarm_set": None, "weather_query": None, "play_music": None, "calendar_query": None}}}),
 ({"premise": "A man is playing a guitar on stage.", "hypothesis": "A man is performing music."}, {"nli": {"type": "choice", "instructions": "Does the premise entail the hypothesis?", "criteria": {"entailment": None, "neutral": None, "contradiction": None}}}),
 ({"passage": "Water boils at 100 degrees Celsius at sea level.", "question": "does water boil at 100 degrees celsius at sea level"}, {"answer": {"type": "noul", "instructions": "Is the answer to the question yes?"}}),
 ({"health": 20, "ammo": 12, "enemies": [{"name": "imp", "distance": 3, "angle": -10}], "position": "open room"}, {"action": {"type": "choice", "instructions": "What should the player do next?", "criteria": {"attack": "shoot the nearest enemy", "retreat": "back away", "explore": "move forward", "turn_left": None, "turn_right": None}}}),
]

def gen(model, tok, dev):
    out = {}
    for p in PROMPTS:
        ids = tok.encode(p, add_special_tokens=False)
        with torch.no_grad():
            o = model.generate(ids, n_new=48, temperature=0.0)
        out[p] = tok.decode(o[len(ids):])
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=None); ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    a = ap.parse_args(); dev = a.device; torch.set_flush_denormal(True)
    tok = SpikeTokenizer(os.path.join(HERE, "tokenizer.json"))
    def lm(state):
        m = BioWhaleLM(C.fly100(vocab_size=16512)); fly100.apply(m, fly100.load(os.path.join(HERE, "fly100.pt")))
        miss, unexp = m.load_state_dict(state, strict=False); assert not miss and not unexp, (miss[:3], unexp[:3])
        return m.to(dev).eval()
    c = torch.load(os.path.join(HERE, "On-Fly-Jev.pt"), map_location="cpu", weights_only=False)
    trunk = {k[len("lm.bio."):]: v for k, v in c["model_state"].items() if k.startswith("lm.bio.")}
    res = {"text_on_fly_jev": gen(lm(trunk), tok, dev)}
    if a.base:
        res["text_base"] = gen(lm(torch.load(a.base, map_location="cpu", weights_only=False)["model"]), tok, dev)
    agent = DecisionAgent(os.path.join(HERE, "On-Fly-Jev.pt"), code_dir=HERE, device=dev)
    agent.predict(*CASES[0])
    res["decisions"] = []
    for state, qs in CASES:
        t = time.perf_counter(); r = agent.predict(state, qs); ms = (time.perf_counter() - t) * 1000
        res["decisions"].append({"state": state, "ms": round(ms, 1), "answers": {q: {k: v for k, v in x.items() if k not in ("action", "confidence", "type")} for q, x in r["answers"].items()}})
    print(json.dumps(res, indent=1, ensure_ascii=False))
    json.dump(res, open(os.path.join(HERE, "eval", "generation_test.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)

if __name__ == "__main__":
    main()
