# Uncropped composer density evidence (#467, common 6cf00ce)

Real Clash web app (local-api + Vite + headless Chrome CDP) with real **dsh-acp / DeepSeek Flash** (no stub ACP, no echo).
Panel width set through the app's own `copilot-sidebar-width` + viewport (w430 / w560 / w720).
w360 is below Clash's 420px panel minimum, so the panel chain is DOM-forced to 360px (marked `data-evidence-forced-width`).

`wNNN-panel.png` = the whole Agent panel (header → composer outer border, both toolbar lanes), no crop.
`wNNN-window.png` = full window.
`assertions.json` = per-control bounding boxes vs the composer shell/surface inner box, and scrollWidth/clientWidth for shell, surface, toolbar, lanes.
