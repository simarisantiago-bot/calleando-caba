"""
detectar_fotos_no_persona.py — Detecta calles de categoría PERSONA cuya foto
NO es de una persona (viene de una batalla, provincia, río, edificio, etc.).

Para cada PERSONA con foto, resuelve la ENTIDAD DE WIKIDATA de la que sale la
imagen y chequea si es "ser humano" (P31 = Q5). Si no lo es, la marca, con la
etiqueta de qué es (batalla, río, etc.) para que sea fácil corregir.

Fuentes de la foto (en orden de cómo las usa la app):
  - data/fotos.json:   Wikidata (qid conocido) / en.wikipedia / manual (es.wiki)
  - baseline es.wiki:  data/fotos_baseline.json (título del artículo)

Salida: data/fotos_no_persona.txt
"""

import json
import re
import time
from pathlib import Path

import requests

BASE = Path(__file__).parent
S = requests.Session()
S.headers.update({"User-Agent": "calleando-caba/1.0 (simarisantiago@gmail.com) detect"})
WD = "https://www.wikidata.org/w/api.php"

calles = json.load(open(BASE / "data" / "calles.json", encoding="utf-8"))
fotos = json.load(open(BASE / "data" / "fotos.json", encoding="utf-8"))
baseline = json.load(open(BASE / "data" / "fotos_baseline.json", encoding="utf-8"))
wikidata = json.load(open(BASE / "data" / "fotos_wikidata.json", encoding="utf-8"))
enwiki = json.load(open(BASE / "data" / "fotos_enwiki.json", encoding="utf-8"))

# claves PERSONA (una por clave)
persona = {}
for c in calles:
    if (c.get("categoria") or "").strip().upper().startswith("PERSONA"):
        persona.setdefault(c["clave"], c["nombre_busqueda"])

# Para cada PERSONA con foto, determinar (qid conocido) o (wiki, titulo)
directos = {}   # clave -> qid
por_titulo = {} # clave -> (wiki, titulo)
sin_foto = 0
for clave in persona:
    f = fotos.get(clave)
    if f and f.get("sinFoto"):
        sin_foto += 1
        continue
    if f:  # tiene override precomputado
        if clave in wikidata and wikidata[clave].get("qid"):
            directos[clave] = wikidata[clave]["qid"]
        elif clave in enwiki:
            por_titulo[clave] = ("en", f.get("titulo") or enwiki[clave].get("titulo"))
        else:  # manual (es.wiki)
            por_titulo[clave] = ("es", f.get("titulo"))
    else:  # sin override -> búsqueda en vivo es.wiki (baseline)
        b = baseline.get(clave)
        if b and b.get("tiene_foto") and b.get("titulo"):
            por_titulo[clave] = ("es", b["titulo"])

print(f"PERSONA: {len(persona)} | con foto a verificar: {len(directos)+len(por_titulo)} "
      f"(directos {len(directos)}, por título {len(por_titulo)}, sinFoto {sin_foto})", flush=True)


def wiki_qids(titulos, lang):
    """Resuelve títulos de <lang>.wikipedia a Q-id (pageprops wikibase_item)."""
    api = f"https://{lang}.wikipedia.org/w/api.php"
    out = {}
    titulos = list(titulos)
    for i in range(0, len(titulos), 50):
        lote = titulos[i:i + 50]
        try:
            r = S.get(api, params={"action": "query", "format": "json",
                                   "titles": "|".join(lote), "prop": "pageprops",
                                   "ppprop": "wikibase_item", "redirects": "1"}, timeout=40)
            j = r.json()
            norm = {n["from"]: n["to"] for n in (j.get("query", {}).get("normalized") or [])}
            redir = {n["from"]: n["to"] for n in (j.get("query", {}).get("redirects") or [])}
            pages = {p.get("title"): (p.get("pageprops") or {}).get("wikibase_item")
                     for p in (j.get("query", {}).get("pages") or {}).values()}
            for t in lote:
                tt = norm.get(t, t); tt = redir.get(tt, tt)
                out[t] = pages.get(tt)
        except Exception:
            pass
        time.sleep(0.3)
        print(f"  qids {lang}: {min(i+50,len(titulos))}/{len(titulos)}", flush=True)
    return out


# Resolver Q-ids por título
es_t = [t for (w, t) in por_titulo.values() if w == "es" and t]
en_t = [t for (w, t) in por_titulo.values() if w == "en" and t]
es_q = wiki_qids(set(es_t), "es")
en_q = wiki_qids(set(en_t), "en")

clave_qid = dict(directos)
for clave, (w, t) in por_titulo.items():
    q = (es_q if w == "es" else en_q).get(t)
    if q:
        clave_qid[clave] = q

# Batch P31 de todos los qids
qids = sorted(set(clave_qid.values()))
p31 = {}   # qid -> set(instance-of qids)
print(f"Consultando P31 de {len(qids)} entidades...", flush=True)
for i in range(0, len(qids), 50):
    lote = qids[i:i + 50]
    try:
        r = S.get(WD, params={"action": "wbgetentities", "format": "json",
                              "ids": "|".join(lote), "props": "claims"}, timeout=40)
        ents = r.json().get("entities", {})
        for q, e in ents.items():
            vals = set()
            for cl in (e.get("claims", {}).get("P31") or []):
                try:
                    vals.add(cl["mainsnak"]["datavalue"]["value"]["id"])
                except (KeyError, TypeError):
                    pass
            p31[q] = vals
    except Exception:
        pass
    time.sleep(0.3)
    print(f"  P31: {min(i+50,len(qids))}/{len(qids)}", flush=True)

# Etiquetas de los P31 no-humanos (para mostrar qué son)
no_humano_qids = set()
for clave, q in clave_qid.items():
    if q in p31 and "Q5" not in p31[q]:
        no_humano_qids |= p31[q]
labels = {}
lq = sorted(no_humano_qids)
for i in range(0, len(lq), 50):
    lote = lq[i:i + 50]
    try:
        r = S.get(WD, params={"action": "wbgetentities", "format": "json",
                              "ids": "|".join(lote), "props": "labels", "languages": "es|en"}, timeout=40)
        for q, e in r.json().get("entities", {}).items():
            lab = (e.get("labels", {}).get("es") or e.get("labels", {}).get("en") or {}).get("value")
            labels[q] = lab
    except Exception:
        pass
    time.sleep(0.3)

# Palabras clave de título que delatan que NO es persona (respaldo)
NO_PER = re.compile(r"^(batalla|combate|sitio|provincia|departamento|partido|"
                    r"r[ií]o|arroyo|laguna|cerro|volc[áa]n|isla|bah[íi]a|puerto|"
                    r"estaci[óo]n|iglesia|templo|catedral|bas[íi]lica|barrio|"
                    r"bandera|escudo|batall[óo]n|regimiento|club|estadio|"
                    r"localidad|ciudad|municipio|paso de|combate de)\b", re.I)

flagged = []
for clave, nombre in persona.items():
    q = clave_qid.get(clave)
    titulo = None
    if clave in por_titulo:
        titulo = por_titulo[clave][1]
    motivo = None
    if q and q in p31 and "Q5" not in p31[q]:
        tipos = ", ".join((labels.get(t) or t) for t in sorted(p31[q])) or "?"
        motivo = f"Wikidata: NO es persona (es: {tipos})"
    elif titulo and NO_PER.match(titulo.strip()):
        motivo = f"título '{titulo}' no parece persona"
    if motivo:
        flagged.append((nombre, titulo or (f"Q{q}" if q else ""), motivo))

flagged.sort()
out = [f"CALLES PERSONA con foto que NO es de una persona: {len(flagged)}", ""]
for nombre, titulo, motivo in flagged:
    out.append(f"  {nombre}")
    out.append(f"       foto de: {titulo}  ->  {motivo}")
txt = "\n".join(out)
(BASE / "data" / "fotos_no_persona.txt").write_text(txt + "\n", encoding="utf-8")
print()
print(txt[:2500])
print(f"\nReporte: data/fotos_no_persona.txt  | flagged: {len(flagged)}")
