import json, os, re, shutil, tempfile, uuid, zipfile
import numpy as np, shapely
import geopandas as gpd, pandas as pd
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from shapely.geometry import Point

app = FastAPI(title="GeoClean")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
JOBS = {}
TYPES = {".shp": "Shapefile", ".geojson": "GeoJSON", ".json": "GeoJSON", ".csv": "CSV", ".kml": "KML", ".gpkg": "GeoPackage"}
ISSUES = [("invalid", "Invalid geometries", "High"), ("dup_features", "Duplicate features", "Medium"),
          ("missing", "Missing coordinates", "Medium"), ("crs", "CRS conflicts", "Low"),
          ("dup_attrs", "Duplicate attributes", "Low"), ("overlaps", "Overlapping polygons", "Medium"),
          ("nulls", "Null attributes", "Low"), ("cross_dups", "Cross-file duplicates", "Medium")]


def read(path):
    if path.lower().endswith(".csv"):
        df = pd.read_csv(path)
        c = {k.lower(): k for k in df.columns}
        pick = lambda *n: next((c[k] for k in n if k in c), None)
        la, lo = pick("lat", "latitude", "y"), pick("lon", "lng", "long", "longitude", "x")
        if not (la and lo):
            raise ValueError("CSV needs lat/lon columns")
        x, y = pd.to_numeric(df[lo], errors="coerce"), pd.to_numeric(df[la], errors="coerce")
        geom = [Point(a, b) if pd.notna(a) and pd.notna(b) else None for a, b in zip(x, y)]
        return gpd.GeoDataFrame(df, geometry=geom, crs=4326)
    return gpd.read_file(path)


def guess_crs(g):
    geo = g.geometry
    b = geo[geo.notna() & ~geo.is_empty].total_bounds
    if pd.isna(b).any():
        return None
    if abs(b).max() <= 180:
        return 4326
    return 3857 if abs(b).max() > 1e6 else None  # UTM etc. can't be guessed safely


def stats(g):
    geo = g.geometry
    ok = geo.notna() & ~geo.is_empty
    v, attrs = geo[ok], g.drop(columns=g.geometry.name)
    s = {"features": len(g), "missing": int((~ok).sum()), "invalid": int((~v.is_valid).sum()),
         "dup_features": int(g[ok].drop(columns=g.geometry.name).assign(_g=v.to_wkb()).duplicated().sum()), "dup_attrs": int(attrs.duplicated().sum()),
         "nulls": int(attrs.isna().sum().sum()), "overlaps": 0}
    p = v[v.geom_type.isin(["Polygon", "MultiPolygon"])].make_valid()
    if len(p) > 1:
        i, j = p.sindex.query(p, predicate="overlaps")
        s["overlaps"] = int((i < j).sum())
    return s


def preview(g):
    g = g[g.geometry.notna() & ~g.geometry.is_empty][[g.geometry.name]]
    if g.crs is None:
        c = guess_crs(g)
        if not c:
            return None
        g = g.set_crs(c)
    g = g.to_crs(4326)
    if len(g) > 1500:
        g = g.sample(1500, random_state=0)
    return json.loads(g.to_json())


def sig(g):
    """Set of normalised geometry hashes (EPSG:4326, ~1 m grid) used to match layers across files."""
    c = g.crs or guess_crs(g)
    geo = g.geometry[g.geometry.notna() & ~g.geometry.is_empty]
    if not c or geo.empty:
        return None
    geo = geo.set_crs(c, allow_override=True).to_crs(4326)
    return set(shapely.to_wkb(shapely.normalize(shapely.set_precision(geo.to_numpy(), 1e-5, mode="pointwise"))))


def job(jid):
    if jid not in JOBS:
        raise HTTPException(404, "Unknown job")
    return JOBS[jid]


@app.post("/api/analyze")
async def analyze(files: list[UploadFile] = File(...)):
    jid = uuid.uuid4().hex[:12]
    d = os.path.join(tempfile.gettempdir(), "geoclean", jid)
    os.makedirs(d)
    for f in files:
        p = os.path.join(d, os.path.basename(f.filename))
        with open(p, "wb") as o:
            shutil.copyfileobj(f.file, o)
        if p.lower().endswith(".zip"):
            zipfile.ZipFile(p).extractall(d)
    entries, layers = [], {}
    for root, _, names in os.walk(d):
        for n in sorted(names):
            ext = os.path.splitext(n)[1].lower()
            if ext not in TYPES:
                continue
            p = os.path.join(root, n)
            e = {"name": n, "type": TYPES[ext], "size": os.path.getsize(p), "ok": True}
            try:
                layers[n] = read(p)
            except Exception as ex:
                e.update(ok=False, error=str(ex)[:120])
            entries.append(e)
    if not layers:
        raise HTTPException(400, "No readable GIS files found (shapefiles need .shp + .dbf + .shx together)")
    JOBS[jid] = {"dir": d, "layers": layers}
    st = {n: stats(g) for n, g in layers.items()}
    tot = {k: sum(s[k] for s in st.values()) for k in next(iter(st.values()))}
    crs = {n: (g.crs.to_epsg() if g.crs else guess_crs(g)) for n, g in layers.items()}
    common = max(set(crs.values()), key=list(crs.values()).count)
    tot["crs"] = sum(1 for n, g in layers.items() if g.crs is None or crs[n] != common)
    sigs = {}
    for nm, g in layers.items():
        try:
            sigs[nm] = sig(g)
        except Exception:
            sigs[nm] = None
    names = [x for x in sigs if sigs[x]]
    parent = {x: x for x in names}

    def find(x):
        while parent[x] != x:
            x = parent[x]
        return x
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            if len(sigs[a] & sigs[b]) / min(len(sigs[a]), len(sigs[b])) >= 0.8:
                parent[find(b)] = find(a)
    gm = {}
    for x in names:
        gm.setdefault(find(x), []).append(x)
    groups = []
    for ms in gm.values():
        if len(ms) > 1:
            dups = sum(len(sigs[x]) for x in ms) - len(set().union(*(sigs[x] for x in ms)))
            groups.append({"layers": ms, "duplicates": dups})
    tot["cross_dups"] = sum(x["duplicates"] for x in groups)
    JOBS[jid]["groups"] = groups
    n = max(tot["features"], 1)
    W = {"invalid": 25, "missing": 15, "dup_features": 10, "overlaps": 15, "dup_attrs": 5, "cross_dups": 10}
    pen = sum(w * min(1, 10 * tot[k] / n) for k, w in W.items())
    pen += 15 * min(1, tot["crs"] / len(layers)) + 5 * min(1, tot["nulls"] / (n * 3))
    prev = []
    for name, g in layers.items():
        try:
            gj = preview(g)
            if gj:
                prev.append({"name": name, "geojson": gj})
        except Exception:
            pass
    return {"job_id": jid, "files": entries, "preview": prev,
            "report": {"score": max(0, round(100 - pen)), "layers": len(layers), "groups": groups,
                       "issues": [{"key": k, "label": l, "severity": s, "found": tot[k]} for k, l, s in ISSUES]}}


@app.post("/api/clean/{jid}")
def clean(jid: str, opts: dict | None = None):
    j = job(jid)
    o = {"geometry": True, "duplicates": True, "crs": True, "fields": True, "merge": True, **(opts or {})}
    out, log, rin, rout = os.path.join(j["dir"], "geoclean_output.gpkg"), [], 0, 0
    if os.path.exists(out):
        os.remove(out)
    done = {}
    for n, g in j["layers"].items():
        g, rin = g.copy(), rin + len(g)
        if g.crs is None:
            c = guess_crs(g)
            if c:
                g = g.set_crs(c)
                log.append(f"{n}: CRS missing, assigned EPSG:{c} from coordinate range")
            else:
                log.append(f"{n}: CRS unknown and not inferable, left unprojected (set it manually)")
        k = g.geometry.notna() & ~g.geometry.is_empty
        if (~k).sum():
            g = g[k]
            log.append(f"{n}: removed {int((~k).sum())} rows with missing/empty geometry")
        if o["crs"] and g.crs is not None and g.crs.to_epsg() != 4326:
            g = g.to_crs(4326)
            log.append(f"{n}: reprojected to EPSG:4326")
        if o["geometry"]:
            bad = ~g.geometry.is_valid
            if bad.sum():
                g.loc[bad, g.geometry.name] = g.geometry[bad].make_valid()
                log.append(f"{n}: repaired {int(bad.sum())} invalid geometries")
        if o["duplicates"]:
            dup = g.drop(columns=g.geometry.name).assign(_g=g.geometry.to_wkb()).duplicated()
            if dup.sum():
                g = g[~dup]
                log.append(f"{n}: removed {int(dup.sum())} identical duplicate features (same geometry and attributes)")
        if o["fields"]:
            seen, ren = {}, {}
            for c in g.columns:
                if c == g.geometry.name:
                    continue
                b = re.sub(r"\W+", "_", str(c).strip().lower()).strip("_") or "field"
                seen[b] = seen.get(b, 0) + 1
                ren[c] = b if seen[b] == 1 else f"{b}_{seen[b] - 1}"
            if any(a != b for a, b in ren.items()):
                g = g.rename(columns=ren)
                log.append(f"{n}: standardised field names (lowercase, underscores)")
        done[n] = g
    if o["merge"]:
        for grp in j.get("groups", []):
            ms = [x for x in grp["layers"] if x in done]
            if len({str(done[x].crs) for x in ms}) > 1:
                log.append(f"Skipped merging {', '.join(ms)}: layers use different CRS (enable reprojection)")
                continue

            def comp(x):
                a = done[x].drop(columns=done[x].geometry.name)
                return 1 - a.isna().to_numpy().mean() if a.size else 1
            ms.sort(key=comp)  # most complete layer last, so its attributes win
            parts = [done[x].assign(source_layer=x) for x in ms]
            m = pd.concat(parts, ignore_index=True)
            m = gpd.GeoDataFrame(m, geometry=parts[0].geometry.name, crs=parts[0].crs)
            keys = shapely.to_wkb(shapely.normalize(shapely.set_precision(m.geometry.to_numpy(), 1e-5, mode="pointwise")))
            idx = np.concatenate([[i] * len(p) for i, p in enumerate(parts)])
            m2 = m[pd.Series(idx).groupby(keys).transform("max").to_numpy() == idx]
            base = os.path.commonprefix([os.path.splitext(x)[0] for x in ms]).rstrip("_- .")
            name = f"{base}_merged" if base else "merged"
            for x in ms:
                done.pop(x)
            done[name + ".gpkg"] = m2
            log.append(f"Merged {len(ms)} versions of one layer ({', '.join(ms)}) into '{name}': {len(m):,} -> {len(m2):,} features; attributes taken from '{ms[-1]}' (most complete); source_layer column added")
    used = set()
    for k, g in done.items():
        ln, i = os.path.splitext(k)[0], 1
        while ln in used:
            i += 1
            ln = f"{os.path.splitext(k)[0]}_{i}"
        used.add(ln)
        g.to_file(out, layer=ln, driver="GPKG")
        rout += len(g)
    log.append("Overlapping polygons, duplicate attributes and null attributes are reported only, not auto-fixed.")
    with open(os.path.join(j["dir"], "changelog.txt"), "w") as f:
        f.write("\n".join(log))
    return {"summary": {"layers": len(j["layers"]), "rows_in": rin, "rows_out": rout}, "changelog": log,
            "downloads": {"gpkg": f"/api/download/{jid}/gpkg", "log": f"/api/download/{jid}/log"}}


@app.get("/api/download/{jid}/{kind}")
def download(jid: str, kind: str):
    names = {"gpkg": "geoclean_output.gpkg", "log": "changelog.txt"}
    if kind not in names:
        raise HTTPException(404)
    p = os.path.join(job(jid)["dir"], names[kind])
    if not os.path.exists(p):
        raise HTTPException(404, "Run cleaning first")
    return FileResponse(p, filename=names[kind])