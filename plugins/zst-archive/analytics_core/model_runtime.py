"""
Potion Multilingual 128M INT8 - CPU 推理运行时
=================================================

模型来源: https://huggingface.co/soubruno/potion-multilingual-128M-int8
基座模型: minishlab/potion-multilingual-128M (Model2Vec 静态嵌入)

本文件不依赖 PyTorch，直接用 NumPy + tokenizers + safetensors 复现模型语义:

1. 词表嵌入矩阵 int8 形状 (500353, 256)，按行做对称量化:
       scale_r = max(|x_r|) / 127
       q_r     = round(x_r / scale_r)  , clamp[-127, 127]
   反量化: E_r = q_r * scale_r
2. 编码: 对文本 token 序列的 (反量化) 向量做均值池化;
3. 归一化: L2 归一化 (config.normalize = true)。

整个过程是一次 "gather + 加权求和"，没有任何矩阵乘法参与文本编码，
因此 CPU 吞吐远高于同参数量的 BERT 类模型（后者需要 12~24 层 attention）。
"""

from __future__ import annotations

import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from typing import Iterable, Sequence

import numpy as np
from safetensors import safe_open
from tokenizers import Tokenizer

if __package__:
    from .cpu_runtime import check_cancelled, cpu_workers, managed_job, operator
else:
    from cpu_runtime import check_cancelled, cpu_workers, managed_job, operator


@dataclass
class ModelMeta:
    name: str
    path: str
    dim: int
    vocab_size: int
    params: int
    quant: str
    file_bytes: int
    load_ms: float
    normalize: bool
    tokenizer_name: str
    arch: str = "StaticModel (Model2Vec)"
    dequant_bytes: int = 0


class PotionINT8Encoder:
    """INT8 静态嵌入推理器（纯 CPU / NumPy）。"""

    def __init__(self, model_dir: str, eager_dequant: bool = False):
        t0 = time.perf_counter()
        self.workers = cpu_workers()
        self._pool = None
        self.model_dir = model_dir
        with open(os.path.join(model_dir, "config.json"), "r", encoding="utf-8") as f:
            self.config = json.load(f)
        self.dim = int(self.config.get("hidden_dim", 256))
        self.normalize = bool(self.config.get("normalize", True))
        self.tokenizer_name = str(self.config.get("tokenizer_name", ""))
        self.seq_length = int(self.config.get("seq_length", 1_000_000))

        self.tokenizer = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
        self.tokenizer.no_padding()
        self.tokenizer.no_truncation()
        self._encode_plain = self.tokenizer.encode_batch  # 见 _tokenize

        st_path = os.path.join(model_dir, "model.safetensors")
        with safe_open(st_path, framework="numpy") as f:
            keys = list(f.keys())
            emb = f.get_tensor("embeddings")
            if emb.dtype != np.int8:
                emb = emb.astype(np.int8) if emb.dtype.kind == "f" else emb
            w = f.get_tensor("weights") if "weights" in keys else None
        if w is None:
            w = np.ones(emb.shape[0], dtype=np.float32)
        self.emb_i8: np.ndarray = np.ascontiguousarray(emb, dtype=np.int8)
        self.weights: np.ndarray = np.ascontiguousarray(w.reshape(-1), dtype=np.float32)
        self.vocab_size, self.actual_dim = self.emb_i8.shape
        self.dim = self.actual_dim
        # 文件内实际参数规模(以原始 fp32 计) ≈ vocab*dim
        self.params = self.vocab_size * self.dim

        # 可选: 预先反量化为 fp16 常驻内存, 换取更高吞吐(内存换速度)
        self.eager = eager_dequant
        self.emb_f16 = None
        if eager_dequant:
            self.emb_f16 = (self.emb_i8.astype(np.float32) * self.weights[:, None]).astype(np.float16)

        self.lock = threading.Lock()
        self.load_ms = (time.perf_counter() - t0) * 1000.0
        self.meta = ModelMeta(
            name="potion-multilingual-128M-int8",
            path=model_dir,
            dim=self.dim,
            vocab_size=self.vocab_size,
            params=self.params,
            quant="int8 (symmetric, per-row absmax)",
            file_bytes=os.path.getsize(st_path),
            load_ms=round(self.load_ms, 2),
            normalize=self.normalize,
            tokenizer_name=self.tokenizer_name,
            dequant_bytes=int(self.vocab_size * self.dim * 4 + self.vocab_size * 4),
        )
        # 累计运行统计
        self.stats = {
            "docs": 0,
            "tokens": 0,
            "encode_ms": 0.0,
            "batches": 0,
        }

    # ------------------------------------------------------------------ #
    # tokenization
    # ------------------------------------------------------------------ #
    def tokenize(self, texts: Sequence[str]) -> list[list[int]]:
        """不添加 special token，避免 <s>/</s> 常量向量造成的公共偏移。"""
        encs = self.tokenizer.encode_batch(list(texts), add_special_tokens=False)
        return [e.ids for e in encs]

    # ------------------------------------------------------------------ #
    # 核心编码
    # ------------------------------------------------------------------ #
    @managed_job("potion_embedding")
    def encode(
        self,
        texts: Sequence[str],
        batch_size: int = 256,
        max_tokens: int = 512,
        return_tokens: bool = False,
    ) -> np.ndarray | tuple[np.ndarray, int]:
        """把文本编码为 (n, dim) 的 L2 归一化向量。"""
        n = len(texts)
        out = np.zeros((n, self.dim), dtype=np.float32)
        total_tokens = 0
        t_start = time.perf_counter()
        starts = range(0, n, batch_size)

        def encode_batch(start):
            ids_list = self.tokenize(texts[start : start + batch_size])
            if max_tokens and max_tokens > 0:
                ids_list = [ids[:max_tokens] for ids in ids_list]
            return self._encode_ids(ids_list), sum(map(len, ids_list))

        workers = min(self.workers, len(starts))
        with operator("potion_batch", workers):
            if workers > 1:
                if self._pool is None:
                    self._pool = ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix="potion")
                # Bound pending tokenization and quantized gather buffers.
                for offset in range(0, len(starts), workers):
                    check_cancelled()
                    group = starts[offset:offset + workers]
                    pending = [self._pool.submit(encode_batch, start) for start in group]
                    wait(pending)
                    for start, job in zip(group, pending, strict=True):
                        vecs, tokens = job.result()
                        out[start : start + len(vecs)] = vecs
                        total_tokens += tokens
            else:
                for start in starts:
                    check_cancelled()
                    vecs, tokens = encode_batch(start)
                    out[start : start + len(vecs)] = vecs
                    total_tokens += tokens
        dt = (time.perf_counter() - t_start) * 1000.0
        with self.lock:
            self.stats["docs"] += n
            self.stats["tokens"] += total_tokens
            self.stats["encode_ms"] += dt
            self.stats["batches"] += max(1, (n + batch_size - 1) // batch_size)
        if return_tokens:
            return out, total_tokens
        return out

    def _encode_ids(self, ids_list: list[list[int]]) -> np.ndarray:
        b = len(ids_list)
        lengths = np.fromiter((len(x) for x in ids_list), dtype=np.int64, count=b)
        maxlen = int(lengths.max()) if b and lengths.max() > 0 else 1
        ids = np.zeros((b, maxlen), dtype=np.int64)
        mask = np.zeros((b, maxlen), dtype=np.float32)
        for i, x in enumerate(ids_list):
            if not x:
                continue
            arr = np.asarray(x, dtype=np.int64)
            arr = np.clip(arr, 0, self.vocab_size - 1)
            ids[i, : len(arr)] = arr
            mask[i, : len(arr)] = 1.0

        if self.emb_f16 is not None:
            rows = self.emb_f16[ids]                      # (b, L, dim) fp16
            vecs = np.einsum("bl,blk->bk", mask, rows.astype(np.float32))
        else:
            rows = self.emb_i8[ids]                        # (b, L, dim) int8
            w = self.weights[ids] * mask                   # (b, L)
            vecs = np.einsum("bl,blk->bk", w, rows.astype(np.float32))

        counts = np.maximum(mask.sum(axis=1, keepdims=True), 1.0)
        vecs = vecs / counts
        if self.normalize:
            norms = np.linalg.norm(vecs, axis=1, keepdims=True)
            vecs = vecs / np.maximum(norms, 1e-12)
        return vecs.astype(np.float32)

    # ------------------------------------------------------------------ #
    # 检索辅助
    # ------------------------------------------------------------------ #
    @staticmethod
    def topk(query: np.ndarray, matrix: np.ndarray, k: int = 10) -> tuple[np.ndarray, np.ndarray]:
        """余弦相似度 top-k（向量已归一化，等价点积）。"""
        q = query.reshape(-1).astype(np.float32)
        qn = np.linalg.norm(q)
        if qn > 0:
            q = q / qn
        scores = matrix @ q
        k = min(k, scores.shape[0])
        idx = np.argpartition(-scores, k - 1)[:k]
        idx = idx[np.argsort(-scores[idx])]
        return idx, scores[idx]

    def info(self) -> dict:
        st = dict(self.stats)
        st["avg_ms_per_doc"] = round(st["encode_ms"] / st["docs"], 4) if st["docs"] else 0.0
        st["tokens_per_s"] = round(st["tokens"] / (st["encode_ms"] / 1000.0), 1) if st["encode_ms"] else 0.0
        st["docs_per_s"] = round(st["docs"] / (st["encode_ms"] / 1000.0), 1) if st["encode_ms"] else 0.0
        return {
            "meta": self.meta.__dict__,
            "runtime": {
                "dtype": "fp16-cache" if self.emb_f16 is not None else "int8 on-the-fly dequant",
                "threads": self.workers,
                "numpy": np.__version__,
                "eager_dequant": self.eager,
                "resident_emb_mb": round(
                    (self.vocab_size * self.dim * (2 if self.emb_f16 is not None else 1)) / 1024 / 1024, 1
                ),
            },
            "stats": st,
        }


if __name__ == "__main__":  # 冒烟测试
    import sys

    d = sys.argv[1] if len(sys.argv) > 1 else "models/potion-int8"
    enc = PotionINT8Encoder(d)
    print(json.dumps(enc.info(), ensure_ascii=False, indent=2))
    texts = ["I love this update, it works great", "这个更新太糟糕了，全是 bug", "Olá, mundo!"]
    v, nt = enc.encode(texts, return_tokens=True)
    print("shape", v.shape, "tokens", nt, "norm", np.linalg.norm(v, axis=1))
    sim = v @ v.T
    print(np.round(sim, 4))
