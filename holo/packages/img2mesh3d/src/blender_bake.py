from __future__ import annotations

import argparse
import sys

import bpy


def _parse_args() -> argparse.Namespace:
    if "--" not in sys.argv:
        raise SystemExit("Expected -- to pass args to blender_bake.py")
    idx = sys.argv.index("--")
    args = sys.argv[idx + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--texture", required=True)
    parser.add_argument("--size", type=int, default=1024)
    parser.add_argument("--samples", type=int, default=64)
    parser.add_argument("--margin", type=float, default=0.02)
    return parser.parse_args(args)


def _ensure_material(obj: bpy.types.Object, image: bpy.types.Image) -> None:
    material = bpy.data.materials.new(name="BakedMaterial")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links

    nodes.clear()
    tex_node = nodes.new(type="ShaderNodeTexImage")
    tex_node.image = image
    tex_node.select = True
    nodes.active = tex_node

    bsdf_node = nodes.new(type="ShaderNodeBsdfPrincipled")
    output_node = nodes.new(type="ShaderNodeOutputMaterial")
    links.new(tex_node.outputs["Color"], bsdf_node.inputs["Base Color"])
    links.new(bsdf_node.outputs["BSDF"], output_node.inputs["Surface"])

    if obj.data.materials:
        obj.data.materials[0] = material
    else:
        obj.data.materials.append(material)


def _uv_unwrap(obj: bpy.types.Object, margin: float) -> None:
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=66.0, island_margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")


def _bake(obj: bpy.types.Object, samples: int) -> None:
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.context.scene.cycles.samples = samples
    bpy.context.scene.render.engine = "CYCLES"
    bpy.context.scene.cycles.use_adaptive_sampling = True
    bpy.context.scene.cycles.bake_type = "DIFFUSE"
    bpy.context.scene.render.bake.use_pass_direct = False
    bpy.context.scene.render.bake.use_pass_indirect = False
    bpy.context.scene.render.bake.use_pass_color = True
    bpy.ops.object.bake(type="DIFFUSE")
    obj.select_set(False)


def main() -> None:
    args = _parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=args.input)

    mesh_objects = [obj for obj in bpy.data.objects if obj.type == "MESH"]
    if not mesh_objects:
        raise SystemExit("No mesh objects found in input")

    image = bpy.data.images.new("Albedo", width=args.size, height=args.size, alpha=False)

    for obj in mesh_objects:
        _uv_unwrap(obj, args.margin)
        _ensure_material(obj, image)
        _bake(obj, args.samples)

    image.filepath_raw = args.texture
    image.file_format = "PNG"
    image.save()

    bpy.ops.export_scene.gltf(
        filepath=args.output,
        export_format="GLB",
        export_texcoords=True,
        export_normals=True,
        export_colors=True,
        export_materials="EXPORT",
    )


if __name__ == "__main__":
    main()
