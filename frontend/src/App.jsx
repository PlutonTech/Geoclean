import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Home, PlusCircle, Folder, Settings, UploadCloud, AlertTriangle, CheckCircle2, XCircle, Sparkles, ArrowRight, Info, ChevronDown, Download, Loader2 } from "lucide-react";
import "./styles.css";

const COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0d9488", "#dc2626", "#64748b"];
const DOT = { invalid: "#dc2626", dup_features: "#ea580c", missing: "#f59e0b", crs: "#2563eb", dup_attrs: "#9333ea", overlaps: "#0d9488", nulls: "#64748b" };
const CUR = { idle: 0, analysing: 0, ready: 1, cleaning: 2, done: 4 };
const STEPS = ["Upload", "Analyse", "Clean", "Download"];
const mb = (b) => (b / 1048576).toFixed(1) + " MB";
const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
};

const Logo = ({ size = 44 }) => (
  <svg width={size} height={size} viewBox="0 0 44 46">
    <path d="M22 24 40 34 22 44 4 34z" fill="#16a34a" /><path d="M22 14 40 24 22 34 4 24z" fill="#2563eb" /><path d="M22 4 40 14 22 24 4 14z" fill="#38bdf8" />
  </svg>
);

function Preview({ layers, hidden }) {
  const el = useRef(), map = useRef(), grp = useRef(), fit = useRef();
  useEffect(() => {
    map.current = L.map(el.current, { zoomControl: false }).setView([9, 8], 5);
    L.control.zoom({ position: "topright" }).addTo(map.current);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap" }).addTo(map.current);
    grp.current = L.featureGroup().addTo(map.current);
    return () => map.current.remove();
  }, []);
  useEffect(() => {
    grp.current.clearLayers();
    layers.forEach((l, i) => {
      const color = COLORS[i % 7];
      if (!hidden[l.name]) L.geoJSON(l.geojson, { style: { color, weight: 2, fillOpacity: 0.15 }, pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 3, color }) }).addTo(grp.current);
    });
    const b = grp.current.getBounds();
    if (fit.current !== layers && b.isValid()) { fit.current = layers; map.current.fitBounds(b); }
  }, [layers, hidden]);
  return <div ref={el} className="map" />;
}

export default function App() {
  const [phase, setPhase] = useState("idle");
  const [files, setFiles] = useState([]);
  const [report, setReport] = useState(null);
  const [prev, setPrev] = useState([]);
  const [job, setJob] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState({});
  const [drag, setDrag] = useState(false);
  const input = useRef();
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const [view, setView] = useState("home");
  const [settings, setSettings] = useState(() => load("gc_settings", { geometry: true, duplicates: true, crs: true, fields: true }));
  const [projects, setProjects] = useState(() => load("gc_projects", []));
  const [name, setName] = useState("Untitled project");
  const [draft, setDraft] = useState("");
  useEffect(() => { localStorage.setItem("gc_settings", JSON.stringify(settings)); }, [settings]);
  useEffect(() => { localStorage.setItem("gc_projects", JSON.stringify(projects)); }, [projects]);
  const reset = (n) => { setPhase("idle"); setFiles([]); setReport(null); setPrev([]); setResult(null); setError(""); setName(n || "Untitled project"); setPending([]); setDraft(""); setView("home"); };

  const [pending, setPending] = useState([]);
  const ctrl = useRef();
  const add = (list) => setPending((p) => { const m = new Map(p.map((f) => [f.name, f])); [...list].forEach((f) => m.set(f.name, f)); return [...m.values()]; });
  const stop = () => ctrl.current?.abort();
  const upload = async () => {
    if (!pending.length) return;
    setPhase("analysing"); setError(""); setResult(null); setFiles([]); setReport(null); setPrev([]);
    ctrl.current = new AbortController();
    const fd = new FormData();
    pending.forEach((f) => fd.append("files", f));
    try {
      const d = await api("/api/analyze", { method: "POST", body: fd, signal: ctrl.current.signal });
      setJob(d.job_id); setFiles(d.files); setReport(d.report); setPrev(d.preview); setHidden({}); setPending([]); setPhase("ready");
    } catch (e) { if (e.name !== "AbortError") setError(e.message); setPhase("idle"); }
  };
  const clean = async () => {
    setPhase("cleaning"); setError(""); ctrl.current = new AbortController();
    try {
      const r = await api(`/api/clean/${job}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings), signal: ctrl.current.signal });
      setResult(r); setPhase("done");
      setProjects((p) => [{ id: job, name, date: new Date().toLocaleString(), files: files.length, score, rows_in: r.summary.rows_in, rows_out: r.summary.rows_out, downloads: r.downloads }, ...p]);
    }
    catch (e) { if (e.name !== "AbortError") setError(e.message); setPhase("ready"); }
  };

  const cur = CUR[phase];
  const score = report?.score ?? 0;
  const col = score < 50 ? "#dc2626" : score < 75 ? "#f97316" : "#16a34a";
  const C = 2 * Math.PI * 70;
  const types = report ? report.issues.filter((i) => i.found > 0).length : 0;

  return (
    <div className="app">
      <aside>
        <div className="brand"><Logo /><div><b>GeoClean</b><small>Clean Data. Better Maps.</small></div></div>
        <nav>{[[Home, "Home", "home"], [PlusCircle, "New Project", "new"], [Folder, "Projects", "projects"], [Settings, "Settings", "settings"]].map(([I, t, v]) => (
          <a key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}><I size={20} />{t}</a>))}</nav>
        <div className="help"><Info size={18} color="#2563eb" /><b> Need help?</b><p>Check our documentation for file formats and tips.</p>
          <a href="https://gdal.org/drivers/vector/" target="_blank" rel="noreferrer">View docs →</a></div>
      </aside>
      <main>
        <header><div className="av">AO</div>Amara O.<ChevronDown size={16} /></header>
        {view === "home" && <div className="grid">
          <section>
            <div className="hero">
              <div><small className="muted">Project: {name}</small><h1>Turn messy GIS data into clean, reliable layers</h1>
                <p>Upload your spatial files and let GeoClean find and fix common GIS issues automatically.</p></div>
              <Logo size={130} />
            </div>
            <div className="card">
              <div className="steps">{STEPS.map((s, i) => (
                <div key={s} className={"step " + (i < cur ? "done" : i === cur ? "on" : "")}><i>{i < cur ? "✓" : i + 1}</i>{s}</div>))}</div>
              <h2>GIS Health Report</h2>
              {!report ? (
                <p className="muted">{phase === "analysing" ? "Analysing your files…" : "Upload files to see your health report."}</p>
              ) : (<>
                <div className="sum">
                  <div className="donut">
                    <svg width="170" height="170" viewBox="0 0 170 170"><circle cx="85" cy="85" r="70" fill="none" stroke="#e8edf4" strokeWidth="14" />
                      <circle cx="85" cy="85" r="70" fill="none" stroke={col} strokeWidth="14" strokeLinecap="round" strokeDasharray={`${(score / 100) * C} ${C}`} transform="rotate(-90 85 85)" /></svg>
                    <div><b>{score}%</b><span>Overall quality</span></div>
                  </div>
                  <div className="note"><b><AlertTriangle size={18} color="#f59e0b" /> {types ? "Your data has some issues" : "Your data looks clean"}</b>
                    <p>We found {types} types of issues across {report.layers} layers. You can review the details below or let us fix them automatically.</p></div>
                </div>
                <div className="tbl">
                  <div className="tr th"><span>Issue</span><span>Found</span><span>Severity</span></div>
                  {report.issues.map((i) => (
                    <div className="tr" key={i.key}><span><u style={{ background: DOT[i.key] }} />{i.label}</span><span>{i.found.toLocaleString()}</span>
                      <span><em className={i.severity}>{i.severity}</em></span></div>))}
                </div>
                <div className="fix">
                  <Sparkles size={18} color="#2563eb" />
                  <div><b>{phase === "done" ? "Cleaning complete" : "Fix these issues automatically"}</b>
                    <p>{phase === "done" ? `${result.summary.rows_in.toLocaleString()} → ${result.summary.rows_out.toLocaleString()} features across ${result.summary.layers} layers.`
                      : "GeoClean can repair geometries, remove duplicates, detect CRS, reproject layers, standardize fields and more."}</p></div>
                  {phase === "done" ? (
                    <div className="dl"><a className="btn" href={result.downloads.gpkg}><Download size={15} /> GeoPackage</a><a className="btn ghost" href={result.downloads.log}>Change log</a></div>
                  ) : (
                    <div className="dl"><button className="btn" disabled={phase !== "ready"} onClick={clean}>
                      {phase === "cleaning" ? <><Loader2 size={15} className="spin" /> Cleaning…</> : <>Fix Data <ArrowRight size={15} /></>}</button>{phase === "cleaning" && <button className="btn stop" onClick={stop}>Stop</button>}</div>)}
                </div>
                {phase === "done" && <ul className="log">{result.changelog.map((c, i) => <li key={i}>{c}</li>)}</ul>}
              </>)}
            </div>
          </section>
          <section>
            <div className={"drop" + (drag ? " over" : "")} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}>
              <UploadCloud size={38} color="#2563eb" /><b>Upload your GIS files</b>
              <span>Drag and drop files here or click to browse</span>
              <small>Supports Shapefile (.shp + .dbf + .shx, or .zip), GeoJSON, CSV, KML, GeoPackage.</small>
              <button className="btn" onClick={() => input.current.click()}>Select Files</button>
              <input ref={input} type="file" multiple hidden accept=".shp,.dbf,.shx,.prj,.cpg,.geojson,.json,.csv,.kml,.gpkg,.zip" onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
            </div>
            {pending.length > 0 && (
              <div className="card">
                <div className="row"><h3>Selected Files ({pending.length})</h3></div>
                {pending.map((f) => (
                  <div className="file" key={f.name}><div><b>{f.name}</b><small>{mb(f.size)}</small></div>
                    <button className="btn ghost" disabled={phase === "analysing"} onClick={() => setPending(pending.filter((x) => x !== f))}>Remove</button></div>))}
                <div className="dl" style={{ marginTop: 12 }}>
                  {phase === "analysing" ? <><button className="btn" disabled><Loader2 size={15} className="spin" /> Analysing…</button><button className="btn stop" onClick={stop}>Stop</button></>
                    : <><button className="btn" disabled={phase === "cleaning"} onClick={upload}>Start analysis</button><button className="btn ghost" onClick={() => setPending([])}>Clear</button></>}
                </div>
              </div>)}
            {files.length > 0 && (
              <div className="card">
                <div className="row"><h3>Input Files ({files.length})</h3>{new Set(files.map((f) => f.type)).size > 1 && <em className="low">Multiple formats</em>}</div>
                {files.map((f, k) => (
                  <div className="file" key={f.name}><span className="fi" style={{ background: COLORS[k % 7] }}>{f.type[0]}</span>
                    <div><b>{f.name}</b><small>{f.ok ? `${f.type} · ${mb(f.size)}` : f.error}</small></div>
                    {f.ok ? <CheckCircle2 size={18} color="#16a34a" /> : <XCircle size={18} color="#dc2626" />}</div>))}
              </div>)}
            <div className="card">
              <h3>Data Preview</h3>
              <div className="mapbox">
                {prev.length > 0 && <div className="layers"><small>Layers</small>{prev.map((l) => (
                  <label key={l.name}><input type="checkbox" checked={!hidden[l.name]} onChange={() => setHidden({ ...hidden, [l.name]: !hidden[l.name] })} />{l.name}</label>))}</div>}
                <Preview layers={prev} hidden={hidden} />
              </div>
            </div>
            {error && <div className="status err"><XCircle color="#dc2626" /><div><b>Something went wrong</b><p>{error}</p></div></div>}
            {!error && (phase === "ready" || phase === "done") && (
              <div className="status"><CheckCircle2 color="#16a34a" /><div><b>{phase === "done" ? "Cleaning complete" : "Ready to clean"}</b>
                <p>{phase === "done" ? "Download your cleaned GeoPackage and change log." : "Your data is analysed. Click Fix Data to start the cleaning process."}</p></div></div>)}
          </section>
        </div>}
        {view === "new" && (
          <div className="page"><div className="card"><h2>New Project</h2>
            <p className="muted">Start a fresh cleaning run. Earlier results stay under Projects.</p>
            <input className="txt" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Project name" />
            <button className="btn" onClick={() => reset(draft.trim())}>Create project</button></div></div>)}
        {view === "projects" && (
          <div className="page"><div className="card"><div className="row"><h2>Projects</h2>{projects.length > 0 && <button className="btn ghost" onClick={() => setProjects([])}>Clear all</button>}</div>
            {!projects.length ? <p className="muted">No completed projects yet. Clean some files and they will appear here.</p> : projects.map((p) => (
              <div className="file" key={p.id}><div><b>{p.name}</b><small>{p.date} · {p.files} files · quality {p.score}% · {p.rows_in.toLocaleString()} → {p.rows_out.toLocaleString()} features</small></div>
                <a className="btn ghost" href={p.downloads.gpkg}>GeoPackage</a><a className="btn ghost" href={p.downloads.log}>Log</a>
                <button className="btn ghost" onClick={() => setProjects(projects.filter((x) => x.id !== p.id))}>Delete</button></div>))}
            <p className="muted"><small>Downloads work while the backend is running; results are cleared when it restarts.</small></p></div></div>)}
        {view === "settings" && (
          <div className="page"><div className="card"><h2>Settings</h2><h3>Cleaning rules</h3>
            {[["geometry", "Repair invalid geometries"], ["duplicates", "Remove identical duplicate features"], ["crs", "Reproject to EPSG:4326"], ["fields", "Standardise field names"]].map(([k, l]) => (
              <label className="opt" key={k}><input type="checkbox" checked={settings[k]} onChange={() => setSettings({ ...settings, [k]: !settings[k] })} />{l}</label>))}
            <p className="muted"><small>Applied the next time you click Fix Data.</small></p></div></div>)}
      </main>
    </div>
  );
}