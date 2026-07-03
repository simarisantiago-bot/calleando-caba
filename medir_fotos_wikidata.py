"""
medir_fotos_wikidata.py — PASO 2. Sobre las que HOY no tienen foto
(fotos_baseline.json, tiene_foto=False), intenta recuperarlas vía Wikidata:
   término -> wbsearchentities (Q) -> P18 (imagen) -> Commons.

Wikidata es multilingüe: si no hay imagen asociada al artículo en español,
suele estar en la entidad (cargada desde inglés u otro idioma).

Salida:
  data/fotos_wikidata.json  {clave: {url, titulo, qid}}  (las recuperadas)
  data/fotos_paso2_report.txt

Uso:
    python medir_fotos_wikidata.py
"""

import json
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock

import requests

from medir_fotos import terminos_busqueda, BUSQUEDA_OVERRIDES

BASE = Path(__file__).parent
BASELINE = BASE / "data" / "fotos_baseline.json"
CALLES = BASE / "data" / "calles.json"
OUT_JSON = BASE / "data" / "fotos_wikidata.json"
OUT_TXT = BASE / "data" / "fotos_paso2_report.txt"

WD_API = "https://www.wikidata.org/w/api.php"
UA = "calleando-caba/1.0 (simarisantiago@gmail.com) foto-wikidata"
WORKERS = 8

_session = requests.Session()
_session.headers.update({"User-Agent": UA})
_cache = {}
_lock = Lock()


def _get(params):
    for intento in range(3):
        try:
            r = _session.get(WD_API, params=params, timeout=30)
            if r.status_code == 200:
                return r.json()
            time.sleep(1 + intento)
        except Exception:
            time.sleep(1 + intento)
    return None


def qid_de_termino(term, lang):
    j = _get({
        "action": "wbsearchentities", "format": "json",
        "search": term, "language": lang, "uselang": lang,
        "type": "item", "limit": "1",
    })
    hits = (j or {}).get("search") or []
    return hits[0]["id"] if hits else None


def imagen_de_qid(qid):
    j = _get({
        "action": "wbgetentities", "format": "json",
        "ids": qid, "props": "claims", "languages": "es",
    })
    ent = ((j or {}).get("entities") or {}).get(qid) or {}
    claims = ent.get("claims") or {}
    p18 = claims.get("P18")
    if not p18:
        return None
    try:
        fname = p18[0]["mainsnak"]["datavalue"]["value"]
    except (KeyError, IndexError, TypeError):
        return None
    safe = urllib.parse.quote(fname.replace(" ", "_"))
    return f"https://commons.wikimedia.org/wiki/Special:FilePath/{safe}?width=480"


def buscar_wikidata(term):
    key = term.strip().lower()
    if not key:
        return None
    with _lock:
        if key in _cache:
            return _cache[key]
    res = None
    for lang in ("es", "en"):
        qid = qid_de_termino(term, lang)
        if not qid:
            continue
        url = imagen_de_qid(qid)
        if url:
            res = {"url": url, "titulo": term, "qid": qid}
            break
    with _lock:
        _cache[key] = res
    return res


def main():
    baseline = json.load(open(BASELINE, encoding="utf-8"))
    calles = json.load(open(CALLES, encoding="utf-8"))
    rep = {}
    for c in calles:
        rep.setdefault(c["clave"], {"rep": c, "ids": [c["id"]]})
        if c["id"] not in rep[c["clave"]]["ids"]:
            rep[c["clave"]]["ids"].append(c["id"])

    faltantes = [(clave, r) for clave, r in baseline.items() if not r["tiene_foto"]]
    print(f"Reintentando {len(faltantes)} sin foto vía Wikidata ({WORKERS} hilos)...")

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
            hit = buscar_wikidata(t)
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
    con_antes = sum(1 for r in baseline.values() if r["tiene_foto"])
    nuevas = len(recuperadas)
    con_despues = con_antes + nuevas
    por_cat = Counter(v["categoria"] for v in recuperadas.values())

    lines = []
    lines.append("PASO 2 — Wikidata sobre las sin foto")
    lines.append(f"Sin foto (baseline): {len(faltantes)}")
    lines.append(f"Recuperadas vía Wikidata: {nuevas}")
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
    print(f"\nJSON recuperadas: {OUT_JSON}")


if __name__ == "__main__":
    main()
