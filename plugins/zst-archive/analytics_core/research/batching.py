"""Ordered CPU-bound batches. Worker processes never launch native teams."""

from concurrent.futures import ProcessPoolExecutor, wait
from concurrent.futures.process import BrokenProcessPool
from math import ceil
from multiprocessing import get_context
from os import name

from cpu_runtime import check_cancelled, cpu_workers, managed_job, operator


_pool = None
_pool_size = 0
MIN_PARALLEL_DOCUMENTS = 1600


def _worker_start():
    from threadpoolctl import threadpool_limits

    threadpool_limits(limits=1)


def _executor(workers):
    global _pool, _pool_size
    if _pool_size != workers:
        if _pool:
            _pool.shutdown(cancel_futures=True)
        _pool = ProcessPoolExecutor(max_workers=workers, mp_context=get_context("spawn"), initializer=_worker_start)
        _pool_size = workers
    return _pool


@managed_job("ordered_rules")
def ordered_map(worker, rows, *args, label, parallel=True, on_batch=None):
    """Bound submissions by batch count and wait for work before releasing its lease."""
    global _pool, _pool_size
    n = len(rows)
    limit = min(cpu_workers(), 61) if name == "nt" else cpu_workers()
    workers = min(limit, ceil(n / 480)) if parallel and n >= MIN_PARALLEL_DOCUMENTS else 1
    if workers <= 1:
        with operator(label):
            return [worker(rows, *args)]
    width = max(192, ceil(n / (workers * 3)))
    results = []
    with operator(label, workers):
        pool = _executor(workers)
        submitted = []
        try:
            submitted = [pool.submit(worker, rows[i:i + width], *args) for i in range(0, n, width)]
            for index, item in enumerate(submitted):
                check_cancelled()
                results.append(item.result())
                if on_batch:
                    on_batch(min((index + 1) * width, n), n)
            check_cancelled()
        except BaseException as exc:
            for future in submitted:
                future.cancel()
            wait(submitted)
            if isinstance(exc, BrokenProcessPool):
                pool.shutdown(cancel_futures=True)
                _pool, _pool_size = None, 0
            raise
    return results
