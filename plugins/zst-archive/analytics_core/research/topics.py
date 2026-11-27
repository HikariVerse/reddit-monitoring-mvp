"""Corpus topic discovery using a bounded fitting sample and full assignment."""

import numpy as np
import pandas as pd
from cpu_runtime import cpu_workers, managed_job, operator

from . import common as CM, features as F, populations as P


@managed_job("cluster")
def cluster_passages(vectors, texts, *, k=8, enhanced=True, name_builder=None):
    # Large BLAS operations benefit from threads. Small batches and PCA fits
    # incur more overhead than work once threads outnumber the available rows.
    workers = min(cpu_workers(), max(1, len(texts) // 3000 + 1))
    with operator("topic_clustering", workers, native=True, openmp=1):
        labels, names, info = _cluster_passages(vectors, texts, k=k, enhanced=enhanced,
                                               defer_naming=name_builder is not None)
    return labels, name_builder(labels) if name_builder is not None and len(texts) >= 8 else names, info


def _cluster_passages(vectors, texts, *, k, enhanced, defer_naming):
    from sklearn.cluster import HDBSCAN, MiniBatchKMeans
    from sklearn.decomposition import PCA
    from sklearn.metrics import adjusted_rand_score

    n = len(texts)
    if n < 8:
        return np.full(n, -1), {}, {"method": "insufficient_support", "stability": None, "noise_share": 1.0}
    vectors = vectors / np.maximum(1e-9, np.linalg.norm(vectors, axis=1, keepdims=True))
    rng = np.random.default_rng(42)
    fit = np.sort(rng.choice(n, min(n, 2200), replace=False))
    fit_vectors = vectors[fit]
    labels = None
    stability = None
    similarity_floor = None
    if enhanced and n >= 30 and vectors.shape[1] > 2:
        dimensions = min(18, len(fit) - 1, vectors.shape[1])
        points = PCA(n_components=dimensions, random_state=42).fit_transform(fit_vectors)
        minimum = max(6, min(28, len(points) // 45))
        hdb = HDBSCAN(min_cluster_size=minimum, min_samples=max(3, minimum // 2), allow_single_cluster=False)
        found = hdb.fit_predict(points)
        clusters = sorted(set(found) - {-1})
        if len(clusters) >= 2:
            centroids = np.vstack([fit_vectors[found == group].mean(axis=0) for group in clusters])
            centroids /= np.maximum(1e-9, np.linalg.norm(centroids, axis=1, keepdims=True))
            similarity = vectors @ centroids.T
            labels = similarity.argmax(axis=1).astype(int)
            similarity_floor = float(np.quantile(similarity[fit[found >= 0]].max(axis=1), .05))
            labels[similarity.max(axis=1) < similarity_floor] = -1
            labels[fit] = found
            held = np.sort(rng.choice(len(points), int(.85 * len(points)), replace=False))
            repeat = hdb.fit_predict(points[held])
            stability = float(adjusted_rand_score(found[held], repeat))
    method = "pca_hdbscan" if labels is not None else "mini_batch_kmeans"
    if labels is None:
        count = max(2, min(k, len(fit) // 5))
        fast = MiniBatchKMeans(n_clusters=count, random_state=42, n_init=3, batch_size=256).fit(fit_vectors)
        labels = fast.predict(vectors)
        if enhanced:
            repeat = MiniBatchKMeans(n_clusters=count, random_state=19, n_init=3, batch_size=256).fit_predict(fit_vectors)
            stability = float(adjusted_rand_score(labels[fit], repeat))
    names = {} if defer_naming else class_terms(texts, labels)
    quality = {"method": method, "naming": "class_tfidf", "fit_rows": len(fit), "noise_share": float((labels < 0).mean()),
               "stability_ari": stability, "similarity_floor": similarity_floor}
    return labels, names, quality


def class_terms(texts, labels):
    from sklearn.feature_extraction.text import CountVectorizer

    ids = sorted(set(labels) - {-1})
    if not ids:
        return {}
    joined = {i: [] for i in ids}
    for i, text in zip(labels, texts):
        if i >= 0:
            joined[i].append(text)
    vectorizer = CountVectorizer(tokenizer=CM.clean_tokens, token_pattern=None, lowercase=False, ngram_range=(1, 2), max_features=12000)
    try:
        counts = vectorizer.fit_transform(["\n".join(joined[i]) for i in ids])
    except ValueError:
        return {}
    totals = np.asarray(counts.sum(axis=1)).ravel()
    frequency = np.asarray(counts.sum(axis=0)).ravel()
    weights = np.log1p(max(1.0, totals.mean()) / np.maximum(frequency, 1))
    feature_names = vectorizer.get_feature_names_out()
    results = {}
    for row, group in enumerate(ids):
        profile = counts.getrow(row)
        indices = profile.indices
        score = profile.data * weights[indices] / max(1, totals[row])
        order = np.argsort(-score, kind="stable")[:8]
        results[group] = [{"term": str(feature_names[indices[i]]), "weight": float(score[i])} for i in order]
    return results


@managed_job("v4_topics")
def discover(scope, k=8):
    key = ("topics", k)
    if key in scope.cache:
        return scope.cache[key]
    if scope.n < 20:
        return [], np.full(scope.n, -1)
    texts = scope.docs["norm"].tolist()
    labels, names, quality = cluster_passages(scope.unit_emb, texts, k=k, enhanced=scope.meta.get("nlp_profile") != "fast")
    rows = []
    for topic in sorted(np.unique(labels)):
        if topic < 0:
            continue
        indices = np.flatnonzero(labels == topic)
        if len(indices) < 5:
            continue
        centroid = scope.unit_emb[indices].mean(axis=0)
        examples = indices[np.argsort(-scope.unit_emb[indices] @ centroid)[:6]]
        evidence_ref = scope.docs.iloc[examples]["doc_id"].tolist()
        sub = scope.docs.iloc[indices]
        top = names.get(topic, [])
        rows.append({"id": int(topic), "name": " / ".join(row["term"] for row in top[:3]) or f"主题 {topic}", "documents": len(indices),
                     "share": len(indices) / scope.n, "evidence_ref": evidence_ref,
                     "member_count": len(indices), "membership_predicate": {"topic_id": int(topic), "k": k}, "terms": top, "quality": quality,
                     "communities": sub["community"].value_counts().head(4).to_dict()})
    result = (sorted(rows, key=lambda item: -item["documents"]), labels)
    scope.cache[key] = result
    return result


def subset(scope, ids, k=8):
    if not ids:
        return scope
    ids = set(ids)
    keys = ("topic_scope", k, tuple(sorted(ids)))
    if keys in scope.cache:
        return scope.cache[keys]
    rows, labels = discover(scope, k)
    if not ids <= {r["id"] for r in rows}:
        raise ValueError("未知子主题")
    mask = np.isin(labels, list(ids))
    docs = scope.docs.loc[mask].copy().reset_index(drop=True)
    keep = set(docs["thread_id"])
    context = pd.concat([scope.context[scope.context["thread_id"].isin(keep)],
                         scope.docs.loc[~mask & scope.docs["thread_id"].isin(keep)]], ignore_index=True)
    meta = {**scope.meta, "quality": F.quality_report(docs), "selected_topics": sorted(ids)}
    parent = scope.meta["populations"]["research"]
    population = P.Population("research", parent["source"], parent["version"], "document", len(docs),
                              {"parent": parent["population_id"], "topic_ids": sorted(ids)}, "subset").record()
    meta["populations"] = {"research": population, "semantic": {}}
    meta["scope_id"] = population["population_id"]
    derived = type(scope)(meta, docs, scope.emb[mask], scope.dict, {}, context)
    scope.cache[keys] = derived
    return derived
