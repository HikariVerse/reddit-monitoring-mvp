"""One process-wide compute scheduler for the workbench and portable analysis."""

from collections import deque
from contextlib import contextmanager, nullcontext
from contextvars import ContextVar
from dataclasses import asdict, dataclass
from functools import wraps
from pathlib import Path
from threading import Condition
from time import perf_counter, process_time
import os
import sys


NATIVE_ENV = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
              "NUMEXPR_NUM_THREADS", "BLIS_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "RAYON_NUM_THREADS")


@dataclass(frozen=True)
class CpuPolicy:
    logical_cpu_count: int
    effective_cpu_count: int
    reserved_logical_cpus: int
    workers: int
    affinity: tuple[int, ...] | None
    mode: str
    quota_cpus: int | None


def _cpu_quota():
    if sys.platform != "linux":
        return None
    # The process may reside below the mount root. Apply inherited parent quotas as well.
    root = Path("/sys/fs/cgroup")
    memberships = {}
    try:
        for entry in Path("/proc/self/cgroup").read_text().splitlines():
            _, controller, location = entry.split(":", 2)
            memberships.update((name, location) for name in controller.split(","))
    except (OSError, ValueError):
        pass
    limits = []
    for mount, folder, names in ((root, memberships.get("", "/"), ("cpu.max",)),
                                 (root / "cpu", memberships.get("cpu", "/"), ("cpu.cfs_quota_us", "cpu.cfs_period_us")),
                                 (root / "cpu,cpuacct", memberships.get("cpu", "/"), ("cpu.cfs_quota_us", "cpu.cfs_period_us"))):
        leaf = mount / folder.lstrip("/")
        for path in [leaf, *leaf.parents]:
            if path != mount and mount not in path.parents:
                break
            try:
                parts = [word for name in names for word in (path / name).read_text().split()]
                quota, period = map(int, parts)
            except (OSError, ValueError):
                continue
            if quota > 0 and period > 0:
                limits.append(max(1, quota // period))
    return min(limits) if limits else None


def detect_policy():
    import psutil

    logical = os.cpu_count() or 1
    effective = min(logical, getattr(os, "process_cpu_count", os.cpu_count)() or logical)
    affinity = None
    try:
        bound = psutil.Process().cpu_affinity()
        if bound:
            affinity = tuple(sorted(bound))
            effective = min(effective, len(bound))
    except (AttributeError, NotImplementedError, psutil.Error):
        if hasattr(os, "sched_getaffinity"):
            try:
                affinity = tuple(sorted(os.sched_getaffinity(0)))
                effective = min(effective, len(affinity))
            except OSError:
                pass
    quota = _cpu_quota()
    effective = max(1, min(effective, quota or effective))
    raw = os.getenv("BI_CPU_CORES", "auto").strip().lower()
    if raw in {"", "auto", "auto_minus_one"}:
        return CpuPolicy(logical, effective, min(1, effective - 1), max(1, effective - 1), affinity, "auto_minus_one", quota)
    if not raw.isascii() or not raw.isdecimal() or int(raw) < 1:
        raise ValueError("BI_CPU_CORES must be auto or a positive integer")
    workers = min(effective, int(raw))
    return CpuPolicy(logical, effective, effective - workers, workers, affinity, "explicit", quota)


_policy = None
_lease = ContextVar("analysis_cpu_lease", default=None)


def cpu_policy():
    global _policy
    if _policy is None:
        _policy = detect_policy()
    return _policy


def cpu_workers():
    job = _lease.get()
    return job["workers"] if job else cpu_policy().workers


def configure_cpu():
    """Set idle native pools to one before imports. Keep the OS affinity intact."""
    policy = cpu_policy()
    for name in NATIVE_ENV:
        os.environ[name] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    return asdict(policy)


class AnalysisCancelled(RuntimeError):
    pass


class Budget:
    """Fair whole-job leases, with one active heavy job per process.

    Serial leases make BLAS/OpenMP limits process-wide and race-free. Operators
    parallelize within that lease. A multi-process host uses one shared worker.
    """

    def __init__(self):
        self.lock = Condition()
        self.queue = deque()
        self.running = None
        self.recent = deque(maxlen=16)
        self.next_id = 1

    @contextmanager
    def job(self, name, cancel=None):
        parent = _lease.get()
        if parent is not None:
            check_cancelled()
            yield parent
            return
        with self.lock:
            item = {"id": self.next_id, "name": name, "workers": cpu_policy().workers,
                    "operators": {}, "stages": [], "queued_at": perf_counter(), "cancel": cancel}
            self.next_id += 1
            self.queue.append(item)
            while self.running is not None or self.queue[0] is not item:
                if cancel is not None and cancel.is_set():
                    self.queue.remove(item)
                    self.lock.notify_all()
                    raise AnalysisCancelled(name)
                self.lock.wait(.1 if cancel is not None else None)
            self.queue.popleft()
            if cancel is not None and cancel.is_set():
                self.lock.notify_all()
                raise AnalysisCancelled(name)
            item.update(started_at=perf_counter(), cpu_start=process_time())
            self.running = item
        token = _lease.set(item)
        state = "done"
        try:
            yield item
        except AnalysisCancelled:
            state = "cancelled"
            raise
        except BaseException:
            state = "failed"
            raise
        finally:
            _lease.reset(token)
            with self.lock:
                self.recent.append({**self._record(item), "status": state})
                self.running = None
                self.lock.notify_all()

    def _record(self, item):
        return {"id": item["id"], "name": item["name"], "workers": item["workers"],
                "queued_seconds": round(item["started_at"] - item["queued_at"], 4),
                "elapsed_seconds": round(perf_counter() - item["started_at"], 4),
                "process_cpu_seconds": round(process_time() - item["cpu_start"], 4),
                "active_stage": dict(item["stages"][-1]) if item["stages"] else None,
                "operators": {key: dict(value) for key, value in item["operators"].items()}}

    def status(self):
        with self.lock:
            return {**asdict(cpu_policy()), "running_jobs": int(self.running is not None),
                    "queued_jobs": len(self.queue), "active": self._record(self.running) if self.running else None,
                    "recent_jobs": list(self.recent)}


SCHEDULER = Budget()


def check_cancelled():
    current = _lease.get()
    cancel = current.get("cancel") if current else None
    if cancel is not None and cancel.is_set():
        raise AnalysisCancelled(current["name"])


def managed_job(name):
    def decorate(function):
        @wraps(function)
        def run(*args, **kwargs):
            with SCHEDULER.job(name):
                return function(*args, **kwargs)
        return run
    return decorate


@contextmanager
def operator(name, workers=1, *, native=False, openmp=None):
    """A sequential stage of a job. Native limits are restored after the stage."""
    check_cancelled()
    job = _lease.get()
    workers = max(1, min(cpu_workers(), workers))
    if native:
        from threadpoolctl import threadpool_limits
        # A cap on OpenMP for kernels that create a team for each minibatch.
        limits = {"blas": workers, "openmp": min(workers, openmp or workers)}
        pool = threadpool_limits(limits=limits)
    else:
        pool = nullcontext()
    started = perf_counter()
    if job:
        with SCHEDULER.lock:
            job["stages"].append({"name": name, "workers": workers})
    try:
        with pool:
            yield workers
    finally:
        if job:
            with SCHEDULER.lock:
                job["stages"].pop()
                stage = job["operators"].setdefault(name, {"workers": 0, "calls": 0, "seconds": 0.0})
                stage["workers"] = max(stage["workers"], workers)
                stage["calls"] += 1
                stage["seconds"] = round(stage["seconds"] + perf_counter() - started, 6)
