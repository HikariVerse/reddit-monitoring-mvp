"""BM25, dense and hybrid candidate rankings with optional local reranking."""

import re

import numpy as np

from .contextual import local_context


def rank(scope, encoder, query, k=10):
    k = min(max(1, k), scope.n, 100)
    if not k:
        return {name: np.empty(0, dtype=int) for name in ("bm25", "potion", "hybrid", "passage_rerank")}, np.empty(0), np.empty(0), np.empty(0)
    if "bm25" not in scope.cache:
        from sklearn.feature_extraction.text import CountVectorizer
        vectorizer = CountVectorizer(token_pattern=r"(?u)\b\w{2,}\b", dtype=np.int32)
        try:
            tf = vectorizer.fit_transform(scope.docs["norm"])
            lengths = np.asarray(tf.sum(axis=1)).ravel()
            scope.cache["bm25"] = (vectorizer, tf.tocsc(), lengths)
        except ValueError:
            scope.cache["bm25"] = None
    query_vector = encoder.encode([query], batch_size=1, max_tokens=128)[0]
    semantic = scope.unit_emb @ (query_vector / max(1e-9, np.linalg.norm(query_vector)))
    lexical = np.zeros(scope.n)
    bm25 = scope.cache["bm25"]
    if bm25 is not None:
        vectorizer, tf, lengths = bm25
        avg_length = max(1, lengths.mean())
        for col in vectorizer.transform([query]).indices:
            block = tf.getcol(col)
            idx = block.indices
            weight = np.log1p((scope.n - len(idx) + .5) / (len(idx) + .5))
            lexical[idx] += weight * (block.data * 2.2) / (block.data + 1.2 * (.25 + .75 * lengths[idx] / avg_length))
    sort = lambda scores: np.argsort(-scores, kind="stable")
    order_s, order_k = sort(semantic), sort(lexical)
    rank_s, rank_k = np.argsort(order_s), np.argsort(order_k)
    hybrid = 0.65 / (60 + rank_s) + 0.35 * (lexical > 0) / (60 + rank_k)
    order_h = sort(hybrid)
    pool = order_h[:min(60, max(k, 3 * k))]
    normalized_query = " ".join(re.findall(r"\w+", query.casefold()))
    exact = np.array([bool(normalized_query and normalized_query in " ".join(re.findall(r"\w+", text.casefold())))
                      for text in scope.docs.iloc[pool]["norm"]])
    reranked = pool[sort(hybrid[pool] + .003 * exact)]
    rankings = {"bm25": order_k[:k], "potion": order_s[:k], "hybrid": order_h[:k], "passage_rerank": reranked[:k]}
    manifest = scope.meta.get("provider_manifest", {}).get("models", {})
    model = scope.cache.get("context_provider") or local_context()
    if manifest.get("rerank", {}).get("installed") or "context_provider" in scope.cache:
        pairs = [(query, text) for text in scope.docs.iloc[pool]["norm"]]
        scores = model.rank(pairs)
        rankings["cross_encoder"] = pool[sort(scores)][:k]
        scope.cache["last_rerank"] = {"candidates": len(pool), "scores": {str(int(i)): float(s) for i, s in zip(pool, scores)}}
    if manifest.get("context", {}).get("installed") and "linguistic" in scope.docs:
        vectors = [(i, record["context_embedding"]) for i, record in enumerate(scope.docs.linguistic) if record.get("context_embedding")]
        if vectors:
            indices, embeddings = zip(*vectors)
            query_embedding = model.embed([query])[0]
            similarities = np.asarray(embeddings) @ (query_embedding / max(1e-9, np.linalg.norm(query_embedding)))
            rankings["contextual_sample"] = np.asarray(indices)[sort(similarities)][:k]
    return rankings, semantic, lexical, hybrid
