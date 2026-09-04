/* NEURAL CORTEX MAP — force-graph rendered as an AI "brain": a glowing brain
   silhouette behind the nodes, synaptic-firing pulses along links, breathing
   neurons, and live telemetry HUD panels on both sides. */

import { useEffect, useMemo, useRef, useState } from "react";
import { api, agentTextClass, type ActivityRow, type GraphData } from "../lib/api";
import { useStore } from "../lib/store";

interface SimNode {
  id: string;
  title: string;
  size: number; // degree
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  pinned: boolean;
}

interface Pulse {
  a: number;
  b: number;
  t: number;
  speed: number;
}



// Constants requested by dispatch
const CORTEX_DENSITY = 8000;
const SHELL_BIAS = 5;
const SULCUS_DEPTH = 0.05;
const RIM_INTENSITY = 1.5;
const FIRING_INTERVAL = 4000;

const BRAIN_OUTLINE = [
  [-0.95, 0.10], [-0.92, 0.32], [-0.85, 0.52], [-0.72, 0.68],
  [-0.55, 0.82], [-0.35, 0.92], [-0.12, 0.97], [ 0.10, 0.96],
  [ 0.32, 0.90], [ 0.52, 0.80], [ 0.68, 0.66], [ 0.80, 0.50],
  [ 0.88, 0.32], [ 0.92, 0.14], [ 0.90,-0.02], [ 0.80,-0.12],
  [ 0.66,-0.16], [ 0.50,-0.22], [ 0.34,-0.30], [ 0.18,-0.40],
  [-0.02,-0.50], [-0.22,-0.54], [-0.40,-0.50], [-0.52,-0.40],
  [-0.58,-0.26], [-0.48,-0.16], [-0.40,-0.08], [-0.56,-0.02],
  [-0.72,-0.02], [-0.86, 0.02]
].map(p => [p[0] * 1.30, p[1]]);

function pointInPolygon(x: number, y: number, poly: number[][]) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) ins = !ins;
  }
  return ins;
}

function halfWidth(x: number, y: number) {
  return 0.40 * (1 - 0.55 * x * x) * (0.70 + 0.30 * (y + 1) / 2);
}

const MESH_MAX_SEGMENTS = 6000;
const SWEEP_PERIOD_MS = 6000;
const LOCK_ANIM_MS = 300;
const MOUSE_TILT_MAX = { yaw: 25 * Math.PI / 180, pitch: 15 * Math.PI / 180 };
const PROBE_RADIUS = 100;

const GLOBAL_BRAIN = (() => {
  const pts = [];
  while (pts.length < CORTEX_DENSITY) {
    let x = (Math.random() - 0.5) * 2.5;
    let y = (Math.random() - 0.5) * 2.5;

    let inCerebrum = pointInPolygon(x, y, BRAIN_OUTLINE);
    let inCerebellum = false;
    let inStem = false;

    const cx = 0.72 * 1.30, cy = -0.34;
    const rx = 0.26, ry = 0.20;
    const t = -0.2;
    const dx = x - cx, dy = y - cy;
    const tx = dx * Math.cos(t) - dy * Math.sin(t);
    const ty = dx * Math.sin(t) + dy * Math.cos(t);
    if ((tx*tx)/(rx*rx) + (ty*ty)/(ry*ry) <= 1) inCerebellum = true;

    const sx1 = 0.30, sy1 = -0.40, w1 = 0.10;
    const sx2 = 0.24, sy2 = -0.62, w2 = 0.05;
    const l2 = (sx2-sx1)*(sx2-sx1) + (sy2-sy1)*(sy2-sy1);
    let t_s = Math.max(0, Math.min(1, ((x - sx1)*(sx2 - sx1) + (y - sy1)*(sy2 - sy1)) / l2));
    const projX = sx1 + t_s * (sx2 - sx1);
    const projY = sy1 + t_s * (sy2 - sy1);
    if ((x - projX)*(x - projX) + (y - projY)*(y - projY) <= Math.pow(w1 + t_s * (w2 - w1), 2) && y <= sy1) inStem = true;

    if (!inCerebrum && !inCerebellum && !inStem) continue;
    if (inCerebrum && !inCerebellum && !inStem && Math.random() > 0.5) continue; // increase relative density of cerebellum

    let hw = halfWidth(x, y);
    if (inCerebellum) hw *= 0.9;
    if (inStem) hw *= 0.6;
    
    let u = 1 - Math.pow(Math.random(), SHELL_BIAS);
    let z = (Math.random() > 0.5 ? 1 : -1) * hw * Math.sqrt(Math.max(0, 1 - u*u));

    let wave = Math.sin(x*15 + z*8) + Math.sin(y*18 + x*6) + Math.sin(z*15 + y*8);
    let shift = 1 + wave * SULCUS_DEPTH;
    x *= shift; y *= shift; z *= shift;

    let nx = x, ny = y, nz = z;
    let nl = Math.sqrt(nx*nx + ny*ny + nz*nz);
    if (nl > 0) { nx /= nl; ny /= nl; nz /= nl; }

    pts.push({
      x: x * 350,
      y: -y * 350,
      z: z * 350,
      nx, ny, nz,
      isGyrus: wave > 0,
      wave: wave,
      flicker: Math.random() * Math.PI * 2
    });
  }

  const links = [];
  const cellSize = 50;
  const grid = new Map();
  const hash = (x: number, y: number, z: number) => `${Math.floor(x/cellSize)},${Math.floor(y/cellSize)},${Math.floor(z/cellSize)}`;
  
  for (let i = 0; i < pts.length; i++) {
    const h = hash(pts[i].x, pts[i].y, pts[i].z);
    if (!grid.has(h)) grid.set(h, []);
    grid.get(h).push(i);
  }
  
  // We want links distributed evenly.
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const cx = Math.floor(p.x/cellSize);
    const cy = Math.floor(p.y/cellSize);
    const cz = Math.floor(p.z/cellSize);
    let neighbors = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const h = `${cx+dx},${cy+dy},${cz+dz}`;
          if (grid.has(h)) {
            for (const j of grid.get(h)) {
              if (j > i) {
                const dx2 = p.x - pts[j].x;
                const dy2 = p.y - pts[j].y;
                const dz2 = p.z - pts[j].z;
                if (dx2*dx2 + dy2*dy2 + dz2*dz2 < cellSize*cellSize) {
                  neighbors.push({j, d: dx2*dx2 + dy2*dy2 + dz2*dz2});
                }
              }
            }
          }
        }
      }
    }
    neighbors.sort((a,b) => a.d - b.d);
    const limit = Math.min(2 + Math.floor(Math.random() * 2), neighbors.length);
    for (let k = 0; k < limit; k++) {
      links.push({ a: i, b: neighbors[k].j });
    }
  }

  return { pts, links };
})();

const REPULSION = 6500;
const SPRING_K = 0.015;
const SPRING_REST = 120;
const CENTER_PULL = 0.004;
const DAMPING = 0.85;

export default function GraphView() {
  const { vaultTick, activityTick, syncTick, notes, openNote, pushError } = useStore();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [counts, setCounts] = useState({ nodes: 0, links: 0 });
  const [hubs, setHubs] = useState<{ id: string; title: string; size: number }[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);

  const simRef = useRef<{
    nodes: SimNode[];
    edges: { a: number; b: number }[];
    byId: Map<string, number>;
    neighbors: Map<number, Set<number>>;
    pulses: Pulse[];
    lastPulse: number;
    time: number;
    alpha: number;
    hover: number;
    drag: number;
    dragMoved: boolean;
    yaw: number;
    pitch: number;
    vYaw: number;
    vPitch: number;
    targetYaw: number;
    targetPitch: number;
    zoom: number;
    targetZoom: number;
    idleFrames: number;
    isRotating: boolean;
    lastActivityTs: number;
    hoverStartTs: number;
    nodeClusters: string[];
    maxLinks: number;
    hasInteracted: boolean;
    lastMouseX: number;
    lastMouseY: number;
    pNodes: { i: number; sx: number; sy: number; scale: number; z: number }[];
    raf: number;
    w: number;
    h: number;
    activeBrainPoints: number;
    avgFrameTime: number;
    loggedDrawError: boolean;
    fitAdj: number;
    neighborCache: Uint8Array;
    frameCount: number;
    forceCache: boolean;
  }>({
    nodes: [],
    edges: [],
    byId: new Map(),
    neighbors: new Map(),
    pulses: [],
    lastPulse: 0,
    time: 0,
    alpha: 1,
    hover: -1,
    drag: -1,
    dragMoved: false,
    yaw: 0,
    pitch: 0,
    vYaw: 0,
    vPitch: 0,
    targetYaw: 0,
    targetPitch: 0,
    zoom: 1,
    targetZoom: 1,
    idleFrames: 0,
    isRotating: false,
    lastActivityTs: 0,
    hoverStartTs: 0,
    nodeClusters: [],
    maxLinks: 0,
    hasInteracted: false,
    lastMouseX: 0,
    lastMouseY: 0,
    pNodes: [],
    raf: 0,
    w: 0,
    h: 0,
    activeBrainPoints: 4000,
    avgFrameTime: 16,
    loggedDrawError: false,
    fitAdj: 1,
    neighborCache: new Uint8Array(CORTEX_DENSITY),
    frameCount: 0,
    forceCache: false,
  });

  /* clusters: notes grouped by top-level folder */
  const clusters = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) {
      const seg = n.path.includes("/") ? n.path.split("/")[0] : "· root";
      m.set(seg, (m.get(seg) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [notes]);

  const density = counts.nodes > 0 ? (counts.links / counts.nodes).toFixed(2) : "0.00";
  const activeMinds = useMemo(
    () => new Set(activity.map((a) => (a.agent || "system").toLowerCase())).size,
    [activity]
  );

  /* load graph data */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const g: GraphData = await api.graph();
        if (!alive) return;
        const s = simRef.current;
        const prev = new Map(s.nodes.map((n) => [n.id, n]));
        const cx = s.w / 2 || 400;
        const cy = s.h / 2 || 300;
        s.byId = new Map(g.nodes.map((n, i) => [n.id, i]));
        s.nodes = g.nodes.map((n, i) => {
          const old = prev.get(n.id);
          const angle = (i / Math.max(1, g.nodes.length)) * Math.PI * 2;
          const rad = 120 + (i % 5) * 40;
          return {
            id: n.id,
            title: n.title,
            size: n.size,
            x: old ? old.x : cx + Math.cos(angle) * rad + (Math.random() - 0.5) * 40,
            y: old ? old.y : cy + Math.sin(angle) * rad + (Math.random() - 0.5) * 40,
            z: old ? old.z : (Math.random() - 0.5) * 400,
            vx: 0,
            vy: 0,
            vz: 0,
            r: Math.max(4, Math.min(14, 4 + n.size * 1.6)),
            pinned: false,
          };
        });
        s.edges = g.edges
          .map((e) => ({ a: s.byId.get(e.source) ?? -1, b: s.byId.get(e.target) ?? -1 }))
          .filter((e) => e.a >= 0 && e.b >= 0 && e.a !== e.b);
        s.neighbors = new Map();
        for (const e of s.edges) {
          if (!s.neighbors.has(e.a)) s.neighbors.set(e.a, new Set());
          if (!s.neighbors.has(e.b)) s.neighbors.set(e.b, new Set());
          s.neighbors.get(e.a)!.add(e.b);
          s.neighbors.get(e.b)!.add(e.a);
        }
        s.pulses = [];
        // Reset interaction state: the node array was just replaced, so any
        // hover/drag index from the old graph is now stale (out of range).
        s.hover = -1;
        s.nodeClusters = g.nodes.map(n => {
          const note = notes.find(x => x.path === n.id);
          const path = note ? note.path : "";
          return path.includes("/") ? path.split("/")[0] : "· root";
        });
        let maxL = 0;
        for (const [id, set] of s.neighbors.entries()) {
          if (set.size > maxL) maxL = set.size;
        }
        s.maxLinks = maxL;
        s.drag = -1;
        s.dragMoved = false;
        s.alpha = 1;
        setCounts({ nodes: g.nodes.length, links: g.edges.length });
        setHubs(
          [...g.nodes]
            .sort((a, b) => b.size - a.size)
            .slice(0, 6)
            .filter((n) => n.size > 0)
            .map((n) => ({ id: n.id, title: n.title, size: n.size }))
        );
      } catch (e) {
        pushError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [vaultTick, pushError]);

  /* recent activity feed */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rows = await api.activity(12);
        if (alive) setActivity(rows);
      } catch {
        /* non-fatal for HUD */
      }
    })();
    return () => {
      alive = false;
    };
  }, [activityTick, vaultTick]);

  useEffect(() => {
    if (simRef.current) {
      simRef.current.lastActivityTs = performance.now();
    }
  }, [activityTick]);

  /* sim + render loop + interaction */
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext("2d")!;
    const s = simRef.current;
    let stopped = false;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      s.w = rect.width;
      s.h = rect.height;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = rect.width + "px";
      canvas.style.height = rect.height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      s.alpha = Math.max(s.alpha, 0.3);
      s.forceCache = true;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const step = () => {
      const { nodes, edges } = s;
      const cx = s.w / 2;
      const cy = s.h / 2;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let dz = a.z - b.z;
          let d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 1) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            dz = Math.random() - 0.5;
            d2 = 1;
          }
          const f = (REPULSION / d2) * s.alpha;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          const fz = (dz / d) * f;
          a.vx += fx;
          a.vy += fy;
          a.vz += fz;
          b.vx -= fx;
          b.vy -= fy;
          b.vz -= fz;
        }
      }
      for (const e of edges) {
        const a = nodes[e.a];
        const b = nodes[e.b];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const f = (d - SPRING_REST) * SPRING_K * s.alpha;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        const fz = (dz / d) * f;
        a.vx += fx;
        a.vy += fy;
        a.vz += fz;
        b.vx -= fx;
        b.vy -= fy;
        b.vz -= fz;
      }
      for (const n of nodes) {
        n.vx += (cx - n.x) * CENTER_PULL * s.alpha;
        n.vy += (cy - n.y) * CENTER_PULL * s.alpha;
        n.vz += (0 - n.z) * CENTER_PULL * s.alpha;
        n.vx *= DAMPING;
        n.vy *= DAMPING;
        n.vz *= DAMPING;
        if (!n.pinned) {
          n.x += n.vx;
          n.y += n.vy;
          n.z += n.vz;
        }
      }
      s.alpha = Math.max(0, s.alpha * 0.995 - 0.0004);
    };



    const spawnPulse = () => {
      if (s.edges.length === 0) return;
      const e = s.edges[(Math.random() * s.edges.length) | 0];
      s.pulses.push({ a: e.a, b: e.b, t: 0, speed: 0.012 + Math.random() * 0.02 });
      if (s.pulses.length > 40) s.pulses.shift();
    };

    const draw = () => {
      s.frameCount++;
      const isNeighborUpdate = s.frameCount % 4 === 0 || s.forceCache;
      s.forceCache = false;
      let meshDrawnCount = 0;
      try {
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, s.w, s.h);
      const { nodes, edges, hover, zoom } = s;
      const hoverSet = hover >= 0 ? (s.neighbors.get(hover) ?? new Set<number>()) : null;

      const now = performance.now();
      const cx = s.w / 2;
      const cy = s.h / 2;
      const cyaw = Math.cos(s.yaw);
      const syaw = Math.sin(s.yaw);
      const cpitch = Math.cos(s.pitch);
      const spitch = Math.sin(s.pitch);
      const f = 2800;
      const rOuter = Math.min(cx, cy) * 0.9;
      const fit = ((rOuter * 0.80) / (432 * 1.15)) * s.fitAdj;
      const radarAngle = ((now % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS) * Math.PI * 2;
      const flashAge = now - s.lastActivityTs;
      const alertFlash = flashAge < 300 ? Math.max(0, 1 - flashAge / 300) : 0;

      // TELEMETRY STREAM
      ctx.fillStyle = "rgba(0,255,102,0.15)";
      ctx.font = "9px monospace";
      ctx.textAlign = "right";
      const scrollOffset = (now * 0.05) % 15;
      for (let y = -15; y < s.h + 15; y += 15) {
          const val = Math.floor((y + now*0.01)*13.7) % 256;
          const hex = val.toString(16).padStart(2, '0').toUpperCase();
          ctx.fillText(hex, 25, y + scrollOffset);
      }

      // VIEWPORT BRACKETS & ALERT FLASH
      ctx.save();
      ctx.strokeStyle = `rgba(0, 255, 102, ${0.2 + alertFlash * 0.8})`;
      ctx.lineWidth = 1 + alertFlash * 2;
      ctx.beginPath();
      const bLen = 20;
      const m = 10;
      // Top Left
      ctx.moveTo(m, m + bLen); ctx.lineTo(m, m); ctx.lineTo(m + bLen, m);
      // Top Right
      ctx.moveTo(s.w - m - bLen, m); ctx.lineTo(s.w - m, m); ctx.lineTo(s.w - m, m + bLen);
      // Bottom Left
      ctx.moveTo(m, s.h - m - bLen); ctx.lineTo(m, s.h - m); ctx.lineTo(m + bLen, s.h - m);
      // Bottom Right
      ctx.moveTo(s.w - m - bLen, s.h - m); ctx.lineTo(s.w - m, s.h - m); ctx.lineTo(s.w - m, s.h - m - bLen);
      
      // Edge ticks
      for (let i = 0.2; i <= 0.8; i += 0.2) {
          ctx.moveTo(m, s.h * i); ctx.lineTo(m + 4, s.h * i);
          ctx.moveTo(s.w - m, s.h * i); ctx.lineTo(s.w - m - 4, s.h * i);
          ctx.moveTo(s.w * i, m); ctx.lineTo(s.w * i, m + 4);
          ctx.moveTo(s.w * i, s.h - m); ctx.lineTo(s.w * i, s.h - m - 4);
      }
      ctx.stroke();
      ctx.restore();

      // FUI Frame
      ctx.save();
      ctx.strokeStyle = "rgba(0, 255, 102, 0.15)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
      ctx.stroke();
      
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0, rOuter - 8), s.time * 0.002, s.time * 0.002 + Math.PI * 0.4);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0, rOuter - 8), s.time * 0.002 + Math.PI, s.time * 0.002 + Math.PI * 1.4);
      ctx.stroke();

      const ch = 12;
      ctx.beginPath();
      ctx.moveTo(cx, cy - rOuter - ch); ctx.lineTo(cx, cy - rOuter + ch);
      ctx.moveTo(cx, cy + rOuter - ch); ctx.lineTo(cx, cy + rOuter + ch);
      ctx.moveTo(cx - rOuter - ch, cy); ctx.lineTo(cx - rOuter + ch, cy);
      ctx.moveTo(cx + rOuter - ch, cy); ctx.lineTo(cx + rOuter + ch, cy);
      ctx.stroke();

      for (let i = 0; i < 36; i++) {
        const angle = i * Math.PI / 18;
        const len = i % 3 === 0 ? 8 : 4;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * rOuter, cy + Math.sin(angle) * rOuter);
        ctx.lineTo(cx + Math.cos(angle) * (rOuter - len), cy + Math.sin(angle) * (rOuter - len));
        ctx.stroke();
      }

      ctx.font = "10px monospace";
      ctx.fillStyle = "rgba(0, 255, 102, 0.5)";
      ctx.textAlign = "left";
      ctx.fillText(`PTS: ${s.activeBrainPoints}`, 35, s.h - 40);
      ctx.fillText(`FTM: ${s.avgFrameTime.toFixed(1)}ms`, 35, s.h - 25);
      ctx.textAlign = "right";
      ctx.fillText(`YAW: ${(s.yaw * 180 / Math.PI % 360).toFixed(1)}°`, s.w - 35, s.h - 40);
      ctx.fillText(`PITCH: ${(s.pitch * 180 / Math.PI % 360).toFixed(1)}°`, s.w - 35, s.h - 25);
      
      ctx.textAlign = "left";
      ctx.fillText(`NODES: ${nodes.length}`, 35, 30);
      ctx.fillText(`LINKS: ${edges.length}`, 35, 45);
      ctx.restore();

      ctx.globalCompositeOperation = "lighter";
      
      // Brain Points
      const breath = 1 + Math.sin(s.time * 0.02) * 0.03;
      const sparks = [];
      
      // Calculate hotspot
      const hotspotIdx = Math.floor(s.time / FIRING_INTERVAL) % GLOBAL_BRAIN.pts.length;
      const hotspotTarget = GLOBAL_BRAIN.pts[hotspotIdx];
      const hx = hotspotTarget.x, hy = hotspotTarget.y, hz = hotspotTarget.z;

      // Draw lines
      const thickLines = [];
      const batchFar = [];
      const batchMid = [];
      const batchNear = [];
      for (const link of GLOBAL_BRAIN.links) {
        if (link.a >= s.activeBrainPoints || link.b >= s.activeBrainPoints) continue;
        const p1 = GLOBAL_BRAIN.pts[link.a];
        const p2 = GLOBAL_BRAIN.pts[link.b];
        
        const bx1 = p1.x * breath, by1 = p1.y * breath, bz1 = p1.z * breath;
        const x1_1 = bx1 * cyaw + bz1 * syaw;
        const z1_1 = -bx1 * syaw + bz1 * cyaw;
        const y2_1 = by1 * cpitch - z1_1 * spitch;
        const z2_1 = by1 * spitch + z1_1 * cpitch;
        const scale1 = (f / (f + z2_1)) * zoom * fit;

        const bx2 = p2.x * breath, by2 = p2.y * breath, bz2 = p2.z * breath;
        const x1_2 = bx2 * cyaw + bz2 * syaw;
        const z1_2 = -bx2 * syaw + bz2 * cyaw;
        const y2_2 = by2 * cpitch - z1_2 * spitch;
        const z2_2 = by2 * spitch + z1_2 * cpitch;
        const scale2 = (f / (f + z2_2)) * zoom * fit;

        if (scale1 < 0 || scale2 < 0) continue;
        
        const sx1 = cx + x1_1 * scale1;
        const sy1 = cy + y2_1 * scale1;
        const sx2 = cx + x1_2 * scale2;
        const sy2 = cy + y2_2 * scale2;
        
        const mx = (sx1 + sx2) / 2;
        const my = (sy1 + sy2) / 2;
        
        let thickened = false;
        
        // Probe
        const d = Math.sqrt((mx - s.lastMouseX)**2 + (my - s.lastMouseY)**2);
        if (d < PROBE_RADIUS) thickened = true;
        
        // Radar Sweep
        let ang = Math.atan2(my - cy, mx - cx);
        if (ang < 0) ang += Math.PI * 2;
        let adiff = Math.abs(ang - radarAngle);
        if (adiff > Math.PI) adiff = Math.PI * 2 - adiff;
        if (adiff < 0.15) thickened = true;
        
        meshDrawnCount++;
        if (thickened) {
            thickLines.push({sx1, sy1, sx2, sy2, d});
        } else {
            const zMid = (z2_1 + z2_2) / 2;
            if (zMid > 50) batchFar.push({sx1, sy1, sx2, sy2});
            else if (zMid > -50) batchMid.push({sx1, sy1, sx2, sy2});
            else batchNear.push({sx1, sy1, sx2, sy2});
        }
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0, 255, 102, 0.4)";
      if (batchFar.length > 0) {
          ctx.globalAlpha = 0.15;
          ctx.beginPath();
          for (const l of batchFar) { ctx.moveTo(l.sx1, l.sy1); ctx.lineTo(l.sx2, l.sy2); }
          ctx.stroke();
      }
      if (batchMid.length > 0) {
          ctx.globalAlpha = 0.28;
          ctx.beginPath();
          for (const l of batchMid) { ctx.moveTo(l.sx1, l.sy1); ctx.lineTo(l.sx2, l.sy2); }
          ctx.stroke();
      }
      if (batchNear.length > 0) {
          ctx.globalAlpha = 0.45;
          ctx.beginPath();
          for (const l of batchNear) { ctx.moveTo(l.sx1, l.sy1); ctx.lineTo(l.sx2, l.sy2); }
          ctx.stroke();
      }

      ctx.save();
      ctx.font = "10px monospace";
      ctx.fillStyle = "rgba(0, 255, 102, 0.5)";
      ctx.textAlign = "left";
      ctx.fillText(`MESH: ${meshDrawnCount}`, 35, s.h - 10);
      ctx.restore();

      if (thickLines.length > 0) {
          ctx.beginPath();
          for (const tl of thickLines) {
              ctx.moveTo(tl.sx1, tl.sy1);
              ctx.lineTo(tl.sx2, tl.sy2);
          }
          ctx.globalAlpha = 0.15;
          ctx.lineWidth = 2.0;
          ctx.stroke();
      }

      const projectedPts = [];
      const ssCellSize = 12;
      const ssGrid = isNeighborUpdate ? new Map<string, number[]>() : null;
      let maxAbsSx = 0;
      
      for (let i = 0; i < s.activeBrainPoints; i++) {
        const bp = GLOBAL_BRAIN.pts[i];
        
        const bx = bp.x * breath;
        const by = bp.y * breath;
        const bz = bp.z * breath;

        const x1 = bx * cyaw + bz * syaw;
        const z1 = -bx * syaw + bz * cyaw;
        const y2 = by * cpitch - z1 * spitch;
        const z2 = by * spitch + z1 * cpitch;

        const scale = (f / (f + z2)) * zoom * fit;
        if (scale < 0) continue;
        const sx = cx + x1 * scale;
        const sy = cy + y2 * scale;
        
        const dx = Math.abs(sx - cx);
        if (dx > maxAbsSx) maxAbsSx = dx;
        
        projectedPts.push({ sx, sy, scale, z2, bp });
        if (isNeighborUpdate) {
            const cxGrid = Math.floor(sx / ssCellSize);
            const cyGrid = Math.floor(sy / ssCellSize);
            const h = `${cxGrid},${cyGrid}`;
            if (!ssGrid!.has(h)) ssGrid!.set(h, []);
            ssGrid!.get(h)!.push(projectedPts.length - 1);
        }
      }

      for (let idx = 0; idx < projectedPts.length; idx++) {
        const p = projectedPts[idx];
        const { sx, sy, scale, z2, bp } = p;

        // Hotspot distance
        const distToHotspot = Math.sqrt((bp.x - hx)**2 + (bp.y - hy)**2 + (bp.z - hz)**2);
        const isHot = distToHotspot < 40;

        const isSpark = isHot && Math.sin(s.time * 0.05 + bp.flicker) > 0.90;
        const zDepth = (z2 + 400) / 800; 
        
        let alpha = Math.max(0, 1 - zDepth * 0.8);
        const band = Math.floor(bp.wave * 2);
        if (Math.abs(band) % 2 !== 0) {
            alpha *= 0.15;
        }

        let neighbors = 0;
        if (isNeighborUpdate) {
            const cxGrid = Math.floor(sx / ssCellSize);
            const cyGrid = Math.floor(sy / ssCellSize);
            for (let dx = -1; dx <= 1; dx++) {
              for (let dy = -1; dy <= 1; dy++) {
                const h = `${cxGrid + dx},${cyGrid + dy}`;
                const cell = ssGrid!.get(h);
                if (cell) {
                  for (const otherIdx of cell) {
                    if (otherIdx !== idx) {
                      const other = projectedPts[otherIdx];
                      const d2 = (sx - other.sx)**2 + (sy - other.sy)**2;
                      if (d2 < 144) {
                        neighbors++;
                      }
                    }
                  }
                }
              }
            }
            s.neighborCache[idx] = neighbors;
        } else {
            neighbors = s.neighborCache[idx];
        }
        
        let sizeBase = 3.0 * scale;
        if (neighbors < 8) {
            alpha += RIM_INTENSITY * 0.4;
            sizeBase += RIM_INTENSITY * 0.5;
        }

        // Cursor probe
        const distMouse = Math.sqrt((sx - s.lastMouseX)**2 + (sy - s.lastMouseY)**2);
        if (distMouse < PROBE_RADIUS) {
            alpha = Math.max(alpha, 1 - distMouse / PROBE_RADIUS);
        }
        
        // Radar Sweep
        let ang = Math.atan2(sy - cy, sx - cx);
        if (ang < 0) ang += Math.PI * 2;
        let adiff = Math.abs(ang - radarAngle);
        if (adiff > Math.PI) adiff = Math.PI * 2 - adiff;
        if (adiff < 0.15) {
            alpha = Math.max(alpha, 1 - adiff / 0.15);
        }

        if (isSpark) {
          sparks.push({ sx, sy, scale, alpha: alpha * 3, hot: true });
          continue;
        }

        ctx.globalAlpha = Math.min(1, alpha * 0.6);
        ctx.fillStyle = isHot ? "rgba(255, 200, 50, 0.8)" : "rgba(0, 255, 102, 1)";
        ctx.fillRect(sx, sy, sizeBase, sizeBase);
      }

      for (const sp of sparks) {
        ctx.globalAlpha = Math.min(1, sp.alpha);
        const size = 4.0 * sp.scale;
        ctx.fillStyle = sp.hot ? "rgba(255, 200, 50, 1)" : "rgba(100, 255, 200, 1)";
        ctx.fillRect(sp.sx, sp.sy, size, size);
      }

      s.pNodes = nodes.map((n, i) => {
        const dx = n.x - cx;
        const dy = n.y - cy;
        const dz = n.z;
        const x1 = dx * cyaw + dz * syaw;
        const z1 = -dx * syaw + dz * cyaw;
        const y2 = dy * cpitch - z1 * spitch;
        const z2 = dy * spitch + z1 * cpitch;
        const scale = (f / (f + z2)) * zoom * fit;
        return { i, sx: cx + x1 * scale, sy: cy + y2 * scale, scale, z: z2 };
      }).sort((a, b) => b.z - a.z);

      const pMap = new Map(s.pNodes.map(p => [p.i, p]));

      const pEdges = edges.map(e => {
        const pa = pMap.get(e.a);
        const pb = pMap.get(e.b);
        return { e, pa, pb, z: ((pa?.z ?? 0) + (pb?.z ?? 0)) / 2 };
      }).sort((a, b) => b.z - a.z);

      for (const pe of pEdges) {
        const { e, pa, pb } = pe;
        if (!pa || !pb) continue;
        const hot = hover >= 0 && (e.a === hover || e.b === hover);
        const zDepth = Math.max(0, pe.z + 400) / 800;
        const alpha = Math.max(0.02, 1 - zDepth * 0.7);
        
        ctx.globalAlpha = 1;
        ctx.strokeStyle = hot
          ? "rgba(0,255,102,0.8)"
          : hover >= 0
            ? `rgba(0,255,102,${alpha * 0.15})`
            : `rgba(0,255,102,${alpha * 0.4})`;
        ctx.lineWidth = (hot ? 1.5 : 1) * ((pa.scale + pb.scale) / 2);
        ctx.beginPath();
        ctx.moveTo(pa.sx, pa.sy);
        ctx.lineTo(pb.sx, pb.sy);
        ctx.stroke();
      }

      const pPulses = s.pulses.map(p => {
        const pa = pMap.get(p.a);
        const pb = pMap.get(p.b);
        const z = pa && pb ? pa.z + (pb.z - pa.z) * p.t : 0;
        return { p, pa, pb, z };
      }).sort((a, b) => b.z - a.z);

      for (const pp of pPulses) {
        const { p, pa, pb, z } = pp;
        if (!pa || !pb) continue;
        const x = pa.sx + (pb.sx - pa.sx) * p.t;
        const y = pa.sy + (pb.sy - pa.sy) * p.t;
        const tx = pa.sx + (pb.sx - pa.sx) * Math.max(0, p.t - 0.12);
        const ty = pa.sy + (pb.sy - pa.sy) * Math.max(0, p.t - 0.12);
        const grad = ctx.createLinearGradient(tx, ty, x, y);
        const alpha = Math.max(0.1, 1 - Math.max(0, z + 400) / 800 * 0.7);
        grad.addColorStop(0, "rgba(0,229,255,0)");
        grad.addColorStop(1, `rgba(0,229,255,${alpha})`);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2 * ((pa.scale + pb.scale) / 2);
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.save();
        ctx.shadowColor = `rgba(0,229,255,${alpha})`;
        ctx.shadowBlur = 10 * ((pa.scale + pb.scale) / 2);
        ctx.fillStyle = `rgba(138,246,255,${alpha})`;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.1, 2 * ((pa.scale + pb.scale) / 2)), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;

      for (const pn of s.pNodes) {
        const i = pn.i;
        const n = nodes[i];
        const isHover = i === hover;
        const isNeighbor = hoverSet?.has(i) ?? false;
        const dimmed = hover >= 0 && !isHover && !isNeighbor;

        const zDepth = Math.max(0, pn.z + 400) / 800;
        const bgMix = Math.min(1, Math.max(0, zDepth));
        const baseAlpha = 1 - bgMix * 0.6;
        const alpha = dimmed ? baseAlpha * 0.15 : baseAlpha;

        const pulse = 1 + Math.sin(s.time * 0.003 + i) * 0.15;
        const r = Math.max(0.1, n.r * pulse * pn.scale);
        
        // THREAT HEAT
        const linksCount = (s.neighbors.get(i) ?? new Set()).size;
        let baseColor = "0, 255, 102";
        if (linksCount > 0) {
            if (linksCount === s.maxLinks && s.maxLinks > 0) {
                baseColor = "255, 50, 50"; // Red
            } else {
                const heatRatio = linksCount / s.maxLinks;
                const cr = Math.floor(0 + heatRatio * 255);
                const cg = Math.floor(255 - heatRatio * 75);
                const cb = Math.floor(200 - heatRatio * 200);
                baseColor = `${cr}, ${cg}, ${cb}`;
            }
        }

        ctx.beginPath();
        ctx.arc(pn.sx, pn.sy, r, 0, Math.PI * 2);
        ctx.fillStyle = "#09090b";
        ctx.fill();

        ctx.save();
        const shadowColor = isHover ? "#00ff66" : isNeighbor ? "#00e5ff" : `rgba(${baseColor},${alpha * 0.5})`;
        ctx.shadowColor = shadowColor;
        ctx.shadowBlur = (isHover ? 20 : isNeighbor ? 15 : 8) * pn.scale * alpha;
        const strokeColor = isHover
          ? `rgba(0,255,102,${alpha})`
          : isNeighbor
            ? `rgba(0,229,255,${alpha})`
            : `rgba(${baseColor},${alpha * 0.8})`;
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = (isHover ? 2 : 1.5) * pn.scale;
        ctx.stroke();
        ctx.restore();

        const innerAlpha = isHover ? 1 : isNeighbor ? 0.9 : alpha;
        ctx.fillStyle = isHover ? "#fff" : isNeighbor ? "#ccfbfd" : `rgba(${baseColor},${innerAlpha})`;
        ctx.beginPath();
        ctx.arc(pn.sx, pn.sy, Math.max(1, r * 0.3), 0, Math.PI * 2);
        ctx.fill();

        // TARGET LOCK
        if (isHover && pn.scale > 0.3) {
          const lockAnim = Math.min(1, (now - s.hoverStartTs) / LOCK_ANIM_MS);
          const br = r * 1.5 + (1 - lockAnim) * 20;
          ctx.strokeStyle = `rgba(0, 255, 102, ${lockAnim})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          // Top Left
          ctx.moveTo(pn.sx - br, pn.sy - br + 6); ctx.lineTo(pn.sx - br, pn.sy - br); ctx.lineTo(pn.sx - br + 6, pn.sy - br);
          // Top Right
          ctx.moveTo(pn.sx + br - 6, pn.sy - br); ctx.lineTo(pn.sx + br, pn.sy - br); ctx.lineTo(pn.sx + br, pn.sy - br + 6);
          // Bottom Left
          ctx.moveTo(pn.sx - br, pn.sy + br - 6); ctx.lineTo(pn.sx - br, pn.sy + br); ctx.lineTo(pn.sx - br + 6, pn.sy + br);
          // Bottom Right
          ctx.moveTo(pn.sx + br - 6, pn.sy + br); ctx.lineTo(pn.sx + br, pn.sy + br); ctx.lineTo(pn.sx + br, pn.sy + br - 6);
          ctx.stroke();

          if (lockAnim > 0.8) {
              ctx.fillStyle = "#fff";
              const fontSize = Math.max(8, 12 * pn.scale);
              ctx.font = `${fontSize}px monospace`;
              const title = n.title.slice(0, 20);
              const connections = linksCount;
              const cluster = s.nodeClusters[i] || "root";
              
              const textX = pn.sx + br + 8;
              const textY = pn.sy - br + 8;
              ctx.fillText(title, textX, textY);
              
              ctx.fillStyle = "rgba(0, 255, 102, 0.8)";
              ctx.font = `${Math.max(7, 9 * pn.scale)}px monospace`;
              ctx.fillText(`LNK: ${connections} | CLS: ${cluster}`, textX, textY + fontSize + 2);
          }
        } else if (isNeighbor && pn.scale > 0.3) {
          ctx.fillStyle = `rgba(0,229,255,${alpha})`;
          const fontSize = Math.max(8, 10 * pn.scale);
          ctx.font = `${fontSize}px monospace`;
          ctx.fillText(n.title.slice(0, 20), pn.sx + r + 6 * pn.scale, pn.sy + 4 * pn.scale);
        }
      }
      
      const want = Math.min(cx, cy) * 0.9 * 0.82;
      if (maxAbsSx > 1) s.fitAdj += ((want / maxAbsSx) - s.fitAdj) * 0.08;
      
      } catch (err) {
        if (!s.loggedDrawError) {
          console.error("Draw error:", err);
          s.loggedDrawError = true;
        }
        ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, s.w, s.h);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "rgba(0, 255, 102, 1)";
        ctx.strokeStyle = "rgba(0, 255, 102, 0.4)";
        const { nodes, edges } = s;
        
        ctx.beginPath();
        for (const e of edges) {
          const a = nodes[e.a];
          const b = nodes[e.b];
          if (a && b) {
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
          }
        }
        ctx.stroke();

        for (const n of nodes) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
const loop = () => {
      if (stopped) return;
      const t0 = performance.now();
      
      s.time++;
      if (s.alpha > 0.005 || s.drag >= 0) step();
      
      s.idleFrames++;
      if (s.idleFrames > 180) {
        s.hasInteracted = false;
      }
      
      if (!s.isRotating) {
        s.yaw += s.vYaw;
        s.pitch += s.vPitch;
        s.vYaw *= 0.95;
        s.vPitch *= 0.95;
        
        if (s.drag < 0) {
          s.yaw += (s.targetYaw - s.yaw) * 0.1;
          s.pitch += (s.targetPitch - s.pitch) * 0.1;
        }
        
        if (!s.hasInteracted) {
          s.targetYaw = Math.sin(s.time * 0.002) * (35 * Math.PI / 180);
        }
      }
      
      s.zoom += (s.targetZoom - s.zoom) * 0.1;

      for (const p of s.pulses) p.t += p.speed;
      s.pulses = s.pulses.filter((p) => p.t < 1);
      if (s.time - s.lastPulse > 15) {
        s.lastPulse = s.time;
        spawnPulse();
      }
      draw();
      
      const t1 = performance.now();
      const frameTime = t1 - t0;
      s.avgFrameTime = s.avgFrameTime * 0.9 + frameTime * 0.1;
      
      if (s.avgFrameTime > 22 && s.activeBrainPoints > 4000) {
        s.activeBrainPoints -= 100;
      } else if (s.avgFrameTime < 10 && s.activeBrainPoints < CORTEX_DENSITY) {
        s.activeBrainPoints += 20;
      }
      
      s.raf = requestAnimationFrame(loop);
    };
    loop();

    const pos = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };
    const hit = (x: number, y: number): number => {
      let best = -1;
      let bestD = Infinity;
      for (let i = s.pNodes.length - 1; i >= 0; i--) {
        const pn = s.pNodes[i];
        const dx = pn.sx - x;
        const dy = pn.sy - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const rad = s.nodes[pn.i].r * pn.scale + 6;
        if (d <= rad && d < bestD) {
          best = pn.i;
          bestD = d;
        }
      }
      return best;
    };

    const onMove = (ev: MouseEvent) => {
      const { x, y } = pos(ev);
      s.hasInteracted = true;
      s.idleFrames = 0;
      s.forceCache = true;

      if (s.isRotating) {
        const dx = ev.clientX - s.lastMouseX;
        const dy = ev.clientY - s.lastMouseY;
        s.vYaw = dx * 0.005;
        s.vPitch = dy * 0.005;
        s.yaw += s.vYaw;
        s.pitch += s.vPitch;
        s.pitch = Math.max(-Math.PI / 2.5, Math.min(Math.PI / 2.5, s.pitch));
        s.dragMoved = true;
      } else if (s.drag >= 0) {
        const n = s.nodes[s.drag];
        const pn = s.pNodes.find(p => p.i === s.drag);
        const scale = pn ? pn.scale : 1;
        const dxScreen = (ev.clientX - s.lastMouseX) / scale;
        const dyScreen = (ev.clientY - s.lastMouseY) / scale;
        const cpitch = Math.cos(-s.pitch);
        const spitch = Math.sin(-s.pitch);
        const cyaw = Math.cos(-s.yaw);
        const syaw = Math.sin(-s.yaw);
        const y1 = dyScreen * cpitch;
        const z1 = dyScreen * spitch;
        n.x += dxScreen * cyaw + z1 * syaw;
        n.y += y1;
        n.z += -dxScreen * syaw + z1 * cyaw;
        n.vx = 0;
        n.vy = 0;
        n.vz = 0;
        s.dragMoved = true;
        s.alpha = Math.max(s.alpha, 0.25);
      } else {
        const newHover = hit(x, y);
        if (newHover !== s.hover) {
          s.hover = newHover;
          if (s.hover >= 0) {
            s.hoverStartTs = performance.now();
            const set = s.neighbors.get(s.hover);
            if (set) {
              for (const neighbor of set) {
                s.pulses.push({ a: s.hover, b: neighbor, t: 0, speed: 0.02 + Math.random() * 0.02 });
              }
            }
          }
        }
        canvas.style.cursor = s.hover >= 0 ? "pointer" : "default";
        
        const cx = s.w / 2;
        const cy = s.h / 2;
        s.targetYaw = ((x - cx) / (cx || 1)) * MOUSE_TILT_MAX.yaw;
        s.targetPitch = ((y - cy) / (cy || 1)) * MOUSE_TILT_MAX.pitch;
      }
      s.lastMouseX = ev.clientX;
      s.lastMouseY = ev.clientY;
    };
    const onDown = (ev: MouseEvent) => {
      const { x, y } = pos(ev);
      s.hasInteracted = true;
      s.idleFrames = 0;
      const i = hit(x, y);
      if (i >= 0) {
        s.drag = i;
        s.dragMoved = false;
        s.nodes[i].pinned = true;
      } else {
        s.isRotating = true;
        s.dragMoved = false;
      }
      s.lastMouseX = ev.clientX;
      s.lastMouseY = ev.clientY;
    };
    const onUp = () => {
      s.isRotating = false;
      if (s.drag >= 0) {
        const wasDragged = s.dragMoved;
        const id = s.nodes[s.drag].id;
        s.nodes[s.drag].pinned = false;
        s.drag = -1;
        if (!wasDragged) openNote(id);
      }
    };
    const onLeave = () => {
      s.hover = -1;
      s.targetYaw = 0;
      s.targetPitch = 0;
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      s.hasInteracted = true;
      s.idleFrames = 0;
      s.targetZoom -= ev.deltaY * 0.002;
      s.targetZoom = Math.max(0.2, Math.min(5, s.targetZoom));
    };

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      stopped = true;
      cancelAnimationFrame(s.raf);
      ro.disconnect();
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("mouseleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [openNote]);

  return (
    <div className="flex-1 min-h-0 flex">
      {/* ---------- LEFT HUD: neural activity ---------- */}
      <aside className="hidden md:flex shrink-0 w-52 border-r border-line flex-col bg-panel/30 overflow-y-auto">
        <HudHead label="NEURAL ACTIVITY" sub="" />
        <div className="px-3 pb-3">
          <Eeg energy={syncTick} />
        </div>
        <div className="px-3 grid grid-cols-2 gap-2">
          <Stat label="NEURONS" value={counts.nodes} accent="text-neon" />
          <Stat label="SYNAPSES" value={counts.links} accent="text-cyan" />
          <Stat label="DENSITY" value={density} accent="text-neon" />
          <Stat label="MINDS" value={activeMinds} accent="text-amber" />
        </div>
        <HudHead label="COGNITION" sub="" />
        <div className="px-3 pb-4">
          <Cognition tick={syncTick} />
        </div>
      </aside>

      {/* ---------- CENTER: the brain graph ---------- */}
      <div ref={wrapRef} className="flex-1 relative min-h-0 overflow-hidden">
        <canvas ref={canvasRef} className="block" />
        <div className="absolute top-3 left-4 text-[10px] tracking-[.2em] text-muted select-none pointer-events-none">
          <span className="text-neon glow">◉</span> NEURONS {counts.nodes} / SYNAPSES {counts.links}
        </div>
        <div className="absolute top-3 right-4 text-[9px] tracking-[.25em] text-faint select-none pointer-events-none">
          CORTEX MAP ░▒▓
        </div>
        {counts.nodes === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-faint text-xs tracking-[.25em] pointer-events-none">
            NO DATA IN SECTOR ░░░
          </div>
        )}
      </div>

      {/* ---------- RIGHT HUD: cortex readout ---------- */}
      <aside className="hidden lg:flex shrink-0 w-56 border-l border-line flex-col bg-panel/30 overflow-y-auto">
        <HudHead label="DOMINANT MEMORIES" sub="" />
        <div className="px-2 pb-2">
          {hubs.length === 0 && <Empty />}
          {hubs.map((h, i) => (
            <button
              key={h.id}
              onClick={() => openNote(h.id)}
              className="w-full text-left flex items-center gap-2 px-2 py-1 hover:bg-panel2 group"
            >
              <span className="text-[9px] text-faint tabular-nums w-4">{i + 1}</span>
              <span className="flex-1 text-[11px] text-ink group-hover:text-neon truncate" dir="auto">
                {h.title}
              </span>
              <span className="text-[9px] text-neon-dim tabular-nums">{h.size}</span>
            </button>
          ))}
        </div>

        <HudHead label="RECENT FIRING" sub="" />
        <div className="px-2 pb-2 space-y-0.5">
          {activity.length === 0 && <Empty />}
          {activity.slice(0, 7).map((a, i) => (
            <button
              key={i}
              onClick={() => a.path && openNote(a.path)}
              className="w-full text-left flex items-center gap-1.5 px-2 py-0.5 hover:bg-panel2"
            >
              <span className="text-[8px] text-faint tabular-nums">{a.ts.slice(11, 19)}</span>
              <span className={"text-[9px] " + agentTextClass(a.agent)}>
                {(a.agent || "system").slice(0, 6)}
              </span>
              <span className="text-[9px] text-muted truncate flex-1">{a.action}</span>
            </button>
          ))}
        </div>

        <HudHead label="CLUSTERS" sub="" />
        <div className="px-2 pb-4 space-y-0.5">
          {clusters.length === 0 && <Empty />}
          {clusters.map(([name, n]) => (
            <div key={name} className="flex items-center gap-2 px-2 py-0.5">
              <span className="text-cyan text-[9px]">▪</span>
              <span className="flex-1 text-[10px] text-muted truncate" dir="auto">
                {name}
              </span>
              <span className="text-[9px] text-faint tabular-nums">{n}</span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------- HUD bits */

function HudHead({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="px-3 pt-3 pb-1.5 flex items-baseline gap-2 border-b border-line/60 mb-2">
      <span className="text-[10px] tracking-[.18em] text-neon-dim glow">{label}</span>
      <span className="text-[9px] text-faint" dir="auto">
        {sub}
      </span>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number | string; accent: string }) {
  return (
    <div className="border border-line/60 bg-bg2/40 px-2 py-1.5">
      <div className="text-[8px] tracking-[.15em] text-faint">{label}</div>
      <div className={"text-base font-bold tabular-nums leading-6 " + accent}>{value}</div>
    </div>
  );
}

function Empty() {
  return <div className="text-faint text-[9px] tracking-[.2em] px-2 py-2">░ NO SIGNAL</div>;
}

/* animated EEG waveform */
function Eeg({ energy }: { energy: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const boost = useRef(0);
  useEffect(() => {
    boost.current = 1;
  }, [energy]);
  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext("2d")!;
    let raf = 0;
    let t = 0;
    let stop = false;
    const render = () => {
      if (stop) return;
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth || 176;
      const h = 44;
      if (cv.width !== w * dpr || cv.height !== h * dpr) {
        cv.width = w * dpr;
        cv.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      ctx.clearRect(0, 0, w, h);
      boost.current *= 0.94;
      const amp = 6 + boost.current * 12;
      ctx.strokeStyle = "rgba(0,255,102,0.85)";
      ctx.lineWidth = 1.2;
      ctx.shadowColor = "rgba(0,255,102,0.6)";
      ctx.shadowBlur = 6;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const ph = x * 0.18 + t;
        const y =
          h / 2 +
          Math.sin(ph) * amp * 0.5 +
          Math.sin(ph * 0.5 + 1) * amp * 0.35 +
          (Math.sin(ph * 2.3) > 0.9 ? -amp * 0.6 : 0);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      t += 0.25;
      raf = requestAnimationFrame(render);
    };
    render();
    return () => {
      stop = true;
      cancelAnimationFrame(raf);
    };
  }, []);
  return <canvas ref={ref} className="w-full h-[44px] border border-line/50 bg-bg2/40" />;
}

/* a soft "cognition" bar that flares when the vault syncs */
function Cognition({ tick }: { tick: number }) {
  const [level, setLevel] = useState(30);
  useEffect(() => {
    setLevel(60 + Math.random() * 40);
    const t = setTimeout(() => setLevel(24 + Math.random() * 26), 900);
    return () => clearTimeout(t);
  }, [tick]);
  return (
    <div className="h-2 border border-line/60 bg-bg2/40 overflow-hidden">
      <div
        className="h-full bg-neon/70 transition-all duration-700"
        style={{ width: Math.min(100, level) + "%", boxShadow: "0 0 8px rgba(0,255,102,0.6)" }}
      />
    </div>
  );
}
