"""
limpiar_fuera_caba.py — Recorta del cache cualquier segmento fuera del polígono de CABA.

Cuando consultamos Overpass con bbox (rectángulo), incluímos sin querer
trozos de Avellaneda al sur del Riachuelo, de Vicente López al norte,
y partes del Río de la Plata al este. Este script:

  1. Construye el polígono real de CABA uniendo los 48 barrios.
  2. Itera todas las entradas tipo 'line' del geo_cache.
  3. Recorta cada way al polígono de CABA.
  4. Si una entrada queda sin geometría dentro, la convierte a punto
     usando el centro de su bbox original (si está dentro de CABA).
  5. Reporta cuántas entradas se modificaron.

Uso:
    python limpiar_fuera_caba.py
"""

import json
from pathlib import Path

from shapely.geometry import shape, mapping, LineString, MultiLineString, Point
from shapely.ops import unary_union

BASE = Path(__file__).parent
BARRIOS = BASE / "data" / "barrios.geojson"
CACHE = BASE / "data" / "geo_cache.json"


def cargar_poligono_caba():
    with BARRIOS.open(encoding="utf-8") as f:
        data = json.load(f)
    polys = [shape(f["geometry"]) for f in data["features"]]
    union = unary_union(polys)
    if not union.is_valid:
        union = union.buffer(0)
    return union


def recortar_linestring(coords, caba):
    """Devuelve lista de LineStrings (en formato lista de coords) dentro de CABA."""
    if len(coords) < 2:
        return []
    line = LineString(coords)
    clipped = line.intersection(caba)
    return _a_lineas(clipped)


def _a_lineas(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, LineString):
        if len(geom.coords) < 2:
            return []
        return [list(map(list, geom.coords))]
    if isinstance(geom, MultiLineString):
        out = []
        for line in geom.geoms:
            if len(line.coords) >= 2:
                out.append(list(map(list, line.coords)))
        return out
    # Otros tipos (GeometryCollection con puntos, etc.) los ignoramos
    if hasattr(geom, "geoms"):
        out = []
        for g in geom.geoms:
            out.extend(_a_lineas(g))
        return out
    return []


def main():
    print("Cargando polígono de CABA...")
    caba = cargar_poligono_caba()
    print(f"  Área aprox: {caba.area * 111 * 111 * 0.83:.0f} km²")
    print()

    with CACHE.open(encoding="utf-8") as f:
        cache = json.load(f)

    modificadas = 0
    sin_cambios = 0
    sin_geom_restante = 0
    eliminadas = []

    for clave in list(cache.keys()):
        entry = cache[clave]
        if entry.get("tipo") != "line" or "geometry" not in entry:
            continue

        geom = entry["geometry"]
        if geom["type"] == "LineString":
            lineas_orig = [geom["coordinates"]]
        elif geom["type"] == "MultiLineString":
            lineas_orig = geom["coordinates"]
        else:
            continue

        # Recortar cada sub-línea
        lineas_clip = []
        for coords in lineas_orig:
            lineas_clip.extend(recortar_linestring(coords, caba))

        if not lineas_clip:
            # Todo afuera. Convertir a punto si bbox cae dentro.
            bbox = entry.get("bbox")
            if bbox and len(bbox) == 4:
                lat_c = (bbox[0] + bbox[1]) / 2
                lon_c = (bbox[2] + bbox[3]) / 2
                if caba.contains(Point(lon_c, lat_c)):
                    cache[clave] = {
                        "tipo": "point",
                        "center": [lat_c, lon_c],
                        "bbox": bbox,
                        "source": entry.get("source", "?") + "-clipped",
                    }
                    sin_geom_restante += 1
                    continue
            # Ni siquiera el bbox cae en CABA → eliminar
            del cache[clave]
            eliminadas.append(clave)
            continue

        # Si la cantidad cambió, hubo recorte
        original_n = sum(len(c) for c in lineas_orig)
        nuevo_n = sum(len(c) for c in lineas_clip)
        if nuevo_n == original_n and len(lineas_clip) == len(lineas_orig):
            sin_cambios += 1
            continue

        # Reconstruir bbox
        todos = [pt for ln in lineas_clip for pt in ln]
        lons = [p[0] for p in todos]
        lats = [p[1] for p in todos]
        if len(lineas_clip) == 1:
            geom_nueva = {"type": "LineString", "coordinates": lineas_clip[0]}
        else:
            geom_nueva = {"type": "MultiLineString", "coordinates": lineas_clip}

        cache[clave] = {
            **entry,
            "geometry": geom_nueva,
            "bbox": [min(lats), max(lats), min(lons), max(lons)],
            "ways": len(lineas_clip),
        }
        modificadas += 1

    # Guardar
    tmp = CACHE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    tmp.replace(CACHE)

    print(f"Recorte completado:")
    print(f"  Sin cambios (ya estaban dentro de CABA): {sin_cambios}")
    print(f"  Modificadas (se les quitó algun segmento): {modificadas}")
    print(f"  Convertidas a punto (sin lineas en CABA): {sin_geom_restante}")
    print(f"  Eliminadas (completamente afuera):        {len(eliminadas)}")
    if eliminadas:
        print("    " + ", ".join(eliminadas[:10]))
    print(f"  Cache total: {len(cache)}")


if __name__ == "__main__":
    main()
