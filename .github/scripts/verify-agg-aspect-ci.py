#!/usr/bin/env python3
"""
verify-agg-aspect-ci.py — CI version of AGG aspect-status verifier.

Runs the 6 signal-based checks (no fs-based checks — workspace files
not available in CI). Publishes to R2 data/agg-aspect-status.json.

Full 10-aspect verification: run verify-agg-aspect-status.py from the
workspace (projects/zjp/scripts/).

Usage: python3 .github/scripts/verify-agg-aspect-ci.py
Env: GH_TOKEN (or GITHUB_TOKEN), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
     R2_ENDPOINT, R2_BUCKET_NAME
"""
import json, os, subprocess, sys, datetime

NOW = datetime.datetime.now(datetime.timezone.utc)
AGG_REPO = "zapplyjobs/jobs-aggregator-private"
AGG_REPOS = ["zapplyjobs/jobs-aggregator-private", "zapplyjobs/job-board-aggregator"]
PROXY = os.environ.get("ASPECT_PROXY", "https://zjp-data-proxy.wild-queen-069e.workers.dev/data")

def gh_json(args):
    try:
        out = subprocess.check_output(["gh"] + args, text=True, stderr=subprocess.DEVNULL, timeout=30)
        return json.loads(out) if out.strip() else None
    except Exception:
        return None

def gh_runconclusion(repo, workflow=None, limit=5):
    args = ["run", "list", "-R", repo, "-L", str(limit), "--json", "status,conclusion,createdAt"]
    if workflow:
        args += ["--workflow", workflow]
    rows = gh_json(args) or []
    return [r for r in rows if r.get("status") == "completed"]

def proxy_json(path):
    try:
        url = f"{PROXY}/{path}"
        out = subprocess.check_output(["curl", "-sf", url], text=True, timeout=15)
        return json.loads(out) if out.strip() else None
    except Exception:
        return None

def bucket_high(v, g, y): return "GREEN" if v >= g else ("YELLOW" if v >= y else "RED")
def bucket_low(v, g, y): return "GREEN" if v <= g else ("YELLOW" if v <= y else "RED")
def green_if(c): return "GREEN" if c else "RED"

def c_verification():
    runs = gh_runconclusion(AGG_REPO, workflow="fetch-jobs.yml", limit=3)
    if not runs: return "RED", "no completed fetch-jobs runs", "gh-api:CI"
    latest = runs[0]
    fails = [r for r in runs if r.get("conclusion") != "success"]
    s = "GREEN" if latest.get("conclusion") == "success" else "RED"
    return s, f"last {latest.get('conclusion')} ({latest['createdAt'][:10]}), {len(fails)} fail/3", "gh-api:CI"

def c_monitoring():
    m = proxy_json("zjp-metrics.json")
    if not m: return "RED", "metrics unreadable", "proxy:metrics"
    alerts = m.get("alerts", {})
    gen = m.get("generated_at", "")
    age = 999
    if gen:
        try:
            age = (NOW - datetime.datetime.fromisoformat(gen.replace("Z","+00:00"))).total_seconds()/60
        except: pass
    nf = len(alerts.get("failures", []))
    if age <= 60: return "GREEN", f"metrics {age:.0f}min old ({nf} alerts)", "zjp-metrics.alerts"
    elif age <= 1440: return "YELLOW", f"metrics {age:.0f}min old (stale)", "zjp-metrics.alerts"
    else: return "RED", f"metrics {age:.0f}min old", "zjp-metrics.alerts"

def c_data_quality():
    m = proxy_json("zjp-metrics.json")
    if not m: return "RED", "metrics unreadable", "proxy:metrics"
    dq = m.get("enrichment",{}).get("description_quality",{})
    rate = dq.get("retrievable_description_pct")
    if rate is None: return "YELLOW", "rate missing", "zjp-metrics"
    s = bucket_high(rate, 90, 80)
    return s, f"{rate}% retrievable — threshold ≥90%/≥80%, pool {m.get('pool',{}).get('total_jobs','?')}", "zjp-metrics.retrievable_rate"

def c_performance():
    m = proxy_json("zjp-metrics.json")
    if not m: return "RED", "metrics unreadable", "proxy:metrics"
    rt = m.get("pipeline",{}).get("aggregator_runtime_minutes")
    if rt is None: return "YELLOW", "runtime missing", "zjp-metrics"
    s = bucket_low(rt, 5, 8)
    return s, f"{rt:.1f} min — target <5, alert <8", "zjp-metrics.runtime"

def c_infrastructure():
    m = proxy_json("zjp-metrics.json")
    if not m: return "RED", "metrics unreadable", "proxy:metrics"
    r2 = m.get("r2",{})
    st = r2.get("status","unknown"); age = r2.get("manifest_age_minutes",9999)
    if st == "healthy" and age <= 60: return "GREEN", f"R2 {st}, {age}min old", "zjp-metrics.r2"
    elif st == "healthy": return "YELLOW", f"R2 {st} but {age}min old", "zjp-metrics.r2"
    else: return "RED", f"R2 {st}", "zjp-metrics.r2"

def c_security():
    crit = 0; total = 0
    for repo in AGG_REPOS:
        alerts = gh_json(["api", f"repos/{repo}/dependabot/alerts?state=open&per_page=50"]) or []
        total += len(alerts)
        crit += sum(1 for a in alerts if a.get("security_advisory",{}).get("severity","") in ("critical","high"))
    if crit == 0: return "GREEN", f"{total} open, 0 critical/high", "gh-api:dependabot"
    elif crit <= 2: return "YELLOW", f"{total} open, {crit} critical/high", "gh-api:dependabot"
    else: return "RED", f"{total} open, {crit} critical/high", "gh-api:dependabot"

CHECKS = {
    "verification": c_verification,
    "monitoring": c_monitoring,
    "data_quality": c_data_quality,
    "performance": c_performance,
    "infrastructure": c_infrastructure,
    "security": c_security,
    # fs-based checks OMITTED in CI — run workspace verifier for full 10-aspect picture
}

result = {"module": "AGG", "generated_at": NOW.isoformat(), "aspects": {}}
for name, fn in CHECKS.items():
    try:
        s, e, src = fn()
    except Exception as ex:
        s, e, src = "RED", f"check error: {ex}", "verifier-error"
    result["aspects"][name] = {"status": s, "evidence": e, "source": src}

data_str = json.dumps(result, indent=2)
print(data_str)
counts = {}
for a in result["aspects"].values():
    counts[a["status"]] = counts.get(a["status"], 0) + 1
print(f"\n=== AGG aspect-status (CI) === {counts.get('GREEN',0)}G / {counts.get('YELLOW',0)}Y / {counts.get('RED',0)}R ({len(result['aspects'])} signal checks; 4 fs checks N/A in CI)", file=sys.stderr)

if "--publish" in sys.argv:
    import boto3
    s3 = boto3.client("s3", region_name="auto",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"])
    s3.put_object(Bucket=os.environ["R2_BUCKET_NAME"],
                  Key="data/agg-aspect-status.json", Body=data_str, ContentType="application/json")
    print("published R2: data/agg-aspect-status.json", file=sys.stderr)
