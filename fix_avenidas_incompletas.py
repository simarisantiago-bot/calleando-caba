"""
fix_avenidas_incompletas.py — Reconstruye la geometría de avenidas cuyo
trazado en el cache está incompleto (detectadas por _diag_avenidas.py).

Para cada una:
  1. Trae de OSM todos los ways del corredor con el nombre (con/sin "Avenida").
  2. Los agrupa por CONECTIVIDAD (ways que comparten un nodo = misma vía).
  3. Elige el componente conectado más cercano al trazado actual del cache
     (evita traer un homónimo desconectado, como Av. Belgrano centro vs sur).
  4. Si mejora (más largo) y está cerca del cache, actualiza el cache.

Uso: python fix_avenidas_incompletas.py
"""

import json
import math
import os
import time

import apply_overrides as a

CACHE = "data/geo_cache.json"

# ids a arreglar (del reporte avenidas_audit.txt)
OBJETIVO = [
    "suarez|calle",
    "chorroarin|avenida",
    "congreso|avenida",
    "avellaneda|avenida",
    "raul scalabrini ortiz|avenida",
    "san pedrito|avenida",
    "asamblea|avenida",
    "teniente general donato alvarez|avenida",
    "garcia del rio|avenida",
    "comodoro martin rivadavia|avenida",
    "cervino|avenida",
]


def largo_geom(geom):
    lns = [geom["coordinates"]] if geom["type"] == "LineString" else geom["coordinates"]
    return sum(math.hypot(ln[i + 1][1] - ln[i][1], ln[i + 1][0] - ln[i][0]) * 111320
               for ln in lns for i in range(len(ln) - 1))


def puntos_cache(geom):
    lns = [geom["coordinates"]] if geom["type"] == "LineString" else geom["coordinates"]
    return [(lat, lon) for ln in lns for lon, lat in ln]


def fetch_ways(nombres):
    s, w, n, e = a.CABA_BBOX
    partes = "".join(f'way["highway"]["name"="{nm}"]({s},{w},{n},{e});' for nm in nombres)
    data = a.overpass(f"[out:json][timeout:60];({partes});out geom;")
    time.sleep(0.6)
    if not data:
        return []
    return [el for el in data.get("elements", []) if el.get("type") == "way" and el.get("geometry")]


def componentes(ways):
    parent = list(range(len(ways)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[rx] = ry

    coord_idx = {}
    for i, wy in enumerate(ways):
        for p in wy["geometry"]:
            k = (round(p["lat"], 6), round(p["lon"], 6))
            if k in coord_idx:
                union(i, coord_idx[k])
            else:
                coord_idx[k] = i
    comps = {}
    for i in range(len(ways)):
        comps.setdefault(find(i), []).append(ways[i])
    return list(comps.values())


def dist_min(comp, cache_pts):
    """Distancia mínima (m) entre nodos del componente y del cache."""
    cn = [(p["lat"], p["lon"]) for wy in comp for p in wy["geometry"]]
    mind = 9e9
    for la, lo in cn:
        for cla, clo in cache_pts:
            d = math.hypot(la - cla, lo - clo)
            if d < mind:
                mind = d
    return mind * 111320


def main():
    calles = json.load(open("data/calles.json", encoding="utf-8"))
    cache = json.load(open(CACHE, encoding="utf-8"))
    byid = {c["id"]: c for c in calles}

    for id_ in OBJETIVO:
        c = byid.get(id_)
        v = cache.get(id_)
        if not c or not v or v.get("tipo") != "line":
            print(f"  SKIP {id_} (sin línea)")
            continue
        nombre = c["nombre_busqueda"]
        base = nombre
        for pre in ("Avenida General ", "Av. General ", "Avenida ", "Av. "):
            if base.startswith(pre):
                base = base[len(pre):]
                break
        nombres = {f"Avenida {base}", base, nombre}
        nombres = {nm.replace('"', "") for nm in nombres}

        ways = fetch_ways(nombres)
        if not ways:
            print(f"  {nombre}: sin ways OSM")
            continue
        comps = componentes(ways)
        cache_pts = puntos_cache(v["geometry"])
        # elegir el componente más cercano al trazado actual
        comps.sort(key=lambda comp: dist_min(comp, cache_pts))
        mejor = comps[0]
        d = dist_min(mejor, cache_pts)
        geo = a.ways_a_linea(mejor)
        if not geo:
            print(f"  {nombre}: no se pudo construir")
            continue
        nuevo = largo_geom(geo["geometry"])
        viejo = largo_geom(v["geometry"])
        # Seguridad: el componente elegido debe estar pegado al cache y mejorar.
        if d > 400:
            print(f"  {nombre}: componente más cercano a {d:.0f}m del cache -> REVISAR, no aplico")
            continue
        if nuevo < viejo * 1.05:
            print(f"  {nombre}: sin mejora ({viejo:.0f}->{nuevo:.0f}m), dejo como está")
            continue
        geo["source"] = "fix-avenida-incompleta"
        cache[id_] = geo
        print(f"  {nombre}: {v.get('ways')}w {viejo:.0f}m -> {geo['ways']}w {nuevo:.0f}m "
              f"(comps={len(comps)}, dist={d:.0f}m)")

    tmp = CACHE + ".tmp"
    json.dump(cache, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
    os.replace(tmp, CACHE)
    print("cache actualizado.")


if __name__ == "__main__":
    main()
