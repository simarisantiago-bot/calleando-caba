"""
fix_calles_punto.py — Repara calles tipo línea que quedaron como pin en
el cache, usando bulk-download de OSM y matching por palabras significativas.

Estrategia (rápida):
  1. Descarga TODAS las ways con highway+name en CABA (una sola query a Overpass).
  2. Para cada calle del Excel que está como punto:
     - Toma sus palabras significativas (saca preposiciones).
     - Busca ways OSM cuyo `name` contenga TODAS esas palabras.
     - Si encuentra, agrupa por name OSM, combina geometrías y reemplaza
       el punto por la línea completa.
  3. Recorta al polígono real de CABA antes de guardar.

Uso:
    python fix_calles_punto.py

Tiempo estimado: ~30 segundos (1 query Overpass + procesamiento local).
"""

import json
import time
import unicodedata
from pathlib import Path
from collections import defaultdict

import requests
from shapely.geometry import shape, LineString, MultiLineString
from shapely.ops import unary_union

BASE = Path(__file__).parent
CALLES_JSON = BASE / "data" / "calles.json"
GEO_CACHE = BASE / "data" / "geo_cache.json"
BARRIOS = BASE / "data" / "barrios.geojson"
OSM_BULK = BASE / "data" / "_osm_bulk_calles.json"

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
]
USER_AGENT = "calleando-caba/1.0 (simarisantiago@gmail.com)"
CABA_BBOX = (-34.706, -58.531, -34.527, -58.335)

TIPOS_LINEA = {"calle", "avenida", "pasaje peatonal", "autopista",
               "sendero", "paseo", "puente", "tunel", "túnel",
               "sendero peatonal", "puente peatonal"}

PREPOSICIONES = {
    "de", "del", "la", "las", "los", "y", "el", "en", "para", "por",
    "san", "santa", "santo", "don", "dona", "sor",
}


def _norm(s):
    if not isinstance(s, str):
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower().strip()


def palabras_significativas(nombre):
    """Tokens del nombre normalizado, excluyendo preposiciones y palabras de 1-2 letras."""
    raw = _norm(nombre).split()
    return [p for p in raw if p not in PREPOSICIONES and len(p) >= 3]


def cargar_caba():
    with BARRIOS.open(encoding="utf-8") as f:
        data = json.load(f)
    return unary_union([shape(f["geometry"]) for f in data["features"]]).buffer(0)


def descargar_calles_osm():
    if OSM_BULK.exists():
        edad_min = (time.time() - OSM_BULK.stat().st_mtime) / 60
        if edad_min < 60 * 24:  # menos de 24h
            print(f"Usando bulk cacheado ({edad_min:.0f} min).")
            with OSM_BULK.open(encoding="utf-8") as f:
                return json.load(f)
    s, w, n, e = CABA_BBOX
    q = (
        '[out:json][timeout:300];'
        f'(way["highway"]["name"]({s},{w},{n},{e}););'
        'out geom;'
    )
    for url in OVERPASS_URLS:
        print(f"Probando Overpass: {url}")
        try:
            r = requests.post(url, data={"data": q}, timeout=300,
                              headers={"User-Agent": USER_AGENT})
            if r.status_code != 200:
                print(f"  HTTP {r.status_code} — siguiente mirror.")
                continue
            if not r.text.strip().startswith("{"):
                print(f"  Respuesta no es JSON ({len(r.text)} bytes) — siguiente mirror.")
                continue
            data = r.json()
            OSM_BULK.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            print(f"  OK: {len(data.get('elements', []))} ways descargados.")
            return data
        except (requests.RequestException, ValueError) as e:
            print(f"  Error: {type(e).__name__}: {e}")
            continue
    raise SystemExit("No se pudo descargar de ningún mirror de Overpass.")


def _a_lineas(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, LineString):
        if len(geom.coords) < 2:
            return []
        return [list(map(list, geom.coords))]
    if isinstance(geom, MultiLineString):
        return [list(map(list, line.coords)) for line in geom.geoms
                if len(line.coords) >= 2]
    if hasattr(geom, "geoms"):
        out = []
        for g in geom.geoms:
            out.extend(_a_lineas(g))
        return out
    return []


def ways_a_lineas_recortadas(ways, caba):
    lineas = []
    for w in ways:
        geom = w.get("geometry")
        if not geom:
            continue
        coords = [(pt["lon"], pt["lat"]) for pt in geom]
        if len(coords) < 2:
            continue
        line = LineString(coords)
        clip = line.intersection(caba)
        for sub in _a_lineas(clip):
            lineas.append(sub)
    return lineas


def construir_entry(lineas, name_osm):
    if not lineas:
        return None
    todos = [pt for ln in lineas for pt in ln]
    lons = [p[0] for p in todos]
    lats = [p[1] for p in todos]
    if len(lineas) == 1:
        geom = {"type": "LineString", "coordinates": lineas[0]}
    else:
        geom = {"type": "MultiLineString", "coordinates": lineas}
    return {
        "tipo": "line",
        "geometry": geom,
        "bbox": [min(lats), max(lats), min(lons), max(lons)],
        "source": "fix-calles-punto",
        "ways": len(lineas),
        "match_osm": name_osm,
    }


def main():
    caba = cargar_caba()

    with CALLES_JSON.open(encoding="utf-8") as f:
        calles = json.load(f)
    with GEO_CACHE.open(encoding="utf-8") as f:
        cache = json.load(f)

    # Candidatos: tipo línea del Excel pero punto en cache
    candidatos = [c for c in calles
                  if c["tipo"] in TIPOS_LINEA
                  and cache.get(c["id"], {}).get("tipo") == "point"]
    print(f"Candidatos a re-procesar: {len(candidatos)}")
    if not candidatos:
        return

    # Bulk download e indexación
    osm_data = descargar_calles_osm()
    ways_por_name = defaultdict(list)
    for el in osm_data.get("elements", []):
        if el.get("type") != "way":
            continue
        name = (el.get("tags") or {}).get("name")
        if not name:
            continue
        ways_por_name[name].append(el)

    # Pre-computar palabras significativas de cada name OSM
    sig_por_name = {n: set(palabras_significativas(n)) for n in ways_por_name}

    print(f"Índice OSM: {len(ways_por_name)} nombres únicos.\n")
    print("Matcheando candidatos...")

    arregladas = 0
    sin_match = []

    for c in candidatos:
        nombre = c["nombre_busqueda"]
        sig_excel = set(palabras_significativas(nombre))
        if not sig_excel:
            sin_match.append(nombre)
            continue

        # Buscar nombres OSM que CONTENGAN TODAS las palabras significativas del Excel
        matches = []
        for name_osm, sig_osm in sig_por_name.items():
            if sig_excel.issubset(sig_osm):
                # Match: el name OSM contiene todas las palabras significativas del Excel
                matches.append(name_osm)

        if not matches:
            sin_match.append(nombre)
            continue

        # Ordenar matches: menos palabras extras primero (más exactos)
        matches.sort(key=lambda n: len(sig_por_name[n] - sig_excel))

        # Probar cada match en orden. Si uno cae fuera de CABA tras el clip,
        # pasar al siguiente. Tomamos el primero que produzca >= 1 línea útil.
        mejor = None
        mejor_lineas = []
        for cand in matches:
            lineas = ways_a_lineas_recortadas(ways_por_name[cand], caba)
            if lineas:
                # Si encontramos uno que tiene varias líneas, lo preferimos
                # sobre uno que tiene 1 sola (más confiable)
                if len(lineas) > len(mejor_lineas):
                    mejor = cand
                    mejor_lineas = lineas
                # Si ya tenemos uno con buena cobertura (3+), cortar
                if len(mejor_lineas) >= 3:
                    break

        if not mejor:
            sin_match.append(nombre)
            continue

        entry = construir_entry(mejor_lineas, mejor)
        if not entry:
            sin_match.append(nombre)
            continue

        cache[c["id"]] = entry
        arregladas += 1
        print(f"  FIX  {nombre[:38]:38s} -> '{mejor}' ({entry['ways']} ways)")

    # Guardar
    tmp = GEO_CACHE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    tmp.replace(GEO_CACHE)

    print()
    print(f"Arregladas: {arregladas} / {len(candidatos)}")
    print(f"Sin match en OSM: {len(sin_match)}")
    if sin_match[:20]:
        print("Ejemplos sin match:")
        for n in sin_match[:20]:
            print(f"  - {n}")


if __name__ == "__main__":
    main()
