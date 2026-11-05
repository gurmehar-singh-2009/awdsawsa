"""
Builds Brickfall's tool and prop models in Blender and exports them as a compact
JSON mesh bundle the game's renderers read directly (no glTF loader needed).

Run headless from the repo root:
    blender -b --factory-startup --python tools/blender/build_assets.py

Outputs:
    src/assets/models.json   flat-shaded, vertex-coloured triangle meshes
    public/preview.png       a render of every model (used for README / og:image)

Conventions: models face Blender +Y (game forward, -Z) with +Z up, origin at the
grip/pivot. 1 Blender unit = 1 stud. Export converts to the game's Y-up frame.
"""
import bpy
import bmesh
import json
import math
import os
import sys
from mathutils import Vector, Matrix

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_JSON = os.path.join(ROOT, "src", "assets", "models.json")
OUT_PNG = os.path.join(ROOT, "public", "preview.png")

# ---------------------------------------------------------------- helpers

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

_mats = {}

def mat(name, rgb, emission=0.0):
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.55
    if emission > 0:
        for key in ("Emission Color", "Emission"):
            if key in bsdf.inputs:
                bsdf.inputs[key].default_value = (*rgb, 1.0)
                break
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = emission
    m.diffuse_color = (*rgb, 1.0)
    m["export_rgb"] = list(rgb)
    m["export_glow"] = emission
    _mats[name] = m
    return m


def assign(obj, m):
    obj.data.materials.clear()
    obj.data.materials.append(m)
    return obj


def box(name, size, loc, m, bevel=0.0, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if bevel > 0:
        mod = o.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 1
        mod.limit_method = "ANGLE"
    return assign(o, m)


def cyl(name, r, depth, loc, m, verts=10, rot=(0, 0, 0), r2=None):
    if r2 is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r2, depth=depth, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    return assign(o, m)


def sphere(name, r, loc, m, sub=1, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=sub, radius=r, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    return assign(o, m)


def join(name, objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    for o in objs:
        bpy.context.view_layer.objects.active = o
        for mod in list(o.modifiers):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = name
    return o

# ---------------------------------------------------------------- models

def build_sword():
    # grip at origin, blade along +Y
    parts = [
        cyl("grip", 0.11, 0.9, (0, -0.05, 0), LEATHER, verts=8, rot=(math.pi / 2, 0, 0)),
        sphere("pommel", 0.17, (0, -0.55, 0), GOLD, sub=1),
        box("guard", (1.1, 0.16, 0.2), (0, 0.45, 0), GOLD, bevel=0.04),
        box("blade", (0.34, 3.4, 0.07), (0, 2.2, 0), STEEL, bevel=0.03),
        box("fuller", (0.08, 2.8, 0.09), (0, 2.0, 0), mat("fuller", (0.6, 0.62, 0.68))),
    ]
    tip = cyl("tip", 0.24, 0.5, (0, 4.15, 0), STEEL, verts=4, rot=(-math.pi / 2, 0, 0), r2=0.0)
    tip.scale = (0.72, 1, 0.15)
    bpy.ops.object.transform_apply(scale=True)
    parts.append(tip)
    return join("sword", parts)


def build_launcher():
    # held at grip (origin); tube runs along +Y, shoulder-mounted look
    parts = [
        cyl("tube", 0.32, 3.6, (0, 0.6, 0.35), OLIVE, verts=12, rot=(math.pi / 2, 0, 0)),
        cyl("muzzle", 0.38, 0.35, (0, 2.45, 0.35), DARK, verts=12, rot=(math.pi / 2, 0, 0)),
        cyl("rear", 0.40, 0.3, (0, -1.25, 0.35), DARK, verts=12, rot=(math.pi / 2, 0, 0)),
        box("grip", (0.16, 0.22, 0.6), (0, 0.0, -0.12), DARK, bevel=0.03),
        box("grip2", (0.16, 0.22, 0.5), (0, 0.9, -0.08), DARK, bevel=0.03),
        box("sight", (0.12, 0.4, 0.3), (-0.3, 0.9, 0.7), DARK),
        box("stripe", (0.68, 0.18, 0.68), (0, 1.6, 0.35), RED),
    ]
    return join("launcher", parts)


def build_rocket():
    # centred, nose along +Y
    parts = [
        cyl("body", 0.22, 1.2, (0, 0, 0), WHITE, verts=10, rot=(math.pi / 2, 0, 0)),
        cyl("nose", 0.22, 0.5, (0, 0.85, 0), RED, verts=10, rot=(-math.pi / 2, 0, 0), r2=0.0),
        cyl("flame", 0.16, 0.5, (0, -0.85, 0), FLAME, verts=8, rot=(math.pi / 2, 0, 0), r2=0.0),
    ]
    for i in range(4):
        a = i * math.pi / 2
        f = box(f"fin{i}", (0.05, 0.4, 0.3), (math.cos(a) * 0.3, -0.45, math.sin(a) * 0.3), RED,
                rot=(0, a, 0))
        parts.append(f)
    return join("rocket", parts)


def build_bomb():
    parts = [
        sphere("shell", 0.62, (0, 0, 0), BOMB, sub=2),
        cyl("cap", 0.2, 0.24, (0, 0, 0.66), DARK, verts=8),
        cyl("fuse", 0.05, 0.4, (0.06, 0, 0.92), WOOD, verts=5, rot=(0, 0.3, 0)),
        sphere("spark", 0.11, (0.13, 0, 1.13), FLAME, sub=1),
        box("band", (1.27, 0.2, 0.2), (0, 0, 0), RED),
    ]
    return join("bomb", parts)


def build_slingshot():
    # handle at origin (+Z up), fork opens upward, faces +Y
    parts = [
        cyl("handle", 0.1, 0.9, (0, 0, -0.1), WOOD, verts=7),
        cyl("armL", 0.08, 0.75, (-0.22, 0, 0.6), WOOD, verts=7, rot=(0, -0.5, 0)),
        cyl("armR", 0.08, 0.75, (0.22, 0, 0.6), WOOD, verts=7, rot=(0, 0.5, 0)),
        box("band", (0.9, 0.05, 0.06), (0, -0.05, 0.92), RUBBER),
        box("pouch", (0.22, 0.1, 0.14), (0, -0.12, 0.92), LEATHER),
        box("wrap", (0.24, 0.24, 0.3), (0, 0, 0.0), LEATHER),
    ]
    return join("slingshot", parts)


def build_trowel():
    # handle at origin, blade forward along +Y
    parts = [
        cyl("handle", 0.12, 0.8, (0, -0.1, 0), WOOD, verts=8, rot=(math.pi / 2, 0, 0)),
        cyl("ferrule", 0.14, 0.15, (0, 0.35, 0), STEEL, verts=8, rot=(math.pi / 2, 0, 0)),
        box("shank", (0.08, 0.08, 0.45), (0, 0.45, -0.2), STEEL),
    ]
    blade = cyl("blade", 0.55, 0.05, (0, 1.05, -0.42), TEAL, verts=3)
    blade.rotation_euler = (0, 0, math.pi / 2)
    blade.scale = (1.5, 0.95, 1)
    bpy.ops.object.select_all(action="DESELECT")
    blade.select_set(True)
    bpy.context.view_layer.objects.active = blade
    bpy.ops.object.transform_apply(rotation=True, scale=True)
    parts.append(blade)
    return join("trowel", parts)


def build_core():
    # team core crystal, centred, ~2 studs tall (tinted per team at runtime)
    bpy.ops.mesh.primitive_cone_add(vertices=6, radius1=0.8, radius2=0, depth=1.1, location=(0, 0, 0.55))
    top = bpy.context.active_object
    bpy.ops.mesh.primitive_cone_add(vertices=6, radius1=0.8, radius2=0, depth=0.9, location=(0, 0, -0.45),
                                    rotation=(math.pi, 0, 0))
    bot = bpy.context.active_object
    for o in (top, bot):
        assign(o, CRYSTAL)
    return join("core", [top, bot])


def build_flag():
    # spawn banner: pole + cloth (cloth tinted at runtime: colour (1,1,1) = tint)
    parts = [
        cyl("pole", 0.09, 6.0, (0, 0, 3.0), DARK, verts=6),
        sphere("knob", 0.16, (0, 0, 6.05), GOLD, sub=1),
        box("cloth", (0.05, 2.0, 1.3), (0, 1.0, 5.2), WHITE),
    ]
    return join("flag", parts)

# ---------------------------------------------------------------- export

PALETTE = []  # shared [r, g, b, glow] entries referenced by index


def pal_index(rgb, glow):
    key = [round(rgb[0], 3), round(rgb[1], 3), round(rgb[2], 3), 1 if glow > 0 else 0]
    if key not in PALETTE:
        PALETTE.append(key)
    return PALETTE.index(key)


def export_mesh(obj):
    """Triangulated + flat shaded. Per triangle: 9 position floats, 3 normal floats
    and one palette index. Converted to the game's Y-up, -Z-forward frame."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(depsgraph)
    me = ev.to_mesh()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    mw = obj.matrix_world
    nm = mw.to_3x3().inverted_safe().transposed()
    pos, nor, col = [], [], []
    mats = obj.data.materials
    for f in bm.faces:
        m = mats[f.material_index] if f.material_index < len(mats) else None
        rgb = list(m["export_rgb"]) if m else [1, 1, 1]
        glow = float(m["export_glow"]) if m else 0.0
        n = (nm @ f.normal).normalized()
        for v in f.verts:
            p = mw @ v.co
            # Blender (x, y, z) Z-up, +Y forward  ->  game (x, z, -y) Y-up, -Z forward
            pos += [round(p.x, 3), round(p.z, 3), round(-p.y, 3)]
        nor += [round(n.x, 3), round(n.z, 3), round(-n.y, 3)]
        col.append(pal_index(rgb, glow))
    bm.free()
    ev.to_mesh_clear()
    return {"p": pos, "n": nor, "c": col}


def render_preview(objs):
    """Lay the models out on a 4x2 grid and render a 1200x630 card."""
    scene = bpy.context.scene
    layout = {
        "sword": ((-7.5, 2.5, 0.5), (0, 0, -1.2)), "launcher": ((-2.5, 2.5, 0.5), (0, 0, -1.0)),
        "rocket": ((2.5, 2.5, 0.8), (0, 0, -1.0)), "bomb": ((7.0, 2.5, 0.7), (0, 0, 0.4)),
        "slingshot": ((-7.0, -2.0, 0.6), (0, 0, 0.3)), "trowel": ((-2.5, -2.0, 0.6), (0, 0, -1.0)),
        "core": ((2.5, -2.0, 1.0), (0, 0, 0.3)), "flag": ((7.0, -2.0, -2.6), (0, 0, -0.6)),
    }
    for o in objs:
        loc, rot = layout.get(o.name, ((0, 0, 0), (0, 0, 0)))
        o.location = loc
        o.rotation_euler = rot
    bpy.ops.object.camera_add(location=(0, -17, 13))
    cam = bpy.context.active_object
    direction = Vector((0, 0.3, 0.6)) - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = 35
    scene.camera = cam
    try:
        scene.render.engine = "BLENDER_WORKBENCH"
    except TypeError:
        pass
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "MATERIAL"
    shading.show_shadows = True
    shading.show_cavity = True
    shading.background_type = "VIEWPORT"
    shading.background_color = (0.35, 0.58, 0.90)
    scene.render.resolution_x = 1200
    scene.render.resolution_y = 630
    scene.render.filepath = OUT_PNG
    bpy.ops.render.render(write_still=True)


def main():
    reset()
    global _mats
    _mats = {}
    # materials were wiped by reset(); rebuild palette in this fresh file
    g = globals()
    for k, (rgb, em) in {
        "STEEL": ((0.78, 0.80, 0.84), 0), "DARK": ((0.16, 0.17, 0.20), 0),
        "WOOD": ((0.50, 0.30, 0.15), 0), "LEATHER": ((0.32, 0.18, 0.10), 0),
        "GOLD": ((0.95, 0.70, 0.18), 0), "OLIVE": ((0.33, 0.40, 0.22), 0),
        "RED": ((0.85, 0.15, 0.12), 0), "WHITE": ((0.93, 0.93, 0.90), 0),
        "FLAME": ((1.0, 0.55, 0.10), 4.0), "BOMB": ((0.10, 0.10, 0.12), 0),
        "RUBBER": ((0.80, 0.35, 0.55), 0), "CRYSTAL": ((0.95, 0.95, 1.0), 2.0),
        "TEAL": ((0.15, 0.62, 0.62), 0),
    }.items():
        g[k] = mat(k.lower(), rgb, em)

    builders = [build_sword, build_launcher, build_rocket, build_bomb,
                build_slingshot, build_trowel, build_core, build_flag]
    objs = [b() for b in builders]
    data = {"palette": PALETTE, "meshes": {}}
    for o in objs:
        data["meshes"][o.name] = export_mesh(o)
        print(f"[assets] {o.name}: {len(data['meshes'][o.name]['c'])} tris")
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w") as fh:
        json.dump(data, fh, separators=(",", ":"))
    print(f"[assets] wrote {OUT_JSON} ({os.path.getsize(OUT_JSON)} bytes)")
    if "--no-render" not in sys.argv:
        os.makedirs(os.path.dirname(OUT_PNG), exist_ok=True)
        render_preview(objs)
        print(f"[assets] wrote {OUT_PNG}")


main()
