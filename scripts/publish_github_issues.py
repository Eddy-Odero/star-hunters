#!/usr/bin/env python3
"""Publish Star Hunters issues to GitHub via `gh` CLI in topological order with assignees,
completed status closure (`ISS-01`, `ISS-02`), and native `blockedBy` links.

Usage:
  1. Dry-run validation (default):
     python3 scripts/publish_github_issues.py --dry-run

  2. Create labels, create & assign all 22 issues, close completed issues (ISS-01, ISS-02),
     and wire native GitHub blockedBy relations:
     python3 scripts/publish_github_issues.py --execute

  3. Re-apply or override collaborator assignments from a JSON map:
     python3 scripts/publish_github_issues.py --assign-map collaborators.json [--execute]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
from typing import Any, Dict, List


REPO_ROOT = Path(__file__).resolve().parent.parent
ALL_ISSUES_JSON = REPO_ROOT / "issues" / "all_issues.json"
PUBLISHED_MAP_FILE = REPO_ROOT / "issues" / ".published_github_map.json"


LABEL_COLORS: Dict[str, str] = {
    "phase:1": "0E8A16",
    "phase:2": "1D76DB",
    "phase:3": "5319E7",
    "area:architecture": "0052CC",
    "area:contracts": "006B75",
    "area:backend": "D93F0B",
    "area:frontend": "FBCA04",
    "area:presets": "C2E0C6",
    "area:spherex-pipeline": "5319E7",
    "area:multi-mission": "006B75",
    "area:known-objects": "B60205",
    "area:pixel-engine": "E99695",
    "area:tracking": "F9D0C4",
    "area:caching-3g": "0E8A16",
    "area:database": "D4C5F9",
    "area:astronomy": "1D76DB",
    "area:catalogs": "BFD4F2",
    "area:wcs": "C5DEF5",
    "area:spectrophotometry": "5319E7",
    "area:api": "D93F0B",
    "area:sky-map": "006B75",
    "area:ui-ux": "FBCA04",
    "area:discovery-flow": "FEF2C0",
    "area:integration": "0052CC",
    "area:devops": "0E8A16",
    "area:verification": "B60205",
    "role:dev-1": "BFDADC",
    "role:dev-2": "D4C5F9",
    "role:dev-3": "C2E0C6",
    "role:dev-4": "F9D0C4",
    "role:dev-5": "FEF2C0",
}


def load_issues_bundle(require_assigned: bool = True) -> Dict[str, Any]:
    if not ALL_ISSUES_JSON.exists():
        raise FileNotFoundError(f"Missing {ALL_ISSUES_JSON}; run scripts/generate_issues_artifacts.py first.")
    data = json.loads(ALL_ISSUES_JSON.read_text(encoding="utf-8"))
    issues = data["issues"]
    id_to_order = {i["id"]: i["order"] for i in issues}
    id_to_status = {i["id"]: i.get("status", "open") for i in issues}
    for item in issues:
        if require_assigned and not item.get("assignees"):
            raise ValueError(f"Issue {item['id']} must have at least one assignee.")
        for dep in item["blocked_by"]:
            if id_to_status.get(dep) == "completed":
                raise ValueError(f"Completed issue {dep} must not remain in {item['id']}.blocked_by")
            if id_to_order[dep] >= item["order"]:
                raise ValueError(f"Topological violation: {item['id']} blocked by {dep}")
        for blk in item["blocking"]:
            if id_to_order[blk] <= item["order"]:
                raise ValueError(f"Topological violation: {item['id']} blocking {blk}")
    return data


def run_gh(args: List[str], dry_run: bool = True) -> str:
    cmd = ["gh", *args]
    if dry_run:
        print("[DRY-RUN]", " ".join(cmd))
        return ""
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return res.stdout.strip()


def ensure_labels(labels: List[str], dry_run: bool = True) -> None:
    for lbl in labels:
        color = LABEL_COLORS.get(lbl, "EDEDED")
        run_gh(
            ["label", "create", lbl, "--color", color, "--force"],
            dry_run=dry_run,
        )


def publish_issues(bundle: Dict[str, Any], dry_run: bool = True) -> None:
    issues: List[Dict[str, Any]] = bundle["issues"]
    ensure_labels(bundle["labels"], dry_run=dry_run)

    created_map: Dict[str, Dict[str, Any]] = {}
    if not dry_run and PUBLISHED_MAP_FILE.exists():
        try:
            created_map = json.loads(PUBLISHED_MAP_FILE.read_text(encoding="utf-8"))
        except Exception:
            created_map = {}

    for item in issues:
        issue_id = item["id"]
        title = item["title"]
        body = item["github_body"]
        label_arg = ",".join(item["labels"])
        assignees = item.get("assignees", [])
        assignee_arg = ",".join(assignees)
        status = item.get("status", "open")

        if dry_run:
            fake_num = item["order"]
            created_map[issue_id] = {
                "number": fake_num,
                "node_id": f"I_kwDO_FAKE_{fake_num:02d}",
                "url": f"https://github.com/OWNER/REPO/issues/{fake_num}",
                "status": status,
                "assignees": assignees,
            }
            print(
                f"[DRY-RUN] Create {issue_id}: '{title}' "
                f"(status={status}, labels={label_arg}, blocked_by={item['blocked_by']}, assignees={assignees})"
            )
            if status == "completed":
                run_gh(
                    ["issue", "close", str(fake_num), "--reason", "completed"],
                    dry_run=True,
                )
        elif issue_id in created_map:
            print(f"[SKIP] {issue_id} already published as #{created_map[issue_id]['number']}")
        else:
            create_cmd = ["issue", "create", "--title", title, "--body", body, "--label", label_arg]
            if assignee_arg:
                create_cmd.extend(["--assignee", assignee_arg])
            try:
                url = run_gh(create_cmd, dry_run=False)
            except subprocess.CalledProcessError:
                # Fallback if a collaborator has not yet accepted the repo invitation
                url = run_gh(
                    ["issue", "create", "--title", title, "--body", body, "--label", label_arg],
                    dry_run=False,
                )
                num_fallback = url.rstrip("/").split("/")[-1]
                for user in assignees:
                    try:
                        run_gh(
                            ["issue", "edit", num_fallback, "--add-assignee", user],
                            dry_run=False,
                        )
                    except subprocess.CalledProcessError as exc:
                        print(f"[WARN] Could not assign @{user} to #{num_fallback}: {exc.stderr.strip() if exc.stderr else exc}")

            num_str = url.rstrip("/").split("/")[-1]
            node_id = run_gh(
                ["issue", "view", num_str, "--json", "id", "--jq", ".id"],
                dry_run=False,
            )
            if status == "completed":
                run_gh(
                    ["issue", "close", num_str, "--reason", "completed"],
                    dry_run=False,
                )
            created_map[issue_id] = {
                "number": int(num_str),
                "node_id": node_id,
                "url": url,
                "status": status,
                "assignees": assignees,
            }
            PUBLISHED_MAP_FILE.write_text(
                json.dumps(created_map, indent=2) + "\n", encoding="utf-8"
            )
            print(f"Created {issue_id} -> #{num_str} ({url}) [status={status}, assignees={assignees}]")

    # Wire native GitHub `addBlockedBy` GraphQL relations & update issue bodies with exact #number links
    mutation = """
    mutation($issueId: ID!, $blockingIssueId: ID!) {
      addBlockedBy(input: {issueId: $issueId, blockingIssueId: $blockingIssueId}) {
        issue { number }
        blockingIssue { number }
      }
    }
    """.strip()

    for item in issues:
        issue_id = item["id"]
        issue_meta = created_map[issue_id]
        for blocker_id in item["blocked_by"]:
            blocker_meta = created_map[blocker_id]
            try:
                run_gh(
                    [
                        "api",
                        "graphql",
                        "-f",
                        f"query={mutation}",
                        "-F",
                        f"issueId={issue_meta['node_id']}",
                        "-F",
                        f"blockingIssueId={blocker_meta['node_id']}",
                    ],
                    dry_run=dry_run,
                )
            except subprocess.CalledProcessError as exc:
                print(
                    f"[WARN] GraphQL addBlockedBy failed for {issue_id} <- {blocker_id} "
                    f"({exc.stderr.strip() if exc.stderr else exc}); continuing with Markdown #number links."
                )

        # Replace symbolic ISS-XX with #number in issue body once all numbers are known
        updated_body = item["github_body"]
        for cand_id, cand_meta in created_map.items():
            updated_body = updated_body.replace(
                f"`{cand_id}`", f"`{cand_id}` (#{cand_meta['number']})"
            )
        if not dry_run:
            run_gh(
                ["issue", "edit", str(issue_meta["number"]), "--body", updated_body],
                dry_run=False,
            )

    if not dry_run:
        PUBLISHED_MAP_FILE.write_text(
            json.dumps(created_map, indent=2) + "\n", encoding="utf-8"
        )


def _normalize_role_map(raw_map: Dict[str, Any]) -> Dict[str, List[str]]:
    normalized: Dict[str, List[str]] = {}
    for k, v in raw_map.items():
        users = [v] if isinstance(v, str) else [str(u) for u in v]
        key_clean = k.strip()
        if key_clean.lower().startswith("dev-") or key_clean.lower().startswith("dev "):
            num = key_clean.split("-")[-1].split()[-1]
            key_clean = f"role:dev-{num}"
        normalized[key_clean] = [u.lstrip("@").strip() for u in users if u.strip()]
    return normalized


def assign_collaborators(assign_map_path: Path, dry_run: bool = True) -> None:
    """Assign GitHub usernames based on a role-to-username or issue-to-username JSON map."""
    bundle = load_issues_bundle(require_assigned=False)
    raw_map: Dict[str, Any] = json.loads(assign_map_path.read_text(encoding="utf-8"))
    role_map = _normalize_role_map(raw_map)
    published_map: Dict[str, Any] = (
        json.loads(PUBLISHED_MAP_FILE.read_text(encoding="utf-8"))
        if PUBLISHED_MAP_FILE.exists()
        else {}
    )

    for item in bundle["issues"]:
        issue_id = item["id"]
        issue_num = published_map.get(issue_id, {}).get("number", item["order"])
        matched_users: List[str] = []
        if issue_id in role_map:
            for u in role_map[issue_id]:
                if u not in matched_users:
                    matched_users.append(u)
        for lbl in item["labels"]:
            if lbl in role_map:
                for u in role_map[lbl]:
                    if u not in matched_users:
                        matched_users.append(u)
        if matched_users:
            run_gh(
                [
                    "issue",
                    "edit",
                    str(issue_num),
                    "--add-assignee",
                    ",".join(matched_users),
                ],
                dry_run=dry_run,
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Execute `gh` commands against the live GitHub repository (default is --dry-run).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate topological ordering and print the `gh` commands without creating issues.",
    )
    parser.add_argument(
        "--assign-map",
        type=Path,
        default=None,
        help="Optional JSON file mapping issue IDs or role labels to GitHub usernames.",
    )
    args = parser.parse_args()
    dry_run = not args.execute

    bundle = load_issues_bundle()
    if args.assign_map:
        assign_collaborators(args.assign_map, dry_run=dry_run)
    else:
        publish_issues(bundle, dry_run=dry_run)

    print(
        f"Completed {'DRY-RUN' if dry_run else 'LIVE EXECUTION'} for "
        f"{bundle['total_issues']} topologically ordered issues."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
