"""Thresholded weighted graph clustering with a selectable mature implementation."""

import numpy as np


def community_partition(matrix, threshold, profile):
    from .mod_social import _label_propagation

    if profile != "fast":
        try:
            import networkx as nx
        except ImportError:
            pass
        else:
            graph = nx.Graph()
            graph.add_nodes_from(range(len(matrix)))
            graph.add_weighted_edges_from((int(i), int(j), float(matrix[i, j]))
                                         for i, j in zip(*np.where(np.triu(matrix, 1) > threshold)))
            groups = list(nx.algorithms.community.asyn_lpa_communities(graph, weight="weight", seed=42))
            mapping = {index: group for group, members in enumerate(sorted(groups, key=min)) for index in members}
            return [mapping[i] for i in range(len(matrix))], "NetworkX 加权异步标签传播"
    return _label_propagation(matrix, threshold), "确定性基线标签传播"


def multilayer(scope, topic_labels):
    from scipy.spatial.distance import jensenshannon
    from sklearn.feature_extraction.text import TfidfVectorizer
    try:
        import networkx as nx
    except ImportError:
        return {"method": "networkx_missing", "layers": {}}

    docs = scope.docs
    counts = [name for name, count in docs.community.value_counts().items() if name and count >= 8][:30]
    if len(counts) < 2:
        return {"method": "insufficient_community_support", "layers": {}}
    from itertools import combinations
    from sklearn.metrics import adjusted_rand_score
    from . import common as CM

    frames = [docs.index[docs.community == name].to_numpy() for name in counts]
    authors = [set(docs.iloc[idx].author) - {"", "[deleted]", "[removed]", "unknown"} for idx in frames]
    valid_topics = sorted(set(topic_labels) - {-1})
    distributions = [np.asarray([np.count_nonzero(topic_labels[idx] == topic) for topic in valid_topics]) for idx in frames]
    center = scope.unit_emb.mean(axis=0)
    semantic = np.vstack([scope.unit_emb[indices].mean(axis=0) - center for indices in frames])
    semantic /= np.maximum(1e-9, np.linalg.norm(semantic, axis=1, keepdims=True))
    try:
        vocab = TfidfVectorizer(tokenizer=CM.clean_tokens, token_pattern=None, lowercase=False, max_features=8000).fit_transform(
            ["\n".join(docs.iloc[indices].norm) for indices in frames])
    except ValueError:
        words = np.zeros((len(frames), len(frames)))
    else:
        words = (vocab @ vocab.T).toarray()

    metrics = {layer: {} for layer in ("authors_jaccard", "vocabulary_tfidf", "topic_js", "centered_semantic")}
    for i, j in combinations(range(len(frames)), 2):
        a, b = authors[i], authors[j]
        if len(a & b) >= 2:
            metrics["authors_jaccard"][i, j] = len(a & b) / len(a | b)
        metrics["vocabulary_tfidf"][i, j] = float(words[i, j])
        u, v = distributions[i], distributions[j]
        if u.sum() >= 5 and v.sum() >= 5:
            metrics["topic_js"][i, j] = 1 - float(jensenshannon(u, v, base=2))
        metrics["centered_semantic"][i, j] = float(semantic[i] @ semantic[j])

    layers = {}
    for layer, weights in metrics.items():
        neighbors = [set([j for j, _ in sorted(((b if a == i else a, w) for (a, b), w in weights.items() if i in (a, b)
                                               and np.isfinite(w) and w > .03), key=lambda pair: (-pair[1], pair[0]))[:4]])
                     for i in range(len(frames))]
        graph = nx.Graph()
        graph.add_nodes_from(range(len(frames)))
        graph.add_weighted_edges_from((a, b, w) for (a, b), w in weights.items() if a in neighbors[b] and b in neighbors[a])

        def partition(seed):
            partition = nx.algorithms.community.louvain_communities(graph, seed=seed) if graph.number_of_edges() else [{i} for i in graph]
            labels = {i: group for group, cluster in enumerate(sorted(partition, key=min)) for i in cluster}
            return [labels[i] for i in range(len(graph))]

        groups = partition(42)
        stability = float(adjusted_rand_score(groups, partition(17))) if graph.number_of_edges() else None
        nodes = [{"community": name, "group": groups[i], "support": len(frames[i]),
                  "valid_authors": len(authors[i]), "evidence_ref": docs.iloc[frames[i]]["doc_id"].head(4).tolist()}
                 for i, name in enumerate(counts)]
        links = [{"a": counts[i], "b": counts[j], "weight": float(row["weight"]),
                  "support": len(authors[i] & authors[j]) if layer == "authors_jaccard" else min(len(frames[i]), len(frames[j]))}
                 for i, j, row in graph.edges(data=True)]
        layers[layer] = {"nodes": nodes, "links": links, "stability_ari": stability, "groups": len(set(groups))}
    return {"method": "networkx_louvain_mutual_top4_neighbors", "layers": layers}
