"""
fix_calles_manual.py — Arregla calles puntuales con sus nombres OSM correctos.

Lista curada manualmente: para cada calle que estaba como pin en el cache,
mapeamos al nombre real en OpenStreetMap.

Uso:
    python fix_calles_manual.py
"""

import json
import time
import unicodedata
from pathlib import Path

import requests
from shapely.geometry import shape, LineString, MultiLineString
from shapely.ops import unary_union

BASE = Path(__file__).parent
CALLES_JSON = BASE / "data" / "calles.json"
GEO_CACHE = BASE / "data" / "geo_cache.json"
BARRIOS = BASE / "data" / "barrios.geojson"

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
USER_AGENT = "calleando-caba/1.0 (simarisantiago@gmail.com)"
CABA_BBOX = (-34.706, -58.531, -34.527, -58.335)
DELAY = 1.1


# Mapeo curado: clave del Excel -> lista de nombres OSM a probar.
# Si más de uno matchea, se combinan todos en una sola geometría.
MAPEO = {
    # Avenidas grandes con nombre OSM distinto
    "rivadavia|avenida":                                ["Avenida Rivadavia", "Rivadavia"],
    "diagonal norte presidente roque saenz pena|avenida": [
        "Avenida Presidente Roque Sáenz Peña",
        "Diagonal Norte Presidente Roque Sáenz Peña",
    ],
    "diagonal sur presidente julio a roca|avenida": [
        "Avenida Presidente Julio Argentino Roca",
        "Avenida Presidente Julio A. Roca",
        "Diagonal Sur Presidente Julio A. Roca",
    ],
    "canonigo miguel calixto del corro|avenida":  ["Avenida Canónigo Miguel Calixto del Corro", "Canónigo Miguel Calixto del Corro"],

    # Calles famosas con nombre OSM expandido
    "antonio vespucio liberti|calle":   ["Avenida Antonio Vespucio Liberti", "Antonio Vespucio Liberti"],
    "hipolito bouchard|calle":          ["Hipólito Bouchard", "Pasaje Hipólito Bouchard"],
    "aerolineas argentinas|calle":      ["Aerolíneas Argentinas"],
    "boulevard azucena villaflor|calle": ["Boulevard Azucena Villaflor", "Azucena Villaflor"],
    "edmundo de amicis|calle":          ["Edmundo De Amicis", "Edmundo de Amicis"],
    "el lazo|calle":                    ["El Lazo"],
    "manuel nicolas savio|calle":       ["Manuel Nicolás Savio", "Doctor Manuel Nicolás Savio"],
    "prilidiano pueyrredon|calle":      ["Prilidiano Pueyrredón"],
    "doctor rodolfo rivarola|calle":    ["Doctor Rodolfo Rivarola", "Rodolfo Rivarola"],
    "ignacio fermin rodriguez|calle":   ["Ignacio Fermín Rodríguez"],
    "coronel manuel jose olascoaga|calle": ["Coronel Manuel José Olascoaga", "Coronel Olascoaga"],
    "espadana|calle":                   ["Espadaña"],
    "orquideas|calle":                  ["Orquídeas"],
    "ruda|calle":                       ["Ruda"],
    "tehuelche|calle":                  ["Tehuelche"],
    "alerce|calle":                     ["Alerce"],
    "chilca|calle":                     ["Chilca"],
    "claudia falcone|calle":            ["Claudia Falcone"],
    "nelly nistal|calle":               ["Nelly Nistal"],
    "francisco alejandro mohr|calle":   ["Francisco Alejandro Mohr"],
    "micaela bastidas|calle":           ["Micaela Bastidas", "Avenida Micaela Bastidas"],
    "padre mario luis migone|calle":    ["Padre Mario Luis Migone"],
    "sudamerica|calle":                 ["Sudamérica"],
    "crucero general belgrano|calle":   ["Crucero General Belgrano", "Crucero ARA General Belgrano"],

    # Bergantín / Aljaba / etc. eran del lote 1 manual
    "bergantin vigilante|calle":        ["Bergantín Vigilante"],
    "aljaba magallanica|calle":         ["Aljaba Magallánica"],

    # Puentes
    "adan buenosayres|puente":          ["Puente Adán Buenosayres", "Adán Buenosayres"],
    "barraca pena|puente":              ["Puente Barraca Peña", "Barraca Peña"],
    "de la noria|puente":               ["Puente de la Noria", "Puente De la Noria"],
    "prilidiano pueyrredon|puente":     ["Puente Prilidiano Pueyrredón"],

    # Túnel
    "intendente seeber|tunel":          ["Túnel Intendente Seeber"],
    "intendente seeber|túnel":          ["Túnel Intendente Seeber"],

    # Paseos
    "astor piazzola|calle":             ["Astor Piazzola", "Astor Piazzolla"],
    "astor piazzola|paseo":             ["Paseo Astor Piazzola", "Astor Piazzola", "Paseo Astor Piazzolla"],
    "chacarita de los colegiales|paseo": ["Paseo Chacarita de los Colegiales", "Chacarita de los Colegiales"],
    "comisario general juan angel pirker|paseo": ["Paseo Comisario General Juan Ángel Pirker", "Comisario Juan Ángel Pirker"],
    "de versalles|paseo":               ["Paseo de Versalles", "Paseo De Versalles"],
    "de la vida|paseo":                 ["Paseo de la Vida"],
    "de las americas|paseo":            ["Paseo de las Américas"],
    "de las esculturas|paseo":          ["Paseo de las Esculturas"],
}


def _norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower().strip()


def cargar_caba():
    with BARRIOS.open(encoding="utf-8") as f:
        data = json.load(f)
    return unary_union([shape(f["geometry"]) for f in data["features"]]).buffer(0)


def overpass(name):
    name_safe = name.replace('"', '\\"')
    s, w, n, e = CABA_BBOX
    q = (
        '[out:json][timeout:15];'
        f'(way["highway"]["name"="{name_safe}"]({s},{w},{n},{e}););'
        'out geom;'
    )
    for url in OVERPASS_URLS:
        try:
            r = requests.post(url, data={"data": q}, timeout=20,
                              headers={"User-Agent": USER_AGENT})
            if r.status_code == 200 and r.text.strip().startswith("{"):
                return r.json()
        except (requests.RequestException, ValueError):
            continue
    return None


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


def ways_a_lineas_recortadas(data, caba):
    if not data:
        return []
    ways = [el for el in data.get("elements", [])
            if el.get("type") == "way" and el.get("geometry")]
    lineas = []
    for w in ways:
        coords = [(pt["lon"], pt["lat"]) for pt in w["geometry"]]
        if len(coords) < 2:
            continue
        line = LineString(coords)
        clip = line.intersection(caba)
        for sub in _a_lineas(clip):
            lineas.append(sub)
    return lineas


def construir_entry(lineas, nombres_osm):
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
        "source": "fix-manual",
        "ways": len(lineas),
        "match_osm": " + ".join(nombres_osm),
    }


def main():
    caba = cargar_caba()
    with CALLES_JSON.open(encoding="utf-8") as f:
        calles = json.load(f)
    with GEO_CACHE.open(encoding="utf-8") as f:
        cache = json.load(f)
    ids_validos = {c["id"] for c in calles}

    arregladas = 0
    sin_cambio = []

    for clave_excel, candidatos in MAPEO.items():
        if clave_excel not in ids_validos:
            print(f"  [SKIP] {clave_excel!r} no existe en calles.json")
            continue

        lineas_combinadas = []
        usados = []
        for nom in candidatos:
            data = overpass(nom)
            time.sleep(DELAY)
            ls = ways_a_lineas_recortadas(data, caba)
            if ls:
                lineas_combinadas.extend(ls)
                usados.append(nom)

        ways_actual = cache.get(clave_excel, {}).get("ways", 0)
        if not lineas_combinadas:
            sin_cambio.append(clave_excel)
            print(f"  ---  {clave_excel:60s}  (sin match en OSM)")
            continue

        entry = construir_entry(lineas_combinadas, usados)
        cache[clave_excel] = entry
        arregladas += 1
        print(f"  FIX  {clave_excel:60s}  {ways_actual} -> {entry['ways']} ways  ({', '.join(usados)})")

        # Guardado parcial
        if arregladas % 5 == 0:
            tmp = GEO_CACHE.with_suffix(".json.tmp")
            with tmp.open("w", encoding="utf-8") as f:
                json.dump(cache, f, ensure_ascii=False)
            tmp.replace(GEO_CACHE)

    # Guardar final
    tmp = GEO_CACHE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    tmp.replace(GEO_CACHE)

    print()
    print(f"Total mapeos: {len(MAPEO)}")
    print(f"Arregladas: {arregladas}")
    print(f"Sin match: {len(sin_cambio)}")


if __name__ == "__main__":
    main()
