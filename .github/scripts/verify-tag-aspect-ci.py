#!/usr/bin/env python3
"""
verify-tag-aspect-ci.py — CI version of TAG aspect-status verifier.

Runs the 5 signal-based checks (no fs checks — the git-crypt-encrypted config
files + the .GenAI_Work workspace files are not available/valid in CI).
Publishes to R2 data/tag-aspect-status.json.

Full 9-aspect verification (incl. configuration/discoverability/documentation/
change_mgmt, which need unlocked workspace files): run verify-tag-aspect-status.js
from the workspace (projects/zjp/scripts/).

Mirrors verify-agg-aspect-ci.py (per ASPECT_STATUS_CONTRACT.md verified model,
DASH-QUALITYMATRIX-ACTIONABILITY-1 / TAG-ASPECT-VERIFY-1).

Usage: python3 .github/scripts/verify-tag-aspect-ci.py [--publish]
Env: GH_TOKEN (or GITHUB_TOKEN), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
     R2_ENDPOINT, R2_BUCKET_NAME
"""
import json, os, subprocess, sys, datetime

NOW = datetime.datetime.now(datetime.timezone.utc)
TAG_REPO = "zapplyjobs/job-board-aggregator"
PROXY = os.environ.get("ASPECT_PROXY", "https://zjp-data-proxy.wild-queen-069e.workers.dev/data")

def gh_json(args):
    try:
        out = subprocess.check_output(["gh"] + args, text=True, stderr=subprocess.DEVNULL, timeout=30)
        return json.loads(out) if out.strip() else None
    except Exception:
        return None

def gh_runconclusion(repo, workflow=None, limit=3):
    args = ["run", "list", "-R", repo, "-L", str(limit), "--json", "status,conclusion,createdAt"]
    if workflow:
        args += ["--workflow", workflow]
    rows = gh_json(args) or []
    return [r for r in rows if r.get("status") == "completed"]

def proxy_json(path):
    try:
        out = subprocess.check_output(["curl", "-sf", f"{PROXY}/{path}"], text=True, timeout=15)
        return json.loads(out) if out.strip() else None
    except Exception:
        return None

def bucket_low(v, g, y): return "GREEN" if v <= g else ("YELLOW" if v <= y else "RED")

def c_verification():
    runs = gh_runconclusion(TAG_REPO, workflow="ci-gate.yml", limit=3)
    if not runs:
        return "RED", "no completed ci-gate runs", "gh-api:CI"
    latest = runs[0]
    fails = [r for r in runs if r.get("conclusion") != "success"]
    s = "GREEN" if latest.get("conclusion") == "success" else "RED"
    return s, f"ci-gate last {latest.get('conclusion')} ({latest['createdAt'][:10]}), {len(fails)} fail/3", "gh-api:ci-gate.yml"

def c_monitoring():
    m = proxy_json("zjp-metrics.json")
    if not m:
        return "RED", "metrics unreadable", "proxy:metrics"
    has_tag = bool(m.get("pool", {}).get("g1_us"))
    gen = m.get("generated_at") or m.get("generated", "")
    age_min = 9999.0
    if gen:
        try:
            age_min = (NOW - datetime.datetime.fromisoformat(gen.replace("Z", "+00:00"))).total_seconds() / 60
        except Exception:
            pass
    if has_tag and age_min <= 60:
        return "GREEN", f"tag-monitor output present (g1_us); metrics {age_min:.0f}min old", "zjp-metrics.pool.g1_us"
    if has_tag and age_min <= 1440:
        return "YELLOW", f"tag-monitor output present; metrics {age_min:.0f}min old (stale)", "zjp-metrics.pool.g1_us"
    return "RED", f"metrics {age_min:.0f}min old or tag fields missing", "zjp-metrics"

def c_data_quality():
    # TAG data_quality = classification coverage (US G1), NOT retrievable-rate (AGG-scoped)
    m = proxy_json("zjp-metrics.json")
    if not m:
        return "RED", "metrics unreadable", "proxy:metrics"
    g1 = (m.get("pool", {}).get("g1_us", {}) or {}).get("us_general_rate_pct")
    if g1 is None:
        return "YELLOW", "US G1 rate missing", "zjp-metrics.pool.g1_us"
    s = bucket_low(g1, 15, 20)
    return s, f"US G1 {g1}% — threshold <15/<20 (TAG data_quality = classification coverage)", "zjp-metrics.pool.g1_us.us_general_rate_pct"

def c_performance():
    m = proxy_json("zjp-metrics.json")
    if not m:
        return "RED", "metrics unreadable", "proxy:metrics"
    st = (m.get("pipeline", {}).get("stage_timings", {}) or {})
    ms = st.get("step5_tag_ms") or st.get("tag")
    if ms is None:
        return "YELLOW", "tag step runtime missing", "zjp-metrics.pipeline.stage_timings"
    s = bucket_low(ms, 60000, 120000)
    return s, f"tag step {ms/1000:.1f}s — target <60s, alert <120s", "zjp-metrics.pipeline.stage_timings.step5_tag_ms"

def c_security():
    alerts = gh_json(["api", f"repos/{TAG_REPO}/dependabot/alerts?state=open&per_page=50"]) or []
    total = len(alerts)
    crit = sum(1 for a in alerts if a.get("security_vulnerability", {}).get("severity", "") in ("critical", "high"))
    if crit == 0:
        return "GREEN", f"{total} open, 0 critical/high", "gh-api:dependabot"
    if crit <= 2:
        return "YELLOW", f"{total} open, {crit} critical/high", "gh-api:dependabot"
    return "RED", f"{total} open, {crit} critical/high", "gh-api:dependabot"


# --- CI-native proxy checks (per INF-ASPECT-CI-NATIVE-1 design: gh-api repo-state replaces workspace-fs) ---
def c_configuration():
    # PROXY: config files exist in repo (git-crypt encrypted; validity via ci-gate parity test).
    files = ["lib/fetchers/company-list.json", "lib/processors/onet-unified-lookup.json", "lib/processors/wd-family-domain-map.json"]
    found = sum(1 for f in files if gh_json(["api", f"repos/{TAG_REPO}/contents/{f}"]))
    if found == len(files):
        return "GREEN", f"{found}/{len(files)} config files present in repo (git-crypt encrypted; validity via ci-gate parity)", "gh-api:repo-contents"
    return "YELLOW", f"{found}/{len(files)} config files found in repo", "gh-api:repo-contents"

def c_discoverability():
    # PROXY: TAG engine present in PUBLIC job-board-aggregator (guide is in PRIVATE zjp-dashboard —
    # CI's GITHUB_TOKEN can't read it cross-repo; contract/registry are workspace-only).
    engine = gh_json(["api", f"repos/{TAG_REPO}/contents/lib/processors/tag-engine.js"])
    if engine:
        return "GREEN", "tag-engine.js present in public job-board-aggregator (guide in private zjp-dashboard; contract/registry workspace-only)", "gh-api:repo-contents"
    return "YELLOW", "tag-engine.js not found in job-board-aggregator", "gh-api:repo-contents"

def c_documentation():
    # PROXY: recent commit to tag-engine.js (repo activity -> doc/code freshness).
    commits = gh_json(["api", f"repos/{TAG_REPO}/commits?per_page=1&path=lib/processors/tag-engine.js"]) or []
    if not commits:
        return "YELLOW", "no commits found on tag-engine.js", "gh-api:commits"
    date = commits[0].get("commit", {}).get("committer", {}).get("date", "")[:10]
    return "GREEN", f"latest tag-engine.js commit {date} (repo-activity proxy for doc freshness)", "gh-api:commits"

def c_change_mgmt():
    # PROXY: ci-gate.yml exists (structural proxy for SDLC + change-mgmt practices).
    gate = gh_json(["api", f"repos/{TAG_REPO}/contents/.github/workflows/ci-gate.yml"])
    if gate:
        return "GREEN", "ci-gate.yml present (structural proxy for SDLC + change-mgmt)", "gh-api:repo-contents"
    return "YELLOW", "ci-gate.yml not found", "gh-api:repo-contents"

CHECKS = {
    "verification": c_verification,
    "monitoring": c_monitoring,
    "data_quality": c_data_quality,
    "performance": c_performance,
    "security": c_security,
    "configuration": c_configuration,
    "discoverability": c_discoverability,
    "documentation": c_documentation,
    "change_mgmt": c_change_mgmt,
    # infrastructure OMITTED — TAG has no deploy (runs inline in AGG Step 5); genuinely N/A.
    # Matrix renders omitted aspects as N/A (ASPECT_STATUS_CONTRACT, verified G20).
}

result = {"module": "TAG", "generated_at": NOW.isoformat(), "aspects": {}}
for name, fn in CHECKS.items():
    try:
        s, e, src = fn()
    except Exception as ex:
        s, e, src = "RED", f"check error: {ex}", "verifier-error"
    result["aspects"][name] = {"status": s, "evidence": e, "source": src}

# Infrastructure is genuinely N/A for TAG — include it WITH A REASON so the matrix cell is
# informative (clickable with explanation), not just "omitted → generic N/A text".
result["aspects"]["infrastructure"] = {
    "status": "N/A",
    "evidence": "TAG has no deploy — runs inline in AGG Step 5 (pure-function library; no Worker/server/API/R2 of its own). Infrastructure it depends on (pipeline/R2/CI) is owned + checked by AGG/INF in their aspect rows.",
    "source": "N/A — no independent infrastructure"
}

data_str = json.dumps(result, indent=2)
print(data_str)
counts = {}
for a in result["aspects"].values():
    counts[a["status"]] = counts.get(a["status"], 0) + 1
print(f"\n=== TAG aspect-status (CI) === {counts.get('GREEN',0)}G / {counts.get('YELLOW',0)}Y / {counts.get('RED',0)}R / {counts.get('N/A',0)}N/A ({len(result['aspects'])} aspects: 9 checked + 1 N/A)", file=sys.stderr)

if "--publish" in sys.argv:
    import boto3
    s3 = boto3.client("s3", region_name="auto",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"])
    s3.put_object(Bucket=os.environ["R2_BUCKET_NAME"],
                  Key="data/tag-aspect-status.json", Body=data_str, ContentType="application/json")
    print("published R2: data/tag-aspect-status.json", file=sys.stderr)
