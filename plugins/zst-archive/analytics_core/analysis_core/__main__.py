"""Run the portable operators against canonical JSONL on a local machine."""

import argparse
import json
from pathlib import Path
import sys

from . import ALIASES, CONDITIONAL, PANELS, SELECTED, Config, Filters, JSONLAdapter, Study, manifest


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    source = cli.add_mutually_exclusive_group(required=True)
    source.add_argument("--input", type=Path)
    source.add_argument("--v4-scope")
    source.add_argument("--manifest", action="store_true")
    choice = cli.add_mutually_exclusive_group()
    choice.add_argument("--metric", choices=sorted(SELECTED | ALIASES | CONDITIONAL))
    choice.add_argument("--panel", choices=sorted(PANELS))
    cli.add_argument("--version", help="Required version of a canonical JSONL dataset")
    cli.add_argument("--profile", choices=("fast", "balanced"), default="fast")
    cli.add_argument("--seed", action="append", default=[])
    cli.add_argument("--group-by", choices=("group", "source", "dataset", "kind", "language"), default="group")
    cli.add_argument("--coverage", type=Path, help="JSON object of UTC days to complete, partial or missing")
    cli.add_argument("--no-near-duplicates", action="store_true")
    cli.add_argument("--from", dest="start")
    cli.add_argument("--to", dest="end")
    cli.add_argument("--group", action="append", default=[])
    cli.add_argument("--source", action="append", default=[])
    cli.add_argument("--kind", action="append", default=[])
    cli.add_argument("--evidence", help="Resolve a returned evidence ID in the reproduced study")
    cli.add_argument("--offset", type=int, default=0)
    cli.add_argument("--limit", type=int, default=20)
    cli.add_argument("--output", type=Path)
    args = cli.parse_args()
    if args.manifest:
        result = manifest()
    else:
        if args.v4_scope:
            from research.scope import load_scope
            from .archive import resolve_archive
            scope = load_scope(args.v4_scope)
            if scope is None:
                cli.error(f"Unknown V4 scope: {args.v4_scope}")
            study = Study.from_v4(scope, config=Config(tuple(scope.meta["spec"]["seeds"]), args.profile,
                                                        group_by=args.group_by), archive_resolver=resolve_archive)
        else:
            if not args.version:
                cli.error("--version is required when using --input")
            config = Config(tuple(args.seed), args.profile, near_duplicates=not args.no_near_duplicates, group_by=args.group_by)
            coverage = json.loads(args.coverage.read_text(encoding="utf-8")) if args.coverage else None
            study = Study.ingest(JSONLAdapter(args.input), data_version=args.version, config=config, coverage_days=coverage)
        filters = Filters(args.start, args.end, tuple(args.group), tuple(args.source), tuple(args.kind))
        result = (study.run(args.metric, filters) if args.metric else study.panel(args.panel, filters) if args.panel
                  else study.run_all(filters))
        if args.evidence:
            result = study.resolve_evidence(args.evidence, offset=args.offset, limit=args.limit)
    payload = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)
    if args.output:
        args.output.write_text(payload + "\n", encoding="utf-8")
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print(payload)
    if isinstance(result, dict) and result.get("state") in {"failed", "unavailable_dependency"}:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
