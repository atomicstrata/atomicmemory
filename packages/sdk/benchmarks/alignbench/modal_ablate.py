"""
AlignBench embedding-model ablation on Modal.

Runs the AlignBench items.json against multiple sentence-transformer models
on a single A100 container, returning per-model per-axis recall@1 / recall@5
and margin distributions. Resolves the local-CPU stall on mpnet and gives
real signal on whether a stronger embedding model closes the temporal /
pronoun gaps the bi-encoder MiniLM (SDK default) struggles with.

Outputs runs/modal-ablation.json — one entry per model.

Usage:
    modal run modal_ablate.py
    (writes to runs/modal-ablation.json in this folder)
"""

import json
import pathlib
import modal

APP_NAME = "alignbench-embed-ablate"

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "sentence-transformers==3.2.1",
        "torch==2.5.1",
        "rank-bm25==0.2.2",
        "numpy<2",
    )
)

app = modal.App(APP_NAME, image=image)

MODELS = [
    "sentence-transformers/all-MiniLM-L6-v2",  # SDK default, ~22M params
    "sentence-transformers/all-mpnet-base-v2",  # 110M params
    "BAAI/bge-small-en-v1.5",  # 33M params
    "BAAI/bge-base-en-v1.5",  # 109M params
    "intfloat/e5-small-v2",  # 33M params
    "intfloat/e5-base-v2",  # 110M params
]


def _cosine(a, b):
    import numpy as np
    a = np.asarray(a, dtype="float32")
    b = np.asarray(b, dtype="float32")
    na = np.linalg.norm(a) * np.linalg.norm(b)
    return float(np.dot(a, b) / na) if na > 0 else 0.0


def _build_pool(manifest):
    pool = []
    for axis_name, body in manifest["axes"].items():
        is_distractor = axis_name == "distractors"
        for i, fact in enumerate(body["facts"]):
            pool.append(
                {"text": fact, "globalKey": f"{axis_name}#{i}",
                 "axis": axis_name, "factIndex": i, "isDistractor": is_distractor}
            )
    return pool


def _score_one_model(model_name: str, manifest: dict) -> dict:
    """Embed all facts, score all queries, return per-axis + composite metrics."""
    from sentence_transformers import SentenceTransformer
    import time

    t0 = time.time()
    model = SentenceTransformer(model_name)
    pool = _build_pool(manifest)
    fact_vecs = model.encode([e["text"] for e in pool], normalize_embeddings=True)

    per_axis = []
    composite_top1 = composite_top5 = composite_n = 0
    composite_distractor = 0

    for axis_name, body in manifest["axes"].items():
        if not body["items"]:
            continue
        hit1 = hit5 = 0
        distractor_top1 = 0
        margins = []
        ranks = []

        for item in body["items"]:
            q_vec = model.encode([item["query"]], normalize_embeddings=True)[0]
            scores = [_cosine(q_vec, fv) for fv in fact_vecs]
            ranked = sorted(
                ((s, pool[i]) for i, s in enumerate(scores)),
                key=lambda x: -x[0],
            )
            # dedupe by globalKey (best rank wins)
            seen = set()
            dedup = []
            for s, entry in ranked:
                if entry["globalKey"] in seen:
                    continue
                seen.add(entry["globalKey"])
                dedup.append((s, entry))
            top5 = dedup[:5]

            gold_rank = None
            gold_score = None
            if item.get("gold_in_topk") and item.get("fact_index") is not None:
                gold_key = f"{axis_name}#{item['fact_index']}"
                for idx, (s, entry) in enumerate(dedup):
                    if entry["globalKey"] == gold_key:
                        gold_rank = idx + 1
                        gold_score = s
                        break

            if gold_rank == 1:
                hit1 += 1
            if gold_rank is not None and gold_rank <= 5:
                hit5 += 1
            if gold_rank is not None:
                ranks.append(gold_rank)

            if item.get("gold_in_topk") and top5 and top5[0][1]["isDistractor"]:
                distractor_top1 += 1

            if gold_score is not None:
                best_non_gold = next(
                    (s for s, e in dedup if e["globalKey"] != f"{axis_name}#{item['fact_index']}"),
                    None,
                )
                if best_non_gold is not None:
                    margins.append(gold_score - best_non_gold)

        n = len(body["items"])
        margins.sort()
        per_axis.append({
            "axis": axis_name,
            "n": n,
            "recall_at_1": hit1 / n if n else None,
            "recall_at_5": hit5 / n if n else None,
            "mean_gold_rank": (sum(ranks) / len(ranks)) if ranks else None,
            "median_gold_margin": margins[len(margins) // 2] if margins else None,
            "distractor_at_top1": distractor_top1,
        })
        if axis_name != "control":
            composite_top1 += hit1
            composite_top5 += hit5
            composite_n += n
            composite_distractor += distractor_top1

    wall = time.time() - t0
    return {
        "model": model_name,
        "wall_seconds": round(wall, 1),
        "composite": {
            "recall_at_1": composite_top1 / composite_n if composite_n else None,
            "recall_at_5": composite_top5 / composite_n if composite_n else None,
            "distractor_top1_rate": composite_distractor / composite_n if composite_n else None,
            "n": composite_n,
        },
        "per_axis": per_axis,
    }


@app.function(gpu="A10G", timeout=1200)
def run_model(model_name: str, manifest_json: str) -> dict:
    """Remote: run one model end-to-end and return its result dict."""
    manifest = json.loads(manifest_json)
    return _score_one_model(model_name, manifest)


@app.local_entrypoint()
def main():
    here = pathlib.Path(__file__).parent
    manifest_json = (here / "items.json").read_text()

    # Fan out across models — Modal autoscales containers, one per model.
    results = list(run_model.map(MODELS, kwargs={"manifest_json": manifest_json}))

    out_path = here / "runs" / "modal-ablation.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"models": results}, indent=2))

    print("\n=== AlignBench embedding ablation (Modal A10G) ===\n")
    print(f"{'model':<48} {'r@1':>6} {'r@5':>6} {'distr':>6} {'wall_s':>7}")
    for r in results:
        c = r["composite"]
        print(
            f"{r['model']:<48} "
            f"{c['recall_at_1']:.3f}  "
            f"{c['recall_at_5']:.3f}  "
            f"{c['distractor_top1_rate']:.3f}  "
            f"{r['wall_seconds']:>7.1f}"
        )
    print(f"\nsaved → {out_path}")
