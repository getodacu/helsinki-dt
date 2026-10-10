"""Run: blender --background --python scripts/build-vehicle-models.py
Original Helsinki-inspired exterior models, in metres; no third-party model assets.
Blender +Y is forward (glTF -Z); Z=0 is tyre contact / ferry waterline.
"""
from pathlib import Path
import json
import math
import sys
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "static/models"
SOURCE = ROOT / "assets/blender"
OUT.mkdir(parents=True, exist_ok=True)
SOURCE.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.context.scene.unit_settings.system = "METRIC"
bpy.context.scene.unit_settings.scale_length = 1


def linear(hex_colour):
    rgb = [int(hex_colour[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(c / 12.92 if c <= 0.04045 else ((c + .055) / 1.055) ** 2.4 for c in rgb) + (1,)


PALETTE = {key: linear(value) for key, value in {
    "purple": "9276b6", "blue": "007bc4", "white": "e7eef0", "green": "17654e", "cream": "e8d5aa",
    "dark": "14212a", "tyre": "171c20", "metal": "8896a0", "glass": "244a60",
    "light": "fff1c1", "red": "bd2628", "deck": "697777", "hull": "183e56",
}.items()}
material_cache = {}
collection = None


def material(colour, kind):
    key = (colour, kind)
    if key not in material_cache:
        m = bpy.data.materials.new(f"{kind}_{colour}")
        m.diffuse_color = PALETTE[colour]
        m.use_nodes = True
        shader = m.node_tree.nodes.get("Principled BSDF")
        shader.inputs["Base Color"].default_value = PALETTE[colour]
        shader.inputs["Roughness"].default_value = .15 if kind == "glass" else .5
        shader.inputs["Metallic"].default_value = .5 if kind in ("glass", "metal") else .1
        material_cache[key] = m
    return material_cache[key]


def finish(obj, name, colour, kind="body", bevel=0):
    obj.name = name
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    collection.objects.link(obj)
    obj.data.materials.append(material(colour, kind))
    if bevel:
        mod = obj.modifiers.new("Soft manufactured edges", "BEVEL")
        mod.width = bevel
        mod.segments = 2
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def box(name, pos, size, colour, bevel=.025, kind="body"):
    bpy.ops.mesh.primitive_cube_add(size=1, location=pos)
    obj = bpy.context.object
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, colour, kind, bevel)


def cylinder(name, pos, radius, depth, colour, axis="Z", kind="body", vertices=16):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=pos)
    obj = bpy.context.object
    obj.rotation_euler = (0, math.pi / 2, 0) if axis == "X" else (math.pi / 2, 0, 0) if axis == "Y" else (0, 0, 0)
    for face in obj.data.polygons:
        face.use_smooth = len(face.vertices) == 4
    return finish(obj, name, colour, kind)


def rod(name, start, end, radius=.025, colour="metal"):
    direction = Vector(end) - Vector(start)
    obj = cylinder(name, (Vector(start) + Vector(end)) / 2, radius, direction.length, colour, kind="metal", vertices=8)
    obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
    return obj


def mesh(name, vertices, faces, colour, kind="body", bevel=0):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    collection.objects.link(obj)
    return finish(obj, name, colour, kind, bevel)


def coach_end(name, centre, length, width, bottom, top, colour, end, rake, bevel=.06):
    # Three stations form a tapered cab nose, with a raked upper windscreen line.
    vertices = []
    for z in (bottom, top):
        terminal = centre + end * (length / 2 - (rake if z == top else 0))
        rear = centre - end * length / 2
        shoulder = centre + end * (length / 2 - 1.4)
        for y, half in [(rear, width / 2), (shoulder, width / 2), (terminal, width * .43)]:
            vertices.extend([(-half, y, z), (half, y, z)])
    faces = [(0, 1, 3, 5, 4, 2), (6, 8, 10, 11, 9, 7), (0, 6, 7, 1), (4, 5, 11, 10)]
    for i in (0, 2):
        faces.extend([(i, i + 2, i + 8, i + 6), (i + 1, i + 7, i + 9, i + 3)])
    if end > 0:
        faces = [tuple(reversed(face)) for face in faces]
    return mesh(name, vertices, faces, colour, bevel=bevel)


def side_windows(length, centre=0, width=2.5, bottom=1.55, top=2.8, spacing=1.18, bevel=.025):
    count = int(length / spacing)
    for side in (-1, 1):
        for i in range(count):
            y = centre - (count - 1) * spacing / 2 + i * spacing
            box("Tinted side window", (side * (width / 2 + .012), y, (bottom + top) / 2), (.024, spacing - .1, top - bottom), "glass", bevel, "glass")


def wheel(y, radius=.47, width=2.5, z=None):
    for side in (-1, 1):
        x = side * (width / 2 - .1)
        cylinder("Rubber tyre", (x, y, z or radius), radius, .24, "tyre", "X", vertices=24)
        cylinder("Wheel rim", (x + side * .125, y, z or radius), radius * .59, .015, "metal", "X", "metal", 16)
        cylinder("Wheel hub", (x + side * .14, y, z or radius), radius * .2, .02, "dark", "X", "metal")


def bus():
    # 12 m low-floor city bus, with stepped beltline and curved front/roof.
    box("Lower blue body", (0, 0, .87), (2.48, 11.85, .95), "blue", .14)
    coach_end("Raked white passenger cabin", -.03, 11.75, 2.46, 1.315, 2.765, "white", 1, .22)
    box("Window band", (0, -.05, 2.22), (2.49, 11.45, 1.15), "dark", .09)
    side_windows(9.6, centre=-.35, width=2.5, bottom=1.68, top=2.76)
    box("Roof", (0, -.08, 2.97), (2.5, 11.75, .33), "white", .15)
    box("Roof battery/HVAC", (0, -1.5, 3.2), (1.8, 4.2, .2), "white", .09)
    for y in (-2.65, -2.25, -1.85, -1.45):
        box("Roof cooling grille", (0, y, 3.309), (1.25, .14, .014), "dark", 0)
    for y in (3.55, -3.25):
        wheel(y)
        for side in (-1, 1):
            # Body panels stop above the wheel centres; arches sit over dark wheel recesses.
            box("Wheel arch trim", (side * 1.252, y, .99), (.025, 1.13, .1), "dark", .035)
    windshield = box("Sloping front windshield", (0, 5.75, 2.1), (2.05, .028, 1.4), "glass", .09, "glass")
    windshield.rotation_euler.x = math.radians(9)
    box("Front destination display", (0, 5.93, 2.89), (1.8, .02, .22), "dark", .025)
    for side in (-1, 1):
        box("Headlamp", (side * .88, 5.958, .96), (.38, .026, .15), "light", .045)
        box("Rear red lamp", (side * 1.01, -5.94, 1.05), (.19, .025, .36), "red", .035)
        box("Mirror", (side * 1.35, 5.23, 2.48), (.15, .18, .32), "dark", .04)
        rod("Mirror arm", (side * 1.14, 5.42, 2.65), (side * 1.34, 5.23, 2.64), .026)
    box("Front bumper", (0, 5.954, .55), (2.2, .05, .18), "dark", .04)
    box("Rear window", (0, -5.911, 2.2), (1.8, .025, 1.08), "glass", .06, "glass")
    for y in (4.57, -.82):
        box("Door frame", (1.264, y, 1.6), (.024, 1.32, 2.12), "dark", .03)
        for offset in (-.31, .31):
            box("Door glass", (1.285, y + offset, 1.95), (.016, .55, 1.4), "glass", .02, "glass")
            rod("Door edge", (1.303, y + offset + .27, .57), (1.303, y + offset + .27, 2.64), .013)
    for side in (-1, 1):
        rod("Windshield wiper", (side * .48, 5.947, 1.46), (side * .78, 5.947, 2.25), .017, "dark")


def tram():
    for centre, length in [(-9.55, 8.5), (0, 9.0), (9.55, 8.5)]:
        end = 1 if centre > 0 else -1
        if centre:
            coach_end("Tapered green cab section", centre, length, 2.4, .405, 1.555, "green", end, .12)
            coach_end("Tapered cream cab section", centre, length - .1, 2.39, 1.53, 2.91, "cream", end, .4)
        else:
            box("Green lower section", (0, centre, .98), (2.4, length, 1.15), "green", .14)
            box("Cream upper section", (0, centre, 2.22), (2.39, length - .1, 1.38), "cream", .14)
        box("Dark window belt", (0, centre - (end * .4 if centre else 0), 2.25), (2.405, length - (1.2 if centre else .3), 1.08), "dark", .08)
        side_windows(length - 1.7, centre, 2.42, 1.82, 2.83, 1.22)
        if centre:
            coach_end("Tapered cab roof", centre - end * .12, length - .45, 2.36, 2.89, 3.21, "cream", end, .12)
        else:
            box("Curved roof", (0, centre, 3.05), (2.36, length - .2, .32), "cream", .13)
        box("Roof equipment", (0, centre - .3, 3.3), (1.75, length * .48, .24), "metal", .08, "metal")
        for side in (-1, 1):
            for y in (centre - length * .22, centre + length * .22):
                box("Passenger door frame", (side * 1.219, y, 1.75), (.022, 1.22, 2.22), "cream", .025)
                for offset in (-.28, .28):
                    box("Passenger door glass", (side * 1.235, y + offset, 2.03), (.016, .49, 1.52), "glass", .025, "glass")
        for y in (centre - length * .28, centre + length * .28):
            wheel(y, .32, 2.05)
    for y in (-4.88, 4.88):
        box("Articulation bellows", (0, y, 1.92), (2.28, .78, 2.54), "dark", .06)
        for offset in (-.3, -.2, -.1, 0, .1, .2, .3):
            for side in (-1, 1):
                box("Bellows rib", (side * 1.151, y + offset, 1.92), (.032, .043, 2.35), "metal", .008, "metal")
    for end in (-1, 1):
        y = end * 13.57
        windshield = box("Raked driver windshield", (0, y, 2.2), (1.91, .033, 1.16), "glass", .12, "glass")
        windshield.rotation_euler.x = end * math.radians(17)
        box("Cab destination display", (0, y - end * .155, 2.88), (1.6, .024, .2), "dark", .035)
        box("Cab bumper", (0, y, .72), (2.1, .037, .18), "dark", .035)
        for side in (-1, 1):
            box("Tram headlight", (side * .79, y + end * .02, 1.15), (.29, .03, .12), "light", .04)
            rod("Cab wiper", (side * .4, y + end * .16, 1.65), (side * .6, y - end * .035, 2.35), .015, "dark")
    # Folded pantograph is inside the operating envelope; no imaginary overhead wires.
    for side in (-1, 1):
        rod("Pantograph lower arm", (side * .42, -.8, 3.42), (side * .42, .15, 3.76), .035)
        rod("Pantograph upper arm", (side * .42, .15, 3.76), (side * .42, .95, 3.48), .035)
    rod("Pantograph contact strip", (-.85, .15, 3.79), (.85, .15, 3.79), .035)


def ferry():
    # Double-ended harbour ferry: hull below datum, passenger deck and raised wheelhouse.
    rings = []
    for z, width, length, taper in [(-1.7, 3.1, 31, 2.8), (.25, 4.4, 35.5, 3.2), (1.35, 4.5, 36, 3.5)]:
        rings.append([(-width, -length / 2 + taper, z), (-width * .65, -length / 2, z), (width * .65, -length / 2, z),
                      (width, -length / 2 + taper, z), (width, length / 2 - taper, z), (width * .65, length / 2, z),
                      (-width * .65, length / 2, z), (-width, length / 2 - taper, z)])
    faces = [tuple(reversed(range(8))), tuple(range(16, 24))]
    for ring in range(2):
        for i in range(8):
            faces.append((ring * 8 + i, ring * 8 + (i + 1) % 8, (ring + 1) * 8 + (i + 1) % 8, (ring + 1) * 8 + i))
    mesh("Shaped displacement hull", sum(rings, []), faces, "hull", bevel=.09)
    box("Passenger deck", (0, 0, 1.43), (8.5, 28.5, .2), "deck", .05)
    box("White passenger salon", (0, 0, 2.88), (7.4, 20.8, 2.7), "white", .16)
    side_windows(19.5, 0, 7.42, 2.32, 3.79, 1.45)
    box("Salon roof", (0, 0, 4.34), (7.8, 21.4, .24), "white", .1)
    box("Raised bridge", (0, 1.4, 5.35), (5.25, 5.1, 1.85), "white", .14)
    side_windows(4.6, 1.4, 5.27, 4.9, 6.05, 1.15)
    for end in (-1, 1):
        box("Bridge windshield", (0, 1.4 + end * 2.565, 5.49), (4.8, .025, 1.11), "glass", .06, "glass")
        box("Salon end windows", (0, end * 10.41, 3.05), (6.6, .026, 1.4), "glass", .06, "glass")
        box("Boarding ramp", (0, end * 15.8, 1.45), (4.2, 3.2, .16), "metal", .04, "metal")
        for side in (-1, 1):
            cylinder("Mooring bollard", (side * 3.1, end * 13.5, 1.76), .17, .42, "dark")
            bpy.ops.mesh.primitive_torus_add(major_segments=16, minor_segments=6, location=(side * 3.77, end * 8.5, 3.52), major_radius=.24, minor_radius=.065)
            ring = bpy.context.object
            ring.rotation_euler.y = math.pi / 2
            finish(ring, "Deck life ring", "red")
    for side in (-1, 1):
        for y in range(-13, 14, 2):
            rod("Guardrail stanchion", (side * 4.0, y, 1.53), (side * 4.0, y, 2.52), .022)
        for z in (2.0, 2.5):
            rod("Deck guardrail", (side * 4.0, -13.8, z), (side * 4.0, 13.8, z), .026)
        box("Hull rubbing strake", (side * 4.47, 0, .7), (.18, 28.9, .23), "tyre", .055)
    box("Bridge roof", (0, 1.4, 6.38), (5.65, 5.45, .18), "white", .08)
    cylinder("Mast", (0, 1.4, 7.12), .055, 1.32, "metal", kind="metal")
    rod("Radar bar", (-.8, 1.4, 7.58), (.8, 1.4, 7.58), .06)
    cylinder("Funnel", (0, -5.8, 5.25), .55, 1.6, "blue", vertices=16)
    cylinder("Funnel cap", (0, -5.8, 6.1), .61, .15, "dark")


def train():
    # Representative two-car set; live feeds do not establish the actual formation.
    for centre, end in [(-11.25, -1), (11.25, 1)]:
        coach_end("Rail passenger body", centre, 22, 2.9, .75, 3.45, "white", end, .8)
        box("Purple lower livery", (0, centre, 1.15), (2.91, 20.7, .6), "purple", .12)
        side_windows(18, centre, 2.92, 1.8, 3.1, 1.65)
        box("Rail roof", (0, centre - end * .45, 3.58), (2.78, 20.2, .32), "white", .12)
        box("Roof equipment", (0, centre, 3.87), (1.7, 5, .25), "metal", .06, "metal")
        for y in (centre - 7, centre + 7):
            box("Bogie", (0, y, .58), (2.3, 2.5, .5), "dark", .06)
            wheel(y - .75, .4, 2.5)
            wheel(y + .75, .4, 2.5)
        for side in (-1, 1):
            for y in (centre - 4, centre + 4):
                box("Train door", (side * 1.48, y, 1.95), (.04, 1.5, 2.2), "purple", .025)
                box("Door window", (side * 1.51, y, 2.4), (.025, 1.1, 1.05), "glass", .025, "glass")
        windshield = box("Rail cab windshield", (0, centre + end * 10.5, 2.65), (2.25, .03, 1.1), "glass", .08, "glass")
        windshield.rotation_euler.x = end * math.radians(16)
        for side in (-1, 1):
            box("Rail headlamp", (side * .88, centre + end * 10.87, 1.4), (.28, .04, .16), "light", .03)
    box("Inter-car connection", (0, 0, 2.05), (2.55, .6, 2.5), "dark", .04)
    for side in (-1, 1):
        rod("Pantograph arm", (side * .45, 8, 3.8), (side * .45, 9.1, 4.3), .04)
    rod("Pantograph strip", (-.9, 9.1, 4.3), (.9, 9.1, 4.3), .04)


def ship_hull(length, width, deck, draft, colour="hull"):
    # A broad stern and fine bow stay recognizable from a harbor camera.
    outline = [(-.36, -.5), (.36, -.5), (.5, -.38), (.5, .2), (.37, .38),
               (0, .5), (-.37, .38), (-.5, .2), (-.5, -.38)]
    rings = [[(x * width * scale, y * length, z) for x, y in outline]
             for z, scale in [(-draft, .65), (0, 1), (deck, .98)]]
    n = len(outline)
    faces = [tuple(reversed(range(n))), tuple(range(2 * n, 3 * n))]
    for ring in range(2):
        for i in range(n):
            faces.append((ring * n + i, ring * n + (i + 1) % n,
                          (ring + 1) * n + (i + 1) % n, (ring + 1) * n + i))
    mesh("Displacement hull", sum(rings, []), faces, colour)
    box("Working deck", (0, -length * .04, deck + .06), (width * .87, length * .67, .12), "deck", .025)


def ship_cabin(name, centre, length, width, bottom, height, colour="white"):
    box(name, (0, centre, bottom + height / 2), (width, length, height), colour, .08)
    box("Cabin roof", (0, centre, bottom + height + .1), (width + .3, length + .3, .2), colour, .06)
    side_windows(length - .5, centre, width + .03, bottom + height * .42,
                 bottom + height * .84, max(1.1, length / 15), bevel=0)
    box("Bridge windshield", (0, centre + length / 2 + .012, bottom + height * .64),
        (width * .84, .025, height * .42), "glass", .025, "glass")


def ship_mast(y, bottom, height):
    rod("Radio mast", (0, y, bottom), (0, y, bottom + height), .055)
    rod("Radar scanner", (-.8, y, bottom + height * .8), (.8, y, bottom + height * .8), .07)
    rod("Antenna", (.35, y, bottom + height * .7), (.35, y, bottom + height + .4), .018)


def ship_rails(length, width, deck):
    for side in (-1, 1):
        x = side * width * .44
        for i in range(9):
            y = -length * .34 + i * length * .075
            rod("Rail stanchion", (x, y, deck), (x, y, deck + 1), .025)
        for z in (.5, 1):
            rod("Guardrail", (x, -length * .34, deck + z), (x, length * .26, deck + z), .025)
        for y in (-length * .32, length * .26):
            cylinder("Mooring bollard", (side * width * .36, y, deck + .22), .14, .44, "metal", kind="metal")


def passenger_ship():
    ship_hull(160, 27, 5, 5)
    for level, length in enumerate((112, 106, 98, 82)):
        ship_cabin("Passenger accommodation", -3, length, 24 - level * 1.3, 5.2 + level * 3, 2.8)
    ship_cabin("Forward navigation bridge", 35, 12, 23, 17.3, 3)
    for y in (-17, -29):
        box("Blue funnel", (0, y, 20), (6, 6, 7), "blue", .3)
        box("Funnel exhaust cap", (0, y, 23.6), (6.2, 6.2, .3), "dark", .08)
    for side in (-1, 1):
        for y in (-30, -15, 0, 15):
            box("Orange lifeboat", (side * 12.5, y, 11.5), (2, 6.5, 1.5), "red", .3)
    ship_rails(160, 27, 5.2)
    ship_mast(35, 20.5, 5)


def cargo_ship():
    ship_hull(140, 23, 4, 5)
    ship_cabin("Aft accommodation", -48, 16, 18, 4.2, 9)
    ship_cabin("Raised bridge", -46, 11, 20, 13.4, 3)
    for row in range(7):
        for column in range(4):
            for level in range(3 if row < 5 else 2):
                x, y, z = (column - 1.5) * 4.6, -25 + row * 11.6, 5.6 + level * 2.8
                colour = ("red", "blue", "green", "cream")[(row + column + level) % 4]
                box("Freight container", (x, y, z), (4.35, 11.1, 2.6), colour, .035)
                for side in (-1, 1):
                    box("Container corner rail", (x + side * 2.1, y, z + 1.32), (.1, 11.1, .06), "metal", 0, "metal")
    cylinder("Cargo funnel", (0, -52, 17), 1.4, 4, "blue")
    ship_mast(-46, 16.6, 5)
    ship_rails(140, 23, 4.2)


def tanker_ship():
    ship_hull(160, 27, 4, 6, "red")
    ship_cabin("Aft accommodation", -57, 17, 21, 4.2, 10)
    ship_cabin("Tanker bridge", -55, 12, 24, 14.4, 3)
    for y in range(-34, 55, 14):
        for side in (-1, 1):
            cylinder("Tank access hatch", (side * 6, y, 4.6), 2.1, .55, "metal", kind="metal")
            rod("Tank branch pipe", (0, y, 5.3), (side * 6, y, 5.3), .22)
        cylinder("Valve wheel", (0, y, 5.8), .45, .12, "red")
    for x in (-1.1, 0, 1.1):
        rod("Deck cargo pipe", (x, -40, 5.1), (x, 57, 5.1), .23)
    box("Raised service walkway", (0, 9, 6.1), (2.5, 95, .25), "metal", .02, "metal")
    cylinder("Tanker funnel", (0, -61, 18.6), 1.7, 4, "dark")
    ship_mast(-55, 17.6, 5)
    ship_rails(160, 27, 4.2)


def tug_ship():
    ship_hull(28, 9.5, 1.6, 2.4)
    ship_cabin("Tug wheelhouse", 3, 8, 6.3, 1.8, 3.5, "cream")
    ship_cabin("Raised tug bridge", 3.8, 5.2, 5.8, 5.5, 2)
    for side in (-1, 1):
        box("Heavy rubber fender", (side * 4.65, -1, .8), (.45, 18, .8), "tyre", .12)
        for y in (-7, -3, 1, 5):
            cylinder("Circular side fender", (side * 4.92, y, 1.2), .6, .3, "tyre", "X")
        cylinder("Tug exhaust", (side * 2.4, -1.5, 5.7), .35, 3, "dark")
    cylinder("Towing winch", (0, -7, 2.7), .9, 3.2, "metal", "X", "metal")
    rod("Towing hook support", (0, -6.2, 1.8), (0, -6.2, 3.5), .25)
    ship_mast(3.8, 7.8, 3.2)
    ship_rails(28, 9.5, 1.8)


def fishing_ship():
    ship_hull(24, 6.8, 1.8, 2, "green")
    ship_cabin("Forward trawler cabin", 4, 7, 4.8, 2, 3)
    ship_mast(4, 5.3, 4)
    for side in (-1, 1):
        rod("Stern gantry upright", (side * 2.3, -7, 2), (side * 2.3, -7, 7.5), .13)
        rod("Trawl outrigger", (side * 1.8, 2, 6), (side * 4.5, -3, 5), .08)
        rod("Outrigger cable", (0, 4, 8), (side * 4.5, -3, 5), .02)
    rod("Gantry crossbeam", (-2.3, -7, 7.5), (2.3, -7, 7.5), .16)
    cylinder("Net drum", (0, -5.7, 3), 1, 3, "metal", "X", "metal")
    for y in (-3, -1):
        box("Fish crates", (0, y, 2.4), (2.5, 1.5, .8), "blue", .04)
    ship_rails(24, 6.8, 2)


def sailing_ship():
    ship_hull(12, 3.5, .65, 1.4, "white")
    ship_cabin("Sailboat cabin", 1, 3.2, 2.4, .8, .9)
    box("Open cockpit", (0, -3, .88), (2.4, 2.4, .25), "dark", .08)
    rod("Sailing mast", (0, 1, .8), (0, 1, 16), .065)
    rod("Boom", (0, 1, 2.3), (0, -4.5, 2.3), .045)
    mesh("Mainsail", [(0, .9, 15.4), (0, .9, 2.5), (0, -4.5, 2.5),
                      (.04, .9, 15.4), (.04, .9, 2.5), (.04, -4.5, 2.5)],
         [(0, 1, 2), (5, 4, 3), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)], "cream")
    mesh("Headsail", [(0, 1.1, 14.7), (0, 5.3, 1), (0, 1.1, 2.5),
                      (.04, 1.1, 14.7), (.04, 5.3, 1), (.04, 1.1, 2.5)],
         [(0, 1, 2), (5, 4, 3), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)], "white")
    for side in (-1, 1):
        rod("Standing rigging", (0, 1, 14), (side * 1.5, 1, .9), .013)
    ship_rails(12, 3.5, .8)


def pleasure_ship():
    ship_hull(15, 4.5, .8, 1, "white")
    ship_cabin("Yacht salon", 1, 6.5, 3.7, 1, 2.1)
    ship_cabin("Flybridge", 1.3, 3.2, 3, 3.3, 1.3)
    box("Cockpit seating", (0, -4.1, 1.25), (3.5, 1.6, .6), "cream", .15)
    box("Swim platform", (0, -7, .3), (3.5, .9, .2), "deck", .05)
    ship_mast(.5, 4.8, 1.7)
    ship_rails(15, 4.5, 1)


def generic_ship():
    ship_hull(40, 9, 2, 2.8)
    ship_cabin("Utility accommodation", -5, 13, 6.8, 2.2, 3.3)
    ship_cabin("Raised wheelhouse", -2, 5, 6, 5.7, 2)
    cylinder("Utility funnel", (0, -9, 5.8), .5, 2.3, "blue")
    ship_mast(-2, 8, 3)
    ship_rails(40, 9, 2.2)


def batch_materials():
    # Vertex colours keep livery details while needing only three GPU material batches.
    for kind in ("body", "glass", "metal"):
        objects = [o for o in collection.objects if o.type == "MESH" and o.data.materials[0].name.startswith(kind + "_")]
        if not objects:
            continue
        for obj in objects:
            colour = obj.data.materials[0].diffuse_color
            layer = obj.data.color_attributes.new(name="Livery", type="FLOAT_COLOR", domain="CORNER")
            for value in layer.data:
                value.color = colour
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
        obj = bpy.context.object
        obj.name = f"{collection.name}_{kind}"
        m = bpy.data.materials.new(f"{collection.name}_{kind}_vertex_colour")
        m.use_nodes = True
        shader = m.node_tree.nodes.get("Principled BSDF")
        vertex = m.node_tree.nodes.new("ShaderNodeVertexColor")
        vertex.layer_name = "Livery"
        m.node_tree.links.new(vertex.outputs["Color"], shader.inputs["Base Color"])
        shader.inputs["Roughness"].default_value = .16 if kind == "glass" else .42 if kind == "metal" else .54
        shader.inputs["Metallic"].default_value = .45 if kind == "glass" else .65 if kind == "metal" else .05
        obj.data.materials.clear()
        obj.data.materials.append(m)
        for polygon in obj.data.polygons:
            polygon.material_index = 0
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


selected_modes = set(sys.argv[sys.argv.index("--") + 1:]) if "--" in sys.argv else set()
ships = selected_modes == {"ships"}
if "ships" in selected_modes and not ships:
    raise ValueError("Generate ships separately with -- ships")
builders = [("ship-passenger", passenger_ship), ("ship-cargo", cargo_ship), ("ship-tanker", tanker_ship),
            ("ship-tug", tug_ship), ("ship-fishing", fishing_ship), ("ship-sailing", sailing_ship),
            ("ship-pleasure", pleasure_ship), ("ship-generic", generic_ship)] if ships else [
            ("bus", bus), ("tram", tram), ("ferry", ferry), ("train", train)]
inventory = {}
for mode, build in builders:
    if selected_modes and not ships and mode not in selected_modes:
        continue
    collection = bpy.data.collections.new(mode)
    bpy.context.scene.collection.children.link(collection)
    build()
    batch_materials()
    bpy.ops.object.select_all(action="DESELECT")
    for obj in collection.objects:
        obj.select_set(True)
    path = OUT / f"{mode}.glb"
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB", use_selection=True,
                              export_yup=True, export_texcoords=False, export_animations=False, export_extras=False)
    points = [obj.matrix_world @ Vector(corner) for obj in collection.objects for corner in obj.bound_box]
    low = [min(p[i] for p in points) for i in range(3)]
    high = [max(p[i] for p in points) for i in range(3)]
    triangles = sum(sum(len(p.vertices) - 2 for p in obj.data.polygons) for obj in collection.objects)
    assert len(collection.objects) <= 3, "Too many material batches"
    assert triangles < 18000, f"{mode} exceeds triangle budget: {triangles}"
    assert path.stat().st_size < 2 * 1024 ** 2, "Model exceeds byte budget"
    assert abs(low[2]) < .01 if mode != "ferry" and not ships else low[2] < 0 < high[2], "Invalid contact/water datum"
    inventory[mode] = {"length": round(high[1] - low[1], 3), "width": round(high[0] - low[0], 3),
                       "heightAboveDatum": round(high[2], 3), "triangles": triangles, "bytes": path.stat().st_size}

# Keep the source immediately editable, with one mode visible at a time.
for c in bpy.context.scene.collection.children:
    c.hide_viewport = c.name != ("ship-passenger" if ships else next(iter(selected_modes)) if selected_modes else "bus")
    c.hide_render = c.name != ("ship-passenger" if ships else next(iter(selected_modes)) if selected_modes else "bus")
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE / ("helsinki-ships.blend" if ships else "helsinki-train.blend" if selected_modes == {"train"} else "helsinki-transit.blend")))
print(json.dumps(inventory, indent=2))
