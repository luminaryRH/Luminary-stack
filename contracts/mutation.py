# Mutation score of the core contracts: Gambit (github.com/Certora/gambit) makes the mutants, each one runs against the
# forge suite in its own copy of contracts/, so the working tree is never touched.
#   cargo install --locked --git https://github.com/Certora/gambit.git
#   python contracts/mutation.py <work dir outside the repo> [workers=8] [solc=path to solc 0.8.28]
# Resumable: results go to <work>/results.jsonl, a rerun skips mutants already there. Killed = any test fails (or the
# run times out); the fork and post-deploy tests are left out (they need an RPC and the deployed build). Fuzz and
# invariant runs are cut to keep a mutant under ~15 s, so the score is a lower bound.
import json, os, queue, shutil, subprocess, sys, threading, time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor

CONTRACTS = ["AuctionPool", "RfqDesk", "ScreeningGate", "PrintRegistry", "DisclosureRegistry"]
HERE = os.path.dirname(os.path.abspath(__file__))
FORGE = shutil.which("forge") or os.path.expanduser("~/.foundry/bin/forge")
GAMBIT = shutil.which("gambit") or os.path.expanduser("~/.cargo/bin/gambit")
ENV = dict(os.environ, FOUNDRY_FUZZ_RUNS="256", FOUNDRY_INVARIANT_RUNS="32", FOUNDRY_INVARIANT_DEPTH="250")

work = os.path.abspath(sys.argv[1])
workers = int(sys.argv[2]) if len(sys.argv) > 2 else 8
solc = sys.argv[3] if len(sys.argv) > 3 else shutil.which("solc") or os.path.expanduser("~/.solc-select/artifacts/solc-0.8.28/solc-0.8.28")
os.makedirs(work, exist_ok=True)
out = os.path.join(work, "results.jsonl")

# 1. mutants (once per contract)
jobs = []
for c in CONTRACTS:
    d = os.path.join(work, "mutants", c)
    if not os.path.exists(os.path.join(d, "gambit_results.json")):
        subprocess.run([GAMBIT, "mutate", "--filename", f"src/{c}.sol", "--solc", solc, "--outdir", d], cwd=HERE, check=True, capture_output=True)
    jobs += [(c, m["id"], m["description"], m["diff"]) for m in json.load(open(os.path.join(d, "gambit_results.json")))]
done = {(r["contract"], r["id"]) for r in map(json.loads, open(out))} if os.path.exists(out) else set()
jobs = [j for j in jobs if (j[0], j[1]) not in done]
print(f"{len(jobs)} mutants to run, {len(done)} already done", flush=True)

# 2. one copy of contracts/ (and the circuit fixtures the tests read) per worker
slots = queue.Queue()
for i in range(workers):
    d = os.path.join(work, "copies", str(i))
    shutil.rmtree(d, ignore_errors=True)
    shutil.copytree(HERE, os.path.join(d, "contracts"), ignore=shutil.ignore_patterns("broadcast", "out-halmos", "cache", "out"))
    shutil.copytree(os.path.join(HERE, "..", "circuits", "target"), os.path.join(d, "circuits", "target"))
    slots.put(os.path.join(d, "contracts"))
lock = threading.Lock()


def run(job):
    c, mid, desc, diff = job
    cdir = slots.get()
    try:
        src = os.path.join(cdir, "src", c + ".sol")
        orig = open(src, "rb").read()
        shutil.copy(os.path.join(work, "mutants", c, "mutants", mid, "src", c + ".sol"), src)
        t = time.time()
        try:
            p = subprocess.run([FORGE, "test", "--fail-fast", "--no-match-contract", "Fork|PostDeployCheck"], cwd=cdir, env=ENV,
                               capture_output=True, text=True, timeout=600)
            status = "survived" if p.returncode == 0 else "compile_error" if "Compiler run failed" in p.stdout + p.stderr else "killed"
        except subprocess.TimeoutExpired:
            status = "killed"
        open(src, "wb").write(orig)
        r = dict(contract=c, id=mid, desc=desc, status=status, secs=round(time.time() - t), diff=diff if status == "survived" else "")
        with lock:
            open(out, "a").write(json.dumps(r) + "\n")
    finally:
        slots.put(cdir)


with ThreadPoolExecutor(workers) as ex:
    list(ex.map(run, jobs))

# 3. score
per = defaultdict(Counter)
for r in map(json.loads, open(out)):
    per[r["contract"]][r["status"]] += 1
total = sum(per.values(), Counter())
for c, n in list(per.items()) + [("all", total)]:
    print(f"{c:20} killed {n['killed']:4} / {n['killed'] + n['survived']:4}  {100 * n['killed'] / (n['killed'] + n['survived']):5.1f}%")
