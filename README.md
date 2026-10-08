# GeoClean

Clean, reliable GIS layers from messy files. Upload shapefiles, GeoJSON, CSV, KML or GeoPackages, get a health report, and download one cleaned GeoPackage plus a change log.

## Features
- **Health report:** quality score and counts for invalid geometries, duplicate features, missing coordinates, CRS conflicts, duplicate attributes, overlapping polygons, null attributes and cross-file duplicates.
- **Staged workflow:** select files, review them, then click Start analysis. A Stop button cancels analysis or cleaning from the browser.
- **Fix Data:** repairs invalid geometries, drops empty and identical duplicate features (same geometry and attributes), infers a missing CRS from coordinate range, reprojects to EPSG:4326, and standardises field names.
- **Version merge:** layers sharing 80%+ of their geometry (e.g. `roads.shp`, `roads_final.shp`) are grouped and merged into one layer. The most complete version's attributes win, and a `source_layer` column is added.
- **Pages:** Home, New Project, Projects (history with downloads) and Settings (toggle each cleaning rule).
- **Map preview** with per-layer toggles.

## Stack
FastAPI, GeoPandas, pyogrio, Shapely 2 (backend). React, Vite, Leaflet (frontend).

## Run locally (PowerShell, one line at a time)
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --reload
```
In a second window:
```powershell
cd frontend
npm install
npm run dev
```
Open http://localhost:5173. The Vite dev server proxies `/api` to port 8000.

## Using it
1. Select files (a shapefile needs its `.shp`, `.dbf` and `.shx` together, or zip it). CSVs need lat/lon columns.
2. Click **Start analysis** and review the health report.
3. Click **Fix Data**, then download the GeoPackage and change log.

## API
- `POST /api/analyze` (multipart `files`): returns report, file list and map preview.
- `POST /api/clean/{job_id}` (optional JSON `geometry`, `duplicates`, `crs`, `fields`, `merge`): cleans and returns the change log.
- `GET /api/download/{job_id}/{gpkg|log}`

## Limitations
- Overlaps, duplicate attributes and nulls are reported, not auto-fixed.
- A projected CRS such as UTM cannot be guessed; that layer is left as-is and flagged.
- Version matching is geometry-based, so versions with edited shapes may not be grouped.
- Jobs live in memory and are lost on restart. There is no auth, and Stop cancels from the browser only; the server finishes the job.
- Large files need memory: use a bigger instance when hosting (Render needs a Dockerfile with `$PORT`).
