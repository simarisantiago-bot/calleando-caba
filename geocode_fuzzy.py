"""
geocode_fuzzy.py — Segundo pase de recuperación para las entradas que aún no
tienen geometría en geo_cache.json y que fallaron el match EXACTO de `name`
en geocode_nuevas.py.

Estrategia:
  Muchas calles existen en OSM pero con el nombre escrito distinto al Excel
  (abreviaturas: "F. J." vs "Francisco José", "Dr." vs "Doctor", o el apellido
  solo). En vez de pedir el `name` exacto, este script:

    1. Elige un TOKEN ANCLA distintivo del nombre (típicamente el apellido:
       el token más largo que no sea título/stopword).
    2. Pregunta a Overpass por ways/areas cuyo `name` CONTENGA ese token
       (regex case-insensitive), dentro de CABA.
    3. Para cada candidato calcula la similitud (SequenceMatcher + overlap de
       tokens) contra el nombre del Excel y se queda con el mejor.
    4. Si supera el umbral, trae TODA la geometría con ese `name` OSM y la
       clipea a CABA -> línea azul (o polígono/centro para áreas).

  Es CONSERVADOR: si nada supera el umbral, deja la entrada pendiente y la
  reporta con el mejor candidato encontrado, para revisión manual.

No degrada entradas que ya estén en el cache (solo toca las que faltan).

Uso:
    python geocode_fuzzy.py            # aplica al cache
    python geocode_fuzzy.py --dry-run  # solo reporta, no escribe
"""

import json
import sys
import time
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

import requests
from shapely.geometry import shape, LineString, MultiLineString
from shapely.ops import unary_union

BASE = Path(__file__).parent
CALLES_JSON = BASE / "data" / "calles.json"
GEO_CACHE = BASE / "data" / "geo_cache.json"
BARRIOS = BASE / "data" / "barrios.geojson"
REPORTE = BASE / "data" / "geocode_fuzzy_report.txt"

OVERPASS = "https://overpass-api.de/api/interpreter"
USER_AGENT = "calleando-caba/1.0 (simarisantiago@gmail.com)"
CABA_BBOX = (-34.706, -58.531, -34.527, -58.335)  # S, W, N, E
DELAY = 1.1

# Dos umbrales sobre el ratio del "núcleo" del nombre (sin títulos ni prefijos
# geográficos ni iniciales sueltas):
#   >= AUTO_MIN  -> se aplica automáticamente (variante ortográfica casi idéntica)
#   >= REVIEW_MIN -> va a la lista de revisión manual, NO se aplica
AUTO_MIN = 0.86
REVIEW_MIN = 0.62

TIPOS_LINEA = {
    "calle", "avenida", "pasaje peatonal", "pasaje", "autopista",
    "sendero", "paseo", "puente", "túnel", "tunel",
    "sendero peatonal", "puente peatonal",
}
TIPOS_AREA = {
    "plaza", "plazoleta", "parque", "jardín", "jardin", "jardín botánico",
    "espacio verde", "espacio público", "espacio publico",
    "cantero central", "canteros centrales", "cantero",
    "patio de recreación", "patio",
}

# Palabras que NO sirven como ancla ni forman parte del "núcleo" del nombre:
# títulos, grados, conectores. Se quitan de AMBOS lados antes de comparar.
STOPWORDS = {
    "de", "del", "la", "el", "los", "las", "y", "e", "a", "al", "san", "santa",
    "general", "gral", "coronel", "cnel", "teniente", "tte", "capitan", "cap",
    "almirante", "alte", "comodoro", "brigadier", "doctor", "dr", "dra",
    "ingeniero", "ing", "presidente", "pte", "padre", "mayor", "cadete",
    "cabo", "comisario", "diputado", "nacional", "soldado", "mecanico",
    "militar", "aviador", "canonigo", "intendente", "sargento", "vicealmirante",
    "profesor", "prof", "monsenor", "fray", "sor", "don", "dona",
    "canciller", "arquitecto", "arq", "comandante", "contraalmirante",
    "vicecomodoro", "subteniente", "alferez", "guardiamarina", "prefecto",
}

# Prefijos genéricos de lugar que OSM antepone (no son parte del nombre propio).
# Se quitan SOLO del candidato OSM para comparar el núcleo.
GEOWORDS = {
    "plaza", "plazoleta", "parque", "jardin", "paseo", "villa", "estadio",
    "polideportivo", "estanque", "barrio", "club", "complejo", "predio",
    "espacio", "patio", "cantero", "sendero", "puente", "tunel", "monumento",
}


def _norm(s):
    if not isinstance(s, str):
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower().strip()


def tokens(nombre):
    n = _norm(nombre)
    out = []
    for t in n.replace(".", " ").replace(",", " ").split():
        t = t.strip()
        if len(t) <= 1:        # iniciales sueltas "f", "j"
            continue
        out.append(t)
    return out


def significativos(nombre, quitar_geo=False):
    """Tokens que no son stopwords/títulos (ni prefijos geo si quitar_geo)."""
    fuera = STOPWORDS | GEOWORDS if quitar_geo else STOPWORDS
    return [t for t in tokens(nombre) if t not in fuera]


def nucleo(nombre, quitar_geo=False):
    """Cadena comparable: tokens significativos (sin iniciales) unidos."""
    return " ".join(significativos(nombre, quitar_geo))


def ancla(nombre):
    """Token distintivo para buscar en OSM: el significativo más largo."""
    sig = significativos(nombre)
    if not sig:
        sig = tokens(nombre)
    if not sig:
        return None
    return max(sig, key=len)


def similitud(excel, osm):
    """
    Ratio de strings sobre el NÚCLEO de ambos nombres (títulos/grados quitados
    de los dos lados; prefijos geográficos quitados del candidato OSM).
    Sin boost por overlap de tokens: ese boost generaba falsos positivos
    cuando dos personas distintas compartían un título o un nombre de pila.
    """
    ne = nucleo(excel)
    no = nucleo(osm, quitar_geo=True)
    if not ne or not no:
        return 0.0
    return SequenceMatcher(None, ne, no).ratio()


def cargar_caba():
    with BARRIOS.open(encoding="utf-8") as f:
        data = json.load(f)
    return unary_union([shape(f["geometry"]) for f in data["features"]]).buffer(0)


def overpass(query):
    try:
        r = requests.post(
            OVERPASS, data={"data": query},
            timeout=50, headers={"User-Agent": USER_AGENT},
        )
        if r.status_code != 200:
            return None
        return r.json()
    except Exception:
        return None


def candidatos_por_ancla(token, filtro):
    """
    filtro: 'highway' (líneas) o 'area' (leisure/landuse/place).
    Devuelve lista de elementos OSM cuyo name contiene `token`.
    """
    s, w, n, e = CABA_BBOX
    tok = token.replace('"', '\\"')
    if filtro == "highway":
        q = (
            '[out:json][timeout:40];'
            f'(way["highway"]["name"~"{tok}",i]({s},{w},{n},{e}););'
            'out geom tags;'
        )
    else:
        q = (
            '[out:json][timeout:40];'
            '('
            f'  way["leisure"]["name"~"{tok}",i]({s},{w},{n},{e});'
            f'  way["landuse"]["name"~"{tok}",i]({s},{w},{n},{e});'
            f'  way["place"="square"]["name"~"{tok}",i]({s},{w},{n},{e});'
            f'  node["place"="square"]["name"~"{tok}",i]({s},{w},{n},{e});'
            ');'
            'out center geom tags;'
        )
    data = overpass(q)
    time.sleep(DELAY)
    if not data:
        return []
    return [el for el in data.get("elements", []) if el.get("tags", {}).get("name")]


def mejor_candidato(nombre_excel, elementos):
    """Devuelve (name_osm, sim) del candidato con mejor similitud."""
    nombres = {}
    for el in elementos:
        nm = el["tags"]["name"]
        nombres[nm] = max(nombres.get(nm, 0.0), similitud(nombre_excel, nm))
    if not nombres:
        return None, 0.0
    best = max(nombres.items(), key=lambda kv: kv[1])
    return best[0], best[1]


def linea_con_nombre(name_osm, caba):
    """Trae todos los ways highway con ese name exacto, clip a CABA -> dict line."""
    s, w, n, e = CABA_BBOX
    nm = name_osm.replace('"', '\\"')
    q = (
        '[out:json][timeout:40];'
        f'(way["highway"]["name"="{nm}"]({s},{w},{n},{e}););'
        'out geom;'
    )
    data = overpass(q)
    time.sleep(DELAY)
    if not data:
        return None
    lineas = []
    for way in data.get("elements", []):
        if way.get("type") != "way" or not way.get("geometry"):
            continue
        coords = [(pt["lon"], pt["lat"]) for pt in way["geometry"]]
        if len(coords) < 2:
            continue
        clipped = LineString(coords).intersection(caba)
        if clipped.is_empty:
            continue
        if isinstance(clipped, LineString) and len(clipped.coords) >= 2:
            lineas.append(list(map(list, clipped.coords)))
        elif isinstance(clipped, MultiLineString):
            for ln in clipped.geoms:
                if len(ln.coords) >= 2:
                    lineas.append(list(map(list, ln.coords)))
    if not lineas:
        return None
    todos = [pt for ln in lineas for pt in ln]
    lons = [p[0] for p in todos]
    lats = [p[1] for p in todos]
    geom = ({"type": "MultiLineString", "coordinates": lineas}
            if len(lineas) > 1 else {"type": "LineString", "coordinates": lineas[0]})
    return {
        "tipo": "line",
        "geometry": geom,
        "bbox": [min(lats), max(lats), min(lons), max(lons)],
        "source": "geocode-fuzzy",
        "ways": len(lineas),
    }


def area_de_elemento(elementos, name_osm):
    """Construye geometría point/polygon del candidato con ese name."""
    for el in elementos:
        if el["tags"].get("name") != name_osm:
            continue
        if el.get("type") == "way" and el.get("geometry"):
            coords = [[pt["lon"], pt["lat"]] for pt in el["geometry"]]
            if len(coords) >= 3:
                if coords[0] != coords[-1]:
                    coords.append(coords[0])
                lats = [p[1] for p in coords]
                lons = [p[0] for p in coords]
                return {
                    "tipo": "point",
                    "center": [sum(lats) / len(lats), sum(lons) / len(lons)],
                    "geometry": {"type": "Polygon", "coordinates": [coords]},
                    "bbox": [min(lats), max(lats), min(lons), max(lons)],
                    "source": "geocode-fuzzy",
                }
        if el.get("type") == "node":
            return {
                "tipo": "point",
                "center": [el["lat"], el["lon"]],
                "bbox": [el["lat"] - 0.001, el["lat"] + 0.001,
                         el["lon"] - 0.001, el["lon"] + 0.001],
                "source": "geocode-fuzzy",
            }
        if el.get("type") == "way" and el.get("center"):
            c = el["center"]
            return {
                "tipo": "point",
                "center": [c["lat"], c["lon"]],
                "bbox": [c["lat"] - 0.001, c["lat"] + 0.001,
                         c["lon"] - 0.001, c["lon"] + 0.001],
                "source": "geocode-fuzzy",
            }
    return None


def main():
    dry = "--dry-run" in sys.argv
    caba = cargar_caba()

    with CALLES_JSON.open(encoding="utf-8") as f:
        calles = json.load(f)
    with GEO_CACHE.open(encoding="utf-8") as f:
        cache = json.load(f)

    # Solo una entrada por clave|tipo, pero varias claves pueden compartir nombre.
    pendientes = [c for c in calles if c["id"] not in cache]
    lineas = [c for c in pendientes if c["tipo"] in TIPOS_LINEA]
    areas = [c for c in pendientes if c["tipo"] in TIPOS_AREA]
    otros = [c for c in pendientes if c["tipo"] not in TIPOS_LINEA
             and c["tipo"] not in TIPOS_AREA]

    print(f"Pendientes: {len(pendientes)}  (líneas {len(lineas)}, "
          f"áreas {len(areas)}, otros {len(otros)})")
    print(f"Umbrales: auto >= {AUTO_MIN}, revisión >= {REVIEW_MIN}  "
          f"{'[DRY-RUN]' if dry else ''}")
    print()

    aceptados = 0
    aceptados_det = []  # (nombre, tipo, osm, sim, geotipo)
    revisar = []      # (nombre, tipo, osm, sim) -> banda media, NO se aplica
    rechazados = []   # (nombre, tipo, mejor_osm, sim)
    sin_ancla = []
    inicio = time.time()

    objetivo = lineas + areas
    for i, c in enumerate(objetivo, 1):
        nombre = c["nombre_busqueda"]
        es_linea = c["tipo"] in TIPOS_LINEA
        tok = ancla(nombre)
        if not tok or len(tok) < 3:
            sin_ancla.append((nombre, c["tipo"]))
            continue

        elementos = candidatos_por_ancla(tok, "highway" if es_linea else "area")
        name_osm, sim = mejor_candidato(nombre, elementos)

        if name_osm and sim >= AUTO_MIN:
            # Banda alta: traer geometría y aplicar.
            if es_linea:
                geo = linea_con_nombre(name_osm, caba)
            else:
                geo = area_de_elemento(elementos, name_osm)
            if geo:
                if not dry:
                    cache[c["id"]] = geo
                aceptados += 1
                aceptados_det.append((nombre, c["tipo"], name_osm, sim, geo["tipo"]))
                estado = f"AUTO {geo['tipo']:5s} sim {sim:.2f} <- '{name_osm[:28]}'"
            else:
                revisar.append((nombre, c["tipo"], name_osm, sim))
                estado = f"geo-fail '{name_osm[:28]}'"
        elif name_osm and sim >= REVIEW_MIN:
            # Banda media: candidato plausible pero dudoso -> revisión manual.
            revisar.append((nombre, c["tipo"], name_osm, sim))
            estado = f"REVISAR  sim {sim:.2f} <- '{name_osm[:28]}'"
        else:
            rechazados.append((nombre, c["tipo"], name_osm or "-", sim))
            estado = f"low sim {sim:.2f} '{(name_osm or '-')[:28]}'"

        elapsed = time.time() - inicio
        rate = i / elapsed if elapsed else 0
        eta = (len(objetivo) - i) / rate / 60 if rate else 0
        print(f"  [{i:3d}/{len(objetivo)}] {estado:48s} {nombre[:32]:32s} ETA {eta:.1f}m")

        if not dry and i % 15 == 0:
            tmp = GEO_CACHE.with_suffix(".json.tmp")
            with tmp.open("w", encoding="utf-8") as f:
                json.dump(cache, f, ensure_ascii=False)
            tmp.replace(GEO_CACHE)

    if not dry:
        tmp = GEO_CACHE.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
        tmp.replace(GEO_CACHE)

    # Reporte
    lineas_rep = []
    lineas_rep.append(f"Auto-aceptados (geometría agregada): {aceptados}")
    lineas_rep.append(f"Para revisar (banda media, NO aplicados): {len(revisar)}")
    lineas_rep.append(f"Rechazados (baja similitud / sin candidato): {len(rechazados)}")
    lineas_rep.append(f"Sin ancla utilizable: {len(sin_ancla)}")
    lineas_rep.append("")
    lineas_rep.append("=== AUTO-ACEPTADOS (auditar: Excel <- nombre OSM) ===")
    for nombre, tipo, osm, sim, gt in sorted(aceptados_det, key=lambda x: x[3]):
        lineas_rep.append(f"  [{tipo:18s}] {gt:5s} sim {sim:.2f}  {nombre}")
        lineas_rep.append(f"       OSM: '{osm}'")
    lineas_rep.append("")
    lineas_rep.append("=== PARA REVISAR (candidato plausible, confirmá vos) ===")
    for nombre, tipo, osm, sim in sorted(revisar, key=lambda x: -x[3]):
        lineas_rep.append(f"  [{tipo:18s}] sim {sim:.2f}  {nombre}")
        lineas_rep.append(f"       candidato OSM: '{osm}'")
    lineas_rep.append("")
    lineas_rep.append("=== RECHAZADOS (sin candidato razonable) ===")
    for nombre, tipo, osm, sim in sorted(rechazados, key=lambda x: -x[3]):
        lineas_rep.append(f"  [{tipo:18s}] {nombre}")
        lineas_rep.append(f"       mejor OSM: '{osm}'  (sim {sim:.2f})")
    if sin_ancla:
        lineas_rep.append("")
        lineas_rep.append("=== SIN ANCLA (nombres no buscables, p.ej. fechas) ===")
        for nombre, tipo in sin_ancla:
            lineas_rep.append(f"  [{tipo:18s}] {nombre}")

    texto = "\n".join(lineas_rep)
    REPORTE.write_text(texto + "\n", encoding="utf-8")

    print()
    print(texto[:2000])
    print()
    print(f"Reporte completo: {REPORTE}")
    print(f"Cache total: {len(cache)} / {len(calles)} "
          f"({100 * len(cache) / len(calles):.1f}%)")


if __name__ == "__main__":
    main()
