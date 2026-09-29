# Scroll viewport

`ScrollViewport` uses Microsoft's actual `DomScrollableElement`, distributed
in the MIT-licensed `monaco-editor` package, pinned to **0.56.0** (VS Code ref
`f487add297079a02eb836810185b165e50cadabc`). Only the scrollbar ESM entry and its
dependencies are imported; the editor and language workers are not initialized.
The upstream package retains its license and third-party notices. Their copies
under `apps/web/public/licenses/monaco-editor/` also ship with Web/Desktop renderer
assets; update them when upgrading the dependency.

This is a private upstream module, not Monaco's versioned public editor API.
Keep imports and the narrow declaration facade here. Upgrades must rerun the
viewport integration tests and native Desktop acceptance, including scrollbar
dragging, wheel direction changes, boundaries, resize, and modifier zoom.

The upstream controller owns both scrollbars, wheel normalization, per-event
predominant-axis selection, and bounds. Clash routes Ctrl/Meta-wheel to Timeline
zoom. The actual content DOM node remains the coordinate reference for DnD,
ruler synchronization, seeking and zoom anchoring. DOM scroll events synchronize
external writes back to the controller. ResizeObserver tracks viewport/content
sizes; cleanup restores the React-owned DOM hierarchy before unmount.
Do not scan dimensions on every React commit: that forces synchronous layout
after Timeline zoom changes every clip width. The initial scan, size observer,
and external-scroll/wheel synchronization cover the controller's actual inputs.

Do not put a gesture lock, multiplier, debounce, or second animation loop around
this primitive. Browser-delivered trackpad inertia is passed through upstream.
