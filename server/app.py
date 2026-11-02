#!/usr/bin/env python3
"""Basecamp server: offline knowledge (ZIM files), own documents and local AI in one place.

Only depends on the Python standard library and `libzim`.
"""
import csv
import datetime
import html
import io
import ipaddress
import json
import math
import mimetypes
import os
import random
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import unicodedata
import uuid
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from libzim.reader import Archive
from libzim.search import Query, Searcher
from libzim.suggestion import SuggestionSearcher
from libzim.writer import Creator, Hint, Item, StringProvider

ROOT = Path(__file__).resolve().parent.parent
STATIC = Path(__file__).resolve().parent / "static"
CONFIG_PATH = ROOT / "config.json"
CATALOG = json.loads((ROOT / "catalog.json").read_text())
ITEMS = {it["id"]: it for it in CATALOG["items"]}
MODELS = {m["name"]: m for m in CATALOG["models"]}
UA = "Basecamp/1.0 (+offline knowledge box)"

DEFAULT_CONFIG = {
    "data_dir": str(ROOT / "data"),
    "host": "127.0.0.1",
    "port": 4774,
    "ollama_url": "http://127.0.0.1:11434",
    "default_model": "",
    "num_ctx": 0,  # 0 = pick from RAM tier
    "power_save": False,
}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        cfg.update(json.loads(CONFIG_PATH.read_text()))
    # set by the USB stick launcher, so the same copy runs on any Mac
    for key, env in (("data_dir", "BASECAMP_DATA_DIR"), ("ollama_url", "BASECAMP_OLLAMA_URL"), ("port", "BASECAMP_PORT")):
        if os.environ.get(env):
            cfg[key] = os.environ[env]
    return cfg


def save_config(updates):
    cfg = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
    cfg.update(updates)
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
    CFG.update(updates)


CFG = load_config()
DATA = Path(os.path.expanduser(CFG["data_dir"]))
ZIM_DIR = DATA / "zim"
LIB_DIR = DATA / "library"
CACHE_DIR = DATA / "cache"
MAP_DIR = DATA / "maps"
CODE_DIR = DATA / "code"
for d in (ZIM_DIR, LIB_DIR, CACHE_DIR, MAP_DIR, CODE_DIR):
    d.mkdir(parents=True, exist_ok=True)
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/x-protobuf", ".pbf")


# --------------------------------------------------------------------------- hardware

def sysctl(key):
    try:
        return subprocess.check_output(["sysctl", "-n", key], text=True).strip()
    except Exception:
        return ""


def hardware():
    ram = int(sysctl("hw.memsize") or 0) / 2**30
    if not ram:
        ram = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30
    du = shutil.disk_usage(DATA)
    return {
        "chip": sysctl("machdep.cpu.brand_string") or "unbekannt",
        "ram_gb": round(ram),
        "disk_free_gb": round(du.free / 1e9, 1),
        "disk_total_gb": round(du.total / 1e9, 1),
    }


def model_tier(ram_gb):
    for tier in CATALOG["model_tiers"]:
        if ram_gb <= tier["max_ram"]:
            return tier
    return CATALOG["model_tiers"][-1]


def num_ctx():
    return CFG.get("num_ctx") or model_tier(hardware()["ram_gb"])["num_ctx"]


def profile_items(pid):
    return [i for i in CATALOG["items"] + CATALOG["maps"] if pid in i["p"]]


def recommended_profile(free_gb):
    """Largest content profile that leaves 15% headroom on the disk. Never "Maximal" by default:
    it is mostly huge English collections."""
    best = "S"
    for p in CATALOG["profiles"][:3]:
        size = sum(i["gb"] for i in profile_items(p["id"]))
        if size * 1.15 + 20 < free_gb:
            best = p["id"]
    return best


# --------------------------------------------------------------------------- ZIM library

LANG3 = {"eng": "en", "deu": "de", "ger": "de", "mul": "mul", "fra": "fr", "spa": "es"}
VERSION_RE = re.compile(r"^(.+?)_(\d{4}-\d{2})$")


class Book:
    def __init__(self, path):
        self.path = path
        self.archive = Archive(str(path))
        m = VERSION_RE.match(path.stem)
        self.id, self.version = (m.group(1), m.group(2)) if m else (path.stem, "")
        self.lock = threading.Lock()
        self._searcher = None
        self._suggester = None
        meta = self.meta
        self.title = meta("Title") or self.id
        self.description = meta("Description")
        lang = (meta("Language") or "").split(",")[0]
        self.lang = LANG3.get(lang, lang[:2])
        item = ITEMS.get(self.id, {})
        self.category = item.get("cat") or self._guess_category(meta("Tags"))
        self.label = item.get("title") or self.title
        self.size = path.stat().st_size
        self.fulltext = self.archive.has_fulltext_index
        self.titles = self.archive.has_title_index
        try:
            self.main = self.archive.main_entry.get_item().path
        except Exception:
            self.main = ""

    def meta(self, key):
        try:
            return self.archive.get_metadata(key).decode("utf-8", "replace").strip()
        except Exception:
            return ""

    @staticmethod
    def _guess_category(tags):
        tags = tags.lower()
        for key, cat in (("medic", "medizin"), ("stack_exchange", "qa"), ("gutenberg", "buecher"),
                         ("wikivoyage", "reisen"), ("wiktionary", "sprache"), ("ifixit", "technik")):
            if key in tags:
                return cat
        return "wissen"

    def icon(self):
        try:
            sizes = self.archive.get_illustration_sizes()
            return bytes(self.archive.get_illustration_item(max(sizes)).content) if sizes else None
        except Exception:
            return None

    def search(self, query, limit):
        """Full-text search. Returns [(path, title, snippet)]."""
        if not self.fulltext or not query.strip():
            return []
        with self.lock:
            if self._searcher is None:
                self._searcher = Searcher(self.archive)
            try:
                res = self._searcher.search(Query().set_query(query)).get_results(0, limit)
                return [(r.path, r.title, r.snippet or "") for r in res]
            except Exception:
                return []

    def suggest(self, query, limit):
        """Title search. Returns [(path, title)]."""
        if not self.titles or not query.strip():
            return []
        with self.lock:
            if self._suggester is None:
                self._suggester = SuggestionSearcher(self.archive)
            try:
                out = []
                for p in self._suggester.suggest(query).get_results(0, limit):
                    try:
                        out.append((p, self.archive.get_entry_by_path(p).title))
                    except Exception:
                        pass
                return out
            except Exception:
                return []

    def resolve(self, path):
        """Follow redirects. Returns (path, title, was_redirect) of the real article, or None."""
        with self.lock:
            try:
                entry = self.archive.get_entry_by_path(path)
                redirect = entry.is_redirect
                if redirect:
                    entry = entry.get_redirect_entry()
                return entry.path, entry.title, redirect
            except Exception:
                return None

    def info(self):
        return {
            "id": self.id, "title": self.label, "zim_title": self.title,
            "description": (ITEMS.get(self.id) or {}).get("desc") or self.description,
            "lang": self.lang, "category": self.category, "version": self.version,
            "articles": self.archive.article_count, "size": self.size,
            "main": self.main, "fulltext": self.fulltext,
        }


class Library:
    def __init__(self):
        self.books = {}
        self.lock = threading.Lock()

    def rescan(self):
        found = {}
        for path in sorted(ZIM_DIR.glob("*.zim")):
            m = VERSION_RE.match(path.stem)
            bid = m.group(1) if m else path.stem
            # keep only the newest version of each book
            if bid not in found or path.stem > found[bid].stem:
                found[bid] = path
        with self.lock:
            current = {b.id: b for b in self.books.values()}
            books = {}
            for bid, path in found.items():
                old = current.get(bid)
                if old and old.path == path:
                    books[bid] = old
                    continue
                try:
                    books[bid] = Book(path)
                except Exception as e:
                    print(f"[basecamp] cannot open {path.name}: {e}", file=sys.stderr)
            self.books = books

    def get(self, bid):
        return self.books.get(bid)

    def all(self):
        return list(self.books.values())


LIB = Library()
POOL = ThreadPoolExecutor(max_workers=8)


# --------------------------------------------------------------------------- text extraction

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


class TextExtractor(HTMLParser):
    SKIP_TAGS = {"script", "style", "table", "sup", "noscript", "nav", "footer", "head", "math",
                 "svg", "figure", "button", "audio", "video", "iframe", "form"}
    SKIP_CLASSES = ("reference", "navbox", "mw-editsection", "noprint", "metadata", "hatnote", "mw-ref")
    BLOCKS = {"p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "dd", "dt", "blockquote", "pre", "tr",
              "div", "section", "article", "caption"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.skip = 0
        self.cur = []
        self.blocks = []

    def handle_starttag(self, tag, attrs):
        if tag in VOID:
            if tag == "br" and not self.skip:
                self.cur.append(" ")
            return
        if self.skip:
            self.skip += 1
            return
        cls = dict(attrs).get("class") or ""
        if tag in self.SKIP_TAGS or any(c in cls for c in self.SKIP_CLASSES):
            self.skip = 1
            return
        if tag in self.BLOCKS:
            self.flush()
        if tag in ("h1", "h2", "h3", "h4"):
            self.cur.append("## ")

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if self.skip:
            self.skip -= 1
            return
        if tag in self.BLOCKS:
            self.flush()

    def handle_data(self, data):
        if not self.skip:
            self.cur.append(data)

    def flush(self):
        text = re.sub(r"\s+", " ", "".join(self.cur)).strip()
        if text and text != "##":
            self.blocks.append(text)
        self.cur = []


def article_blocks(book, path):
    entry = book.archive.get_entry_by_path(path)
    item = entry.get_item()
    if not item.mimetype.startswith("text/html"):
        return entry.title, []
    parser = TextExtractor()
    parser.feed(bytes(item.content).decode("utf-8", "replace"))
    parser.flush()
    return entry.title, parser.blocks


def pick_passages(blocks, terms, max_chars):
    """Intro first, then the blocks that mention the search terms most. Keeps original order."""
    if not blocks:
        return ""
    body = [i for i, b in enumerate(blocks) if not b.startswith("## ") and len(b) > 40]
    chosen, size = set(), 0
    for i in body[:2]:
        chosen.add(i)
        size += len(blocks[i])
    scored = []
    for i in body[2:]:
        low = blocks[i].lower()
        hits = sum(low.count(t) for t in terms)
        if hits:
            scored.append((hits / (1 + len(low) / 800), i))
    for _, i in sorted(scored, reverse=True):
        if size >= max_chars:
            break
        chosen.add(i)
        size += len(blocks[i])
    text = "\n".join(blocks[i] for i in sorted(chosen))
    return text[:max_chars]


# --------------------------------------------------------------------------- search

STOPWORDS = set("""
der die das den dem des ein eine einer eines einem einen und oder aber wie was wer wo wann warum wieso weshalb
welche welcher welches ist sind war waren wird werden kann können könnte muss müssen soll sollte ich du er sie es
wir ihr mir mich dir dich man mit von zu zum zur bei für auf aus in im an am als auch nicht noch nur so sehr
gibt geben habe hat haben bitte erkläre erklär sag sage mal denn dann dass wenn ob über unter nach vor
the a an and or but how what who where when why which is are was were will be can could should would do does did
i you he she it we they me my your of to in on at for with from by as about into is it's please tell explain
""".split())


def keywords(text):
    words = re.findall(r"[\wäöüÄÖÜß\-]+", text.lower())
    return [w for w in words if len(w) > 2 and w not in STOPWORDS]


def search_all(q, book_ids=None, limit=5):
    books = [b for b in LIB.all() if not book_ids or b.id in book_ids]

    ql = q.lower().strip()

    def one(book):
        hits = book.search(q, limit)
        snippets = {p: s for p, _, s in hits}
        # titles that start with the query go first, then the full-text hits
        top = [(p, t) for p, t in book.suggest(q, 3) if t.lower().startswith(ql)][:2]
        top_paths = {p for p, _ in top}
        exact = any(t.lower() == ql for _, t in top) or any(t.lower() == ql for _, t, _ in hits)
        results = [{"path": p, "title": t, "snippet": snippets.get(p, "")} for p, t in top] + \
                  [{"path": p, "title": t, "snippet": s} for p, t, s in hits if p not in top_paths]
        return {"book": book.id, "title": book.label, "lang": book.lang, "category": book.category,
                "exact": exact, "results": results[:limit + 2]}

    groups = [g for g in POOL.map(one, books) if g["results"]]
    groups.sort(key=lambda g: (not g["exact"], g["lang"] != "de", -len(g["results"])))
    return groups


def suggest_all(q, limit=8, book_ids=None):
    out = []
    books = [b for b in LIB.all() if not book_ids or b.id in book_ids]
    per = 4 if len(books) > 1 else limit
    for book, res in zip(books, POOL.map(lambda b: b.suggest(q, per), books)):
        for p, t in res:
            out.append({"book": book.id, "source": book.label, "lang": book.lang, "path": p, "title": t})
    ql = q.lower()
    out.sort(key=lambda r: (not r["title"].lower().startswith(ql), r["lang"] != "de", len(r["title"])))
    return out[:limit]


def search_files(q):
    terms = keywords(q) or [q.lower()]
    return [f for f in list_files() if all(t in f["name"].lower() for t in terms)][:20]


def retrieve(queries, max_sources, per_source_chars, book_ids=None, raw_terms=(), question=""):
    """Find the best passages for a question.

    `queries` maps lang -> list of search strings. `raw_terms` are the user's own words; they are
    also tried as exact article titles, in case the model mistranslated a rare word.
    """
    exact = bible_passages(question, per_source_chars, book_ids)
    books = [b for b in LIB.all() if b.fulltext and bible_may_search(b, book_ids, exact, question)]
    raw_terms = [w for w in raw_terms if len(w) >= 5]
    all_terms = {t for qs in queries.values() for q in qs for t in keywords(q)} | set(raw_terms)

    def matches(word):
        return any(word[:5] == t[:5] for t in all_terms)

    def title_score(title):
        words = keywords(title)
        hits = sum(1 for w in words if matches(w))
        return 4 * hits + 3 * hits / max(len(words), 1)

    def for_book(book):
        qs = queries.get(book.lang) or queries.get("en") or next(iter(queries.values()), [])
        cands = {}
        is_bible = book.category == "bibel"
        # asked for by name, so it goes ahead of articles that only match a word. Else German first, English as backup
        prefer = 20 if is_bible else 1.5 if book.lang == "de" else 0

        def add(path, title, score, follow=True):
            score += prefer
            real = book.resolve(path)
            if not real or (real[2] and not follow):
                return
            if score > cands.get(real[0], (0,))[0]:
                cands[real[0]] = (score, book, real[0], real[1])

        for qi, q in enumerate(qs):
            words = q.split()
            bonus = 2 if qi == 0 else 0
            # article titles: the whole query, then shorter ("heart attack symptoms" -> "heart attack")
            for n in range(0 if is_bible else len(words), 0, -1):  # a chapter's title says nothing about it
                if n == 1 and len(words) > 2:
                    break
                good = [(p, t) for p, t in book.suggest(" ".join(words[:n]), 2) if title_score(t) > 0]
                for p, t in good:
                    # "Heart attack" is a great title hit; "Water purification solution" is not
                    exact = all(matches(w) for w in keywords(t))
                    add(p, t, 6 + bonus + n + title_score(t) if exact else title_score(t) / 2, follow=exact)
                if good:
                    break
            # full text (AND logic): drop words until something is found
            hits, n = [], 0
            for n in range(len(words), 0, -1):
                hits = book.search(" ".join(words[:n]), 4)
                if hits:
                    break
            for rank, (p, t, snip) in enumerate(hits):
                low = snip.lower()
                score = title_score(t) + 0.7 * sum(w in low for w in all_terms) + 2 / (rank + 1) + bonus
                add(p, t, score + 2 * n / max(len(words), 1))
        for w in raw_terms:
            for p, t in book.suggest(w, 1):
                if t.lower() == w:
                    add(p, t, 9)
        return list(cands.values())

    cands = sorted((c for group in POOL.map(for_book, books) for c in group), key=lambda c: -c[0])
    best = cands[0][0] if cands else 0
    picked, per_book = [], {}
    for score, book, path, title in cands:
        if score < best * 0.45 or len(exact) + len(picked) >= max_sources:
            break
        if per_book.get(book.id, 0) >= 2:
            continue
        per_book[book.id] = per_book.get(book.id, 0) + 1
        picked.append((book, path, title))

    def text_of(c):
        book, path, title = c
        try:
            _, blocks = article_blocks(book, path)
            return pick_passages(blocks, all_terms, per_source_chars)
        except Exception:
            return ""

    sources = []
    for book, path, title, text in exact + [(*c, text) for c, text in zip(picked, POOL.map(text_of, picked))]:
        if text:
            sources.append({"n": len(sources) + 1, "book": book.id, "source": book.label,
                            "lang": book.lang, "path": path, "title": title, "text": text})
    return sources


# --------------------------------------------------------------------------- own files

DOC_EXT = {".pdf", ".epub", ".txt", ".md", ".html", ".htm", ".mobi", ".djvu", ".mp4", ".mp3", ".m4a",
           ".jpg", ".jpeg", ".png", ".csv", ".docx", ".xlsx", ".pptx", ".odt"}


def list_files():
    out = []
    for p in sorted(LIB_DIR.rglob("*")):
        if p.is_file() and p.suffix.lower() in DOC_EXT and not p.name.startswith("."):
            rel = p.relative_to(LIB_DIR).as_posix()
            out.append({"path": rel, "name": p.stem.replace("_", " "), "ext": p.suffix.lower()[1:],
                        "folder": p.parent.relative_to(LIB_DIR).as_posix() if p.parent != LIB_DIR else "",
                        "size": p.stat().st_size, "mtime": int(p.stat().st_mtime)})
    return out


# --------------------------------------------------------------------------- Ollama

def ollama(path, body=None, timeout=30, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(CFG["ollama_url"] + path, data=data, method=method or ("POST" if data else "GET"),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def ollama_stream(path, body, timeout=600):
    req = urllib.request.Request(CFG["ollama_url"] + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for line in r:
            if line.strip():
                yield json.loads(line)


_caps_cache = {}


def model_caps(name):
    if name not in _caps_cache:
        try:
            _caps_cache[name] = ollama("/api/show", {"model": name}).get("capabilities", [])
        except Exception:
            return []
    return _caps_cache[name]


def think_param(model, on):
    caps = model_caps(model)
    if "thinking" not in caps:
        return None
    if model.startswith("gpt-oss"):
        return "high" if on else "low"
    return bool(on)


def installed_models():
    try:
        return ollama("/api/tags", timeout=5).get("models", [])
    except Exception:
        return None


def pick_default_model(installed):
    names = [m["name"] for m in installed or []]
    want = CFG.get("default_model")
    if want and want in names:
        return want
    ram = hardware()["ram_gb"]
    tier = model_tier(ram)
    for n in [tier["default"]] + tier["recommended"]:
        if n in names:
            return n
    # then the biggest current model from our catalog that fits this Mac
    known = sorted((m for m in CATALOG["models"] if m["name"] in names and m["min_ram"] <= ram), key=lambda m: -m["gb"])
    if known:
        return known[0]["name"]
    # otherwise the biggest installed model that is not an embedding model
    chat = [m for m in installed or [] if "embed" not in m["name"]]
    chat.sort(key=lambda m: -m.get("size", 0))
    return chat[0]["name"] if chat else (want or tier["default"])


REWRITE_PROMPT = """You turn a user's question into short search queries for an offline library \
(Wikipedia, WikiMed, iFixit, how-to guides). The search engine uses AND logic, so each query must be \
2 to 4 key words. No question words, no filler. Use the words an encyclopedia article title would use, \
and add the technical term as its own query (e.g. "myocardial infarction" for heart attack). \
Give one German and one English list with 2 or 3 queries each. The first query is the most important one.
Reply only with JSON: {"de": ["...", "..."], "en": ["...", "..."]}"""


_no_structured = set()  # models where Ollama has no structured output (e.g. MLX engine)


def parse_json_object(text):
    m = re.search(r"\{.*\}", text or "", re.S)
    return json.loads(m.group(0)) if m else {}


def ask_json(model, system, user, schema):
    """One short question with a JSON answer. Uses the chat's num_ctx, otherwise Ollama reloads the model."""
    body = {
        "model": model, "stream": False, "keep_alive": "30m",
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "options": {"temperature": 0, "num_predict": 200, "num_ctx": num_ctx()},
    }
    if model not in _no_structured:
        body["format"] = schema
    tp = think_param(model, False)
    if tp is not None:
        body["think"] = tp
    try:
        out = ollama("/api/chat", body, timeout=120)
    except urllib.error.HTTPError:
        if "format" not in body:
            raise
        _no_structured.add(model)
        body.pop("format")
        out = ollama("/api/chat", body, timeout=120)
    return parse_json_object(out["message"]["content"])


def rewrite_queries(model, question, history):
    ctx = ""
    for m in history[-4:]:
        ctx += f"{m['role']}: {m['content'][:300]}\n"
    schema = {"type": "object", "properties": {
        "de": {"type": "array", "items": {"type": "string"}},
        "en": {"type": "array", "items": {"type": "string"}}}, "required": ["de", "en"]}
    try:
        data = ask_json(model, REWRITE_PROMPT, (f"Conversation so far:\n{ctx}\n" if ctx else "") + f"Question: {question}", schema)
        queries = {k: [str(q).strip() for q in v if str(q).strip()][:3] for k, v in data.items() if isinstance(v, list)}
        if any(queries.values()):
            return queries
    except Exception as e:
        print(f"[basecamp] query rewrite failed: {e}", file=sys.stderr)
    kw = " ".join(keywords(question)[:4])
    return {"de": [kw], "en": [kw]}


SYSTEM_KNOWLEDGE = """Du bist Basecamp, ein hilfreicher Assistent, der ohne Internet läuft. \
Unten stehen Auszüge aus der lokalen Bibliothek (Wikipedia, WikiMed, iFixit usw.), nummeriert [1], [2] ...
Regeln:
- Antworte in der Sprache der Frage. Kurz, klar, gut gegliedert (Markdown).
- Englische Quellen übersetzt du sinngemäß, Fachbegriffe gibst du auf Deutsch an.
- Stütze dich auf die Quellen und zitiere sie mit [1], [2] direkt nach der Aussage.
- Wenn die Quellen nicht reichen, sag das offen und ergänze mit eigenem Wissen, klar gekennzeichnet.
- Bei Gesundheit und Sicherheit: nenne Warnzeichen und wann man Hilfe holen muss."""

SYSTEM_PLAIN = """Du bist Basecamp, ein hilfreicher Assistent, der ohne Internet läuft. \
Antworte in der Sprache der Frage. Kurz, klar, gut gegliedert (Markdown)."""

SYSTEM_ARTICLE = """Du bist Basecamp, ein hilfreicher Offline-Assistent. Der Nutzer liest gerade den Artikel unten. \
Beantworte Fragen dazu. Stütze dich auf den Artikel und sag, wenn etwas nicht drinsteht. \
Antworte in der Sprache der Frage, kurz und klar (Markdown)."""


def model_loaded(model):
    try:
        return any(model in (m.get("name"), m.get("model")) for m in ollama("/api/ps", timeout=3).get("models", []))
    except Exception:
        return True  # unknown: just go on


def warm_up(model):
    """Big models take 10 to 60 s to load into memory. Say so, instead of looking frozen."""
    if model_loaded(model):
        return
    title = MODELS.get(model, {}).get("title", model).split(" · ")[0]
    yield {"t": "status", "c": f"Lade {title} in den Arbeitsspeicher …", "load": True}
    try:
        ollama("/api/generate", {"model": model, "prompt": "", "keep_alive": "30m"}, timeout=900)
    except Exception:
        pass  # the real request below reports the error


# --------------------------------------------------------------------------- projects and memory

# Facts sit in one file per project, plus one for chats without a project. A chat only ever opens
# its own file, so projects cannot see each other's facts.
MEMORY_DIR = DATA / "memory"
PROJECTS_FILE = DATA / "projects.json"
STORE_LOCK = threading.RLock()
PROJECT_NAME_CHARS = 80
PROJECT_INSTRUCTION_CHARS = 4000
FACT_CHARS = 300
FACTS_PER_SCOPE = 200
FACTS_PER_MESSAGE = 5
FORGETS_PER_MESSAGE = 5
LEARN_MESSAGE_CHARS = 2000
# how much memory goes into the system prompt: the small models have little room
MEMORY_PROMPT_CHARS_SMALL = 1500
MEMORY_PROMPT_CHARS = 4000


def read_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(path, value):
    """Goes through a temp file: a crash or a pulled USB stick must not leave half a file behind."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.unlink(missing_ok=True)
    # health data and addresses end up here: only this user account may read them
    with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT, 0o600), "w", encoding="utf-8") as f:
        f.write(json.dumps(value, ensure_ascii=False, indent=1))
    os.replace(tmp, path)


def all_projects():
    return read_json(PROJECTS_FILE, [])


def find_project(pid):
    return next((p for p in all_projects() if p["id"] == pid), None)


def save_project(pid, fields):
    with STORE_LOCK:
        projects = all_projects()
        project = next((p for p in projects if p["id"] == pid), None)
        if pid and not project:
            return None
        if not project:
            project = {"id": uuid.uuid4().hex[:12], "name": "", "instructions": "", "created": int(time.time())}
            projects.insert(0, project)
        if "name" in fields:
            project["name"] = " ".join(str(fields["name"]).split())[:PROJECT_NAME_CHARS]
        if "instructions" in fields:
            project["instructions"] = str(fields["instructions"]).strip()[:PROJECT_INSTRUCTION_CHARS]
        if not project["name"]:
            return None
        write_json(PROJECTS_FILE, projects)
        return project


def delete_project(pid):
    with STORE_LOCK:
        path = memory_file(pid)
        if not pid or not path:
            return False
        write_json(PROJECTS_FILE, [p for p in all_projects() if p["id"] != pid])
        path.unlink(missing_ok=True)
        return True


def memory_file(project):
    """No project means the general memory. An unknown id gets None: it must not fall back to the
    general memory, and only ids we created ourselves ever become a file name."""
    if not project:
        return MEMORY_DIR / "general.json"
    return MEMORY_DIR / f"{project}.json" if find_project(project) else None


def read_memory(project):
    path = memory_file(project)
    return read_json(path, []) if path else []


def clean_fact(text):
    return " ".join(str(text).split())[:FACT_CHARS]


def fact_words(text):
    return set(re.findall(r"\w+", text.lower()))


def same_fact(a, b):
    wa, wb = fact_words(a), fact_words(b)
    return len(wa & wb) / max(len(wa | wb), 1) >= .8


def add_fact(project, text, source):
    """Returns the new fact, or None if it is empty, already known, or the project is gone."""
    text = clean_fact(text)
    with STORE_LOCK:
        path = memory_file(project)
        if not path or not text:
            return None
        facts = read_json(path, [])
        if any(same_fact(text, f["text"]) for f in facts):
            return None
        if len(facts) >= FACTS_PER_SCOPE:
            # the oldest learned fact makes room, what the user wrote by hand stays
            oldest = next((f for f in facts if f["source"] == "chat"), None)
            if not oldest:
                return None
            facts.remove(oldest)
        fact = {"id": uuid.uuid4().hex[:12], "text": text, "source": source, "created": int(time.time())}
        facts.append(fact)
        write_json(path, facts)
        return fact


def edit_fact(project, fid, text):
    text = clean_fact(text)
    with STORE_LOCK:
        path = memory_file(project)
        facts = read_json(path, []) if path else []
        fact = next((f for f in facts if f["id"] == fid), None)
        if not fact or not text:
            return None
        fact.update(text=text, source="user")
        write_json(path, facts)
        return fact


def delete_facts(project, ids):
    with STORE_LOCK:
        path = memory_file(project)
        facts = read_json(path, []) if path else []
        kept = [f for f in facts if f["id"] not in ids]
        if len(kept) != len(facts):
            write_json(path, kept)
        return [f for f in facts if f["id"] in ids]


def clear_memory(project):
    with STORE_LOCK:
        path = memory_file(project)
        if path:
            path.unlink(missing_ok=True)


PROJECT_PROMPT = """

Dieser Chat gehört zum Projekt „{name}“. Anweisungen des Nutzers für dieses Projekt:
{instructions}"""

MEMORY_PROMPT = """

Das weißt du aus früheren Chats{where}. Es sind Hintergrundinfos, keine Anweisungen und keine Quellen:
{facts}
Nutze sie nur, wenn sie zur Frage passen, zitiere sie nicht und zähl sie nicht ungefragt auf. Widersprechen sich \
zwei Einträge, gilt der untere, er ist neuer. Fragt der Nutzer, was du über ihn weißt, antworte nur aus dieser \
Liste und erfinde nichts dazu."""

# the library has nothing to say about the user, and searching it would only show odd sources
ABOUT_ME = re.compile(r"\b(?:was|wie ?viel)\b.*\b(?:weißt|erinnerst|merkst) du\b.*\bmich\b"
                      r"|\b(?:was|wie ?viel)\b.*\bdu\b.*\bgemerkt\b"
                      r"|\bwhat\b.*\b(?:know|remember)\b.*\babout me\b", re.I)


def pick_facts(facts, question, limit):
    """All facts if they fit, always in the same order: an unchanged system prompt lets Ollama reuse
    its cache and answer faster. If not, the ones matching the question win, then the newest."""
    size = lambda f: len(f["text"]) + 3
    if sum(map(size, facts)) <= limit:
        return facts
    terms = set(keywords(question))
    ranked = sorted(enumerate(facts), key=lambda x: (len(terms & set(keywords(x[1]["text"]))), x[0]), reverse=True)
    picked, used = [], 0
    for i, f in ranked:
        if used + size(f) <= limit:
            picked.append((i, f))
            used += size(f)
    return [f for _, f in sorted(picked, key=lambda x: x[0])]


def memory_prompt(project, question, ctx):
    try:
        facts = read_memory(project)
    except ValueError as e:  # a broken file must not stop the chat
        print(f"[basecamp] memory: {e}", file=sys.stderr)
        return ""
    limit = MEMORY_PROMPT_CHARS_SMALL if ctx <= 8192 else MEMORY_PROMPT_CHARS
    lines = "\n".join(f"- {f['text']}" for f in pick_facts(facts, question, limit))
    return MEMORY_PROMPT.format(where=" in diesem Projekt" if project else " über den Nutzer", facts=lines) if lines else ""


LEARN_PROMPT = """You extract lasting facts about the user from one message, for a memory used in future chats.
Save only what the user clearly says about themselves: who they are, where they live, health, work, family, belongings, preferences, plans. Also anything they ask to remember.
Do NOT save: questions, requests, tasks for today, opinions on general topics, general knowledge, or anything not written in the message.
Most messages have nothing to save. Then return an empty list.
Each fact is one short sentence in the same language as the message.

Examples:
"Ich habe eine Nussallergie, was kann ich backen?" -> {"facts": ["Hat eine Nussallergie."]}
"Merk dir, dass ich Vegetarier bin." -> {"facts": ["Ist Vegetarier."]}
"I work as a nurse on night shifts." -> {"facts": ["Works as a nurse on night shifts."]}
"Ich brauche heute schnell ein Rezept mit Kartoffeln." -> {"facts": []}
"Ich glaube, Diesel ist effizienter als Benzin." -> {"facts": []}
"Wie kann ich einen Reifen wechseln?" -> {"facts": []}"""

LEARN_PROJECT_PROMPT = """
"Das Budget liegt bei 5000 Euro und der Kunde heißt Müller." -> {"facts": ["Das Budget liegt bei 5000 Euro.", "Der Kunde heißt Müller."]}

This chat belongs to a project. Also save lasting facts about the project: names, numbers, decisions, deadlines."""

LEARN_SCHEMA = {"type": "object", "properties": {"facts": {"type": "array", "items": {"type": "string"}}}, "required": ["facts"]}

FORGET_PROMPT = """The user wants the assistant to forget something. From the numbered list of saved facts, \
pick only the ones the user wants forgotten. If unsure, pick none.
Reply only with JSON: {"forget": [1]}"""

FORGET_SCHEMA = {"type": "object", "properties": {"forget": {"type": "array", "items": {"type": "integer"}}}, "required": ["forget"]}

# These filters save model time: most messages are plain questions and cost nothing this way.
REMEMBER_CUE = re.compile(r"\b(merk|merke|merken|notier\w*|speicher\w*|remember|keep in mind)\b", re.I)
# "Vergiss das" counts, "ich habe vergessen" does not, and neither does "lösch den Ordner"
FORGET_CUE = re.compile(r"(?:^|[.!?,;:]\s*)(?:(?:und|bitte|please|and)\s+)*(?:vergiss|forget)\b"
                        r"|\b(?:kannst|sollst)\b.*\bvergessen\b"
                        r"|\b(?:lösch\w*|entfern\w*|delete|remove)\b.*\b(?:dass|gedächtnis|memory|that i)\b", re.I)
SELF_CUE = re.compile(r"\b(ich|mein\w*|wir|unser\w*|i|i'm|i've|my|we|our)\b", re.I)
QUESTION_START = re.compile(r"\s*(wie|was|wo|woher|wohin|wer|wann|warum|wieso|weshalb|welche\w*|kann|könn\w*|soll\w*|darf|muss|"
                            r"gibt|ist|sind|hat|haben|how|what|where|who|when|why|which|can|could|should|do|does|did|is|are)\b", re.I)


def worth_learning(text, in_project):
    if REMEMBER_CUE.search(text):
        return True
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", text):
        if QUESTION_START.match(sentence):
            continue
        if SELF_CUE.search(sentence):
            return True
        if in_project and not sentence.rstrip().endswith("?") and len(sentence.split()) >= 4:
            return True
    return False


def grounded(fact, message):
    """Small models sometimes repeat the examples from the prompt. A real fact shares a word with the message."""
    low = message.lower()
    return any(w[:5] in low for w in keywords(fact))


def learn(project, model, text):
    """Update the memory from one user message. It reads only what the user wrote, never answers or
    articles, so text in a downloaded page cannot plant a fact. The model never replaces or deletes
    on its own: in tests the small one removed "has a dog" because of "has a cat"."""
    changed = {"added": [], "removed": []}
    text = str(text or "").strip()[:LEARN_MESSAGE_CHARS]
    if not text or not memory_file(project) or CFG.get("power_save"):
        return changed
    try:
        if FORGET_CUE.search(text):
            facts = read_memory(project)[-100:]
            if facts:
                listed = "\n".join(f"{i}. {f['text']}" for i, f in enumerate(facts, 1))
                answer = ask_json(model, FORGET_PROMPT, f"Saved:\n{listed}\nMessage: {text}", FORGET_SCHEMA)
                nums = [n for n in answer.get("forget") or [] if isinstance(n, int) and 1 <= n <= len(facts)]
                ids = {facts[n - 1]["id"] for n in nums[:FORGETS_PER_MESSAGE]}
                changed["removed"] = delete_facts(project, ids)
            return changed  # "Vergiss, dass ich Lehrer bin" must not save "Ist Lehrer"
        if not worth_learning(text, bool(project)):
            return changed
        prompt = LEARN_PROMPT + (LEARN_PROJECT_PROMPT if project else "") + "\nReply only with JSON."
        for found in (ask_json(model, prompt, text, LEARN_SCHEMA).get("facts") or [])[:FACTS_PER_MESSAGE]:
            if isinstance(found, str) and grounded(found, text):
                fact = add_fact(project, found, "chat")
                if fact:
                    changed["added"].append(fact)
    except Exception as e:  # learning is a bonus: the answer is already there
        print(f"[basecamp] memory: {e}", file=sys.stderr)
    return changed


# --------------------------------------------------------------------------- power saving

POWER_SAVE_ERROR = "Stromsparen ist an, die KI ist aus. Suchen und Lesen gehen weiter. Schalte es aus, um zu chatten."
BATTERY_RE = re.compile(r"InternalBattery[^\n]*?(\d+)%;\s*([^;\n]+)(?:;\s*([^\n]*))?")
_battery = (0, None)


def parse_battery(text):
    """Reads the output of `pmset -g batt`. None on a Mac without a battery."""
    m = BATTERY_RE.search(text or "")
    if not m:
        return None
    left = re.search(r"(\d+):(\d\d) remaining", m.group(3) or "")
    on_battery = "battery power" in text.lower()
    return {"percent": int(m.group(1)), "on_battery": on_battery,
            "charging": m.group(2).strip().lower() in ("charging", "finishing charge"),
            "minutes_left": int(left.group(1)) * 60 + int(left.group(2)) if left and on_battery else None}


def battery():
    global _battery
    if time.time() - _battery[0] > 20:
        try:
            out = subprocess.run(["pmset", "-g", "batt"], capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.SubprocessError):
            out = ""
        _battery = (time.time(), parse_battery(out))
    return _battery[1]


def unload_models():
    try:
        for m in ollama("/api/ps", timeout=3).get("models", []):
            ollama("/api/generate", {"model": m["name"], "stream": False, "keep_alive": 0}, timeout=30)
    except Exception as e:
        print(f"[basecamp] unload: {e}", file=sys.stderr)


def power_state():
    return {"on": bool(CFG.get("power_save")), "battery": battery()}


def chat_events(req):
    """Generator of NDJSON events for one chat turn."""
    if CFG.get("power_save"):
        yield {"t": "error", "c": POWER_SAVE_ERROR}
        return
    model = req.get("model") or pick_default_model(installed_models())
    messages = [{"role": m["role"], "content": m.get("content", ""), **({"images": m["images"]} if m.get("images") else {})}
                for m in req.get("messages", []) if m.get("role") in ("user", "assistant")]
    if not messages or messages[-1]["role"] != "user":
        yield {"t": "error", "c": "Keine Frage gefunden."}
        return
    question = messages[-1]["content"]
    yield from warm_up(model)
    mode = req.get("mode", "knowledge")
    ctx = num_ctx()
    system = SYSTEM_PLAIN
    t0 = time.time()

    if mode == "knowledge" and req.get("memory") and ABOUT_ME.search(question):
        mode = "plain"
    if mode == "knowledge" and LIB.all():
        yield {"t": "status", "c": "Überlege, wonach ich suche …"}
        queries = rewrite_queries(model, question, messages[:-1])
        yield {"t": "queries", "c": queries}
        yield {"t": "status", "c": f"Suche in {len(LIB.all())} Quellen …"}
        n_src, per = (4, 1200) if ctx <= 8192 else (6, 1800)
        sources = retrieve(queries, n_src, per, req.get("books") or None, keywords(question), question)
        yield {"t": "sources", "c": [{k: s[k] for k in ("n", "book", "source", "path", "title", "lang")} for s in sources]}
        if sources:
            system = SYSTEM_KNOWLEDGE
            block = "\n\n".join(f"[{s['n']}] {s['title']} ({s['source']})\n{s['text']}" for s in sources)
            messages[-1] = {**messages[-1], "content": f"Quellen:\n{block}\n\n---\nFrage: {question}"}
    elif mode == "article" and req.get("article"):
        art = req["article"]
        book = LIB.get(art.get("book"))
        if book:
            try:
                title, blocks = article_blocks(book, art["path"])
                limit = min(int(ctx * 2.2), 60000)
                text = "\n".join(blocks)[:limit]
                system = SYSTEM_ARTICLE + f"\n\nArtikel: {title} ({book.label})\n\n{text}"
                yield {"t": "sources", "c": [{"n": 1, "book": book.id, "source": book.label, "path": art["path"], "title": title, "lang": book.lang}]}
            except Exception:
                pass

    yield {"t": "status", "c": "Lese die Quellen …" if system is not SYSTEM_PLAIN else "Denke nach …"}
    project = find_project(req["project"]) if req.get("project") else None
    if project and project["instructions"]:
        system += PROJECT_PROMPT.format(name=project["name"], instructions=project["instructions"])
    if req.get("memory"):
        system += memory_prompt(req.get("project"), question, ctx)
    body = {"model": model, "stream": True, "keep_alive": "30m",
            "messages": [{"role": "system", "content": system}] + messages,
            "options": {"num_ctx": ctx}}
    tp = think_param(model, req.get("think"))
    if tp is not None:
        body["think"] = tp
    stats = {}
    for ev in ollama_stream("/api/chat", body):
        if ev.get("error"):
            yield {"t": "error", "c": ev["error"]}
            return
        msg = ev.get("message") or {}
        if msg.get("thinking"):
            yield {"t": "think", "c": msg["thinking"]}
        if msg.get("content"):
            yield {"t": "tok", "c": msg["content"]}
        if ev.get("done"):
            stats = {"tokens": ev.get("eval_count"), "seconds": round(time.time() - t0, 1),
                     "tps": round(ev.get("eval_count", 0) / max(ev.get("eval_duration", 1) / 1e9, 1e-6), 1),
                     "model": model}
    yield {"t": "done", "c": stats}
    if CFG.get("power_save"):  # switched on while this answer ran
        unload_models()


# --------------------------------------------------------------------------- emergency plan

# Health data, addresses and phone numbers: stays in this one file and only works directly on this Mac.
EMERGENCY_FILE = DATA / "emergency.json"
EMERGENCY_ROWS = {
    "people": (("name", "info"), 12),
    "contacts": (("name", "phone"), 40),
}
EMERGENCY_SETUP = ("home", "near", "far", "adults", "kids", "needs", "pets", "cellar", "water", "high", "gas", "electric", "nocar")
EMERGENCY_TEXT_CHARS = 500
EMERGENCY_PLAN_CHARS = 30000


def clean_emergency(body):
    text = lambda v: str(v or "").strip()[:EMERGENCY_TEXT_CHARS]
    setup = body.get("setup") if isinstance(body.get("setup"), dict) else {}
    data = {"setup": {k: text(setup.get(k)) for k in EMERGENCY_SETUP},
            "plan": str(body.get("plan") or "")[:EMERGENCY_PLAN_CHARS], "updated": int(time.time())}
    for key, (fields, limit) in EMERGENCY_ROWS.items():
        rows = body.get(key) if isinstance(body.get(key), list) else []
        cleaned = ({f: text(r.get(f)) for f in fields} for r in rows if isinstance(r, dict))
        data[key] = [row for row in cleaned if any(row.values())][:limit]
    return data


# --------------------------------------------------------------------------- warnings and river levels

# The only calls to the internet besides downloads. They start once the user switches them on and
# only send the county. The last good state stays readable offline.
WARN_FILE = DATA / "warnings.json"
WARN_EVERY = 15 * 60
WARN_DETAILS = 40  # warnings to read in full per refresh, any more keep their title
NINA_API = "https://warnung.bund.de/api31"
KREISE_URL = "https://warnung.bund.de/assets/json/converted_kreise.json"
GAUGE_PAGE = "https://www.hnd.bayern.de/pegel/"
FLOOD = CATALOG["flood"]
# "Main" also appears as Obermain, Mittelmain and Untermain
FLOOD_RE = re.compile(r"\b(?:ober|mittel|unter)?(?:" + "|".join(FLOOD["rivers"]) + r")\b", re.I)
WARN_SOURCES = {"dwd": "DWD", "mow": "MoWaS", "kat": "KATWARN", "biw": "BIWAPP", "lhp": "Hochwasserportal", "pol": "Polizei"}
WARN_RANK = {"Extreme": 4, "Severe": 3, "Moderate": 2, "Minor": 1}
WARN_LOCK = threading.Lock()
WARN_EVENT = threading.Event()
WARN_DEFAULT = {"regions": [], "flood": False, "warnings": [], "warnings_at": 0, "warnings_error": "",
                "gauges": [], "gauges_at": 0, "gauges_error": ""}


def fetch_url(url, timeout=20):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout) as r:
        return r.read()


def plain_text(value):
    """Warnings carry bits of HTML. The page shows plain text only."""
    text = re.sub(r"<br\s*/?>", "\n", str(value or ""), flags=re.I)
    return html.unescape(re.sub(r"<[^>]+>", "", text)).strip()[:3000]


def warning_detail(wid):
    d = json.loads(fetch_url(f"{NINA_API}/warnings/{urllib.parse.quote(wid)}.json"))
    infos = d.get("info") or [{}]
    info = next((i for i in infos if str(i.get("language", "")).startswith("de")), infos[0])
    return {"msg": d.get("msgType", ""), "title": plain_text(info.get("headline")), "severity": info.get("severity", ""),
            "text": plain_text(info.get("description")), "instruction": plain_text(info.get("instruction")),
            "sent": d.get("sent", ""), "expires": info.get("expires", ""),
            "area": ", ".join(plain_text(a.get("areaDesc")) for a in info.get("area") or [])[:300]}


def fetch_warnings(regions, flood):
    """Raises if a list cannot be read: a half list must never look like "no warnings"."""
    found = {}
    for region in regions:
        for it in json.loads(fetch_url(f"{NINA_API}/dashboard/{region['id']}0000000.json")):
            data = (it.get("payload") or {}).get("data") or {}
            found.setdefault(it["id"], {"id": it["id"], "msg": data.get("msgType", ""), "severity": data.get("severity", ""),
                                        "title": plain_text((it.get("i18nTitle") or {}).get("de") or data.get("headline")),
                                        "text": "", "instruction": "", "sent": "", "expires": "", "area": ""})
    items = []
    for n, (wid, base) in enumerate(found.items()):
        try:
            items.append({**base, **(warning_detail(wid) if n < WARN_DETAILS else {})})
        except Exception:  # the title alone still counts as a warning
            items.append(base)
    if flood:
        # Official flood warnings name a river basin instead of a county, so only their text tells
        # which river they mean. All of them are read: in a big flood ours could be the last one.
        for it in json.loads(fetch_url(f"{NINA_API}/lhp/mapData.json")):
            if it["id"] in found:
                continue
            try:
                item = {"id": it["id"], **warning_detail(it["id"])}
            except urllib.error.HTTPError as e:
                if e.code == 404:  # lifted between the list and this request
                    continue
                raise
            if FLOOD_RE.search(" ".join((item["title"], item["text"], item["area"]))):
                items.append(item)
    items = [{**w, "source": WARN_SOURCES.get(w["id"][:3], "NINA")} for w in items if w["msg"] != "Cancel"]
    return sorted(items, key=lambda w: (WARN_RANK.get(w["severity"], 2), w["sent"]), reverse=True)


class GaugeParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "img" and a.get("data-thema") == "pegel":
            self.tags.append(a)


def parse_gauges(page):
    parser = GaugeParser()
    parser.feed(page)
    gauges = []
    for a in parser.tags:
        name = a.get("data-name", "")
        if name.endswith(" Q"):  # a second entry for the same gauge, with the flow only
            continue
        level, stage = a.get("data-wert", ""), a.get("data-ms", "")
        gauges.append({"id": a.get("id", name), "name": name, "river": a.get("data-zeile2", ""),
                       "level": int(level) if re.fullmatch(r"-?\d+", level) else None,
                       "stage": int(stage) if stage.isdigit() else None, "at": a.get("data-datum", "")})
    return gauges


def fetch_gauges():
    """All gauges on the rivers we follow, plus every other gauge in the area that reports a flood."""
    seen = {}
    for name in FLOOD["pages"]:
        for g in parse_gauges(fetch_url(GAUGE_PAGE + name).decode("utf-8", "replace")):
            if g["river"] in FLOOD["rivers"] or (g["stage"] or 0) >= 1:
                seen.setdefault(g["id"], g)
    if not any(g["level"] is not None for g in seen.values()):
        raise ValueError("no gauge readings on the page")  # the page changed: not the same as "all fine"
    return list(seen.values())


def read_warnings():
    return {**WARN_DEFAULT, **read_json(WARN_FILE, {})}


def fetch_problem(e):
    if isinstance(e, urllib.error.HTTPError):
        return "Dienst gerade gestört"
    if isinstance(e, OSError):
        return "Keine Verbindung"
    return "Antwort nicht lesbar"


def refresh_warnings():
    """Keeps the last good state of each source when a fetch fails."""
    with WARN_LOCK:
        before = read_warnings()
        update = {}
        if before["regions"] or before["flood"]:
            try:
                update.update(warnings=fetch_warnings(before["regions"], before["flood"]), warnings_at=int(time.time()), warnings_error="")
            except Exception as e:
                print(f"[basecamp] warnings: {e}", file=sys.stderr)
                update["warnings_error"] = fetch_problem(e)
        if before["flood"]:
            try:
                update.update(gauges=fetch_gauges(), gauges_at=int(time.time()), gauges_error="")
            except Exception as e:
                print(f"[basecamp] gauges: {e}", file=sys.stderr)
                update["gauges_error"] = fetch_problem(e)
        with STORE_LOCK:
            now = read_warnings()
            if (now["regions"], now["flood"]) == (before["regions"], before["flood"]) and update:
                write_json(WARN_FILE, {**now, **update})


def warnings_worker():
    while True:
        try:
            refresh_warnings()
        except Exception as e:
            print(f"[basecamp] warnings: {e}", file=sys.stderr)
        WARN_EVENT.wait(WARN_EVERY)
        WARN_EVENT.clear()


def warning_active(w, now):
    try:
        return not w["expires"] or datetime.datetime.fromisoformat(w["expires"]).timestamp() > now
    except ValueError:
        return True


def warnings_view():
    state = read_warnings()
    now = time.time()
    state["warnings"] = [w for w in state["warnings"] if warning_active(w, now)]
    return {**state, "now": int(now), "checking": WARN_LOCK.locked() or WARN_EVENT.is_set(),
            "flood_rivers": FLOOD["rivers"], "flood_regions": FLOOD["regions"]}


def save_warning_settings(body):
    regions = []
    for r in body.get("regions") or []:
        rid = str(r.get("id")) if isinstance(r, dict) else ""
        if re.fullmatch(r"\d{5}", rid):
            regions.append({"id": rid, "name": str(r.get("name") or rid)[:80]})
    with STORE_LOCK:
        state = read_warnings()
        changed = regions[:5] != state["regions"] or bool(body.get("flood")) != state["flood"]
        state.update(regions=regions[:5], flood=bool(body.get("flood")))
        if changed:  # "no warnings" from the old area must not pass for the new one
            state.update(WARN_DEFAULT | {"regions": state["regions"], "flood": state["flood"]})
        write_json(WARN_FILE, state)
    WARN_EVENT.set()


def search_regions(q):
    """Counties, so the user can search by name. The list is kept after the first download."""
    path = CACHE_DIR / "kreise.json"
    names = read_json(path, None)
    if names is None:
        names = {k: v["NAME"] for k, v in json.loads(fetch_url(KREISE_URL)).items()}
        write_json(path, names)
    q = q.strip().lower()
    label = lambda n: n if n.split(" ")[0] in ("Landkreis", "Kreis", "Region", "Regionalverband", "Städteregion", "Eifelkreis") else f"Stadt {n}"
    hits = sorted((n.lower().find(q), n, k) for k, n in names.items() if q in n.lower())
    return [{"id": k, "name": label(n)} for _, n, k in hits[:12]]


# --------------------------------------------------------------------------- background tasks

TASKS = {}
TASK_LOCK = threading.Lock()
DL_QUEUE = []
DL_EVENT = threading.Event()


class Canceled(Exception):
    pass


def new_task(kind, ref, title):
    with TASK_LOCK:
        for t in TASKS.values():
            if t["kind"] == kind and t["ref"] == ref and t["status"] in ("queued", "running"):
                return t
        t = {"id": uuid.uuid4().hex[:8], "kind": kind, "ref": ref, "title": title, "status": "queued",
             "done": 0, "total": 0, "speed": 0, "error": "", "cancel": False, "started": time.time()}
        TASKS[t["id"]] = t
        return t


def public_tasks():
    with TASK_LOCK:
        return [{k: v for k, v in t.items() if k != "cancel"} for t in TASKS.values()]


_listing_cache = {}


def kiwix_latest(item, force=False):
    """Newest file name for a catalog item, from the Kiwix directory listing."""
    folder = item["folder"]
    cached = _listing_cache.get(folder)
    if force or not cached or time.time() - cached[0] > 6 * 3600:
        try:
            names = bible_listing() if item.get("bible") else kiwix_listing(folder)
        except Exception:
            if cached and not force:  # offline: the old listing is good enough
                return _pick_latest(item, cached[1])
            raise
        _listing_cache[folder] = (time.time(), names)
    return _pick_latest(item, _listing_cache[folder][1])


def kiwix_listing(folder):
    html_text = fetch_url(f"{CATALOG['kiwix_base']}/{folder}/", timeout=30).decode("utf-8", "replace")
    return re.findall(r'href="([^"/?]+\.zim)"', html_text)


def _pick_latest(item, names):
    pat = re.compile(re.escape(item["id"]) + r"_(\d{4}-\d{2})\.zim$")
    versions = sorted((m.group(1), n) for n in names if (m := pat.match(n)))
    return versions[-1][1] if versions else None


def download_worker():
    while True:
        DL_EVENT.wait()
        with TASK_LOCK:
            task = DL_QUEUE.pop(0) if DL_QUEUE else None
            if not DL_QUEUE:
                DL_EVENT.clear()
        if not task:
            continue
        if task["cancel"]:
            task["status"] = "canceled"
            continue
        task["status"] = "running"
        try:
            (download_map if task["kind"] == "map" else download_zim)(task)
            task["status"] = "done"
        except Canceled:
            task["status"] = "canceled"
        except Exception as e:
            task["status"], task["error"] = "error", str(e)
            print(f"[basecamp] download {task['ref']} failed: {e}", file=sys.stderr)


def download_zim(task):
    item = ITEMS[task["ref"]]
    if item.get("bible"):
        return download_bible(task, item)
    fname = kiwix_latest(item)
    if not fname:
        raise RuntimeError("Datei nicht im Kiwix-Katalog gefunden")
    dest = ZIM_DIR / fname
    if dest.exists():
        return
    url = f"{CATALOG['kiwix_base']}/{item['folder']}/{fname}"
    part = ZIM_DIR / (fname + ".part")
    for attempt in range(8):
        have = part.stat().st_size if part.exists() else 0
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Range": f"bytes={have}-"})
            with urllib.request.urlopen(req, timeout=60) as r:
                if r.status == 200:
                    have = 0  # server ignored the range
                total = have + int(r.headers.get("Content-Length") or 0)
                task["total"], task["done"] = total, have
                need = (total - have) / 1e9
                free = shutil.disk_usage(ZIM_DIR).free / 1e9
                if need > free - 2:
                    raise RuntimeError(f"Zu wenig Speicher: {need:.1f} GB nötig, {free:.1f} GB frei")
                with open(part, "ab" if have else "wb") as f:
                    last_t, last_b = time.time(), task["done"]
                    while True:
                        if task["cancel"]:
                            raise Canceled()
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                        task["done"] += len(chunk)
                        now = time.time()
                        if now - last_t >= 1:
                            task["speed"] = (task["done"] - last_b) / (now - last_t)
                            last_t, last_b = now, task["done"]
            if total and part.stat().st_size >= total:
                break
        except urllib.error.HTTPError as e:
            if e.code == 416 and have:  # already complete
                break
            if attempt == 7:
                raise
        except (Canceled, RuntimeError):
            raise
        except Exception:
            if attempt == 7:
                raise
        time.sleep(min(60, 2 ** attempt))
    else:
        raise RuntimeError("Download unvollständig. Nochmal versuchen, er setzt an der Stelle fort.")
    install_zim(part, dest, item)


def install_zim(part, dest, item):
    try:
        Archive(str(part))
    except Exception:
        part.unlink(missing_ok=True)
        raise RuntimeError("Die geladene Datei ist beschädigt. Bitte neu laden.")
    part.rename(dest)
    # remove older versions of the same book
    for old in ZIM_DIR.glob(item["id"] + "_*.zim"):
        m = VERSION_RE.match(old.stem)
        if old != dest and m and m.group(1) == item["id"]:
            old.unlink()
    LIB.rescan()


# --------------------------------------------------------------------------- bible

# eBible.org has no ZIM files, so a translation is built into one here. That makes it a normal source
# for search, chat and the article reader. The viewer reads the same file, which holds the whole text
# once more as JSON, because the pages alone do not say where a paragraph or a poem line starts.
BIBLE_BASE = CATALOG["bible_base"]
BIBLE_ITEMS = [it for it in CATALOG["items"] if it.get("bible")]
BIBLE_JSON = "data/bible.json"
BIBLE_BOOKS = 66
BIBLE_MIN_VERSES = 31000  # anything shorter is a broken file, not a Bible
BIBLE_HITS = 200
BIBLE_QUERY_CHARS = 100
BIBLE_LOCK = threading.Lock()
BIBLE_CACHE = {}  # book id -> (file, text), read on first use
# Schlachter writes a second verse numbering into the running text: "(03-2) Ach, HERR". The licence
# asks to say so when text changes, which the catalog credit does.
BIBLE_ALT_NUMBER = re.compile(r"\(\d{1,4}-\d{1,3}\)")
# What people type, in lower case with ae, oe, ue and ss and without spaces or dots.
BIBLE_NAMES = {
    "GEN": "1mose 1mo gen genesis", "EXO": "2mose 2mo ex exo exodus", "LEV": "3mose 3mo lev levitikus",
    "NUM": "4mose 4mo num numeri", "DEU": "5mose 5mo dtn deut deuteronomium", "JOS": "josua jos", "JDG": "richter ri",
    "RUT": "ruth rut", "1SA": "1samuel 1sam", "2SA": "2samuel 2sam", "1KI": "1koenige 1koen 1kge",
    "2KI": "2koenige 2koen 2kge", "1CH": "1chronik 1chr", "2CH": "2chronik 2chr", "EZR": "esra esr",
    "NEH": "nehemia neh", "EST": "esther ester est", "JOB": "hiob hi ijob", "PSA": "psalmen psalm ps",
    "PRO": "sprueche spr", "ECC": "prediger pred kohelet koh", "SNG": "hohelied hoheslied hld hl", "ISA": "jesaja jes",
    "JER": "jeremia jer", "LAM": "klagelieder klgl", "EZK": "hesekiel hes ezechiel ez", "DAN": "daniel dan",
    "HOS": "hosea hos", "JOL": "joel", "AMO": "amos am", "OBA": "obadja ob", "JON": "jona", "MIC": "micha mi",
    "NAM": "nahum nah", "HAB": "habakuk hab", "ZEP": "zephanja zefanja zef", "HAG": "haggai hag", "ZEC": "sacharja sach",
    "MAL": "maleachi mal", "MAT": "matthaeus matth mt", "MRK": "markus mk", "LUK": "lukas lk", "JHN": "johannes joh",
    "ACT": "apostelgeschichte apg", "ROM": "roemer roem", "1CO": "1korinther 1kor", "2CO": "2korinther 2kor",
    "GAL": "galater gal", "EPH": "epheser eph", "PHP": "philipper phil", "COL": "kolosser kol",
    "1TH": "1thessalonicher 1thess 1thes", "2TH": "2thessalonicher 2thess 2thes", "1TI": "1timotheus 1tim",
    "2TI": "2timotheus 2tim", "TIT": "titus tit", "PHM": "philemon phlm", "HEB": "hebraeer hebr", "JAS": "jakobus jak",
    "1PE": "1petrus 1petr", "2PE": "2petrus 2petr", "1JN": "1johannes 1joh", "2JN": "2johannes 2joh",
    "3JN": "3johannes 3joh", "JUD": "judas jud", "REV": "offenbarung offb off",
}
BIBLE_KEYS = {name: book for book, names in BIBLE_NAMES.items() for name in names.split()}
BIBLE_REF = r"((?:[1-3]\s*\.?\s*)?[^\W\d_]+)\.?"
BIBLE_PLACE = r"(\d{1,3})(?:\s*[,:]\s*(\d{1,3}))?(?:\s*-\s*\d{1,3})?"
BIBLE_BOX = re.compile(rf"\s*{BIBLE_REF}(?:\s*{BIBLE_PLACE})?\s*")
BIBLE_IN_TEXT = re.compile(rf"(?<![\w.]){BIBLE_REF}\s*{BIBLE_PLACE}(?!\w)")
BIBLE_CUES = re.compile(r"\b(bibel\w*|biblisch\w*|evangelium|evangelien|psalm\w*|apostel\w*|jesus|jesu|christus"
                        r"|(?:alte|neue)[sn]? testament\w*)\b", re.I)
BIBLE_NEAR = 2  # verses around a named verse that go to the model
BIBLE_PAGE_HEAD = "<style>.ref{font-size:.72em;opacity:.55;font-weight:400;margin-right:.35em}.src{opacity:.6;font-size:.9em}</style>"


def bible_listing():
    """The files we would build, named after eBible's last update of each translation."""
    text = fetch_url(f"{BIBLE_BASE}/translations.csv", timeout=30).decode("utf-8-sig")
    updated = {row["translationId"]: row["UpdateDate"] for row in csv.DictReader(io.StringIO(text))}
    return [f"{it['id']}_{updated[it['bible']][:7]}.zim" for it in BIBLE_ITEMS if it["bible"] in updated]


def clean_verse(text):
    text = re.sub(r"\s+", " ", BIBLE_ALT_NUMBER.sub(" ", text)).strip()
    return re.sub(r" ([,.;:!?])", r"\1", text)


def parse_book(node):
    book = {"id": node.get("id"), "name": "", "title": "", "chapters": []}
    verse = None

    def add(text):
        if not text or verse is None or not book["chapters"]:
            return
        blocks = book["chapters"][-1]
        if not blocks:
            blocks.append(["p", []])
        rows = blocks[-1][1]
        if rows and rows[-1][0] == verse:
            rows[-1][1] += text
        else:
            rows.append([verse, text])

    def walk(parent):
        nonlocal verse
        for el in parent:
            if el.tag == "h":
                book["name"] = (el.text or "").strip().replace("Chonik", "Chronik")  # typo in the source
            elif el.tag == "toc":
                if el.get("level") == "1":
                    book["title"] = (el.text or "").strip()
            elif el.tag == "c":
                while len(book["chapters"]) < int(el.get("id")):
                    book["chapters"].append([])
                verse = None
            elif el.tag == "v":
                verse = int(re.match(r"\d+", el.get("id")).group())
            elif el.tag == "ve":
                verse = None
            elif el.tag in ("p", "q"):
                if (el.get("style") or "").startswith("mt"):  # the title, known from the toc
                    add(el.tail)
                    continue
                if book["chapters"]:
                    book["chapters"][-1].append([el.tag, []])
                add(el.text)
                walk(el)
            elif el.tag not in ("id", "f", "x"):  # f and x are notes
                add(el.text)
                walk(el)
            add(el.tail)
    walk(node)
    for blocks in book["chapters"]:
        for block in blocks:
            block[1] = [[n, cleaned] for n, text in block[1] if (cleaned := clean_verse(text))]
        blocks[:] = [block for block in blocks if block[1]]
    return book


def parse_usfx(raw):
    """eBible's XML to [{id, name, title, chapters: [[[kind, [[verse, text], ...]], ...], ...]}]."""
    books = [parse_book(node) for node in ET.fromstring(raw).iter("book")]
    verses = sum(len(block[1]) for book in books for blocks in book["chapters"] for block in blocks)
    if len(books) != BIBLE_BOOKS or verses < BIBLE_MIN_VERSES:
        raise RuntimeError(f"Die geladene Bibel ist unvollständig: {len(books)} Bücher, {verses} Verse.")
    return books


def chapter_title(book, n):
    return f"{'Psalm' if book['id'] == 'PSA' else book['name']} {n}"


def chapter_verses(blocks):
    merged = {}
    for _, rows in blocks:
        for n, text in rows:
            merged[n] = f"{merged[n]} {text}" if n in merged else text
    return merged


def chapter_page(book, n, source, before, after):
    title = html.escape(chapter_title(book, n))
    verses = "".join(f'<p id="v{v}"><b class="ref">{title},{v}</b> {html.escape(text)}</p>'
                     for v, text in chapter_verses(book["chapters"][n - 1]).items())
    link = lambda page, label: f'<a href="{page[0]["id"]}.{page[1]}">{label} {html.escape(chapter_title(*page))}</a>' if page else ""
    return (f'<!doctype html><html lang="de"><head><meta charset="utf-8"><title>{title}</title>{BIBLE_PAGE_HEAD}</head>'
            f'<body><h1>{title}</h1><p class="src">{html.escape(source)}</p>{verses}'
            f'<nav>{link(before, "←")} {link(after, "→")}</nav></body></html>')


class ZimPage(Item):
    def __init__(self, path, title, mimetype, content, front=True):
        super().__init__()
        self.path, self.title, self.mimetype, self.content, self.front = path, title, mimetype, content, front

    def get_path(self):
        return self.path

    def get_title(self):
        return self.title

    def get_mimetype(self):
        return self.mimetype

    def get_contentprovider(self):
        return StringProvider(self.content)

    def get_hints(self):
        return {Hint.FRONT_ARTICLE: self.front}


def write_bible_zim(books, item, part, version):
    pages = [(book, n) for book in books for n in range(1, len(book["chapters"]) + 1)]
    contents = "".join(f'<li><a href="{book["id"]}.1">{html.escape(book["name"])}</a></li>' for book in books)
    start = (f'<!doctype html><html lang="de"><head><meta charset="utf-8"><title>{html.escape(item["title"])}</title></head>'
             f'<body><h1>{html.escape(item["title"])}</h1><ul>{contents}</ul><p>{html.escape(item["credit"])}</p></body></html>')
    text = json.dumps({"code": item["bible"], "books": books}, ensure_ascii=False, separators=(",", ":"))
    with Creator(str(part)).config_indexing(True, "deu").config_verbose(False) as zim:
        zim.set_mainpath("index")
        for key, value in (("Title", item["title"]), ("Description", item["desc"]), ("Language", "deu"),
                           ("Name", item["id"]), ("Creator", item["short"]), ("Publisher", "eBible.org"),
                           ("Date", f"{version}-01"), ("Tags", "_category:bibel"), ("License", item["credit"])):
            zim.add_metadata(key, value)
        icon = (STATIC / "bible.png").read_bytes()
        try:
            zim.add_illustration(icon, 96)
        except TypeError:  # older libzim wants the size first
            zim.add_illustration(96, icon)
        zim.add_item(ZimPage("index", item["title"], "text/html", start, front=False))
        zim.add_item(ZimPage(BIBLE_JSON, item["title"], "application/json", text, front=False))
        for i, (book, n) in enumerate(pages):
            before = pages[i - 1] if i else None
            after = pages[i + 1] if i + 1 < len(pages) else None
            page = chapter_page(book, n, item["title"], before, after)
            zim.add_item(ZimPage(f"{book['id']}.{n}", chapter_title(book, n), "text/html", page))


def download_bible(task, item):
    fname = kiwix_latest(item)
    if not fname:
        raise RuntimeError("Übersetzung bei eBible.org nicht gefunden")
    dest = ZIM_DIR / fname
    if dest.exists():
        return
    raw = fetch_url(f"{BIBLE_BASE}/{item['bible']}_usfx.zip", timeout=120)
    task["total"] = task["done"] = len(raw)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        books = parse_usfx(archive.read(f"{item['bible']}_usfx.xml"))
    if task["cancel"]:
        raise Canceled()
    part = ZIM_DIR / (fname + ".part")
    part.unlink(missing_ok=True)
    try:
        write_bible_zim(books, item, part, VERSION_RE.match(Path(fname).stem).group(2))
    except Exception:
        part.unlink(missing_ok=True)
        raise
    install_zim(part, dest, item)


def bible_text(book):
    with BIBLE_LOCK:
        cached = BIBLE_CACHE.get(book.id)
        if cached and cached[0] == book.path:
            return cached[1]
        with book.lock:
            raw = bytes(book.archive.get_entry_by_path(BIBLE_JSON).get_item().content)
        data = json.loads(raw)
        data["by_id"] = {b["id"]: b for b in data["books"]}
        data["rows"] = None
        BIBLE_CACHE[book.id] = (book.path, data)
        return data


def bible_key(name):
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        name = name.lower().replace(a, b)
    return re.sub(r"[\s.]", "", name)


def bible_place(data, book_id, chapter, verse):
    """A place that really exists in this Bible, or None. Books with one chapter count verses directly."""
    book = data["by_id"].get(book_id)
    if not book:
        return None
    if len(book["chapters"]) == 1 and chapter and not verse:
        chapter, verse = 1, chapter
    chapter = chapter or 1
    if not 1 <= chapter <= len(book["chapters"]):
        return None
    if verse and verse not in chapter_verses(book["chapters"][chapter - 1]):
        return None
    label = chapter_title(book, chapter) + (f",{verse}" if verse else "")
    return {"b": book_id, "c": chapter, "v": verse, "label": label}


def bible_box_place(data, query):
    """The search box: "Joh 3,16", "1. Kor 13", "johan". The whole input has to be the place."""
    m = BIBLE_BOX.fullmatch(query)
    if not m:
        return None
    key = bible_key(m[1])
    book_id = BIBLE_KEYS.get(key)
    if not book_id and len(key.lstrip("123")) >= 3:
        book_id = next((book for name, book in BIBLE_KEYS.items() if name.startswith(key)), None)
    return book_id and bible_place(data, book_id, int(m[2] or 0), int(m[3] or 0))


def bible_named(question):
    """Places inside a sentence. Short names need capitals and a verse: "Am 3,2" counts, "am 3." does not."""
    pos = 0
    while m := BIBLE_IN_TEXT.search(question, pos):
        key = bible_key(m[1])
        if key in BIBLE_KEYS and (len(key) >= 4 or (m[3] and m[1][0].isupper())):
            yield BIBLE_KEYS[key], int(m[2]), int(m[3] or 0)
            pos = m.end()
        else:  # "bedeutet 1" must not swallow the 1 of "1. Kor 13"
            pos = m.start(1) + len(m[1].split()[0])


def bible_may_search(book, book_ids, exact, question):
    """Chapter titles like "Richter 3" match everyday words, so a Bible's text only counts when it is
    asked for. A named place is answered from that place. The translations are close, one is enough."""
    if book_ids:
        return book.id in book_ids and not (exact and book.category == "bibel")
    if book.category != "bibel":
        return True
    first = next((it["id"] for it in BIBLE_ITEMS if LIB.get(it["id"])), None)
    return not exact and book.id == first and bool(BIBLE_CUES.search(question))


def bible_passages(question, max_chars, book_ids=None):
    """The places a question names, from each translation: (book, path, title, text)."""
    found = []
    named = list(bible_named(question))[:2]
    for it in BIBLE_ITEMS if named else ():
        book = LIB.get(it["id"])
        if not book or (book_ids and book.id not in book_ids):
            continue
        data = bible_text(book)
        for book_id, chapter, verse in named:
            place = bible_place(data, book_id, chapter, verse)
            if not place:
                continue
            verses = chapter_verses(data["by_id"][book_id]["chapters"][place["c"] - 1])
            title = chapter_title(data["by_id"][book_id], place["c"])
            near = [v for v in verses if not place["v"] or abs(v - place["v"]) <= BIBLE_NEAR]
            found.append((book, f"{book_id}.{place['c']}", place["label"],
                           "\n".join(f"{title},{v} {verses[v]}" for v in near)[:max_chars]))
    return found


def bible_index():
    books = None
    translations = []
    for it in BIBLE_ITEMS:
        book = LIB.get(it["id"])
        if book and books is None:
            books = [{"id": b["id"], "name": b["name"], "title": b["title"],
                      "verses": [max(chapter_verses(blocks), default=0) for blocks in b["chapters"]]}
                     for b in bible_text(book)["books"]]
        translations.append({"id": it["id"], "code": it["bible"], "title": it["title"], "short": it["short"],
                             "credit": it["credit"], "installed": bool(book)})
    return {"translations": translations, "books": books or [], "online": CATALOG["bible_online"]}


def bible_chapter(book, book_id, chapter):
    found = bible_text(book)["by_id"].get(book_id)
    if not found or not chapter.isdigit() or not 1 <= int(chapter) <= len(found["chapters"]):
        return None
    return {"blocks": found["chapters"][int(chapter) - 1]}


def bible_search(book, query):
    """A place if the input names one, and the verses: every word must start a word in the verse.
    Verses with the exact phrase come first."""
    query = query[:BIBLE_QUERY_CHARS]
    data = bible_text(book)
    place = bible_box_place(data, query)
    words = re.findall(r"[^\W_]+", query.casefold())
    if sum(map(len, words)) < 2:
        return {"place": place, "total": 0, "hits": [], "words": []}
    with BIBLE_LOCK:
        if data["rows"] is None:
            data["rows"] = [(b["id"], c, v, text, text.casefold())
                            for b in data["books"] for c, blocks in enumerate(b["chapters"], 1)
                            for v, text in chapter_verses(blocks).items()]
    patterns = [re.compile(r"(?<!\w)" + re.escape(word)) for word in words]
    phrase = " ".join(words)
    found = [row for row in data["rows"] if all(p.search(row[4]) for p in patterns)]
    found.sort(key=lambda row: phrase not in row[4])  # stable, so the Bible's own order stays
    return {"place": place, "total": len(found), "words": words,
            "hits": [{"b": b, "c": c, "v": v, "text": text} for b, c, v, text, _ in found[:BIBLE_HITS]]}


def queue_download(item_id):
    item = MAPS.get(item_id) or ITEMS[item_id]
    task = new_task("map" if item_id in MAPS else "zim", item_id, item["title"])
    with TASK_LOCK:
        if task["status"] == "queued" and task not in DL_QUEUE:
            DL_QUEUE.append(task)
    DL_EVENT.set()
    return task


def pull_model(task):
    task["status"] = "running"
    try:
        for ev in ollama_stream("/api/pull", {"model": task["ref"], "stream": True}, timeout=3600):
            if task["cancel"]:
                raise Canceled()
            if ev.get("error"):
                raise RuntimeError(ev["error"])
            if ev.get("total"):
                task["total"], task["done"] = ev["total"], ev.get("completed", 0)
            task["phase"] = ev.get("status", "")
        task["status"] = "done"
        _caps_cache.pop(task["ref"], None)
    except Canceled:
        task["status"] = "canceled"
    except Exception as e:
        task["status"], task["error"] = "error", str(e)


# --------------------------------------------------------------------------- maps

MAPS = {m["id"]: m for m in CATALOG["maps"]}
MAP_RE = re.compile(r"^(map_[a-z]+)_(\d{8})$")
PLACES_DB = MAP_DIR / "places.sqlite"


def installed_maps():
    """id -> newest .pmtiles file of that map."""
    out = {}
    for f in MAP_DIR.glob("map_*.pmtiles"):
        m = MAP_RE.match(f.stem)
        if m and m.group(1) in MAPS and (m.group(1) not in out or f.stem > out[m.group(1)].stem):
            out[m.group(1)] = f
    return out


def map_build(f):
    return MAP_RE.match(f.stem).group(2)


def map_satisfied(mid, installed):
    """A map counts as present when it, or a bigger map that contains it, is installed."""
    return mid in installed or any(mid in MAPS[o].get("replaces", []) for o in installed)


_builds = [0.0, None]


def latest_map_build(force=False):
    if force or not _builds[1] or time.time() - _builds[0] > 6 * 3600:
        req = urllib.request.Request(CATALOG["maps_builds"], headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            keys = sorted(b["key"][:8] for b in json.load(r) if re.match(r"^\d{8}\.pmtiles$", b.get("key", "")))
        _builds[:] = [time.time(), keys[-1]]
    return _builds[1]


def map_outdated(build, latest):
    """Maps are rebuilt daily; only offer an update when ours is two months old."""
    if not build or not latest:
        return False
    d = lambda s: datetime.date(int(s[:4]), int(s[4:6]), int(s[6:]))
    return (d(latest) - d(build)).days >= 60


def _bytes(num, unit):
    return float(num) * {"B": 1, "kB": 1e3, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}.get(unit, 1)


def download_map(task):
    item = MAPS[task["ref"]]
    pm = shutil.which("pmtiles") or next((p for p in ("/opt/homebrew/bin/pmtiles", "/usr/local/bin/pmtiles") if os.path.exists(p)), None)
    if not pm:
        raise RuntimeError("Das Programm pmtiles fehlt. Einmal ./basecamp setup ausführen.")
    build = latest_map_build()
    dest = MAP_DIR / f"{item['id']}_{build}.pmtiles"
    if not dest.exists():
        part = MAP_DIR / f"{item['id']}_{build}.pmtiles.part"
        args = [pm, "extract", f"{CATALOG['maps_base']}/{build}.pmtiles", str(part),
                "--bbox=" + ",".join(str(x) for x in item["bbox"]), "--download-threads=8"]
        if item.get("maxzoom") is not None:
            args.append(f"--maxzoom={item['maxzoom']}")
        task["phase"] = "Berechne Ausschnitt …"
        dry = subprocess.run(args + ["--dry-run"], capture_output=True, text=True, timeout=600)
        m = re.search(r"archive size of ([\d.]+) ?(\w+)", dry.stdout + dry.stderr)
        task["total"] = int(_bytes(*m.groups())) if m else int(item["gb"] * 1e9)
        free = shutil.disk_usage(MAP_DIR).free
        if task["total"] > free - 2e9:
            raise RuntimeError(f"Zu wenig Speicher: {task['total'] / 1e9:.1f} GB nötig, {free / 1e9:.1f} GB frei")
        for attempt in range(3):
            task["phase"] = "Lade Karte …"
            proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
            buf = b""
            try:
                while True:
                    if task["cancel"]:
                        raise Canceled()
                    chunk = proc.stdout.read1(4096) if hasattr(proc.stdout, "read1") else proc.stdout.read(4096)
                    if not chunk:
                        break
                    buf = (buf + chunk)[-600:]
                    # "fetching chunks  94% |█████ | (41/43 MB, 11 MB/s)"
                    hits = re.findall(rb"(\d+)% \|[^(]*\(([\d.]+) ?(\w*)/([\d.]+) (\w+)(?:, ([\d.]+) (\w+)/s)?", buf)
                    if hits:
                        pct, _, _, tot, tot_u, spd, spd_u = hits[-1]
                        total = int(_bytes(tot.decode(), tot_u.decode()))
                        task["total"] = max(task["total"], total)
                        task["done"] = int(task["total"] * int(pct) / 100)
                        if spd:
                            task["speed"] = _bytes(spd.decode(), spd_u.decode())
            finally:
                if proc.poll() is None:
                    proc.kill()
                proc.wait()
                if task["cancel"]:
                    part.unlink(missing_ok=True)
            if proc.returncode == 0 and part.exists():
                break
            part.unlink(missing_ok=True)
            if attempt == 2:
                raise RuntimeError("Karte konnte nicht geladen werden. Internet prüfen und nochmal versuchen.")
            time.sleep(5 * (attempt + 1))
        part.rename(dest)
        task["done"] = task["total"]
    task["phase"] = "Ortsnamen für die Suche …"
    try:
        ensure_places(item.get("places", []), task)
    except Exception as e:  # the map itself is fine; repair_places() tries again later
        print(f"[places] {e}", file=sys.stderr)
    # remove older builds and smaller maps this one contains
    for f in MAP_DIR.glob("map_*.pmtiles"):
        m = MAP_RE.match(f.stem)
        if m and f != dest and (m.group(1) == item["id"] or m.group(1) in item.get("replaces", [])):
            f.unlink()


def repair_places():
    """Build missing parts of the place index, e.g. when the map came from a USB stick or the
    GeoNames download failed. Quietly does nothing when offline."""
    maps = installed_maps()
    if not maps:
        return
    codes = sorted({c for mid in maps for c in MAPS[mid].get("places", [])})
    try:
        ensure_places(codes)
    except Exception as e:
        print(f"[places] noch nicht vollständig: {e}", file=sys.stderr)


# ---- place search (GeoNames, CC BY 4.0)

PLACE_S = {"AIRP": "Flughafen", "RSTN": "Bahnhof", "HSP": "Krankenhaus", "HSPC": "Klinik", "CSTL": "Burg", "MUS": "Museum",
           "MNMT": "Denkmal", "UNIV": "Universität", "STDM": "Stadion", "ZOO": "Zoo", "PAL": "Schloss", "HUT": "Hütte",
           "HTL": None}
PLACE_T = {"MT": "Berg", "MTS": "Gebirge", "PK": "Gipfel", "PKS": "Gipfel", "PASS": "Pass", "VAL": "Tal", "ISL": "Insel",
           "ISLS": "Inseln", "CAPE": "Kap", "GLCR": "Gletscher", "VLC": "Vulkan", "CAVE": "Höhle"}
PLACE_H = {"LK": "See", "LKS": "Seen", "STM": "Fluss", "BAY": "Bucht", "SEA": "Meer", "OCN": "Ozean", "RSV": "Stausee",
           "CNL": "Kanal", "FLLS": "Wasserfall", "SPNG": "Quelle", "GULF": "Golf"}


def place_kind(fcl, fco, pop):
    if fcl == "P":
        if fco == "PPLC":
            return "Hauptstadt"
        return "Großstadt" if pop >= 100000 else "Stadt" if pop >= 10000 else "Ort"
    if fcl == "A":
        return "Land" if fco.startswith("PCL") else "Region"
    if fcl == "T":
        return PLACE_T.get(fco, "Gelände")
    if fcl == "H":
        return PLACE_H.get(fco, "Gewässer")
    if fcl == "S":
        return PLACE_S.get(fco) or "Ort"
    if fcl == "L":
        return "Park" if fco == "PRK" else "Schutzgebiet" if fco in ("RESN", "RESF", "RESW") else "Gebiet"
    if fcl == "V":
        return "Wald"
    return "Ort"


def norm_name(s):
    s = unicodedata.normalize("NFKD", s.lower().replace("ß", "ss"))
    return "".join(c for c in s if not unicodedata.combining(c)).strip()


def ensure_places(codes, task=None):
    """Import GeoNames files into a small SQLite index (world cities + full country files)."""
    con = sqlite3.connect(PLACES_DB)
    con.executescript("""
        CREATE TABLE IF NOT EXISTS places(id INTEGER PRIMARY KEY, name TEXT, lat REAL, lon REAL,
                                          fcl TEXT, fco TEXT, cc TEXT, pop INTEGER);
        CREATE TABLE IF NOT EXISTS names(norm TEXT, pid INTEGER, name TEXT, UNIQUE(norm, pid));
        CREATE TABLE IF NOT EXISTS sources(code TEXT PRIMARY KEY);""")
    have = {r[0] for r in con.execute("SELECT code FROM sources")}
    for code in ["cities500"] + list(codes):
        if code in have:
            continue
        if task:
            task["phase"] = f"Ortsnamen ({'Welt' if code == 'cities500' else code}) …"
        zpath = CACHE_DIR / f"geonames_{code}.zip"
        req = urllib.request.Request(f"{CATALOG['geonames_base']}/{code}.zip", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r, open(zpath, "wb") as f:
            shutil.copyfileobj(r, f)
        places, names = [], []
        with zipfile.ZipFile(zpath) as z, z.open(f"{code}.txt") as raw:
            for line in io.TextIOWrapper(raw, "utf-8"):
                c = line.rstrip("\n").split("\t")
                if len(c) < 15:
                    continue
                gid, name, ascii_, alts, lat, lon, fcl, fco, cc = c[:9]
                pop = int(c[14] or 0)
                if fcl in ("R", "U") or (fcl == "S" and not PLACE_S.get(fco)):
                    continue
                places.append((int(gid), name, float(lat), float(lon), fcl, fco, cc, pop))
                best = {}  # one display spelling per search key: "München" beats "Munchen", "Rom" beats "ROM"
                for n in [name, ascii_] + [a for a in alts.split(",") if a and len(a) <= 60]:
                    if n and all(ord(ch) < 0x250 or ch in "’'" for ch in n):
                        k = norm_name(n)
                        score = (4 if n == name else 0) + (2 if any(ch in "äöüÄÖÜß" for ch in n) else -1 if not n.isascii() else 0) \
                            - (3 if n.isupper() and len(n) > 1 else 0)
                        if k and score > best.get(k, ("", -9))[1]:
                            best[k] = (n, score)
                names += [(k, int(gid), n) for k, (n, _) in best.items()]
        con.executemany("INSERT OR IGNORE INTO places VALUES (?,?,?,?,?,?,?,?)", places)
        con.executemany("INSERT OR IGNORE INTO names VALUES (?,?,?)", names)
        con.execute("INSERT INTO sources VALUES (?)", (code,))
        con.commit()
        zpath.unlink(missing_ok=True)
    con.execute("CREATE INDEX IF NOT EXISTS names_norm ON names(norm)")
    con.commit()
    con.close()


GERMAN_CHARS = re.compile("[äöüÄÖÜß]")


def alias_quality(name, official):
    if name == official:
        return 2
    if name[:1].islower() or (len(name) > 1 and name.isupper()):
        return 0  # codes like "MUN" or odd lowercase variants
    return 1


def search_places(q, limit=8):
    n = norm_name(q)
    if len(n) < 2 or not PLACES_DB.exists():
        return []
    con = sqlite3.connect(f"file:{PLACES_DB}?mode=ro", uri=True)
    cols = "SELECT p.id, n.name, p.name, p.lat, p.lon, p.fcl, p.fco, p.cc, p.pop, n.norm = ? AS exact FROM names n JOIN places p ON p.id = n.pid"
    try:
        rows = con.execute(cols + " WHERE n.norm = ? LIMIT 100", (n, n)).fetchall()
        rows += con.execute(cols + " WHERE n.norm > ? AND n.norm < ? ORDER BY p.pop DESC LIMIT 800", (n, n, n + "\uffff")).fetchall()
    finally:
        con.close()
    places, typed = {}, q.strip().lower()
    for pid, shown, official, lat, lon, fcl, fco, cc, pop, exact in rows:
        quality = alias_quality(shown, official)
        # which matching name to show: the one typed exactly, then one that starts with the typed letters
        # as written ("mün" -> München, "mun" -> Munich), then the official one
        pick = (bool(exact) and quality > 0, shown.lower().startswith(typed), quality, bool(GERMAN_CHARS.search(shown)), len(shown))
        cur = places.get(pid)
        if cur is None:
            cur = places[pid] = {"pid": pid, "official": official, "lat": lat, "lon": lon, "fcl": fcl, "fco": fco,
                                 "cc": cc, "pop": pop or 0, "exact": False, "quality": 0, "pick": None, "name": shown}
        cur["exact"] |= bool(exact) and quality > 0
        cur["quality"] = max(cur["quality"], quality)
        if cur["pick"] is None or pick > cur["pick"]:
            cur["pick"], cur["name"] = pick, shown
    for pl in places.values():
        pl["score"] = (math.log10(pl["pop"] + 10) + (3 if pl["exact"] else 0)
                       + (1 if pl["fcl"] in ("P", "A") else 0) - (3 if pl["quality"] == 0 else 0))
    out = []
    for pl in sorted(places.values(), key=lambda x: -x["score"])[:limit]:
        fcl, fco, pop = pl["fcl"], pl["fco"], pl["pop"]
        out.append({"id": pl["pid"], "name": pl["name"], "official": pl["official"] if pl["official"] != pl["name"] else "",
                    "lat": pl["lat"], "lon": pl["lon"], "kind": place_kind(fcl, fco, pop), "cc": pl["cc"], "pop": pop,
                    "zoom": 11 if fcl == "P" and pop >= 100000 else 13 if fcl in ("P", "S") else 5 if fco.startswith("PCL") else 9 if fcl == "A" else 12})
    return out


# --------------------------------------------------------------------------- coding agent

def _tool(name, desc, props, required=()):
    return {"type": "function", "function": {"name": name, "description": desc, "parameters": {
        "type": "object", "properties": {k: {"type": "string", "description": v} for k, v in props.items()},
        "required": list(required)}}}


CODE_TOOLS = [
    _tool("list_files", "List files and folders in the working folder (2 levels deep).", {"path": "Sub folder, default '.'"}),
    _tool("read_file", "Read a text file.", {"path": "File path relative to the working folder"}, ["path"]),
    _tool("write_file", "Create or overwrite a file with the full new content. Creates folders as needed.",
          {"path": "File path relative to the working folder", "content": "Complete file content"}, ["path", "content"]),
    _tool("edit_file", "Replace one exact piece of text in a file. `old` must occur exactly once.",
          {"path": "File path", "old": "Exact text to replace", "new": "Replacement text"}, ["path", "old", "new"]),
    _tool("run", "Run a shell command (zsh) in the working folder and return its output. Max 120 s, no keyboard input.",
          {"command": "The command, e.g. 'python3 main.py'"}, ["command"]),
    _tool("search_docs", "Search the offline developer docs (Python, Bash, JavaScript, Git, ...). Use when unsure about an API.",
          {"query": "Short English search terms, e.g. 'pathlib glob'"}, ["query"]),
]

CODE_SYSTEM = """Du bist Basecamp Code, ein Coding-Agent. Du läufst lokal auf einem Mac (macOS, zsh), ohne Internet.
Arbeitsordner: {cwd}
Inhalt: {files}

So arbeitest du:
- Erst verstehen, dann handeln. Schau dir vorhandene Dateien an, bevor du sie änderst.
- Schreib Dateien mit write_file, kleine Änderungen mit edit_file. Teste mit run.
- Gib Pfade immer relativ zum Arbeitsordner an (z. B. main.py), Befehle laufen schon darin.
- Nutze python3 und pip3, nie python oder pip. Bevorzuge die Standardbibliothek: es gibt kein Internet, pip install klappt meist nicht.
- Bei Fehlern: Ausgabe lesen, Ursache beheben, erneut testen. Höchstens 3 Versuche pro Problem.
- Lösch oder überschreib nichts außerhalb des Arbeitsordners.{docs}
- Antworte auf Deutsch, kurz. Zum Schluss: 1 bis 3 Sätze, was du gemacht hast und wie man es startet."""

CODE_VERBS = set("schreib schreibe bau baue mach mache erstelle erstell programmiere programmier hilf zeig alle bis "
                 "teste test write build create make code generate help show that this all".split())


def workspace_slug(title):
    """'Schreib ein Python-Skript, das Primzahlen ausgibt' -> 'python-skript-primzahlen'"""
    low = title.lower().translate(str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"}))
    words = [w for w in re.findall(r"[a-z0-9]+", low) if len(w) > 2 and w not in STOPWORDS and w not in CODE_VERBS]
    return "-".join(list(dict.fromkeys(words))[:4])[:48]


CODE_ENV_DROP = ("VIRTUAL_ENV", "PYTHONHOME", "PYTHONPATH", "__PYVENV_LAUNCHER__")


def code_books():
    return [b for b in LIB.all() if b.category == "code" and b.fulltext]


def workspace(path):
    """A folder inside the user's home that the agent may work in."""
    home = Path.home().resolve()
    p = Path(os.path.expanduser(path or "")).resolve()
    if not path or not p.is_dir() or p == home or home not in p.parents:
        raise ValueError("Ungültiger Ordner. Er muss in deinem Benutzerordner liegen.")
    return p


def tree(root, base, depth=2, limit=200):
    lines = []
    skip = {".git", "node_modules", ".venv", "venv", "__pycache__", ".DS_Store", ".idea", "dist", "build"}

    def walk(d, level):
        try:
            entries = sorted(d.iterdir(), key=lambda e: (e.is_file(), e.name.lower()))
        except OSError:
            return
        for e in entries:
            if len(lines) >= limit:
                return
            if e.name in skip:
                continue
            rel = e.relative_to(base).as_posix()
            if e.is_dir():
                lines.append(rel + "/")
                if level < depth:
                    walk(e, level + 1)
            else:
                lines.append(f"{rel} ({e.stat().st_size} B)")
    walk(root, 1)
    return lines


def clip(text, limit=8000):
    if len(text) <= limit:
        return text
    head = limit // 3
    return text[:head] + f"\n… ({len(text) - limit} Zeichen ausgelassen) …\n" + text[-(limit - head):]


def run_tool(cwd, name, args):
    """Execute one agent tool. Returns {"ok", "output", ...}."""
    def inside(p):
        f = (cwd / (p or ".")).resolve()
        if f != cwd and cwd not in f.parents:
            raise ValueError("Pfad liegt außerhalb des Arbeitsordners.")
        return f

    try:
        if name == "list_files":
            lines = tree(inside(args.get("path")), cwd)
            return {"ok": True, "output": "\n".join(lines) or "(leer)"}
        if name == "read_file":
            f = inside(args.get("path"))
            if not f.is_file():
                return {"ok": False, "output": f"Datei nicht gefunden: {args.get('path')}"}
            if f.stat().st_size > 2_000_000:
                return {"ok": False, "output": "Datei ist zu groß zum Lesen."}
            return {"ok": True, "output": clip(f.read_text(errors="replace"), 20000)}
        if name == "write_file":
            f = inside(args.get("path"))
            f.parent.mkdir(parents=True, exist_ok=True)
            content = args.get("content", "")
            existed = f.exists()
            f.write_text(content)
            n = content.count("\n") + (1 if content and not content.endswith("\n") else 0)
            return {"ok": True, "output": f"{'Überschrieben' if existed else 'Angelegt'}: {f.relative_to(cwd)} ({n} Zeilen)"}
        if name == "edit_file":
            f = inside(args.get("path"))
            if not f.is_file():
                return {"ok": False, "output": f"Datei nicht gefunden: {args.get('path')}"}
            text, old = f.read_text(errors="replace"), args.get("old", "")
            count = text.count(old) if old else 0
            if count != 1:
                return {"ok": False, "output": f"`old` kommt {count}-mal vor, es muss genau 1-mal sein. Lies die Datei erneut."}
            f.write_text(text.replace(old, args.get("new", ""), 1))
            return {"ok": True, "output": f"Geändert: {f.relative_to(cwd)}"}
        if name == "run":
            env = {k: v for k, v in os.environ.items() if k not in CODE_ENV_DROP}
            env.update({"PAGER": "cat", "GIT_PAGER": "cat", "TERM": "dumb", "NO_COLOR": "1", "PYTHONUNBUFFERED": "1"})
            proc = subprocess.Popen(["/bin/zsh", "-lc", args.get("command", "")], cwd=cwd, env=env,
                                    stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    start_new_session=True)
            t0 = time.time()
            try:
                out, _ = proc.communicate(timeout=120)
                note = ""
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, 9)
                out, _ = proc.communicate()
                note = "\n[Abgebrochen nach 120 s]"
            text = out.decode("utf-8", "replace") + note
            return {"ok": proc.returncode == 0, "exit": proc.returncode, "seconds": round(time.time() - t0, 1),
                    "output": clip(text) or "(keine Ausgabe)"}
        if name == "search_docs":
            books = code_books()
            if not books:
                return {"ok": False, "output": "Keine Doku installiert."}
            hits = retrieve({"en": [args.get("query", "")]}, 3, 1500, [b.id for b in books])
            if not hits:
                return {"ok": True, "output": "Nichts gefunden. Andere Begriffe probieren.", "sources": []}
            return {"ok": True, "output": "\n\n".join(f"## {h['title']} ({h['source']})\n{h['text']}" for h in hits),
                    "sources": [{k: h[k] for k in ("book", "path", "title", "source")} for h in hits]}
        return {"ok": False, "output": f"Unbekanntes Werkzeug: {name}"}
    except Exception as e:
        return {"ok": False, "output": f"Fehler: {e}"}


def code_events(req):
    if CFG.get("power_save"):
        yield {"t": "error", "c": POWER_SAVE_ERROR}
        return
    model = req.get("model") or pick_default_model(installed_models())
    try:
        cwd = workspace(req.get("cwd"))
    except ValueError as e:
        yield {"t": "error", "c": str(e)}
        return
    yield from warm_up(model)
    have_docs = bool(code_books())
    files = tree(cwd, cwd, depth=1, limit=40)
    system = CODE_SYSTEM.format(cwd=cwd, files=", ".join(files) if files else "(leer)",
                                docs="\n- Bei Unsicherheit zu einer API: search_docs (Offline-Doku)." if have_docs else "")
    messages = [{"role": "system", "content": system}]
    for m in req.get("messages", []):
        role = m.get("role")
        if role == "user":
            messages.append({"role": "user", "content": str(m.get("content", ""))})
        elif role == "assistant":
            msg = {"role": "assistant", "content": str(m.get("content", ""))}
            if m.get("tool_calls"):
                msg["tool_calls"] = [{"function": {"name": c["name"], "arguments": c.get("args") or {}}} for c in m["tool_calls"]]
            messages.append(msg)
        elif role == "tool":
            messages.append({"role": "tool", "tool_name": m.get("tool_name", ""), "content": clip(str(m.get("content", "")))})
    body = {"model": model, "stream": True, "keep_alive": "30m", "messages": messages,
            "tools": CODE_TOOLS if have_docs else CODE_TOOLS[:-1],
            "options": {"num_ctx": max(num_ctx(), 16384) if hardware()["ram_gb"] >= 16 else num_ctx(),
                        **code_sampling(model)}}
    tp = think_param(model, req.get("think"))
    if tp is not None:
        body["think"] = tp
    t0 = time.time()
    for attempt in range(3):
        stats, calls, error = {}, [], None
        for ev in ollama_stream("/api/chat", body):
            if ev.get("error"):
                error = ev["error"]
                break
            msg = ev.get("message") or {}
            if msg.get("thinking"):
                yield {"t": "think", "c": msg["thinking"]}
            if msg.get("content"):
                yield {"t": "tok", "c": msg["content"]}
            for c in msg.get("tool_calls") or []:
                fn = c.get("function") or {}
                args = fn.get("arguments") or {}
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except ValueError:
                        args = {"raw": args}
                calls.append({"id": c.get("id") or uuid.uuid4().hex[:8], "name": fn.get("name", ""), "args": args})
            if ev.get("done"):
                stats = {"tokens": ev.get("eval_count"), "seconds": round(time.time() - t0, 1),
                         "tps": round(ev.get("eval_count", 0) / max(ev.get("eval_duration", 1) / 1e9, 1e-6), 1),
                         "model": model}
        if not error:
            break
        # Small models sometimes write a broken tool call. Ollama then aborts with a parse error.
        # Throw the step away and let the model try again.
        if attempt == 2 or not re.search(r"syntax|parse|unexpected|invalid character|unmarshal", error, re.I):
            yield {"t": "error", "c": error}
            return
        yield {"t": "retry"}
    if calls:
        yield {"t": "tool_calls", "c": calls}
    yield {"t": "done", "c": stats}
    if CFG.get("power_save"):  # switched on while this step ran
        unload_models()


CODE_SAMPLING = [  # what the model makers recommend for coding and tool use
    ("qwen3-coder", {"temperature": 0.7, "top_p": 0.8, "top_k": 20, "repeat_penalty": 1.05, "presence_penalty": 0}),
    ("devstral", {"temperature": 0.15}),
    ("gpt-oss", {"temperature": 1.0, "top_p": 1.0}),
    ("", {"temperature": 0.6, "top_p": 0.95, "top_k": 20, "presence_penalty": 0}),
]


def code_sampling(model):
    return next(opts for prefix, opts in CODE_SAMPLING if model.startswith(prefix))


def best_code_model(installed):
    names = [m["name"] for m in installed or []]
    tier = model_tier(hardware()["ram_gb"])
    for n in [tier["code_default"]] + tier["code"]:
        if n in names:
            return n
    with_tools = [n for n in names if "tools" in model_caps(n)]
    known = [m["name"] for m in sorted(CATALOG["models"], key=lambda m: -m["gb"]) if m["name"] in with_tools and m["min_ram"] <= hardware()["ram_gb"]]
    return (known or with_tools or [tier["code_default"]])[0]


# --------------------------------------------------------------------------- HTTP

def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    return sorted(ips)


# Chats stay in the browser, but memory, instructions and the emergency plan sit on the server. With
# --lan anyone in the WLAN could read them, so like the code agent they only work directly on this Mac.
# A phone can still read the public warnings and see that the AI is off, but not change anything.
PRIVATE_ROUTES = ("projects", "memory", "emergency", "warnings", "power")
PRIVATE_ERROR = "Das geht nur direkt auf diesem Mac."


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Basecamp/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("BASECAMP_DEBUG"):
            super().log_message(fmt, *args)

    # ---- helpers
    def send_json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_bytes(self, data, mimetype, cache="public, max-age=86400"):
        data = bytes(data)
        size = len(data)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng and (m := re.match(r"bytes=(\d*)-(\d*)", rng)) and size and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", mimetype)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data[start:end + 1])

    def send_file(self, path, cache="no-cache"):
        mimetype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if mimetype.startswith("text/") or mimetype in ("application/javascript", "application/json"):
            mimetype += "; charset=utf-8"
        size = path.stat().st_size
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng and (m := re.match(r"bytes=(\d*)-(\d*)", rng)) and m.group(1):
            start, end = int(m.group(1)), min(int(m.group(2) or size - 1), size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", mimetype)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def not_found(self, msg="Nicht gefunden"):
        data = msg.encode()
        self.send_response(404)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def hostname(self):
        host = (self.headers.get("Host") or "").strip().lower()
        if host.startswith("["):
            return host[1:host.find("]")]
        return host.rsplit(":", 1)[0]

    def host_ok(self):
        """Answer only to IP addresses, localhost and .local names. Any other domain in Host means
        DNS rebinding: a website pointed its own name at this Mac to get past the browser."""
        name = self.hostname()
        if name in ("localhost", socket.gethostname().lower()) or name.endswith((".local", ".localhost")):
            return True
        try:
            ipaddress.ip_address(name)
            return True
        except ValueError:
            return False

    def loopback(self):
        return self.client_address[0] in ("127.0.0.1", "::1") and self.hostname() in ("127.0.0.1", "localhost", "::1")

    def content_origin(self):
        name = self.hostname()
        return f"http://{'[' + name + ']' if ':' in name else name}:{content_port()}"

    def fail(self, code, msg):
        try:
            self.send_json({"error": msg}, code)
        except Exception:
            pass

    def same_origin(self):
        """Block other websites from calling write endpoints (CSRF / DNS rebinding)."""
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        if origin and urllib.parse.urlparse(origin).netloc != host:
            return False
        hostname = host.rsplit(":", 1)[0].strip("[]")
        if CFG["host"] in ("127.0.0.1", "localhost"):
            return hostname in ("127.0.0.1", "localhost", "::1")
        return True

    # ---- routing
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self.host_ok():
            return self.fail(403, "forbidden")
        url = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(url.path)
        qs = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        try:
            if path == "/" or path == "/index.html":
                return self.send_file(STATIC / "index.html")
            if path.startswith("/static/"):
                f = (STATIC / path[len("/static/"):]).resolve()
                if f.is_file() and STATIC in f.parents:
                    return self.send_file(f)
                return self.not_found()
            if path.startswith(("/zim/", "/files/", "/preview/")):
                # pages from ZIM files and the agent's folders run on their own origin, see ContentHandler
                return self.redirect(self.content_origin() + self.path)
            if path.startswith("/maps/"):
                f = (MAP_DIR / path[len("/maps/"):]).resolve()
                if f.is_file() and f.suffix == ".pmtiles" and f.parent == MAP_DIR.resolve():
                    return self.send_file(f, cache="public, max-age=604800, immutable")
                return self.not_found()
            if path.startswith("/api/icon/"):
                book = LIB.get(path[len("/api/icon/"):])
                icon = book.icon() if book else None
                return self.send_bytes(icon, "image/png") if icon else self.not_found()
            if path.startswith("/api/"):
                return self.api_get(path[5:], qs)
            return self.not_found()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except ValueError as e:
            self.fail(400, f"Ungültige Anfrage: {e}")
        except Exception as e:
            self.fail(500, str(e))

    def do_POST(self):
        if not self.host_ok() or not self.same_origin():
            return self.send_json({"error": "forbidden"}, 403)
        path = urllib.parse.urlsplit(self.path).path
        try:
            body = self.body()
        except ValueError:
            return self.send_json({"error": "Ungültiges JSON"}, 400)
        try:
            return self.api_post(path[5:] if path.startswith("/api/") else path, body)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            self.fail(500, str(e))

    def serve_zim(self, rest):
        bid, _, zpath = rest.partition("/")
        book = LIB.get(bid)
        if not book:
            return self.not_found("Quelle nicht installiert")
        if not zpath:
            if not book.main:
                return self.not_found("Diese Quelle hat keine Startseite")
            return self.redirect(f"/zim/{bid}/" + urllib.parse.quote(book.main))
        try:
            entry = book.archive.get_entry_by_path(zpath)
        except KeyError:
            if zpath.endswith(".js"):  # scripts the ZIM maker left out; keeps the console quiet
                return self.send_bytes(b"", "text/javascript; charset=utf-8")
            return self.zim_missing(book, zpath)
        if entry.is_redirect:
            target = entry.get_redirect_entry().path
            return self.redirect(f"/zim/{bid}/" + urllib.parse.quote(target))
        item = entry.get_item()
        mimetype = item.mimetype
        if mimetype.startswith("text/") and "charset" not in mimetype:
            mimetype += "; charset=utf-8"
        data = bytes(item.content)
        if mimetype.startswith("text/html"):
            data = inject_reader(data)
        self.send_bytes(data, mimetype, cache="no-cache")

    def zim_missing(self, book, zpath):
        title = html.escape(urllib.parse.unquote(zpath).split("/")[-1].replace("_", " "))
        page = f"""<!doctype html><html lang="de"><head><meta charset="utf-8"><title>{title}</title>
<style>body{{font:16px/1.6 -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:90vh;color:#202122;background:#fff}}
@media (prefers-color-scheme:dark){{body{{color:#eaecf0;background:#000}}a{{color:#88a3e8}}}}
main{{max-width:440px;padding:24px;text-align:center}}h1{{font:600 26px/1.2 Georgia,serif;margin:0 0 10px}}p{{color:#72777d;margin:0 0 18px}}a{{color:#36c}}</style></head>
<body><main><h1>{title}</h1><p>Diesen Artikel gibt es in „{html.escape(book.label)}“ nicht. Vielleicht steht er in einer anderen Quelle, such mit ⌘K.</p>
<a href="/zim/{book.id}/{urllib.parse.quote(book.main)}">Zur Startseite</a></main></body></html>""".encode()
        self.send_response(404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def api_private_get(self, route, qs):
        if route == "emergency":
            return self.send_json(read_json(EMERGENCY_FILE, {}))
        if route == "warnings/regions":
            try:
                return self.send_json({"regions": search_regions(qs.get("q", ""))})
            except (urllib.error.URLError, OSError):
                return self.send_json({"error": "Dafür braucht es einmal Internet."}, 502)
        if route == "projects":
            projects = [{**p, "facts": len(read_memory(p["id"]))} for p in all_projects()]
            return self.send_json({"projects": projects})
        if route == "memory":
            if not memory_file(qs.get("project")):
                return self.send_json({"error": "Projekt nicht gefunden"}, 404)
            return self.send_json({"facts": read_memory(qs.get("project"))})
        return self.send_json({"error": "unknown route"}, 404)

    def api_private_post(self, route, body):
        if route == "emergency/save":
            data = clean_emergency(body)
            with STORE_LOCK:
                write_json(EMERGENCY_FILE, data)
            return self.send_json({"ok": True, "updated": data["updated"]})
        if route == "power":
            save_config({"power_save": bool(body.get("on"))})
            if body.get("on"):
                unload_models()
            return self.send_json(power_state())
        if route == "warnings/settings":
            save_warning_settings(body)
            return self.send_json(warnings_view())
        if route == "warnings/refresh":
            WARN_EVENT.set()
            return self.send_json(warnings_view())
        project = body.get("project")
        if route == "projects/save":
            saved = save_project(body.get("id"), {k: body[k] for k in ("name", "instructions") if k in body})
            return self.send_json({"project": saved} if saved else {"error": "Projekt nicht gefunden oder ohne Namen"}, 200 if saved else 400)
        if route == "projects/delete":
            return self.send_json({"ok": delete_project(body.get("id"))})
        if not memory_file(project):
            return self.send_json({"error": "Projekt nicht gefunden"}, 404)
        if route == "memory/add":
            return self.send_json({"fact": add_fact(project, body.get("text", ""), "user")})
        if route == "memory/edit":
            return self.send_json({"fact": edit_fact(project, body.get("id"), body.get("text", ""))})
        if route == "memory/delete":
            return self.send_json({"removed": delete_facts(project, {body.get("id")})})
        if route == "memory/clear":
            clear_memory(project)
            return self.send_json({"ok": True})
        if route == "memory/learn":
            model = body.get("model") or pick_default_model(installed_models())
            return self.send_json(learn(project, model, body.get("text")))
        return self.send_json({"error": "unknown route"}, 404)

    def api_get(self, route, qs):
        if route == "power":
            return self.send_json(power_state())
        if route == "warnings":
            return self.send_json(warnings_view())
        if route.split("/")[0] in PRIVATE_ROUTES:
            if not self.loopback():
                return self.send_json({"error": PRIVATE_ERROR}, 403)
            return self.api_private_get(route, qs)
        if route == "status":
            installed = installed_models()
            hw = hardware()
            tier = model_tier(hw["ram_gb"])
            return self.send_json({
                **hw, "data_dir": str(DATA), "books": len(LIB.all()), "files": len(list_files()),
                "ollama": installed is not None, "model": pick_default_model(installed),
                "tier": tier["label"], "num_ctx": num_ctx(),
                "lan": CFG["host"] not in ("127.0.0.1", "localhost"),
                "urls": [f"http://{ip}:{CFG['port']}" for ip in lan_ips()],
                "port": CFG["port"], "content_port": content_port(),
            })
        if route == "bible":
            return self.send_json(bible_index())
        if route in ("bible/chapter", "bible/search"):
            it = ITEMS.get(f"bibel_{qs.get('t', '')}")
            book = it and it.get("bible") and LIB.get(it["id"])
            if not book:
                return self.send_json({"error": "Diese Übersetzung ist nicht installiert."}, 404)
            if route == "bible/search":
                return self.send_json(bible_search(book, qs.get("q", "")))
            chapter = bible_chapter(book, qs.get("b", ""), qs.get("c", ""))
            return self.send_json(chapter or {"error": "Dieses Kapitel gibt es nicht."}, 200 if chapter else 404)
        if route == "books":
            cats = {c["id"]: i for i, c in enumerate(CATALOG["categories"])}
            books = sorted((b.info() for b in LIB.all()), key=lambda b: (cats.get(b["category"], 99), b["title"]))
            return self.send_json({"categories": CATALOG["categories"], "books": books})
        if route == "files":
            return self.send_json({"files": list_files(), "dir": str(LIB_DIR)})
        if route == "search":
            q = qs.get("q", "").strip()
            books = [b for b in qs.get("books", "").split(",") if b]
            return self.send_json({"q": q, "groups": search_all(q, books, int(qs.get("limit", 5))) if q else [],
                                   "files": search_files(q) if q else []})
        if route == "suggest":
            q = qs.get("q", "").strip()
            books = [b for b in qs.get("books", "").split(",") if b]
            return self.send_json({"q": q, "results": suggest_all(q, 8, books) if len(q) >= 2 else []})
        if route == "random":
            books = ([LIB.get(qs["book"])] if LIB.get(qs.get("book", "")) else
                     [b for b in LIB.all() if b.category == "wissen"] or LIB.all())
            if not books:
                return self.send_json({})
            b = random.choice(books)
            for _ in range(10):
                e = b.archive.get_random_entry()
                if not e.is_redirect and e.get_item().mimetype.startswith("text/html"):
                    return self.send_json({"book": b.id, "path": e.path, "title": e.title})
            return self.send_json({})
        if route == "models":
            installed = installed_models()
            hw = hardware()
            tier = model_tier(hw["ram_gb"])
            names = {m["name"] for m in installed or []}
            catalog = [{**m, "installed": m["name"] in names, "fits": m["min_ram"] <= hw["ram_gb"],
                        "recommended": m["name"] in tier["recommended"], "tier_default": m["name"] == tier["default"]}
                       for m in CATALOG["models"]]
            inst = [{"name": m["name"], "size": m.get("size", 0),
                     "params": (m.get("details") or {}).get("parameter_size", ""),
                     "quant": (m.get("details") or {}).get("quantization_level", ""),
                     "caps": model_caps(m["name"])} for m in installed or []]
            return self.send_json({"ollama": installed is not None, "installed": inst, "catalog": catalog,
                                   "default": pick_default_model(installed), "code_default": best_code_model(installed),
                                   "tier": tier, "ram_gb": hw["ram_gb"]})
        if route == "catalog":
            hw = hardware()
            installed = {b.id: b for b in LIB.all()}
            parts = {p.name[:-len(".part")] for p in ZIM_DIR.glob("*.zim.part")}
            items = []
            for it in CATALOG["items"]:
                b = installed.get(it["id"])
                latest = kiwix_latest(it) if it["folder"] in _listing_cache else None
                items.append({**it, "installed": b.version if b else None,
                              "installed_size": b.size if b else 0,
                              "latest": VERSION_RE.match(Path(latest).stem).group(2) if latest else None,
                              "partial": any(p.startswith(it["id"] + "_") for p in parts)})
            maps = installed_maps()
            latest_build = _builds[1]
            map_parts = {p.name.split(".")[0].rsplit("_", 1)[0] for p in MAP_DIR.glob("*.pmtiles.part")}
            for m in CATALOG["maps"]:
                f = maps.get(m["id"])
                build = map_build(f) if f else None
                items.append({**m, "cat": "karten", "lang": "mul", "kind": "map", "installed": build,
                              "installed_size": f.stat().st_size if f else 0,
                              "latest": latest_build if map_outdated(build, latest_build) else build,
                              "covered": not f and map_satisfied(m["id"], maps), "partial": m["id"] in map_parts})
            profiles = []
            for p in CATALOG["profiles"]:
                its = profile_items(p["id"])
                missing = sum(i["gb"] for i in its if i["id"] not in installed and not (i["id"] in MAPS and map_satisfied(i["id"], maps)))
                profiles.append({**p, "gb": round(sum(i["gb"] for i in its), 1), "count": len(its),
                                 "missing_gb": round(missing, 1), "fits": missing * 1.05 + 5 < hw["disk_free_gb"]})
            extra = [b.info() for b in LIB.all() if b.id not in ITEMS]
            return self.send_json({"categories": CATALOG["categories"], "profiles": profiles, "items": items,
                                   "extra": extra, "recommended_profile": recommended_profile(hw["disk_free_gb"] + (sum(b.size for b in LIB.all()) + sum(f.stat().st_size for f in maps.values())) / 1e9),
                                   "disk_free_gb": hw["disk_free_gb"], "disk_total_gb": hw["disk_total_gb"],
                                   "zim_dir": str(ZIM_DIR), "checked": bool(_listing_cache)})
        if route == "tasks":
            return self.send_json({"tasks": public_tasks()})
        if route == "maps":
            maps = [{**{k: MAPS[mid][k] for k in ("id", "title", "bbox")}, "maxzoom": MAPS[mid].get("maxzoom", 15),
                     "url": f"/maps/{f.name}", "size": f.stat().st_size, "build": map_build(f)}
                    for mid, f in installed_maps().items()]
            return self.send_json({"maps": maps, "places": PLACES_DB.exists()})
        if route == "places":
            return self.send_json({"results": search_places(qs.get("q", ""), int(qs.get("limit", 8)))})
        return self.send_json({"error": "unknown route"}, 404)

    def api_post(self, route, body):
        if route.split("/")[0] in PRIVATE_ROUTES:
            if not self.loopback():
                return self.send_json({"error": PRIVATE_ERROR}, 403)
            return self.api_private_post(route, body)
        if route == "chat":
            if not self.loopback():
                body = {k: v for k, v in body.items() if k not in ("project", "memory")}
            return self.stream(chat_events(body))
        if route.startswith("code/"):
            # the agent runs commands on this Mac: never allow it over the network
            if not self.loopback():
                return self.send_json({"error": "Basecamp Code geht nur direkt auf diesem Mac."}, 403)
            return self.api_code(route[5:], body)
        if route == "rescan":
            LIB.rescan()
            return self.send_json({"books": len(LIB.all())})
        if route == "catalog/refresh":
            folders = {it["folder"] for it in CATALOG["items"]}
            errors = []

            def fetch(folder):
                it = next(i for i in CATALOG["items"] if i["folder"] == folder)
                try:
                    kiwix_latest(it, force=True)
                except Exception as e:
                    errors.append(f"{folder}: {e}")
            list(POOL.map(fetch, folders))
            try:
                latest_map_build(force=True)
            except Exception as e:
                errors.append(f"maps: {e}")
            return self.send_json({"ok": not errors, "errors": errors})
        if route == "content/download":
            ids = body.get("ids") or []
            if body.get("profile"):
                ids += [i["id"] for i in profile_items(body["profile"])]
            installed = {b.id for b in LIB.all()}
            maps = installed_maps()
            queued = [queue_download(i)["id"] for i in dict.fromkeys(ids)
                      if (i in ITEMS and (i not in installed or body.get("update")))
                      or (i in MAPS and (body.get("update") or not map_satisfied(i, maps)))]
            return self.send_json({"queued": len(queued)})
        if route == "content/update":
            for it in CATALOG["items"]:
                try:
                    kiwix_latest(it, force=False)
                except Exception:
                    pass
            n = 0
            for b in LIB.all():
                it = ITEMS.get(b.id)
                latest = it and kiwix_latest(it)
                if latest and Path(latest).stem > b.path.stem:
                    queue_download(b.id)
                    n += 1
            return self.send_json({"queued": n})
        if route == "content/delete":
            bid = body.get("id", "")
            book = LIB.get(bid)
            with TASK_LOCK:
                for t in TASKS.values():
                    if t["ref"] == bid and t["status"] in ("queued", "running"):
                        t["cancel"] = True
            if book:
                with LIB.lock:
                    LIB.books.pop(bid, None)
                book.path.unlink(missing_ok=True)
            for p in ZIM_DIR.glob(f"{bid}_*.zim.part"):
                p.unlink()
            if bid in MAPS:
                for f in MAP_DIR.glob(f"{bid}_*.pmtiles*"):
                    f.unlink()
                if not installed_maps():
                    PLACES_DB.unlink(missing_ok=True)
            return self.send_json({"ok": True})
        if route == "tasks/cancel":
            t = TASKS.get(body.get("id"))
            if t:
                t["cancel"] = True
                if t["status"] == "queued":
                    t["status"] = "canceled"
            return self.send_json({"ok": bool(t)})
        if route == "tasks/clear":
            with TASK_LOCK:
                for k in [k for k, t in TASKS.items() if t["status"] in ("done", "error", "canceled")]:
                    del TASKS[k]
            return self.send_json({"ok": True})
        if route == "models/pull":
            name = body.get("name", "").strip()
            if not name:
                return self.send_json({"error": "name fehlt"}, 400)
            task = new_task("model", name, name)
            if task["status"] == "queued":
                threading.Thread(target=pull_model, args=(task,), daemon=True).start()
            return self.send_json({"task": task["id"]})
        if route == "models/delete":
            try:
                ollama("/api/delete", {"model": body.get("name")}, method="DELETE")
                return self.send_json({"ok": True})
            except Exception as e:
                return self.send_json({"error": str(e)}, 500)
        if route == "settings":
            allowed = {k: v for k, v in body.items() if k in ("default_model", "num_ctx")}
            save_config(allowed)
            return self.send_json({"ok": True, **allowed})
        return self.send_json({"error": "unknown route"}, 404)

    def api_code(self, route, body):
        if route == "chat":
            return self.stream(code_events(body))
        if route == "tool":
            try:
                cwd = workspace(body.get("cwd"))
            except ValueError as e:
                return self.send_json({"ok": False, "output": str(e)})
            return self.send_json(run_tool(cwd, body.get("name", ""), body.get("args") or {}))
        if route == "workspace":
            if body.get("path"):
                try:
                    return self.send_json({"cwd": str(workspace(body["path"]))})
                except ValueError as e:
                    return self.send_json({"error": str(e)}, 400)
            slug = workspace_slug(body.get("title") or "") or \
                re.sub(r"[^a-z0-9-]", "", (body.get("id") or uuid.uuid4().hex)[:8].lower()) or uuid.uuid4().hex[:8]
            d, n = CODE_DIR / slug, 2
            while d.exists():
                d, n = CODE_DIR / f"{slug}-{n}", n + 1
            d.mkdir(parents=True)
            return self.send_json({"cwd": str(d)})
        if route == "preview":
            try:
                cwd = workspace(body.get("cwd"))
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
            token = next((t for t, d in PREVIEWS.items() if d == cwd), None) or secrets.token_urlsafe(12)
            PREVIEWS[token] = cwd
            return self.send_json({"url": f"{self.content_origin()}/preview/{token}/"})
        if route == "open":
            try:
                subprocess.Popen(["open", str(workspace(body.get("cwd")))])
                return self.send_json({"ok": True})
            except ValueError as e:
                return self.send_json({"error": str(e)}, 400)
        return self.send_json({"error": "unknown route"}, 404)

    def stream(self, events):
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def chunk(obj):
            data = (json.dumps(obj, ensure_ascii=False) + "\n").encode()
            self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            self.wfile.flush()

        try:
            for ev in events:
                chunk(ev)
        except (BrokenPipeError, ConnectionResetError):
            return
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read()).get("error", "")
            except Exception:
                detail = str(e)
            if "unknown model architecture" in detail:
                detail = "Dieses Modell ist zu alt für die installierte Ollama-Version. Bitte ein anderes wählen."
            chunk({"t": "error", "c": f"Ollama-Fehler: {detail}"})
        except urllib.error.URLError as e:
            chunk({"t": "error", "c": f"Ollama nicht erreichbar ({e.reason}). Läuft `./basecamp start`?"})
        except Exception as e:
            chunk({"t": "error", "c": str(e)})
        try:
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError):
            pass


def print_info():
    hw = hardware()
    tier = model_tier(hw["ram_gb"])
    prof = {p["id"]: p for p in CATALOG["profiles"]}[recommended_profile(hw["disk_free_gb"])]
    size = sum(i["gb"] for i in profile_items(prof["id"]))
    model = MODELS.get(tier["default"], {})
    print(f"Dein Mac:        {hw['chip']} · {hw['ram_gb']} GB RAM · {hw['disk_free_gb']:.0f} GB frei")
    print(f"KI-Stufe:        {tier['label']} → {tier['default']} ({model.get('gb', '?')} GB), Kontext {tier['num_ctx']} Token")
    print(f"Inhaltspaket:    {prof['title']} ({prof['id']}) · {size:.0f} GB · {prof['desc']}")
    print(f"Daten-Ordner:    {DATA}")


READER_TAGS = b'<link rel="stylesheet" href="/_reader/reader.css"><script src="/_reader/reader.js" defer></script>'
PREVIEWS = {}  # token -> workspace folder the agent built, served read-only for the preview


def content_port():
    return int(CFG.get("content_port") or int(CFG["port"]) + 1)


def inject_reader(page):
    """Add our reader script and styles to a ZIM page (table of contents, link previews, dark mode)."""
    m = re.search(rb"</head\s*>", page[:200000], re.I)
    return page[:m.start()] + READER_TAGS + page[m.start():] if m else READER_TAGS + page


class ContentHandler(Handler):
    """Second origin (port + 1) for everything we did not write ourselves: ZIM pages, the user's
    files and the agent's web pages. Being a different origin, their scripts cannot call the API."""
    server_version = "Basecamp-Content/1.0"

    def do_GET(self):
        if not self.host_ok():
            return self.fail(403, "forbidden")
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        try:
            if path.startswith("/zim/"):
                return self.serve_zim(path[len("/zim/"):])
            if path.startswith("/_reader/"):
                f = (STATIC / "reader" / path[len("/_reader/"):]).resolve()
                if f.is_file() and STATIC / "reader" in f.parents:
                    return self.send_file(f)
                return self.not_found()
            if path.startswith("/files/"):
                f = (LIB_DIR / path[len("/files/"):]).resolve()
                if f.is_file() and LIB_DIR.resolve() in f.parents:
                    return self.send_file(f, cache="public, max-age=3600")
                return self.not_found()
            if path.startswith("/preview/"):
                return self.serve_preview(path[len("/preview/"):])
            if path in ("/", "/favicon.ico"):
                return self.not_found()
            return self.not_found()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            self.fail(500, str(e))

    def do_POST(self):
        self.send_json({"error": "forbidden"}, 403)

    def serve_preview(self, rest):
        token, _, sub = rest.partition("/")
        root = PREVIEWS.get(token)
        if not root:
            return self.not_found("Vorschau abgelaufen. In Basecamp neu öffnen.")
        f = (root / sub).resolve()
        if f != root and root not in f.parents:
            return self.not_found()
        if f.is_dir():
            if not self.path.split("?")[0].endswith("/"):
                return self.redirect(self.path.split("?")[0] + "/")
            index = f / "index.html"
            if index.is_file():
                return self.send_file(index)
            items = "".join(f'<li><a href="{urllib.parse.quote(e.name)}{"/" if e.is_dir() else ""}">{html.escape(e.name)}</a></li>'
                            for e in sorted(f.iterdir()) if not e.name.startswith("."))
            page = f"<!doctype html><meta charset=utf-8><title>{html.escape(f.name)}</title><body style='font:15px system-ui;padding:24px'><ul>{items}</ul>"
            return self.send_bytes(page.encode(), "text/html; charset=utf-8", cache="no-cache")
        if f.is_file():
            return self.send_file(f)
        return self.not_found()


def fetch_cli(ids):
    """Download content without the web UI, e.g. straight onto a USB stick. Resumes where it stopped."""
    LIB.rescan()
    failed = 0
    for i in ids:
        item = MAPS.get(i) or ITEMS.get(i)
        if not item:
            print(f"? {i}: unbekannt", flush=True)
            continue
        if (i in MAPS and map_satisfied(i, installed_maps())) or (i in ITEMS and LIB.get(i)):
            print(f"= {item['title']}: schon da", flush=True)
            continue
        task = new_task("map" if i in MAPS else "zim", i, item["title"])
        task["status"] = "running"
        stop = threading.Event()

        def report(task=task, title=item["title"]):
            while not stop.wait(10):
                if task["total"]:
                    print(f"  {title}: {pct_done(task)} % ({task['done'] / 1e9:.1f} von {task['total'] / 1e9:.1f} GB,"
                          f" {task.get('speed', 0) / 1e6:.0f} MB/s)", flush=True)
        threading.Thread(target=report, daemon=True).start()
        print(f"↓ {item['title']} ({item['gb']} GB)", flush=True)
        try:
            (download_map if i in MAPS else download_zim)(task)
            print(f"✓ {item['title']}", flush=True)
        except Exception as e:
            failed += 1
            print(f"✗ {item['title']}: {e}", flush=True)
        finally:
            stop.set()
    if MAPS.keys() & set(ids):
        repair_places()
    print(f"Fertig. {failed} Fehler." if failed else "Fertig.", flush=True)
    return 1 if failed else 0


def pct_done(task):
    return int(task["done"] * 100 / task["total"]) if task["total"] else 0


def main():
    if "--fetch" in sys.argv:
        return sys.exit(fetch_cli(sys.argv[sys.argv.index("--fetch") + 1:]))
    if "--info" in sys.argv:
        return print_info()
    if "--default-model" in sys.argv:
        return print(model_tier(hardware()["ram_gb"])["default"])
    if "--code-model" in sys.argv:
        return print(best_code_model(installed_models()))
    LIB.rescan()
    threading.Thread(target=download_worker, daemon=True).start()
    threading.Thread(target=repair_places, daemon=True).start()
    threading.Thread(target=warnings_worker, daemon=True).start()
    host, port = CFG["host"], int(CFG["port"])
    if "--lan" in sys.argv:
        host = CFG["host"] = "0.0.0.0"
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    try:
        content = ThreadingHTTPServer((host, content_port()), ContentHandler)
    except OSError as e:
        sys.exit(f"Port {content_port()} ist belegt ({e}). Anderen Port in config.json eintragen.")
    content.daemon_threads = True
    threading.Thread(target=content.serve_forever, daemon=True).start()
    print(f"[basecamp] {len(LIB.all())} Quellen geladen. Läuft auf http://{'127.0.0.1' if host in ('127.0.0.1', '0.0.0.0') else host}:{port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
