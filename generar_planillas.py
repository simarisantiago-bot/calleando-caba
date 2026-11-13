"""
generar_planillas.py — Arma una planilla de Excel por comuna para revisar las
fotos que la app resuelve por busqueda en vivo contra Wikipedia.

Cada fila trae la miniatura EMBEBIDA, el nombre, el barrio, lo que dice la
ficha y de que articulo sale la foto. La unica columna para completar es
VEREDICTO:

    ok                         la foto que tiene esta bien
    sin foto                   no corresponde ninguna -> isotipo de marca
    <link a Commons>           commons.wikimedia.org/wiki/File:...
    <link a Wikipedia>         es.wikipedia.org/wiki/...  (se resuelve su
                               imagen principal)

Dejar la celda vacia = sin decidir, no se toca la entrada.

La columna ID es la clave de cruce con calles.json: NO tocarla. Por eso la
planilla la genera este script en vez de armarse a mano — los nombres tienen
variantes (Piazzola/Piazzolla, "APELLIDO, NOMBRE", acentos, homonimos que se
distinguen solo por el tipo) y cualquier nombre tipeado que no matchee exacto
es una fila que despues no se puede aplicar.

Las miniaturas se bajan una sola vez a planillas/_thumbs/ (ignorado por git),
asi regenerar es gratis.

Uso:
    python generar_planillas.py            # las 15 comunas
    python generar_planillas.py 1          # solo la Comuna 1
    python generar_planillas.py 1 2 3      # varias

Despues de completarlas: python aplicar_planilla.py planillas/comuna_01.xlsx
"""

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from io import BytesIO
from pathlib import Path

import openpyxl
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from PIL import Image as PILImage

BASE = Path(__file__).parent
DATA = BASE / "data"
SALIDA = BASE / "planillas"
THUMBS = SALIDA / "_thumbs"

UA = {"User-Agent": "calleando-caba/1.0 (simarisantiago@gmail.com) planillas"}
ANCHO_MINIATURA = 120          # px; mantiene los archivos en pocos MB
ALTO_FILA = 96                 # puntos, para que la miniatura entre holgada

COLUMNAS = [
    ("ID", 30, "no tocar: es la clave de cruce"),
    ("FOTO", 18, "la que muestra el sitio hoy"),
    ("NOMBRE", 30, ""),
    ("TIPO", 16, ""),
    ("BARRIO", 18, ""),
    ("QUE DICE LA FICHA", 60, ""),
    ("DE QUE ARTICULO SALE", 30, ""),
    ("VEREDICTO", 34, "ok / sin foto / link a Commons o Wikipedia"),
]


def nombre_archivo(url):
    """Nombre local estable para cachear la miniatura."""
    return re.sub(r"[^a-zA-Z0-9._-]", "_", urllib.parse.urlparse(url).path)[-120:]


def bajar_miniatura(url):
    """Devuelve la ruta local de la miniatura, redimensionada. None si falla."""
    if not url:
        return None
    THUMBS.mkdir(parents=True, exist_ok=True)
    destino = THUMBS / (nombre_archivo(url) + ".jpg")
    if destino.exists():
        return destino
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=30) as r:
            crudo = r.read()
        img = PILImage.open(BytesIO(crudo))
        # JPEG no tiene canal alfa: sin aplanar sobre blanco, los escudos y
        # banderas con transparencia salen con el fondo en negro.
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            fondo = PILImage.new("RGB", img.size, (255, 255, 255))
            fondo.paste(img, mask=img.split()[-1])
            img = fondo
        else:
            img = img.convert("RGB")
        prop = ANCHO_MINIATURA / img.width
        img = img.resize((ANCHO_MINIATURA, max(1, int(img.height * prop))))
        # JPEG en vez de PNG: una foto en PNG pesa ~30 KB y en JPEG ~6 KB, y
        # con 1447 filas la diferencia es entre 40 MB y 9 MB de planillas.
        img.save(destino, "JPEG", quality=82, optimize=True)
        time.sleep(0.25)
        return destino
    except Exception as e:
        print(f"    [sin miniatura] {e.__class__.__name__}: {url[:70]}", flush=True)
        return None


def armar_planilla(comuna, filas):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = f"Comuna {comuna}"

    cab = Font(bold=True, color="FFFFFF")
    fondo = PatternFill("solid", fgColor="1A73E8")
    for i, (titulo, ancho, nota) in enumerate(COLUMNAS, 1):
        c = ws.cell(row=1, column=i, value=titulo)
        c.font = cab
        c.fill = fondo
        c.alignment = Alignment(vertical="center")
        ws.column_dimensions[get_column_letter(i)].width = ancho
    ws.row_dimensions[1].height = 22

    # Fila 2: instrucciones breves, visibles sin abrir ningun comentario.
    for i, (_, _, nota) in enumerate(COLUMNAS, 1):
        if nota:
            c = ws.cell(row=2, column=i, value=nota)
            c.font = Font(italic=True, size=9, color="5F6368")
            c.alignment = Alignment(vertical="center", wrap_text=True)
    ws.row_dimensions[2].height = 26

    # Lista desplegable en VEREDICTO sin bloquear el pegado de un link:
    # showErrorMessage=False deja escribir cualquier cosa igual.
    col_ver = get_column_letter(len(COLUMNAS))
    dv = DataValidation(type="list", formula1='"ok,sin foto"', allow_blank=True)
    dv.showErrorMessage = False
    ws.add_data_validation(dv)
    dv.add(f"{col_ver}3:{col_ver}{len(filas) + 2}")

    for n, r in enumerate(filas, start=3):
        ws.row_dimensions[n].height = ALTO_FILA
        ws.cell(row=n, column=1, value=r["id"])
        ws.cell(row=n, column=3, value=r["nombre"])
        ws.cell(row=n, column=4, value=(r["id"].split("|")[1] if "|" in r["id"] else ""))
        ws.cell(row=n, column=5, value=r.get("barrio") or "")
        ws.cell(row=n, column=6, value=(r.get("descripcion") or "")[:400])
        art = ws.cell(row=n, column=7, value=r.get("titulo") or "")
        if r.get("thumb"):
            art.hyperlink = r["thumb"]
            art.font = Font(color="1A73E8", underline="single")

        for col in (1, 3, 4, 5, 6, 7, 8):
            ws.cell(row=n, column=col).alignment = Alignment(
                vertical="center", wrap_text=(col == 6))

        ruta = bajar_miniatura(r.get("thumb"))
        if ruta:
            img = XLImage(str(ruta))
            # openpyxl mide en px; 96 pt de alto de fila ~ 128 px
            prop = min(120 / img.width, 124 / img.height)
            img.width = int(img.width * prop)
            img.height = int(img.height * prop)
            ws.add_image(img, f"B{n}")

        if n % 25 == 0:
            print(f"    {n - 2}/{len(filas)} filas", flush=True)

    ws.freeze_panes = "C3"
    ws.auto_filter.ref = f"A2:{col_ver}{len(filas) + 2}"

    SALIDA.mkdir(parents=True, exist_ok=True)
    destino = SALIDA / f"comuna_{comuna:02d}.xlsx"
    wb.save(destino)
    wb.close()
    return destino


def main():
    regs = json.load(open(DATA / "fotos_auditoria.json", encoding="utf-8"))
    pedidas = [int(a) for a in sys.argv[1:]] or list(range(1, 16))

    for comuna in pedidas:
        filas = [r for r in regs if r.get("comuna") == comuna]
        if not filas:
            print(f"Comuna {comuna}: sin entradas pendientes, se omite")
            continue
        # Por barrio y despues alfabetico: cada archivo es una zona, y adentro
        # se recorre barrio por barrio.
        filas.sort(key=lambda r: ((r.get("barrio") or "~").lower(),
                                  (r.get("nombre") or "").lower()))
        print(f"Comuna {comuna}: {len(filas)} filas")
        destino = armar_planilla(comuna, filas)
        mb = destino.stat().st_size / 1024 / 1024
        print(f"  -> {destino}  ({mb:.1f} MB)")


if __name__ == "__main__":
    main()
