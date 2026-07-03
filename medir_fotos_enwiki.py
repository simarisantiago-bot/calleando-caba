"""
medir_fotos_enwiki.py — PASO 1 (3a fuente). Sobre las que TODAVÍA no tienen
foto (ni es.wikipedia del baseline, ni Wikidata), prueba en.wikipedia:
misma lógica (terminosBusqueda + generator=search), pero contra el artículo
en inglés (que a veces tiene imagen aunque el de español no).

Salida:
  data/fotos_enwiki.json  {clave: {url, titulo, pageUrl}}  (las recuperadas)
  data/fotos_paso1_report.txt

Uso: python medir_fotos_enwiki.py
"""

import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock

import requests

from medir_fotos import terminos_busqueda, BUSQUEDA_OVERRIDES

BASE = Path(__file__).parent
BASELINE = BASE / "data" / "fotos_baseline.json"
WIKIDATA = BASE / "data" / "fotos_wikidata.json"
CALLES = BASE / "data" / "calles.json"
OUT_JSON = BASE / "data" / "fotos_enwiki.json"
OUT_TXT = BASE / "data" / "fotos_paso1_report.txt"

EN_API = "https://en.wikipedia.org/w/api.php"
UA = "calleando-caba/1.0 (simarisantiago@gmail.com) foto-enwiki"
WORKERS = 8

_session = requests.Session()
_session.headers.update({"User-Agent": UA})
_cache = {}
_lock = Lock()


def fetch_en(term):
    key = term.strip().lower()
    if not key:
        return None
    with _lock:
        if key in _cache:
            return _cache[key]
    params = {
        "action": "query", "format": "json",
        "generator": "search", "gsrsearch": term, "gsrlimit": "1", "gsrnamespace": "0",
        "prop": "pageimages|info|pageprops", "piprop": "thumbnail|name",
        "pithumbsize": "480", "ppprop": "disambiguation", "inprop": "url",
    }
    res = None
    for intento in range(3):
        try:
            r = _session.get(EN_API, params=params, timeout=30)
            if r.status_code == 200:
                j = r.json()
                pages = (j.get("query") or {}).get("pages") or {}
                page = next(iter(pages.values()), None)
                thumb = page and (page.get("thumbnail") or {}).get("source")
                desamb = page and "disambiguation" in (page.get("pageprops") or {})
                if thumb and not desamb:
                    res = {"url": thumb, "titulo": page.get("title", term),
                           "pageUrl": page.get("fullurl", "")}
                break
            time.sleep(1 + intento)
        except Exception:
            time.sleep(1 + intento)
    with _lock:
        _cache[key] = res
    return res


def main():
    baseline = json.load(open(BASELINE, encoding="utf-8"))
    wikidata = json.load(open(WIKIDATA, encoding="utf-8"))
    calles = json.load(open(CALLES, encoding="utf-8"))
    rep = {}
    for c in calles:
        rep.setdefault(c["clave"], {"rep": c, "ids": []})
        rep[c["clave"]]["ids"].append(c["id"])

    # Las que siguen sin foto: baseline False y NO recuperadas por Wikidata.
    faltantes = [(clave, r) for clave, r in baseline.items()
                 if not r["tiene_foto"] and clave not in wikidata]
    print(f"Reintentando {len(faltantes)} sin foto vía en.wikipedia ({WORKERS} hilos)...")

    recuperadas = {}
    done = [0]
    inicio = time.time()
    lock = Lock()

    def trabajo(item):
        clave, base = item
        info = rep.get(clave)
        override = None
        if info:
            for i in info["ids"]:
                if i in BUSQUEDA_OVERRIDES:
                    override = BUSQUEDA_OVERRIDES[i]
                    break
            terms = terminos_busqueda(info["rep"], override)
        else:
            terms = [base.get("nombre") or clave]
        for t in terms:
            hit = fetch_en(t)
            if hit:
                with lock:
                    recuperadas[clave] = {**hit, "categoria": base.get("categoria"),
                                          "nombre": base.get("nombre")}
                break
        done[0] += 1
        if done[0] % 100 == 0:
            el = time.time() - inicio
            eta = (len(faltantes) - done[0]) / (done[0] / el) / 60 if el else 0
            print(f"  {done[0]}/{len(faltantes)}  recuperadas {len(recuperadas)}  ETA {eta:.1f}m", flush=True)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(trabajo, faltantes))

    json.dump(recuperadas, open(OUT_JSON, "w", encoding="utf-8"), ensure_ascii=False)

    from collections import Counter
    total = len(baseline)
    con_antes = sum(1 for r in baseline.values() if r["tiene_foto"]) + len(wikidata)
    nuevas = len(recuperadas)
    con_despues = con_antes + nuevas
    por_cat = Counter(v["categoria"] for v in recuperadas.values())

    lines = []
    lines.append("PASO 1 — en.wikipedia sobre las que aún no tienen foto")
    lines.append(f"Sin foto (tras es.wiki + Wikidata): {len(faltantes)}")
    lines.append(f"Recuperadas vía en.wikipedia: {nuevas}")
    lines.append("")
    lines.append(f"Cobertura ANTES:   {con_antes}/{total} ({100*con_antes/total:.1f}%)")
    lines.append(f"Cobertura DESPUÉS: {con_despues}/{total} ({100*con_despues/total:.1f}%)")
    lines.append(f"Salto: +{nuevas} ({100*nuevas/total:.1f} puntos)")
    lines.append("")
    lines.append("Recuperadas por categoría:")
    for cat, n in por_cat.most_common():
        lines.append(f"  {cat:22s} +{n}")
    txt = "\n".join(lines)
    OUT_TXT.write_text(txt + "\n", encoding="utf-8")
    print()
    print(txt)
    print(f"\nJSON: {OUT_JSON}")


if __name__ == "__main__":
    main()
