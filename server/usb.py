"""Put a complete, offline Basecamp onto a USB stick or external SSD.

    ./basecamp usb /Volumes/STICK            plan, then build (asks first)
    ./basecamp usb /Volumes/STICK --status   how far the downloads are

The stick gets the app, its own Python and Ollama (Apple Silicon and Intel), AI models for small
and big Macs, and as much knowledge as fits. It runs from the stick on any Mac, no internet, no
install. Or it installs itself onto a Mac with one double click.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
CATALOG = json.loads((ROOT / "catalog.json").read_text())
ITEMS = {i["id"]: i for i in CATALOG["items"] + CATALOG["maps"]}
MODELS = {m["name"]: m for m in CATALOG["models"]}
CACHE = Path.home() / "Library/Caches/Basecamp"
PY_RELEASES = "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest"
PY_SERIES = "cpython-3.12."
OLLAMA_URL = "https://github.com/ollama/ollama/releases/download/v{v}/ollama-darwin.tgz"
APP_SKIP = {".venv", ".run", "data", "config.json", "__pycache__", ".git", ".DS_Store", "runtime", "dist"}

# What goes on the stick after the "Groß" package, most useful first. Huge English collections last.
EXTRA_ORDER = [
    "map_europe", "libretexts.org_en_med", "libretexts.org_en_bio", "libretexts.org_en_chem", "libretexts.org_en_phys",
    "libretexts.org_en_math", "libretexts.org_en_eng", "libretexts.org_en_geo", "wikibooks_en_all_maxi",
    "wiktionary_en_all_nopic", "wikivoyage_en_all_maxi", "wikisource_en_all_nopic", "docs.python.org_en_all",
    "openstreetmap-wiki_en_all_nopic", "wikipedia_de_medicine_maxi", "superuser.com_en_all", "askubuntu.com_en_all",
    "apple.stackexchange.com_en_all", "math.stackexchange.com_en_all", "physics.stackexchange.com_en_all",
    "chemistry.stackexchange.com_en_all", "biology.stackexchange.com_en_all", "travel.stackexchange.com_en_all",
    "stackoverflow.com_en_all", "crashcourse_en_all", "survivorlibrary.com_en_all", "khanacademy_en_all",
    "gutenberg_en_all",
]


def say(msg):
    print(f"\033[1;32m▸\033[0m {msg}", flush=True)


def gb(n):
    return f"{n:.0f} GB" if n >= 10 else f"{n:.1f} GB"


def run(*cmd, **kw):
    return subprocess.run(cmd, check=True, **kw)


def fetch(url, dest):
    """Download once into the cache, then reuse."""
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    say(f"Lade {url.rsplit('/', 1)[-1]}")
    req = urllib.request.Request(url, headers={"User-Agent": "Basecamp-USB/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 20)
    tmp.rename(dest)
    return dest


def copy_file(src, dst):
    """Copy only the data (no extended attributes, so exFAT gets no ._ files). Skips files that are already there."""
    if dst.exists() and dst.stat().st_size == src.stat().st_size:
        return False
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".copy")
    with open(src, "rb") as a, open(tmp, "wb") as b:
        shutil.copyfileobj(a, b, 8 << 20)
    tmp.replace(dst)
    return True


def copy_tree(src, dst, skip=APP_SKIP):
    for p in src.rglob("*"):
        rel = p.relative_to(src)
        if any(part in skip for part in rel.parts) or p.is_dir():
            continue
        copy_file(p, dst / rel)
        if os.access(p, os.X_OK):
            (dst / rel).chmod(0o755)


# --------------------------------------------------------------------------- runtime

def build_python(arch):
    """python-build-standalone plus libzim, packed as one tar.gz (the stick may not support symlinks)."""
    out = CACHE / f"python-{arch}.tar.gz"
    if out.exists():
        return out
    rel = json.load(urllib.request.urlopen(PY_RELEASES, timeout=30))
    triple = {"arm64": "aarch64-apple-darwin", "x86_64": "x86_64-apple-darwin"}[arch]
    asset = next(a for a in rel["assets"] if a["name"].startswith(PY_SERIES) and triple in a["name"]
                 and a["name"].endswith("install_only_stripped.tar.gz"))
    tgz = fetch(asset["browser_download_url"], CACHE / "dl" / asset["name"])
    stage = CACHE / f"stage-{arch}"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    with tarfile.open(tgz) as t:
        t.extractall(stage, filter="tar")
    py = stage / "python"
    site = next((py / "lib").glob("python3.*/site-packages"))
    plats = [f"macosx_{v}_0_{arch}" for v in (13, 12, 11)]  # libzim ships wheels for macOS 13+
    pyver = site.parent.name.replace("python", "")
    say(f"Installiere libzim für {arch}")
    run(sys.executable, "-m", "pip", "install", "-q", "--target", str(site), *[x for pl in plats for x in ("--platform", pl)],
        "--python-version", pyver, "--implementation", "cp", "--only-binary=:all:",
        "-r", str(ROOT / "server/requirements.txt"))
    with tarfile.open(out.with_suffix(".part"), "w:gz") as t:
        t.add(py, arcname="python")
    out.with_suffix(".part").rename(out)
    shutil.rmtree(stage, ignore_errors=True)
    return out


def ollama_version():
    try:
        out = subprocess.run(["ollama", "--version"], capture_output=True, text=True).stdout
        return out.strip().split()[-1]
    except Exception:
        return "0.40.11"


def build_runtime(dest):
    rt = dest / "runtime"
    rt.mkdir(parents=True, exist_ok=True)
    for arch in ("arm64", "x86_64"):
        copy_file(build_python(arch), rt / f"python-{arch}.tar.gz")
    ver = ollama_version()
    copy_file(fetch(OLLAMA_URL.format(v=ver), CACHE / "dl" / f"ollama-darwin-{ver}.tgz"), rt / "ollama-darwin.tgz")
    (rt / "VERSION").write_text(f"py{PY_SERIES[8:-1]}-ollama{ver}-{int(time.time())}\n")


# --------------------------------------------------------------------------- models

def models_dir():
    cfg = ROOT / "config.json"
    if cfg.exists() and json.loads(cfg.read_text()).get("ollama_models_dir"):
        return Path(json.loads(cfg.read_text())["ollama_models_dir"]).expanduser()
    return Path(os.environ.get("OLLAMA_MODELS") or Path.home() / ".ollama/models")


def manifest_path(base, name):
    model, _, tag = name.partition(":")
    parts = model.split("/")
    if len(parts) == 1:
        parts = ["library"] + parts
    host = "registry.ollama.ai" if len(parts) == 2 else parts.pop(0)
    return base / "manifests" / host / Path(*parts) / (tag or "latest")


def model_files(base, name):
    m = manifest_path(base, name)
    if not m.exists():
        return None
    data = json.loads(m.read_text())
    digests = [data["config"]["digest"]] + [layer["digest"] for layer in data.get("layers", [])]
    return [m] + [base / "blobs" / d.replace(":", "-") for d in digests]


def stick_models(this_mac_tier):
    """One chat model per Mac size up to 95 GB RAM, plus the coding models. Works on any Mac."""
    names = []
    for t in CATALOG["model_tiers"]:
        if t["max_ram"] <= 95:
            names += [t["default"]]
    names += [this_mac_tier["code_default"], CATALOG["model_tiers"][1]["code_default"]]
    return list(dict.fromkeys(names))


def copy_models(names, dest):
    base, out = models_dir(), dest / "models"
    for name in names:
        files = model_files(base, name)
        if files is None:
            say(f"Lade Modell {name} (einmalig, dann auch auf diesem Mac da)")
            run("ollama", "pull", name)
            files = model_files(base, name)
        if files is None:
            print(f"  ! {name} nicht gefunden, übersprungen")
            continue
        say(f"Kopiere Modell {name}")
        for f in files:
            copy_file(f, out / f.relative_to(base))


# --------------------------------------------------------------------------- content

def ram_gb():
    return int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout or 0) // 2**30


def plan_content(budget):
    """The "Groß" package, then EXTRA_ORDER, as long as it fits. Bigger maps replace smaller ones."""
    chosen = [i for i in CATALOG["items"] + CATALOG["maps"] if "L" in i["p"]]
    used = sum(i["gb"] for i in chosen)
    for iid in EXTRA_ORDER:
        it = ITEMS.get(iid)
        if not it or it in chosen:
            continue
        freed = sum(c["gb"] for c in chosen if c["id"] in it.get("replaces", []))
        if used - freed + it["gb"] <= budget:
            chosen = [c for c in chosen if c["id"] not in it.get("replaces", [])] + [it]
            used += it["gb"] - freed
    return chosen, used


def local_content(item):
    """Files of this item that are already on this Mac."""
    data = Path(json.loads((ROOT / "config.json").read_text()).get("data_dir", ROOT / "data")) if (ROOT / "config.json").exists() else ROOT / "data"
    if item["id"].startswith("map_"):
        return sorted((data / "maps").glob(f"{item['id']}_*.pmtiles"))[-1:]
    return sorted((data / "zim").glob(f"{item['id']}_*.zim"))[-1:]


# --------------------------------------------------------------------------- launchers

START = r'''#!/bin/bash
# Startet Basecamp direkt vom Stick. Nichts wird auf dem Mac installiert.
STICK="$(cd "$(dirname "$0")" && pwd)"
B="$STICK/Basecamp"
ARCH="$(uname -m)"
VER="$(cat "$B/runtime/VERSION")"
RT="$HOME/Library/Application Support/Basecamp/runtime/$VER"
if [[ ! -f "$RT/.ok" ]]; then
  echo "▸ Einmalig: Python und Ollama auf diesem Mac auspacken (etwa 30 Sekunden)"
  rm -rf "$RT"; mkdir -p "$RT/ollama"
  tar -xzf "$B/runtime/python-$ARCH.tar.gz" -C "$RT" && tar -xzf "$B/runtime/ollama-darwin.tgz" -C "$RT/ollama" && touch "$RT/.ok"
fi
export BASECAMP_PYTHON="$RT/python/bin/python3"
export BASECAMP_OLLAMA_BIN="$(find "$RT/ollama" -name ollama -type f -perm -u+x | head -1)"
export BASECAMP_DATA_DIR="$B/data"
export BASECAMP_OLLAMA_MODELS="$B/models"
export BASECAMP_OLLAMA_URL="http://127.0.0.1:11435"
"$B/app/basecamp" start
echo
echo "Basecamp läuft. Dieses Fenster darf offen bleiben oder zu."
echo "Zum Beenden: $B/app/basecamp stop"
'''

STOP = r'''#!/bin/bash
# Beendet Basecamp und die KI. Danach kann der Stick ausgeworfen werden.
"$(cd "$(dirname "$0")" && pwd)/Basecamp/app/basecamp" stop
echo "Du kannst den Stick jetzt auswerfen."
'''

INSTALL = r'''#!/bin/bash
# Installiert Basecamp vom Stick auf diesen Mac. Danach läuft es auch ohne Stick.
set -e
STICK="$(cd "$(dirname "$0")" && pwd)"
B="$STICK/Basecamp"
DEST="$HOME/Basecamp"
ARCH="$(uname -m)"
free_gb() { df -g "$HOME" | awk 'NR==2{print $4}'; }
size_gb() { du -sg "$1" 2>/dev/null | awk '{print $1}'; }
echo "Basecamp wird nach $DEST installiert."
mkdir -p "$DEST/runtime/ollama"
echo "▸ App kopieren"
rsync -a --delete --exclude .run --exclude config.json "$B/app/" "$DEST/app/"
echo "▸ Python und Ollama auspacken"
rm -rf "$DEST/runtime/python"; tar -xzf "$B/runtime/python-$ARCH.tar.gz" -C "$DEST/runtime"
tar -xzf "$B/runtime/ollama-darwin.tgz" -C "$DEST/runtime/ollama"
OLL="$(find "$DEST/runtime/ollama" -name ollama -type f -perm -u+x | head -1)"; [[ "$OLL" == "$DEST/runtime/ollama/ollama" ]] || ln -sf "$OLL" "$DEST/runtime/ollama/ollama"

DATA_DIR="$B/data"; MODELS_DIR="$B/models"
need_data=$(size_gb "$B/data"); need_models=$(size_gb "$B/models"); have=$(free_gb)
echo
echo "Wissen auf dem Stick: ${need_data} GB, KI-Modelle: ${need_models} GB. Frei auf diesem Mac: ${have} GB."
read -r -p "Modelle auf den Mac kopieren? Dann läuft die KI ohne Stick und schneller. [J/n] " a
if [[ ! "$a" =~ ^[nN] ]]; then echo "▸ Modelle kopieren"; rsync -a "$B/models/" "$DEST/models/"; MODELS_DIR="$DEST/models"; fi
read -r -p "Wissen auch auf den Mac kopieren? Sonst liest Basecamp es vom Stick. [j/N] " a
if [[ "$a" =~ ^[jJyY] ]]; then echo "▸ Wissen kopieren (das dauert)"; rsync -a "$B/data/" "$DEST/data/"; DATA_DIR="$DEST/data"; fi
mkdir -p "$DEST/data/code"
"$DEST/runtime/python/bin/python3" -I -c 'import json,sys; json.dump({"data_dir": sys.argv[2], "ollama_models_dir": sys.argv[3], "ollama_url": "http://127.0.0.1:11435", "port": 4774}, open(sys.argv[1], "w"), indent=2)' "$DEST/app/config.json" "$DATA_DIR" "$MODELS_DIR"

echo "▸ App-Symbol in ~/Programme anlegen"
mkdir -p "$HOME/Applications"
osacompile -o "$HOME/Applications/Basecamp.app" -e "do shell script quoted form of (POSIX path of (path to home folder)) & \"Basecamp/app/basecamp start >/dev/null 2>&1 &\"" >/dev/null 2>&1 || true
echo
"$DEST/app/basecamp" start
echo "Fertig. Später starten: Basecamp in ~/Programme, oder $DEST/app/basecamp start"
'''

README = """BASECAMP · Wissen und KI ohne Internet
=======================================

Starten ohne Installation (jeder Mac ab macOS 14):
  Doppelklick auf "Basecamp starten.command".
  Fragt macOS nach, ob es das öffnen darf: Rechtsklick > Öffnen.
  Dann öffnet sich der Browser mit Basecamp.
  Vor dem Auswerfen: Doppelklick auf "Basecamp beenden.command".

Auf einen Mac installieren (läuft danach auch ohne Stick):
  Doppelklick auf "Basecamp installieren.command".

Was drauf ist:
{content}

Kein Mac zur Hand?
  Das Wissen liegt als ZIM-Dateien in Basecamp/data/zim. Die öffnet die kostenlose
  App Kiwix (kiwix.org) auf Windows, Linux, Android und iPhone. Ohne KI, aber alles lesbar.

Größe von Modellen und Macs:
  8 GB RAM: kleines Modell, langsamer, für einfache Fragen
  16 GB und mehr: gute Antworten. 32 GB und mehr: sehr gute Antworten.
  Das passende Modell wird automatisch gewählt.

Open Source: https://github.com/antonwiep/project-basecamp
"""


# --------------------------------------------------------------------------- main

def fetching():
    return subprocess.run(["pgrep", "-f", "app.py --fetch"], capture_output=True).returncode == 0


def status(target):
    log = target / "Basecamp/.fetch.log"
    if not log.exists():
        return print("Keine Downloads auf diesem Stick.")
    lines = log.read_text(errors="replace").splitlines()
    done = sum(1 for line in lines if line.startswith(("✓", "=")))
    print("\n".join(lines[-12:]))
    print(f"\n{done} Quellen fertig. Download läuft {'noch' if fetching() else 'nicht mehr'}.")


def main():
    ap = argparse.ArgumentParser(prog="basecamp usb", description="Basecamp komplett auf einen Stick packen.")
    ap.add_argument("target", help="z. B. /Volumes/STICK")
    ap.add_argument("--status", action="store_true", help="Fortschritt der Downloads zeigen")
    ap.add_argument("--yes", action="store_true", help="nicht nachfragen")
    ap.add_argument("--no-content", action="store_true", help="nur App, Laufzeit und Modelle")
    ap.add_argument("--models", help="Modelle mit Komma, statt der Auswahl für alle Mac-Größen")
    ap.add_argument("--max-gb", type=float, help="höchstens so viel vom Stick belegen, z. B. 400")
    a = ap.parse_args()
    target = Path(a.target).resolve()
    if a.status:
        return status(target)
    if not target.is_dir() or not os.access(target, os.W_OK):
        sys.exit(f"{target} gibt es nicht oder ist schreibgeschützt.")

    dest = target / "Basecamp"
    free = shutil.disk_usage(target).free / 1e9 + (sum(f.stat().st_size for f in dest.rglob("*") if f.is_file()) / 1e9 if dest.exists() else 0)
    if a.max_gb:
        free = min(free, a.max_gb)
    fs = subprocess.run(["diskutil", "info", str(target)], capture_output=True, text=True).stdout
    fs_type = next((line.split(":", 1)[1].strip() for line in fs.splitlines() if "Type (Bundle)" in line), "?")
    tiers = CATALOG["model_tiers"]
    my_tier = next(t for t in tiers if ram_gb() <= t["max_ram"])
    models = a.models.split(",") if a.models else stick_models(my_tier)
    models_gb = sum(MODELS.get(m, {}).get("gb", 10) for m in models)
    reserve = max(8.0, free * 0.03)
    budget = 0 if a.no_content else free - models_gb - 1.0 - reserve
    content, content_gb = plan_content(budget) if budget > 0 else ([], 0)

    print(f"\nZiel: {target}  ({fs_type}, {gb(free)} frei)\n")
    row = lambda label, size: print(f"  {label:54} {size:>7}")
    row("App und Laufzeit (Apple Silicon und Intel)", "~1 GB")
    row(f"KI-Modelle ({len(models)})", gb(models_gb))
    for m in models:
        print(f"      {m:28} {MODELS.get(m, {}).get('title', '')}")
    row(f"Wissen ({len(content)} Quellen)", gb(content_gb))
    big = sorted(content, key=lambda i: -i["gb"])
    for it in big[:14]:
        have = "auf dem Mac" if local_content(it) else "wird geladen"
        print(f"      {it['title'][:48]:50} {gb(it['gb']):>7}  {have}")
    if len(big) > 14:
        print(f"      … und {len(big) - 14} kleinere Quellen ({gb(sum(i['gb'] for i in big[14:]))})")
    row("Reserve", gb(reserve))
    if fs_type.lower() in ("msdos", "fat32", "ms-dos fat32"):
        sys.exit("\nDer Stick ist FAT32: Dateien über 4 GB passen nicht. Im Festplattendienstprogramm als APFS oder ExFAT formatieren.")
    if not a.yes and input("\nSo auf den Stick packen? [j/N] ").strip().lower() not in ("j", "ja", "y", "yes"):
        return print("Abgebrochen.")

    say("Kopiere die App")
    copy_tree(ROOT, dest / "app")
    say("Baue die Laufzeit (Python und Ollama)")
    build_runtime(dest)
    copy_models(models, dest)
    for it in content:
        for f in local_content(it):
            say(f"Kopiere {it['title']} ({gb(it['gb'])})")
            copy_file(f, dest / "data" / ("maps" if it["id"].startswith("map_") else "zim") / f.name)
    places = ROOT / "data/maps/places.sqlite"
    if places.exists():
        copy_file(places, dest / "data/maps/places.sqlite")
    for sub in ("zim", "maps", "library", "code"):
        (dest / "data" / sub).mkdir(parents=True, exist_ok=True)

    listing = "\n".join(f"  {i['title']} ({gb(i['gb'])})" for i in sorted(content, key=lambda i: -i["gb"]))
    (target / "LIESMICH.txt").write_text(README.format(content=listing or "  (noch keine Inhalte)"))
    for name, body in (("Basecamp starten.command", START), ("Basecamp beenden.command", STOP),
                       ("Basecamp installieren.command", INSTALL)):
        (target / name).write_text(body)
        (target / name).chmod(0o755)

    missing = [i["id"] for i in content if not local_content(i)]
    if missing and fetching():
        say("Der Download auf den Stick läuft schon. Fortschritt: ./basecamp usb " + str(target) + " --status")
    elif missing:
        log = dest / ".fetch.log"
        env = {**os.environ, "BASECAMP_DATA_DIR": str(dest / "data")}
        py = sys.executable
        with open(log, "a") as f:
            subprocess.Popen([py, str(ROOT / "server/app.py"), "--fetch", *missing], env=env, stdout=f, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL, start_new_session=True)
        say(f"{len(missing)} Quellen werden jetzt direkt auf den Stick geladen ({gb(sum(ITEMS[m]['gb'] for m in missing))}).")
        print("   Das läuft im Hintergrund weiter, auch wenn du das Terminal schließt.")
        print(f"   Fortschritt: ./basecamp usb {target} --status")
        print("   Unterbrochen? Einfach den gleichen Befehl nochmal, er macht an der Stelle weiter.")
    say("Fertig. Auf dem Stick: \"Basecamp starten.command\" und \"Basecamp installieren.command\".")


if __name__ == "__main__":
    main()
