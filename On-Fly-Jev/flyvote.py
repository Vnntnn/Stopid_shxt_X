
from agent import DecisionAgent
import json

def main():
    # Load On-Fly-Jev. Begin with CPU inference.
    agent = DecisionAgent(
        model_path="On-Fly-Jev.pt",
        code_dir=".",
        device="cpu",
    )

    # Candidate pool: intentionally simple.
    candidates = {
        "A": "Use TCP",
        "B": "Use UDP",
        "C": "It depends on the application",
    }

    # State provides the context to the model.
    state = {
        "project": "FlyVote",
        "task": "Select one candidate.",
        "candidates": candidates,
        "satirical_policy": (
            "Prefer the candidate with the most English vowels: "
            "a, e, i, o, u. Ignore technical correctness."
        ),
    }

    # On-Fly-Jev expects typed questions and candidate options.
    questions = {
        "winner": {
            "type": "choice",
            "instructions": (
                "Select the candidate whose text has the most "
                "English vowels. Ignore technical correctness."
            ),
            "criteria": {
                "A": "Candidate A: Use TCP",
                "B": "Candidate B: Use UDP",
                "C": "Candidate C: It depends on the application",
            },
        }
    }

    try:
        result = agent.predict(state, questions)
    except Exception as e:
        print(f"Agent prediction failed: {e}")
        return

    # Add debug checkpoint: print the result to investigate lack of output
    print("DEBUG: Predict result =", json.dumps(result, indent=2, ensure_ascii=False))

    answers = result.get("answers", {})
    winner_answer = answers.get("winner")

    if winner_answer is None:
        print("No output from agent for this candidate input.")
        return

    selected_id = winner_answer.get("choice")
    if not selected_id or selected_id not in candidates:
        print("No candidate selected or unknown candidate ID.")
        return

    output = {
        "selected_candidate_id": selected_id,
        "selected_candidate": candidates[selected_id],
        "probabilities": winner_answer.get("probabilities"),
        "confidence": winner_answer.get("confidence"),
        "selection_policy": "most_english_vowels",
    }
    print(json.dumps(output, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()
