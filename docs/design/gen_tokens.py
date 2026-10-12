#!/usr/bin/env python3
"""Generate W3C design-tokens JSON (Tokens Studio / Figma-importable) from
the :root block of webapp/css/base.css. Re-run after token changes:

    python3 docs/design/gen_tokens.py webapp/css/base.css docs/design/tokens.json
"""
import json, re, sys

css_path, out_path = sys.argv[1], sys.argv[2]
css = open(css_path).read()
root = re.search(r":root\s*\{(.*?)\n\}", css, re.S).group(1)
decls = {}
for m in re.finditer(r"--([\w-]+)\s*:\s*([^;]+);\s*(?:/\*\s*(.*?)\s*\*/)?", root):
    decls[m.group(1)] = (m.group(2).strip(), (m.group(3) or "").strip())

def tok(t, v, d=""):
    o = {"$type": t, "$value": v}
    if d:
        o["$description"] = d
    return o

def px(v):
    return v if v.endswith("px") else v

out = {"$description": "Rhythm Checker v3 design tokens, generated from webapp/css/base.css. Brand: photocopied gig poster. All text pairs meet WCAG AA (see docs/DESIGN.md).",
       "color": {}, "font": {"family": {}, "size": {}}, "space": {}, "size": {}, "shadow": {}, "motion": {}}
COLOR_GROUPS = {
    "brand": ["paper", "white", "ink", "red", "blue", "green", "amber"],
    "text-safe": ["red-ink", "amber-ink", "green-ink"],
    "neutral": ["ink60", "tint", "cream3", "rule", "dot", "dot-strong"],
    "heat": ["heat1", "heat2", "heat3"],
}
for grp, names in COLOR_GROUPS.items():
    out["color"][grp] = {n: tok("color", decls[n][0], decls[n][1]) for n in names if n in decls}
for n in ["display-font", "label-font", "mono-font"]:
    fam = [f.strip().strip("'\"") for f in decls[n][0].split(",")]
    out["font"]["family"][n.replace("-font", "")] = tok("fontFamily", fam)
for n, (v, d) in decls.items():
    if n.startswith("t-") and v.endswith("px"):
        out["font"]["size"][n[2:]] = tok("dimension", v, d)
for n in ["s1", "s2", "s3", "s4", "s6", "s8", "gutter", "hit"]:
    out["space"][n] = tok("dimension", decls[n][0], decls[n][1])
for n, (v, d) in decls.items():
    if n.startswith("h-") and v.endswith("px"):
        out["size"][n] = tok("dimension", v, d)
out["size"]["border-width"] = tok("dimension", decls["bw"][0])
for n in ["sh-ctl", "sh-card", "sh-cta", "sh-poster", "sh-hub"]:
    v = decls[n][0]
    x, y, blur, col = v.split()[:4]
    colname = col.replace("var(--", "").rstrip(")")
    out["shadow"][n[3:]] = tok("shadow", {"color": "{color.brand." + colname + "}", "offsetX": x, "offsetY": y, "blur": blur + ("px" if blur == "0" else ""), "spread": "0px"}, "zero blur: the poster's hard offset shadow")
for n in ["d-fast", "d-hold", "d-toast", "d-stale", "d-hazard"]:
    out["motion"][n[2:]] = tok("duration", decls[n][0], decls[n][1])
bez = re.findall(r"[\d.]+", decls["ease"][0])
out["motion"]["ease"] = tok("cubicBezier", [float(b) for b in bez])
json.dump(out, open(out_path, "w"), indent=2, ensure_ascii=False)
n = sum(1 for _ in re.finditer(r'"\$value"', json.dumps(out)))
print(f"{out_path}: {n} tokens")
