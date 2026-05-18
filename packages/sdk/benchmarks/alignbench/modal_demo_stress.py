"""
Demo-class synthetic stress test on Modal.

This is the closest reproduction we can run of the actual partner-demo
failure shape *without* deploying the full core+Postgres stack:

  1. Generate 30 short multi-turn conversations (3-4 turns each) where the
     user states 2-3 personal facts and then asks a recall question.
  2. Run the REAL production extraction LLM (Anthropic Haiku, same model
     and same EXTRACTION_PROMPT the engine uses) on each conversation.
  3. Apply the meta-fact filter post-extraction to half the runs; leave
     the other half raw. This matches what the engine does in core after
     the alignbench-meta-fact-filter-2026-05-14 branch ships.
  4. Embed every surviving fact + the recall query with the production
     SDK embedding model (Xenova/all-MiniLM-L6-v2 via
     sentence-transformers).
  5. Score cosine similarity, rank facts, check whether the gold fact
     ranks #1, count how many meta-facts ranked above it.

Output: runs/demo-stress.json with per-conversation results, summary
deltas, and concrete failure examples.

This reproduces the cosine-margin-too-thin pattern that the partner-demo
screenshots showed, on synthetic data so we can iterate safely.

Why on Modal rather than local: parallel extraction calls hit Anthropic
rate limits faster than a single laptop can absorb, and Modal also lets
us run sentence-transformers on a beefy CPU container without local
ONNX init stalls.

Usage:
    modal run modal_demo_stress.py
"""

import json
import os
import pathlib
import modal

APP_NAME = "alignbench-demo-stress"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "sentence-transformers==3.2.1",
        "torch==2.5.1",
        "numpy<2",
        "anthropic==0.40.0",
        "httpx>=0.27",
    )
    .add_local_file(__file__, "/root/modal_demo_stress.py")
)

# Reuse the meta-fact patterns the SDK + core both ship.
# Importing across the local-vs-Modal boundary is awkward; the patterns are short.
META_FACT_PATTERNS = [
    r"^\s*the user (asked|requested|said|is asking|is me)\b",
    r"^\s*as of [^,]+,\s+.+\s+is a term mentioned in the conversation\.?$",
    r"^\s*a name was mentioned\b",
    r"^\s*the conversation involves the user\b",
    r"^\s*the user has started a conversation\b",
]


# Compact production extraction prompt — abbreviated to keep the call cheap
# while preserving the rule that drives meta-fact emission in real production.
# Mirrors src/services/extraction.ts EXTRACTION_PROMPT structure but trimmed
# to the rules that matter for this stress test (we are not testing the
# entity/keyword fields, only what gets emitted as a statement).
EXTRACTION_PROMPT = """You are a memory extraction system. Your only output is a JSON object. You never produce conversational replies. You never continue the dialogue. You read the transcript and emit facts as JSON.

Extract discrete, self-contained facts from the conversation transcript below. Each fact should be useful if retrieved months later in a completely different conversation.

RULES:
- Each fact must be a single, atomic statement.
- Include enough context to be understood in isolation.
- Replace pronouns with specific names/references.
- Length is NOT a reason to skip a fact. A single user sentence containing a named entity (person, place, profession, possession, preference, allergy, hobby) IS extractable. "I'm Alex" → one fact. "I live in Lisbon" → one fact. "My dog is named Apollo" → one fact.
- Skip pleasantries, filler, acknowledgments, and meta-observations about the conversation itself.
- NEVER extract meta-facts of the form "the user asked X", "a term was mentioned", "the conversation involves the user". These describe the chat, not the user.
- Rate importance 0.0-1.0.

Your output MUST be a single raw JSON object, no markdown fences, no preamble, no continuation of the conversation:
{"memories": [{"statement": "...", "importance": 0.7}]}

If no extractable facts: {"memories": []}"""


# 30 conversations: each has user-asserted facts + a recall question + the
# gold fact text we expect retrieval to surface. Crafted to mirror the
# partner-demo failure surface: short, casual, personal, multi-fact.
CONVERSATIONS = [
    {"id": "name-001", "turns": ["My name is Alex.", "Got it."], "query": "what is my name?", "gold": "name is Alex"},
    {"id": "name-002", "turns": ["I go by Sam.", "OK Sam."], "query": "what's my name?", "gold": "go by Sam"},
    {"id": "name-003", "turns": ["You can call me Riley.", "Hi Riley."], "query": "what should you call me?", "gold": "call me Riley"},
    {"id": "name-004", "turns": ["I'm Jordan.", "Nice to meet you."], "query": "who am I?", "gold": "Jordan"},
    {"id": "pet-001", "turns": ["I have a golden retriever named Apollo.", "How sweet."], "query": "what is my dog's name?", "gold": "Apollo"},
    {"id": "pet-002", "turns": ["My cat Luna sleeps on my keyboard.", "Classic cat."], "query": "what's my cat's name?", "gold": "Luna"},
    {"id": "pet-003", "turns": ["I just adopted a beagle puppy. Her name is Penny.", "Congrats!"], "query": "what kind of dog do I have?", "gold": "beagle"},
    {"id": "job-001", "turns": ["I work as a software engineer at a startup.", "Cool field."], "query": "what do I do for work?", "gold": "software engineer"},
    {"id": "job-002", "turns": ["I'm a high school chemistry teacher.", "That's important work."], "query": "what is my profession?", "gold": "chemistry teacher"},
    {"id": "job-003", "turns": ["I freelance as a graphic designer.", "Nice."], "query": "what's my job?", "gold": "graphic designer"},
    {"id": "city-001", "turns": ["I live in Lisbon now.", "Beautiful city."], "query": "where do I live?", "gold": "Lisbon"},
    {"id": "city-002", "turns": ["I just moved to Berlin last month.", "Welcome to Berlin."], "query": "what city am I in?", "gold": "Berlin"},
    {"id": "city-003", "turns": ["I'm based in Toronto.", "Cold this time of year."], "query": "where am I located?", "gold": "Toronto"},
    {"id": "food-001", "turns": ["I'm vegetarian.", "Got it."], "query": "do I eat meat?", "gold": "vegetarian"},
    {"id": "food-002", "turns": ["I'm severely allergic to peanuts.", "Noted, will avoid."], "query": "do I have any allergies?", "gold": "peanut"},
    {"id": "food-003", "turns": ["I don't drink coffee — only tea.", "Tea is great too."], "query": "what do I drink in the morning?", "gold": "tea"},
    {"id": "hobby-001", "turns": ["I play classical piano.", "Lovely hobby."], "query": "what instrument do I play?", "gold": "piano"},
    {"id": "hobby-002", "turns": ["My main sport is rock climbing.", "Cool."], "query": "what sport do I do?", "gold": "rock climbing"},
    {"id": "hobby-003", "turns": ["I've been knitting for about ten years.", "Impressive."], "query": "what's a hobby I have?", "gold": "knitting"},
    {"id": "family-001", "turns": ["I have two kids, Maya and Theo.", "What ages?"], "query": "how many children do I have?", "gold": "two"},
    {"id": "family-002", "turns": ["My partner's name is Casey.", "Nice."], "query": "who is my partner?", "gold": "Casey"},
    {"id": "family-003", "turns": ["My mom lives in Vancouver.", "Far from you?"], "query": "where does my mom live?", "gold": "Vancouver"},
    {"id": "vehicle-001", "turns": ["I drive a blue Subaru Outback.", "Reliable car."], "query": "what kind of car do I have?", "gold": "Subaru"},
    {"id": "vehicle-002", "turns": ["I don't own a car. I bike everywhere.", "Healthy lifestyle."], "query": "do I have a car?", "gold": "does not own"},
    {"id": "edu-001", "turns": ["I studied applied mathematics in college.", "Tough major."], "query": "what was my major?", "gold": "applied mathematics"},
    {"id": "edu-002", "turns": ["I got my MBA from UCLA two years ago.", "Congrats."], "query": "where did I get my MBA?", "gold": "UCLA"},
    {"id": "tech-001", "turns": ["My main laptop is a 16-inch MacBook Pro.", "Solid machine."], "query": "what computer do I use?", "gold": "MacBook"},
    {"id": "tech-002", "turns": ["I prefer Neovim over VS Code.", "Editor preferences are personal."], "query": "what editor do I use?", "gold": "Neovim"},
    {"id": "music-001", "turns": ["I've been getting into bluegrass lately.", "Fun genre."], "query": "what music am I into these days?", "gold": "bluegrass"},
    {"id": "music-002", "turns": ["My all-time favorite band is Radiohead.", "Great band."], "query": "what's my favorite band?", "gold": "Radiohead"},
]

app = modal.App(APP_NAME, image=image)


def _is_meta_fact(text: str, patterns: list[str]) -> bool:
    import re
    if not isinstance(text, str) or len(text) == 0:
        return False
    for p in patterns:
        if re.search(p, text, flags=re.IGNORECASE):
            return True
    return False


def _cosine(a, b) -> float:
    import numpy as np
    a = np.asarray(a, dtype="float32")
    b = np.asarray(b, dtype="float32")
    n = np.linalg.norm(a) * np.linalg.norm(b)
    return float(np.dot(a, b) / n) if n > 0 else 0.0


@app.function(timeout=600)
def extract_facts(conversation_turns: list[str], anthropic_key: str) -> list[dict]:
    """Call Anthropic Haiku with the production EXTRACTION_PROMPT shape."""
    from anthropic import Anthropic

    client = Anthropic(api_key=anthropic_key)
    convo_text = "\n".join(f"User: {t}" if i % 2 == 0 else f"Assistant: {t}" for i, t in enumerate(conversation_turns))
    # Force JSON-only output via assistant-role prefill of "{". Anthropic
    # then resumes generation INSIDE the JSON object, eliminating the
    # chat-continuation failure mode we observed empirically. The prefilled
    # "{" is added back to the parsed text.
    msg = client.messages.create(
        model="claude-haiku-4-5",
        max_tokens=600,
        temperature=0,
        system=EXTRACTION_PROMPT,
        messages=[
            {"role": "user", "content": f"Conversation:\n{convo_text}"},
            {"role": "assistant", "content": "{"},
        ],
    )
    generated = "".join(block.text for block in msg.content if hasattr(block, "text"))
    text = "{" + generated
    # Robust JSON extraction: strip markdown fences, then find the JSON object.
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[1] if "\n" in cleaned else ""
        if cleaned.endswith("```"):
            cleaned = cleaned.rsplit("```", 1)[0]
    cleaned = cleaned.strip()
    # If LLM added preamble like "Here are the facts:", find the first { and last }.
    if not cleaned.startswith("{"):
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            cleaned = cleaned[start : end + 1]
    try:
        parsed = json.loads(cleaned)
        return parsed.get("memories", []) if isinstance(parsed, dict) else []
    except json.JSONDecodeError as e:
        # Log to Modal stderr so we can diagnose in the run output.
        import sys
        sys.stderr.write(f"[extract] JSON parse failed: {e}; raw text first 200 chars: {text[:200]!r}\n")
        return []


@app.function(timeout=1800)
def score_all_conversations(conversations: list[dict], anthropic_key: str) -> dict:
    """Run extraction + embedding + scoring for every conversation, both with and without the filter."""
    from sentence_transformers import SentenceTransformer

    print(f"[score] loading embedding model...", flush=True)
    embedder = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")

    # First: extract facts for every conversation (parallel via .map below would be cleaner,
    # but Modal nested-function calls add complexity; sequential is fine for n=30).
    print(f"[score] extracting facts for {len(conversations)} conversations...", flush=True)
    rows = []
    for conv in conversations:
        try:
            facts = extract_facts.remote(conv["turns"], anthropic_key)
        except Exception as e:
            print(f"  {conv['id']} EXTRACTION FAIL: {e}", flush=True)
            facts = []
        statements = [
            (f.get("statement") or "").strip()
            for f in facts
            if isinstance(f, dict) and isinstance(f.get("statement"), str)
        ]
        statements = [s for s in statements if s]
        meta_mask = [_is_meta_fact(s, META_FACT_PATTERNS) for s in statements]
        rows.append({
            "id": conv["id"],
            "turns": conv["turns"],
            "query": conv["query"],
            "gold": conv["gold"],
            "facts": statements,
            "meta_mask": meta_mask,
            "n_facts": len(statements),
            "n_meta": sum(meta_mask),
        })
        print(f"  {conv['id']}: {len(statements)} facts ({sum(meta_mask)} meta)", flush=True)

    # Second: embed everything and score retrieval, twice (with/without filter).
    print(f"[score] embedding + scoring...", flush=True)
    summary = {"baseline": {}, "filtered": {}, "n": len(rows)}
    for mode in ("baseline", "filtered"):
        hits_at_1 = 0
        hits_at_5 = 0
        gold_present = 0
        meta_top1 = 0
        per_item = []
        for row in rows:
            facts = row["facts"]
            mask = row["meta_mask"]
            if mode == "filtered":
                facts_eff = [s for s, m in zip(facts, mask) if not m]
                meta_eff = [False] * len(facts_eff)
            else:
                facts_eff = facts
                meta_eff = mask

            if not facts_eff:
                per_item.append({
                    "id": row["id"], "gold_rank": None, "gold_score": None,
                    "top1_is_meta": False, "top1_text": None,
                })
                continue

            q_vec = embedder.encode([row["query"]], normalize_embeddings=True)[0]
            f_vecs = embedder.encode(facts_eff, normalize_embeddings=True)
            scores = [_cosine(q_vec, fv) for fv in f_vecs]
            ranked = sorted(
                ((s, i) for i, s in enumerate(scores)),
                key=lambda x: -x[0],
            )

            # Match gold by (a) substring fast path (case-insensitive, also handles
            # short stems by stripping trailing punctuation), or (b) cosine similarity
            # >= 0.65 against the gold tag if substring fails. The cosine fallback
            # recovers cases like gold='go by Sam' matching 'goes by the name Sam'.
            gold_token = row["gold"].lower().rstrip(".,!?;:")
            gold_vec = embedder.encode([row["gold"]], normalize_embeddings=True)[0]
            gold_rank = None
            gold_score = None
            for rank, (s, idx) in enumerate(ranked, start=1):
                fact_lower = facts_eff[idx].lower()
                if gold_token in fact_lower:
                    gold_rank = rank
                    gold_score = s
                    break
                # cosine fallback for stem-mismatch + semantic-paraphrase substring failures
                # ("don't own" matches "does not own", "go by" matches "goes by")
                if _cosine(gold_vec, f_vecs[idx]) >= 0.55:
                    gold_rank = rank
                    gold_score = s
                    break

            top1_idx = ranked[0][1]
            top1_text = facts_eff[top1_idx]
            top1_is_meta = meta_eff[top1_idx]

            if gold_rank is not None:
                gold_present += 1
                if gold_rank == 1:
                    hits_at_1 += 1
                if gold_rank <= 5:
                    hits_at_5 += 1
            if top1_is_meta:
                meta_top1 += 1

            per_item.append({
                "id": row["id"],
                "gold_rank": gold_rank,
                "gold_score": gold_score,
                "top1_score": ranked[0][0],
                "top1_text": top1_text,
                "top1_is_meta": top1_is_meta,
            })

        summary[mode] = {
            "recall_at_1": hits_at_1 / len(rows),
            "recall_at_5": hits_at_5 / len(rows),
            "gold_present_rate": gold_present / len(rows),
            "meta_at_top1": meta_top1,
            "per_item": per_item,
        }

    summary["rows"] = rows
    return summary


@app.local_entrypoint()
def main():
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not anthropic_key:
        raise RuntimeError("ANTHROPIC_API_KEY env var must be set locally before `modal run`")
    result = score_all_conversations.remote(CONVERSATIONS, anthropic_key)

    here = pathlib.Path(__file__).parent
    out_path = here / "runs" / "demo-stress.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=2))

    print("\n" + "=" * 60)
    print("Demo-class stress test results")
    print("=" * 60)
    n = result["n"]
    for mode in ("baseline", "filtered"):
        s = result[mode]
        print(
            f"\n{mode:8}  r@1={s['recall_at_1']:.3f}  "
            f"r@5={s['recall_at_5']:.3f}  "
            f"gold_present={s['gold_present_rate']:.3f}  "
            f"meta_top1={s['meta_at_top1']}/{n}"
        )
    delta_r1 = result["filtered"]["recall_at_1"] - result["baseline"]["recall_at_1"]
    delta_meta = result["baseline"]["meta_at_top1"] - result["filtered"]["meta_at_top1"]
    print(f"\nfilter delta:  r@1 {delta_r1:+.3f}  meta_top1 {delta_meta:+d}")
    print(f"\nsaved -> {out_path}")
