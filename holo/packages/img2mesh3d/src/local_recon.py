from __future__ import annotations

import logging
import math
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image

from .config import PipelineConfig
from .events import Emitter, PipelineEvent, now_ns

logger = logging.getLogger("img2mesh3d.local_recon")

@dataclass
class ViewFrame:
    index: int
    color: np.ndarray
    depth: np.ndarray
    cam_to_world: np.ndarray
    world_to_cam: np.ndarray
    eye: np.ndarray
    fx: float
    fy: float
    cx: float
    cy: float


@dataclass
class ReconOutputs:
    mesh_path: Optional[Path] = None
    texture_path: Optional[Path] = None
    point_cloud_path: Optional[Path] = None


class LocalReconstructor:
    def __init__(self, config: PipelineConfig):
        self.config = config

    def run(
        self,
        *,
        view_paths: List[Path],
        depth_paths: Dict[int, Path],
        out_dir: Path,
        emit: Optional[Emitter] = None,
        emit_stage: str = "rebuild",
    ) -> ReconOutputs:
        def report(progress: float, message: Optional[str] = None) -> None:
            if emit is None:
                return
            clamped = max(0.0, min(1.0, float(progress)))
            if message:
                emit(
                    PipelineEvent(
                        kind="log",
                        stage=emit_stage,
                        ts_ns=now_ns(),
                        message=message,
                    )
                )
            emit(
                PipelineEvent(
                    kind="progress",
                    stage=emit_stage,
                    ts_ns=now_ns(),
                    progress=clamped,
                )
            )

        report(0.0, "Rebuild started")
        import open3d as o3d
        import trimesh
        xatlas = None
        texture_enabled = self.config.texture_enabled
        texture_backend = (self.config.texture_backend or "auto").lower()
        blender_path = self._resolve_blender_path()
        if texture_enabled and texture_backend in {"auto", "pyxatlas"}:
            try:
                import xatlas as _xatlas

                xatlas = _xatlas
            except Exception as exc:
                if texture_backend == "pyxatlas":
                    logger.warning("pyxatlas not available; disabling texture bake. error=%s", exc)
                else:
                    logger.info("pyxatlas not available; falling back. error=%s", exc)
                xatlas = None
        if texture_enabled and texture_backend == "blender" and not blender_path:
            logger.warning("Blender not found; disabling texture bake.")
            texture_enabled = False

        out_dir.mkdir(parents=True, exist_ok=True)

        selected = self._select_views(len(view_paths))
        logger.info(
            "recon inputs views=%d depth=%d selected=%s",
            len(view_paths),
            len(depth_paths),
            selected,
        )
        logger.info(
            "recon params method=%s fusion=%s voxel=%.4f alpha=%.4f poisson_depth=%d target_tris=%d",
            self.config.recon_method,
            self.config.recon_fusion,
            self.config.recon_voxel_size,
            self.config.recon_alpha,
            self.config.recon_poisson_depth,
            self.config.recon_target_tris,
        )
        logger.info(
            "recon camera fov=%.1f radius=%.2f elev=%.1f depth invert=%s near=%.2f far=%.2f",
            self.config.camera_fov_deg,
            self.config.camera_radius,
            self.config.views_elev_deg,
            self.config.depth_invert,
            self.config.depth_near,
            self.config.depth_far,
        )
        frames = self._build_frames(view_paths, depth_paths, selected)
        if not frames:
            raise RuntimeError("No valid views with depth available for reconstruction")
        report(0.2, "Prepared views")

        if self.config.recon_fusion == "tsdf":
            report(0.3, "Fusing TSDF")
            pcd, mesh = self._fuse_tsdf(frames)
            report(0.65, "TSDF fusion complete")
        else:
            report(0.3, "Fusing points")
            pcd = self._fuse_points(frames)
            logger.info("recon points=%d", len(pcd.points))
            report(0.55, "Point fusion complete")
            mesh = self._mesh_from_points(pcd)
            report(0.7, "Meshing complete")

        logger.info("recon mesh raw verts=%d tris=%d", len(mesh.vertices), len(mesh.triangles))
        mesh = self._cleanup_mesh(mesh)
        report(0.8, "Mesh cleanup complete")
        if self.config.recon_target_tris > 0:
            mesh = mesh.simplify_quadric_decimation(self.config.recon_target_tris)
            logger.info("recon mesh decimated verts=%d tris=%d", len(mesh.vertices), len(mesh.triangles))
            report(0.85, "Mesh simplified")
        mesh.compute_vertex_normals()

        outputs = ReconOutputs()

        if self.config.points_enabled:
            points_path = out_dir / "points.ply"
            pcd_to_save = self._limit_points(pcd)
            o3d.io.write_point_cloud(str(points_path), pcd_to_save)
            outputs.point_cloud_path = points_path
            report(0.9, "Point cloud exported")

        vertices = np.asarray(mesh.vertices)
        faces = np.asarray(mesh.triangles)
        vertex_colors = np.asarray(mesh.vertex_colors)

        if texture_enabled and xatlas is not None and texture_backend in {"auto", "pyxatlas"}:
            try:
                uv_mesh, texture = self._unwrap_and_bake(
                    xatlas=xatlas,
                    vertices=vertices,
                    faces=faces,
                    frames=frames,
                    texture_size=self.config.texture_size,
                )
                texture_path = out_dir / "albedo.png"
                texture.save(texture_path)
                outputs.texture_path = texture_path

                glb_path = out_dir / "model.glb"
                glb_data = trimesh.exchange.gltf.export_glb(uv_mesh)
                glb_path.write_bytes(glb_data)
                outputs.mesh_path = glb_path
                report(0.95, "Texture baked")
            except Exception as exc:
                logger.warning("pyxatlas bake failed; falling back. error=%s", exc)
                texture_enabled = False
                texture_backend = "blender"

        if texture_enabled and blender_path and texture_backend in {"auto", "blender"} and outputs.mesh_path is None:
            try:
                baked_glb, baked_tex = self._bake_with_blender(
                    vertices=vertices,
                    faces=faces,
                    vertex_colors=vertex_colors,
                    blender_path=blender_path,
                    out_dir=out_dir,
                )
                outputs.mesh_path = baked_glb
                outputs.texture_path = baked_tex
                report(0.95, "Texture baked")
            except Exception as exc:
                logger.warning("Blender bake failed; exporting untextured GLB. error=%s", exc)
                texture_enabled = False

        if outputs.mesh_path is None:
            self._export_untextured(
                glb_path=out_dir / "model.glb",
                vertices=vertices,
                faces=faces,
                vertex_colors=vertex_colors,
            )
            outputs.mesh_path = out_dir / "model.glb"
        report(1.0, "Rebuild complete")

        return outputs

    def _select_views(self, total: int) -> List[int]:
        if total <= 0:
            return []
        if self.config.recon_view_indices is not None:
            indices = [i for i in self.config.recon_view_indices if i < total]
            if indices:
                return indices
        if self.config.recon_images is None or self.config.recon_images >= total:
            return list(range(total))
        step = total / max(1, self.config.recon_images)
        indices = [min(total - 1, int(i * step)) for i in range(self.config.recon_images)]
        uniq: List[int] = []
        for idx in indices:
            if idx not in uniq:
                uniq.append(idx)
        return uniq

    def _build_frames(
        self,
        view_paths: List[Path],
        depth_paths: Dict[int, Path],
        indices: List[int],
    ) -> List[ViewFrame]:
        frames: List[ViewFrame] = []
        total = len(view_paths)
        angles = self._default_angles(total)
        
        # Log the camera angles being used
        logger.info(
            "recon camera angles for %d views: %s",
            total,
            [(f"view{i}:az={az:.0f}°,el={el:.0f}°") for i, (az, el) in enumerate(angles)]
        )
        
        for idx in indices:
            if idx >= total:
                continue
            depth_path = depth_paths.get(idx)
            if depth_path is None:
                logger.debug("recon view %d skipped: missing depth", idx)
                continue
            color, alpha = self._load_color(view_paths[idx])
            depth = self._load_depth(depth_path)
            if alpha.shape[:2] == depth.shape[:2]:
                depth[alpha < 0.05] = 0.0
            else:
                logger.debug(
                    "recon view %d alpha/depth mismatch: alpha=%s depth=%s",
                    idx,
                    alpha.shape,
                    depth.shape,
                )
            
            # Log depth statistics (non-zero values only for meaningful stats)
            nonzero_depth = depth[depth > 0]
            if nonzero_depth.size > 0:
                logger.debug(
                    "recon view %d size=%dx%d depth: min=%.3f max=%.3f mean=%.3f nonzero=%d/%d",
                    idx,
                    color.shape[1],
                    color.shape[0],
                    float(np.min(nonzero_depth)),
                    float(np.max(nonzero_depth)),
                    float(np.mean(nonzero_depth)),
                    nonzero_depth.size,
                    depth.size,
                )
            
            az_deg, el_deg = angles[idx]
            cam_to_world, eye = self._camera_pose(az_deg, el_deg)
            det = float(np.linalg.det(cam_to_world[:3, :3]))
            logger.info(
                "recon view %d: az=%.1f° el=%.1f° eye=[%.3f,%.3f,%.3f] det=%.3f",
                idx, az_deg, el_deg, eye[0], eye[1], eye[2], det
            )
            world_to_cam = np.linalg.inv(cam_to_world)
            h, w = depth.shape[:2]
            fx, fy, cx, cy = self._intrinsics(w, h)
            frames.append(
                ViewFrame(
                    index=idx,
                    color=color,
                    depth=depth,
                    cam_to_world=cam_to_world,
                    world_to_cam=world_to_cam,
                    eye=eye,
                    fx=fx,
                    fy=fy,
                    cx=cx,
                    cy=cy,
                )
            )
        return frames

    def _default_angles(self, count: int) -> List[Tuple[float, float]]:
        if self.config.views_azimuths_deg and self.config.views_elevations_deg:
            pairs = list(zip(self.config.views_azimuths_deg, self.config.views_elevations_deg))
            if len(pairs) >= count:
                return pairs[:count]
        if count == 6:
            # Zero123++ outputs a 2x3 grid:
            # Top row (views 0,1,2): azimuth 30°, 90°, 150° at elevation ~20°
            # Bottom row (views 3,4,5): azimuth 210°, 270°, 330° at elevation ~-20°
            # IMPORTANT: All views in same row share the same elevation!
            azimuths = [30, 90, 150, 210, 270, 330]
            elevations = [20, 20, 20, -20, -20, -20]
            return list(zip(azimuths, elevations))
        azimuths = np.linspace(0.0, 360.0, count, endpoint=False)
        return [(float(a), float(self.config.views_elev_deg)) for a in azimuths]

    def _camera_pose(self, az_deg: float, el_deg: float) -> Tuple[np.ndarray, np.ndarray]:
        az = math.radians(az_deg)
        el = math.radians(el_deg)
        r = self.config.camera_radius
        eye = np.array(
            [
                r * math.cos(el) * math.sin(az),
                r * math.sin(el),
                r * math.cos(el) * math.cos(az),
            ],
            dtype=np.float64,
        )
        cam_to_world = self._look_at(eye, np.array([0.0, 0.0, 0.0]), np.array([0.0, 1.0, 0.0]))
        return cam_to_world, eye

    def _look_at(self, eye: np.ndarray, target: np.ndarray, up: np.ndarray) -> np.ndarray:
        """
        Build a camera-to-world matrix using OpenGL-style convention:
        - Camera looks down -Z axis in camera space
        - +Y is up, +X is right
        
        For Open3D RGBD backprojection compatibility, we use:
        - z_cam (forward into scene) for depth direction
        - y_cam flipped to account for image Y-down vs world Y-up
        """
        # Forward direction (from eye toward target)
        forward = target - eye
        forward = forward / (np.linalg.norm(forward) + 1e-8)
        
        # Right direction
        right = np.cross(forward, up)
        right = right / (np.linalg.norm(right) + 1e-8)
        
        # Recompute up to ensure orthonormal basis (right-handed: up = forward x right)
        up_vec = np.cross(forward, right)
        up_vec = up_vec / (np.linalg.norm(up_vec) + 1e-8)
        
        # Build cam_to_world transformation
        # In camera space: +X=right, +Y=up, +Z=forward (into scene)
        # Note: Open3D's RGBD backprojection has Y pointing down in image coords,
        # so we negate Y to flip from image space to world space
        cam_to_world = np.eye(4, dtype=np.float64)
        cam_to_world[:3, 0] = right
        cam_to_world[:3, 1] = -up_vec  # Negate Y to flip from image-Y-down to world-Y-up
        cam_to_world[:3, 2] = forward
        cam_to_world[:3, 3] = eye
        return cam_to_world

    def _intrinsics(self, width: int, height: int) -> Tuple[float, float, float, float]:
        fov = math.radians(self.config.camera_fov_deg)
        fx = 0.5 * width / math.tan(fov / 2.0)
        fy = fx
        cx = width * 0.5
        cy = height * 0.5
        return fx, fy, cx, cy

    def _load_color(self, path: Path) -> Tuple[np.ndarray, np.ndarray]:
        img = Image.open(path).convert("RGBA")
        rgba = np.asarray(img)
        color = np.ascontiguousarray(rgba[:, :, :3])
        alpha = rgba[:, :, 3].astype(np.float32) / 255.0
        return color, alpha

    def _load_depth(self, path: Path) -> np.ndarray:
        img = Image.open(path)
        if img.mode not in ("L", "I;16", "I"):
            img = img.convert("L")
        depth = np.asarray(img)
        if depth.dtype == np.uint16:
            depth = depth.astype(np.float32) / 65535.0
        else:
            depth = depth.astype(np.float32) / 255.0
        if self.config.depth_invert:
            depth = 1.0 - depth
        depth = self.config.depth_near + depth * (self.config.depth_far - self.config.depth_near)
        return depth

    def _fuse_points(self, frames: List[ViewFrame]):
        import open3d as o3d

        pcd_all = o3d.geometry.PointCloud()
        for frame in frames:
            color = o3d.geometry.Image(frame.color)
            depth = o3d.geometry.Image(frame.depth.astype(np.float32))
            rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(
                color,
                depth,
                depth_scale=1.0,
                depth_trunc=self.config.depth_far,
                convert_rgb_to_intensity=False,
            )
            intrinsic = o3d.camera.PinholeCameraIntrinsic(
                frame.color.shape[1], frame.color.shape[0], frame.fx, frame.fy, frame.cx, frame.cy
            )
            pcd = o3d.geometry.PointCloud.create_from_rgbd_image(rgbd, intrinsic)
            
            # Log camera-space point cloud bounds before transform
            if len(pcd.points) > 0:
                pts_cam = np.asarray(pcd.points)
                logger.debug(
                    "recon view %d camera-space bounds: X[%.3f,%.3f] Y[%.3f,%.3f] Z[%.3f,%.3f]",
                    frame.index,
                    pts_cam[:, 0].min(), pts_cam[:, 0].max(),
                    pts_cam[:, 1].min(), pts_cam[:, 1].max(),
                    pts_cam[:, 2].min(), pts_cam[:, 2].max(),
                )
            
            pcd.transform(frame.cam_to_world)
            
            # Log world-space point cloud bounds after transform
            if len(pcd.points) > 0:
                pts_world = np.asarray(pcd.points)
                logger.debug(
                    "recon view %d world-space bounds: X[%.3f,%.3f] Y[%.3f,%.3f] Z[%.3f,%.3f]",
                    frame.index,
                    pts_world[:, 0].min(), pts_world[:, 0].max(),
                    pts_world[:, 1].min(), pts_world[:, 1].max(),
                    pts_world[:, 2].min(), pts_world[:, 2].max(),
                )
            
            pcd_all += pcd
            
        logger.info("recon point fusion merged=%d", len(pcd_all.points))
        
        # Log overall bounds before filtering
        if len(pcd_all.points) > 0:
            pts = np.asarray(pcd_all.points)
            logger.info(
                "recon merged bounds: X[%.3f,%.3f] Y[%.3f,%.3f] Z[%.3f,%.3f]",
                pts[:, 0].min(), pts[:, 0].max(),
                pts[:, 1].min(), pts[:, 1].max(),
                pts[:, 2].min(), pts[:, 2].max(),
            )
        
        if self.config.recon_voxel_size > 0:
            pcd_all = pcd_all.voxel_down_sample(self.config.recon_voxel_size)
            logger.info("recon point fusion voxel=%.4f points=%d", self.config.recon_voxel_size, len(pcd_all.points))
        pcd_all, _ = pcd_all.remove_statistical_outlier(nb_neighbors=20, std_ratio=2.0)
        logger.info("recon point fusion filtered=%d", len(pcd_all.points))
        return pcd_all

    def _fuse_tsdf(self, frames: List[ViewFrame]):
        import open3d as o3d

        voxel = max(self.config.recon_voxel_size, 1e-4)
        volume = o3d.pipelines.integration.ScalableTSDFVolume(
            voxel_length=voxel,
            sdf_trunc=voxel * 5.0,
            color_type=o3d.pipelines.integration.TSDFVolumeColorType.RGB8,
        )
        for frame in frames:
            color = o3d.geometry.Image(frame.color)
            depth = o3d.geometry.Image(frame.depth.astype(np.float32))
            rgbd = o3d.geometry.RGBDImage.create_from_color_and_depth(
                color,
                depth,
                depth_scale=1.0,
                depth_trunc=self.config.depth_far,
                convert_rgb_to_intensity=False,
            )
            intrinsic = o3d.camera.PinholeCameraIntrinsic(
                frame.color.shape[1], frame.color.shape[0], frame.fx, frame.fy, frame.cx, frame.cy
            )
            volume.integrate(rgbd, intrinsic, frame.world_to_cam)
        pcd = volume.extract_point_cloud()
        mesh = volume.extract_triangle_mesh()
        logger.info("recon tsdf voxel=%.4f points=%d tris=%d", voxel, len(pcd.points), len(mesh.triangles))
        return pcd, mesh

    def _mesh_from_points(self, pcd):
        import open3d as o3d

        if self.config.recon_method == "alpha":
            alpha = max(self.config.recon_alpha, 1e-4)
            return o3d.geometry.TriangleMesh.create_from_point_cloud_alpha_shape(pcd, alpha)

        pcd.estimate_normals(
            search_param=o3d.geometry.KDTreeSearchParamHybrid(
                radius=max(self.config.recon_voxel_size * 2.0, 0.01), max_nn=30
            )
        )
        mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
            pcd, depth=self.config.recon_poisson_depth
        )
        if len(densities) > 0:
            density_threshold = np.quantile(densities, 0.02)
            mesh.remove_vertices_by_mask(np.asarray(densities) < density_threshold)
        return mesh

    def _cleanup_mesh(self, mesh):
        mesh.remove_degenerate_triangles()
        mesh.remove_duplicated_triangles()
        mesh.remove_duplicated_vertices()
        mesh.remove_non_manifold_edges()
        return mesh

    def _export_untextured(
        self,
        *,
        glb_path: Path,
        vertices: np.ndarray,
        faces: np.ndarray,
        vertex_colors: np.ndarray,
    ) -> None:
        import trimesh

        mesh_tm = trimesh.Trimesh(
            vertices=vertices,
            faces=faces,
            vertex_colors=vertex_colors if vertex_colors.size else None,
            process=False,
        )
        glb_path.write_bytes(trimesh.exchange.gltf.export_glb(mesh_tm))

    def _resolve_blender_path(self) -> Optional[str]:
        if self.config.blender_path:
            path = Path(self.config.blender_path)
            if path.exists():
                return str(path)
        env_path = shutil.which("blender")
        if env_path:
            return env_path
        default_path = Path("/Applications/Blender.app/Contents/MacOS/Blender")
        if default_path.exists():
            return str(default_path)
        return None

    def _bake_with_blender(
        self,
        *,
        vertices: np.ndarray,
        faces: np.ndarray,
        vertex_colors: np.ndarray,
        blender_path: str,
        out_dir: Path,
    ) -> Tuple[Path, Path]:
        temp_dir = Path(tempfile.mkdtemp(prefix="img2mesh3d_blender_"))
        try:
            input_glb = temp_dir / "input.glb"
            self._export_untextured(
                glb_path=input_glb,
                vertices=vertices,
                faces=faces,
                vertex_colors=vertex_colors,
            )
            output_glb = out_dir / "model.glb"
            texture_path = out_dir / "albedo.png"
            script_path = Path(__file__).with_name("blender_bake.py")
            cmd = [
                blender_path,
                "-b",
                "--factory-startup",
                "-P",
                str(script_path),
                "--",
                "--input",
                str(input_glb),
                "--output",
                str(output_glb),
                "--texture",
                str(texture_path),
                "--size",
                str(self.config.texture_size),
                "--samples",
                str(self.config.blender_bake_samples),
                "--margin",
                str(self.config.blender_bake_margin),
            ]
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode != 0:
                detail = (result.stderr or result.stdout or "").strip()
                raise RuntimeError(detail or "Blender bake failed")
            if not output_glb.exists() or not texture_path.exists():
                raise RuntimeError("Blender bake did not produce expected outputs")
            return output_glb, texture_path
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    def _limit_points(self, pcd):
        if self.config.points_voxel_size > 0:
            pcd = pcd.voxel_down_sample(self.config.points_voxel_size)
        max_points = self.config.points_max_points
        if max_points and len(pcd.points) > max_points:
            idx = np.random.choice(len(pcd.points), size=max_points, replace=False)
            pcd = pcd.select_by_index(idx.tolist())
        return pcd

    def _unwrap_and_bake(
        self,
        *,
        xatlas,
        vertices: np.ndarray,
        faces: np.ndarray,
        frames: List[ViewFrame],
        texture_size: int,
    ):
        import trimesh

        atlas = xatlas.Atlas()
        atlas.add_mesh(vertices, faces)
        atlas.generate()
        vmapping, indices, uvs = atlas[0]
        new_vertices = vertices[np.asarray(vmapping)]
        new_faces = np.asarray(indices).reshape(-1, 3)
        new_uvs = np.asarray(uvs)

        texture = self._bake_texture(new_vertices, new_faces, new_uvs, frames, texture_size)
        visual = trimesh.visual.texture.TextureVisuals(uv=new_uvs, image=texture)
        mesh = trimesh.Trimesh(vertices=new_vertices, faces=new_faces, visual=visual, process=False)
        return mesh, texture

    def _bake_texture(
        self,
        vertices: np.ndarray,
        faces: np.ndarray,
        uvs: np.ndarray,
        frames: List[ViewFrame],
        texture_size: int,
    ) -> Image.Image:
        tex = np.zeros((texture_size, texture_size, 3), dtype=np.float32)
        weights = np.zeros((texture_size, texture_size), dtype=np.float32)

        view_cache = [
            {
                "image": frame.color,
                "world_to_cam": frame.world_to_cam,
                "fx": frame.fx,
                "fy": frame.fy,
                "cx": frame.cx,
                "cy": frame.cy,
                "eye": frame.eye,
            }
            for frame in frames
        ]

        for face in faces:
            tri = vertices[face]
            uv = uvs[face]
            view = self._select_view_for_face(tri, view_cache)
            if view is None:
                continue
            self._rasterize_face(tri, uv, view, tex, weights)

        mask = weights > 0
        tex[mask] /= weights[mask][:, None]
        tex = np.clip(tex, 0, 255).astype(np.uint8)
        return Image.fromarray(tex, mode="RGB")

    def _select_view_for_face(self, tri: np.ndarray, views: List[Dict[str, np.ndarray]]):
        v0, v1, v2 = tri
        normal = np.cross(v1 - v0, v2 - v0)
        norm = np.linalg.norm(normal)
        if norm < 1e-8:
            return None
        normal /= norm
        center = (v0 + v1 + v2) / 3.0
        best = None
        best_score = 0.0
        for view in views:
            view_dir = view["eye"] - center
            view_dir /= np.linalg.norm(view_dir) + 1e-8
            score = abs(float(np.dot(normal, view_dir)))
            if score > best_score:
                best_score = score
                best = view
        return best

    def _rasterize_face(
        self,
        tri: np.ndarray,
        uv: np.ndarray,
        view: Dict[str, np.ndarray],
        tex: np.ndarray,
        weights: np.ndarray,
    ) -> None:
        img_h, img_w, _ = view["image"].shape
        uv_px = np.stack([uv[:, 0] * (tex.shape[1] - 1), (1.0 - uv[:, 1]) * (tex.shape[0] - 1)], axis=1)
        min_u = max(int(math.floor(np.min(uv_px[:, 0]))), 0)
        max_u = min(int(math.ceil(np.max(uv_px[:, 0]))), tex.shape[1] - 1)
        min_v = max(int(math.floor(np.min(uv_px[:, 1]))), 0)
        max_v = min(int(math.ceil(np.max(uv_px[:, 1]))), tex.shape[0] - 1)
        if min_u >= max_u or min_v >= max_v:
            return

        a, b, c = uv_px
        v0 = b - a
        v1 = c - a
        denom = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(denom) < 1e-8:
            return
        for y in range(min_v, max_v + 1):
            for x in range(min_u, max_u + 1):
                v2 = np.array([x, y]) - a
                u = (v2[0] * v1[1] - v1[0] * v2[1]) / denom
                v = (v0[0] * v2[1] - v2[0] * v0[1]) / denom
                w = 1.0 - u - v
                if u < 0 or v < 0 or w < 0:
                    continue
                point = tri[0] * w + tri[1] * u + tri[2] * v
                color = self._sample_view_color(point, view, img_w, img_h)
                if color is None:
                    continue
                tex[y, x] += color
                weights[y, x] += 1.0

    def _sample_view_color(self, point: np.ndarray, view: Dict[str, np.ndarray], width: int, height: int):
        proj = view["world_to_cam"] @ np.array([point[0], point[1], point[2], 1.0])
        z = proj[2]
        if z <= 1e-6:
            return None
        u = view["fx"] * proj[0] / z + view["cx"]
        v = view["fy"] * proj[1] / z + view["cy"]
        if u < 0 or v < 0 or u >= width - 1 or v >= height - 1:
            return None
        x0 = int(math.floor(u))
        y0 = int(math.floor(v))
        dx = u - x0
        dy = v - y0
        img = view["image"]
        c00 = img[y0, x0].astype(np.float32)
        c10 = img[y0, x0 + 1].astype(np.float32)
        c01 = img[y0 + 1, x0].astype(np.float32)
        c11 = img[y0 + 1, x0 + 1].astype(np.float32)
        c0 = c00 * (1 - dx) + c10 * dx
        c1 = c01 * (1 - dx) + c11 * dx
        return c0 * (1 - dy) + c1 * dy
